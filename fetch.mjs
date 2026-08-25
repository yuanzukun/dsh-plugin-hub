// fetch.mjs — 双源抓取 DeepSeek Harness (dsh) 插件目录：
//   源 A: GitHub topic:dsh-plugin（带 stars / 仓库元数据）
//   源 B: npm registry（keywords:dsh-plugin，量大，是真正的插件生态）
// 两源合并去重 -> 过滤出真正可装的插件 -> Agnes AI 生成中文简介 ->
// 合并人工策展 overrides -> 输出 public/plugins.json。
//
// 用法:
//   GITHUB_TOKEN=xxx node fetch.mjs        # 带 token 提高 GitHub 限额(推荐)
//   node fetch.mjs                         # 未登录
//   MAX_TRANSLATE=200 node fetch.mjs       # 本次最多自动翻译多少个缺中文的插件
//
// 设计要点:
//   1) 自动抓取数据 与 人工策展(overrides.json) 严格分离，重跑永不会冲掉你的策展。
//   2) npm 源为主力（量最大），GitHub 源补充 stars / 仓库信息，去重后以 npm 安装命令为准。
//   3) 离线兜底：GitHub 失败回退 seed.json；npm 失败则跳过该源（不致命）。

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(ROOT, 'data');
const OUT_FILE = join(PUBLIC_DIR, 'plugins.json');
const OVERRIDE_FILE = join(DATA_DIR, 'overrides.json');
const SEED_FILE = join(DATA_DIR, 'seed.json');

const GITHUB_API = 'https://api.github.com';
const TOPIC = 'dsh-plugin';
const NPM_SEARCH = 'https://registry.npmjs.org/-/v1/search';
const FETCH_TIMEOUT = 9000;
const MAX_TRANSLATE = Number(process.env.MAX_TRANSLATE || 120);

async function fetchWithTimeout(url, opts = {}, ms = FETCH_TIMEOUT) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---- 分类映射（按 keywords + 包名 token 精确命中，第一个命中生效）----
const CATEGORY_RULES = [
  { cat: '界面与体验', kw: ['ui', 'desktop', 'design', 'frontend', 'ui-generator', 'electron', 'browser-extension', 'theme', 'skin', 'wallpaper', 'web-ui', '换肤', 'sidebar', 'tui', 'vscode', 'browser'] },
  { cat: '工具与能力', kw: ['tool', 'tool-use', 'shell', 'terminal', 'cli', 'developer-tools', 'search', 'web-fetch', 'vision', 'ocr', 'quant', 'trading', 'git', 'code', 'rust', 'typescript', 'audio', 'video', 'diff', 'workspace', 'suite', 'file', 'format', 'translate', 'scrap', 'crawl'] },
  { cat: '记忆与上下文', kw: ['memory', 'rag', 'context', 'knowledge', 'knowledge-base', 'embedding', 'vector', 'recall'] },
  { cat: '模型与推理', kw: ['llm', 'model', 'reasoning', 'inference', 'prompt-caching', 'router', 'plan-mode', 'cost', 'billing', 'budget', 'openrouter'] },
  { cat: '技能与智能体', kw: ['skill', 'agent', 'agents', 'agent-skills', 'agentic', 'multi-agent', 'swarm', 'subagent', 'teams', 'persona', 'character', 'role'] },
  { cat: '工作流与自动化', kw: ['workflow', 'automation', 'jobs', 'cron', 'preset', 'pipeline', 'scheduler'] },
  { cat: '集成与连接', kw: ['mcp', 'integration', 'api', 'connector', 'webhook', 'feishu', 'lark', 'wechat', 'weixin', 'dingtalk', 'discord', 'telegram', 'slack', 'whatsapp', 'im', 'bot', 'bridge', 'asana', 'gitlab', 'notion', 'email', 'calendar'] },
  { cat: '安全与审计', kw: ['security', 'audit', 'guard', 'safety', 'vulnerability', 'supply-chain', 'secret', 'privacy'] },
  { cat: '学习资源', kw: ['tutorial', 'docs', 'learning', 'awesome', 'harness-engineering', 'example', 'demo'] },
];

// name 也参与分类：按非字母数字切词，与 keywords 一起做精确 token 匹配
function pickCategory(tags = [], name = '') {
  const tokens = new Set([
    ...tags.map((t) => String(t).toLowerCase()),
    ...String(name).toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean),
  ]);
  for (const rule of CATEGORY_RULES) {
    if (rule.kw.some((k) => tokens.has(k))) return rule.cat;
  }
  return '其他';
}

// ---------- GitHub ----------
const ghHeaders = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-plugin-hub' };
if (process.env.GITHUB_TOKEN) ghHeaders.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

async function gh(path) {
  const res = await fetchWithTimeout(GITHUB_API + path, { headers: ghHeaders });
  if (res.status === 403 || res.status === 429) {
    const remain = res.headers.get('x-ratelimit-remaining');
    throw new Error(`GitHub 限流 (剩余 ${remain})，建议设置 GITHUB_TOKEN 后重试`);
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} ${path}`);
  return res.json();
}

async function rawText(url) {
  try {
    const res = await fetchWithTimeout(url);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

async function detectGithubPlugin(repo) {
  const branch = repo.default_branch || 'main';
  const pkgText = await rawText(
    `https://raw.githubusercontent.com/${repo.owner.login}/${repo.name}/${branch}/package.json`
  );
  let pkg = null;
  try {
    pkg = pkgText ? JSON.parse(pkgText) : null;
  } catch {}

  if (pkg) {
    const name = pkg.name || '';
    const keywords = pkg.keywords || [];
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const hay = (name + ' ' + keywords.join(' ') + ' ' + (repo.description || '')).toLowerCase();
    const looksLikePlugin =
      /dsh|deepseek.?harness|cordis/.test(name) ||
      name.startsWith('dsh-') ||
      keywords.some((k) => /dsh|deepseek.?harness|cordis/.test(k)) ||
      'cordis' in deps ||
      '@cordisjs/core' in deps ||
      /dsh.?plugin/.test(repo.description || '');
    if (looksLikePlugin) {
      const isScoped = name.startsWith('@');
      const npmName = name && /dsh/.test(name) ? name : isScoped ? name : null;
      return { isPlugin: true, npmName };
    }
  }
  for (const f of ['cordis.yml', 'cordis.patch.yml', 'cordis.patch.yaml']) {
    const ok = await rawText(
      `https://raw.githubusercontent.com/${repo.owner.login}/${repo.name}/${branch}/${f}`
    );
    if (ok) return { isPlugin: true, npmName: null };
  }
  return { isPlugin: false, npmName: null };
}

// ---------- npm ----------
function npmRepoKey(links) {
  const r = links?.repository || links?.homepage || '';
  const m = r.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?(?:[/#]|$)/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

async function fetchNpmPlugins() {
  const seen = new Set();
  const out = [];
  const size = 250;
  for (let from = 0; from <= 2750; from += size) {
    const url = `${NPM_SEARCH}?text=keywords:dsh-plugin&size=${size}&from=${from}`;
    let j;
    try {
      const res = await fetchWithTimeout(url);
      if (!res.ok) {
        console.warn(`[npm] 搜索失败 HTTP ${res.status}，停止翻页`);
        break;
      }
      j = await res.json();
    } catch (e) {
      console.warn(`[npm] 搜索异常 ${e.message}，停止翻页`);
      break;
    }
    const objs = j.objects || [];
    if (objs.length === 0) break;
    let added = 0;
    for (const o of objs) {
      const p = o.package;
      if (!p?.name || seen.has(p.name)) continue;
      seen.add(p.name);
      const kw = p.keywords || [];
      // 已用 keywords:dsh-plugin 搜索，命中即视为 dsh 插件；再兜底按名字/描述过滤
      const ok =
        kw.includes('dsh-plugin') ||
        p.name.toLowerCase().startsWith('dsh-') ||
        /deepseek.?harness/.test(p.description || '');
      if (!ok) continue;
      out.push({
        name: p.name,
        description: p.description || '',
        keywords: kw,
        version: p.version || '',
        homepage: p.links?.homepage || '',
        repository: p.links?.repository || '',
        npmUrl: p.links?.npm || `https://www.npmjs.com/package/${p.name}`,
        updatedAt: p.date || '',
        score: o.score?.final || 0,
      });
      added++;
    }
    console.log(`[npm] from=${from} 本页新增 ${added} 个（累计 ${out.length}）`);
    if (objs.length < size) break;
  }
  return out;
}

// ---------- Agnes 翻译 ----------
async function readAgnesKey() {
  // CI/流水线里通过环境变量 AGNES_KEY 注入；本地则回退到文件
  if (process.env.AGNES_KEY) return String(process.env.AGNES_KEY).trim();
  try {
    return (await readFile(join(homedir(), '.workbuddy', 'agnes_api_key.txt'), 'utf8')).trim();
  } catch {
    return '';
  }
}
let AGNES_KEY = '';
async function translateToZh(text) {
  if (!text || !AGNES_KEY) return null;
  try {
    const res = await fetch('https://api.agnes-ai.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGNES_KEY}` },
      body: JSON.stringify({
        model: 'agnes-2.0-flash',
        temperature: 0.3,
        max_tokens: 140,
        messages: [
          {
            role: 'system',
            content:
              '你是 DeepSeek Harness 插件目录的中文编辑。把用户给的英文/多语插件描述浓缩成一句简洁准确的中文简介（不超过 40 字），保留专有名词(DSH/cordis/工具名)。只输出中文，不要解释、不要引号。',
          },
          { role: 'user', content: text },
        ],
      }),
    });
    const j = await res.json();
    return j.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

// ---------- 主流程 ----------
async function main() {
  AGNES_KEY = await readAgnesKey();
  console.log(
    AGNES_KEY
      ? '[agnes] 已载入 API Key，启用中文自动翻译（上限 ' + MAX_TRANSLATE + ' 条/次）'
      : '[agnes] 未找到 Key，跳过翻译(保留英文/策展)'
  );

  // 0) 载入 overrides
  let overrides = { forceExclude: [], forceInclude: [], patch: {} };
  try {
    overrides = JSON.parse(await readFile(OVERRIDE_FILE, 'utf8'));
  } catch {}
  const isExcluded = (id) =>
    overrides.forceExclude?.some((x) => x === id || x === `npm:${id}`);

  // 1) GitHub 源
  let repos = [];
  try {
    const search = await gh(`/search/repositories?q=topic:${TOPIC}&sort=stars&order=desc&per_page=100`);
    repos = search.items || [];
    console.log(`[github] 命中 ${repos.length} 个带 ${TOPIC} 标签的仓库`);
  } catch (e) {
    console.warn(`[github] 实时抓取失败（${e.message}），回退到本地种子数据 seed.json`);
    try {
      const seed = JSON.parse(await readFile(SEED_FILE, 'utf8'));
      repos = seed;
      overrides.forceInclude = [...(overrides.forceInclude || []), ...seed.map((r) => r.full_name)];
    } catch {
      console.error('无种子数据可用');
    }
  }

  const ghByFull = new Map(); // fullName -> item
  const ghByNpm = new Map(); // npmName -> item
  for (const repo of repos) {
    const full = repo.full_name;
    if (isExcluded(full)) {
      console.log(`  - 跳过(GitHub 排除): ${full}`);
      continue;
    }
    let detected = { isPlugin: true, npmName: null };
    if (!overrides.forceInclude?.includes(full)) detected = await detectGithubPlugin(repo);
    if (!detected.isPlugin) continue;

    const item = {
      name: repo.name,
      fullName: full,
      owner: repo.owner.login,
      url: repo.html_url,
      homepage: repo.homepage || '',
      repository: repo.html_url,
      description: repo.description || '',
      keywords: repo.topics || [],
      stars: repo.stargazers_count || 0,
      language: repo.language || '',
      updatedAt: repo.updated_at,
      score: 0,
      category: pickCategory(repo.topics || [], repo.name),
      installSource: detected.npmName ? 'npm' : 'github',
      source: 'github',
      install: detected.npmName
        ? `dsh plugin --profile web add ${detected.npmName}`
        : `dsh plugin --profile web add github:${repo.owner.login}/${repo.name}`,
      zh: '',
      needsTranslation: false,
      _npmName: detected.npmName || undefined,
    };
    ghByFull.set(full, item);
    if (detected.npmName) ghByNpm.set(detected.npmName, item);
    console.log(`  + [gh] ${full}  [${item.category}]  ${item.install}`);
  }

  // 2) npm 源
  let npmPkgs = [];
  try {
    npmPkgs = await fetchNpmPlugins();
    console.log(`[npm] 共 ${npmPkgs.length} 个候选包`);
  } catch (e) {
    console.warn(`[npm] 抓取失败 ${e.message}，跳过 npm 源`);
  }

  const items = [...ghByFull.values()];
  for (const p of npmPkgs) {
    if (isExcluded(p.name)) {
      console.log(`  - 跳过(npm 排除): ${p.name}`);
      continue;
    }
    const repoKey = npmRepoKey(p);
    // 与 GitHub 已抓到的仓库去重：同仓库则合并（用 npm 安装命令，保留 stars）
    if (repoKey && ghByFull.has(repoKey)) {
      const g = ghByFull.get(repoKey);
      g.install = `dsh plugin --profile web add ${p.name}`;
      g.installSource = 'npm';
      g.source = 'github+npm';
      g.homepage = g.homepage || p.homepage || '';
      g.keywords = Array.from(new Set([...(g.keywords || []), ...p.keywords]));
      g.category = pickCategory(g.keywords, g.name);
      g.score = Math.max(g.score || 0, p.score || 0);
      g.version = p.version || g.version || '';
      continue;
    }
    // 独立 npm 插件
    const item = {
      name: p.name,
      fullName: p.name, // npm 包名作为 id（策展 patch 也用此键）
      owner: p.name.startsWith('@') ? p.name.split('/')[0].slice(1) : 'npm',
      url: p.npmUrl,
      homepage: p.homepage || '',
      repository: p.repository || '',
      description: p.description || '',
      keywords: p.keywords,
      stars: 0,
      language: '',
      updatedAt: p.updatedAt,
      score: p.score || 0,
      category: pickCategory(p.keywords, p.name),
      installSource: 'npm',
      source: 'npm',
      install: `dsh plugin --profile web add ${p.name}`,
      zh: '',
      needsTranslation: false,
      _npmName: p.name,
    };
    items.push(item);
    console.log(`  + [npm] ${p.name}  [${item.category}]  ${item.install}`);
  }

  // 3) 合并人工策展 patch（永不被覆盖）；缺失中文的收集起来待翻译
  const needZh = [];
  for (const item of items) {
    const patch = overrides.patch?.[item.fullName];
    if (patch) Object.assign(item, patch);
    if (!item.zh && item.description) needZh.push(item);
  }

  // 4) Agnes 自动翻译（按热度优先，限量）
  if (AGNES_KEY && needZh.length) {
    needZh.sort((a, b) => (b.stars || b.score * 1e5) - (a.stars || a.score * 1e5));
    const n = Math.min(needZh.length, MAX_TRANSLATE);
    console.log(`[agnes] 翻译 ${n} / ${needZh.length} 个缺中文插件...`);
    for (let i = 0; i < n; i++) {
      const zh = await translateToZh(needZh[i].description);
      if (zh) {
        needZh[i].zh = zh;
        needZh[i].needsTranslation = false;
      } else {
        needZh[i].needsTranslation = true;
      }
    }
  }

  // 5) 输出：按热度排序（GitHub stars 优先，npm 用 score 折算）
  const popularity = (it) => (it.stars > 0 ? it.stars : Math.round((it.score || 0) * 1e5));
  items.sort((a, b) => popularity(b) - popularity(a));
  items.forEach((it) => delete it._npmName);

  await mkdir(PUBLIC_DIR, { recursive: true });
  await writeFile(
    OUT_FILE,
    JSON.stringify(
      { generatedAt: new Date().toISOString(), count: items.length, plugins: items },
      null,
      2
    ),
    'utf8'
  );
  const bySrc = items.reduce((m, it) => ((m[it.source] = (m[it.source] || 0) + 1), m), {});
  console.log(
    `\n[done] 已写入 ${items.length} 个插件（来源: ${JSON.stringify(bySrc)}） -> ${OUT_FILE}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

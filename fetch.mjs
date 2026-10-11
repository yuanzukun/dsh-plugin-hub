// fetch.mjs v2.0 — hub 网页数据构建（统一管线，2026-10-11）
//
// 架构变更（v1 双管线 → v2 单管线）：
//   v1 的 fetch.mjs 自建一条「GitHub topic + npm search」抓取管线，与
//   scripts/fetch-cards-snapshot.mjs 并行维护 → 三类漂移（2026-10-11 审计）：
//     ① npm 翻页硬编码 from≤2750（生态实际 6924 包，尾段静默丢失），1.4.1 深分页修复未同步过来；
//     ② GitHub 源只取单页 Top100（snapshot 侧已分桶收割全量 1.3 万仓）；
//     ③ 无 dsh.bundle 硬门禁 → 网页展示的安装命令可能装不上。
//   v2 改为**消费快照**：cards-snapshot.json（市场口径：官方 topic 内 + 通过硬门禁 + 一仓一卡）
//   是唯一数据源，本脚本只做「展示层富化」：分类 + 中文简介 + 策展合并 + 排序输出。
//
//   收益：抓取/限流/重试/增量逻辑只维护一份；网页与市场口径天然一致；
//   中文简介直接继承快照的 description_zh（translate-snapshot 已集中翻译），
//   仅对快照未覆盖的描述才调 Agnes 兜底，且译文回写 tx-cache.json 持久化（v1 每天白烧配额）。
//
// 用法（在 fetch-cards-snapshot.mjs 与 translate-snapshot.mjs 之后执行）：
//   node fetch.mjs                     # 常规构建
//   MAX_TRANSLATE=200 node fetch.mjs   # 本次最多 Agnes 兜底翻译多少条缺中文的插件
//
// 兜底链（zh 字段）：overrides.patch.zh（人工策展，最高优先）
//   → 快照 description_zh（CI 集中翻译，零成本）
//   → data/tx-cache.json 命中（与 translate-snapshot 共享缓存，零成本）
//   → Agnes 实时翻译（受 MAX_TRANSLATE 限量，译文回写 tx-cache）
//   → ''（前端显示英文原文）

import { writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(ROOT, 'public');
const DATA_DIR = join(ROOT, 'data');
const SNAPSHOT_FILE = join(PUBLIC_DIR, 'cards-snapshot.json');
const OUT_FILE = join(PUBLIC_DIR, 'plugins.json');
const OVERRIDE_FILE = join(DATA_DIR, 'overrides.json');
const TX_CACHE_FILE = join(DATA_DIR, 'tx-cache.json');
const TX_CACHE_VERSION = 1;

const MAX_TRANSLATE = Number(process.env.MAX_TRANSLATE || 120);
const FETCH_TIMEOUT = 20000;

// ---- 分类映射（与 v1 一致：按 topics + 包名 token 精确命中，第一个命中生效）----
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

function pickCategory(topics = [], name = '') {
  const tokens = new Set([
    ...topics.map((t) => String(t).toLowerCase()),
    ...String(name).toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean),
  ]);
  for (const rule of CATEGORY_RULES) {
    if (rule.kw.some((k) => tokens.has(k))) return rule.cat;
  }
  return '其他';
}

// 分类兜底：topics/包名未命中时再按描述分词匹配一次（改善「其他」堆积 ——
// 快照侧 GitHub topics 覆盖稀疏，大量插件只有描述里有 mcp/memory/terminal 等信号）
function pickCategoryWithDesc(topics = [], name = '', description = '') {
  const cat = pickCategory(topics, name);
  if (cat !== '其他') return cat;
  return pickCategory([], String(description || '').toLowerCase());
}

// ---- 占位描述判定（与 translate-snapshot.mjs isPlaceholderDesc 同构）----
// 非自然语言（包名变体/topic token 清单）不值得调 LLM，直接跳过
function isPlaceholderDesc(d, name) {
  if (!d || /[\u4e00-\u9fff]/.test(d)) return false;
  const t = String(d).trim();
  if (t === name || t === String(name || '').replace(/^dsh-/, '')) return true;
  if (/^dsh(-[\w-]+)*[.\s]*$/.test(t)) return true;
  const tokens = t.split(/[,;/|]+|\s+/);
  let tokenish = 0;
  for (const raw0 of tokens) {
    const tk = raw0.replace(/^[.\s]+|[.\s]+$/g, '');
    if (!tk) continue;
    if (/^[a-z0-9]+([.\-_][a-z0-9]+)*$/.test(tk)) tokenish++;
    else return false;
  }
  return tokenish >= 2;
}

const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

async function loadJSON(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function readAgnesKey() {
  if (process.env.AGNES_KEY) return String(process.env.AGNES_KEY).trim();
  try {
    return (await readFile(join(homedir(), '.workbuddy', 'agnes_api_key.txt'), 'utf8')).trim();
  } catch {
    return '';
  }
}

// ---- Agnes 兜底翻译（仅 tx-cache 未命中时；译文回写缓存持久化）----
async function translateToZh(text) {
  if (!text || !AGNES_KEY) return null;
  try {
    const res = await fetch('https://api.agnes-ai.cn/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AGNES_KEY}` },
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
      body: JSON.stringify({
        model: 'agnes-2.0-flash',
        temperature: 0.3,
        max_tokens: 300,
        messages: [
          {
            role: 'system',
            content:
              '你是 DeepSeek Harness 插件目录的中文编辑。把用户给的英文/多语插件描述翻译成简洁准确的中文简介（不超过 120 字），保留专有名词(DSH/cordis/工具名)。只输出中文，不要解释、不要引号。',
          },
          { role: 'user', content: text.slice(0, 500) },
        ],
      }),
    });
    const j = await res.json();
    const zh = j.choices?.[0]?.message?.content?.trim();
    if (zh && hasCJK(zh) && zh.length <= 600) return zh;
    return null;
  } catch {
    return null;
  }
}

let AGNES_KEY = '';
let txCache = {}; // sha1(desc) -> zh（与 translate-snapshot.mjs 共享）

async function main() {
  AGNES_KEY = await readAgnesKey();

  // 0) 快照（唯一数据源，必须先构建好）
  const snap = await loadJSON(SNAPSHOT_FILE, null);
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) {
    console.error('fetch: public/cards-snapshot.json 不存在或为空。');
    console.error('  请先执行: node scripts/fetch-cards-snapshot.mjs（CI 中该步骤已排在本脚本之前）');
    process.exit(1);
  }
  console.log(`[snapshot] 载入 ${snap.items.length} 条（市场口径，builtAt ${new Date(snap.builtAt).toISOString()}）`);

  // 0.1) tx-cache（跨构建翻译缓存）
  const cacheRaw = await loadJSON(TX_CACHE_FILE, null);
  txCache = cacheRaw && cacheRaw.v === TX_CACHE_VERSION && cacheRaw.tx ? cacheRaw.tx : {};
  const txCacheSize0 = Object.keys(txCache).length;

  // 0.2) overrides 人工策展
  const overrides = (await loadJSON(OVERRIDE_FILE, null)) || { forceExclude: [], forceInclude: [], patch: {} };
  const isExcluded = (id) => (overrides.forceExclude || []).some((x) => x === id);

  // 1) 快照 → hub 条目（防御性去重：同 full_name 只保留一张卡，npm 包卡优先 ——
  //    兜底旧快照尚存的裸卡并存问题；1.4.2 之后快照自身已收口，此处幂等）
  const byKey = new Map(); // full_name -> item（npm 卡优先）
  for (const it of snap.items) {
    if (!it.full_name) continue; // npm 独立包不在市场口径内（快照已过滤，防御）
    if (isExcluded(it.full_name) || isExcluded(it.npm)) continue;
    const prev = byKey.get(it.full_name);
    if (prev && prev.npm) continue; // 已有 npm 包卡，后者（裸卡）让位
    byKey.set(it.full_name, it);
  }
  console.log(`[dedup] ${snap.items.length} → ${byKey.size} 个仓库（快照未收口时此处兜底）`);

  // 2) 富化：分类 / 中文 / 安装命令
  const needTranslate = []; // {item, desc}
  const plugins = [];
  for (const it of byKey.values()) {
    const patch =
      overrides.patch?.[it.full_name] ||
      (it.npm ? overrides.patch?.[it.npm] : undefined) ||
      {};
    const description = it.description || '';
    const category = patch.category || pickCategoryWithDesc(it.topics || [], it.name, description);

    // zh 兜底链：patch → 快照 description_zh → tx-cache → Agnes
    let zh = patch.zh || it.description_zh || '';
    const desc = String(description).trim();
    if (!zh && desc && !hasCJK(desc) && !isPlaceholderDesc(desc, it.name)) {
      const hit = txCache[sha1(desc)];
      if (hit) zh = hit;
      else needTranslate.push({ desc });
    }
    if (hasCJK(desc) && !zh) zh = desc; // 原文即中文

    // 字段名与前端 app.js 对齐：topics（app.js 按 p.topics 搜索 —— v1 误写 keywords 导致标签搜索从未生效）
    // 输出精简为前端实际消费的字段（紧凑序列化，控制 plugins.json 体积）
    plugins.push({
      name: it.name,
      fullName: it.full_name,
      url: `https://github.com/${it.full_name}`,
      npm: it.npm || '',
      version: it.version || '',
      description,
      zh,
      topics: it.topics || [],
      stars: it.stargazers_count || 0,
      updatedAt: it.updated_at || '',
      category,
      installSource: it.npm ? 'npm' : 'github',
      install: it.npm
        ? `dsh plugin --profile web add ${it.npm}`
        : `dsh plugin --profile web add github:${it.full_name}`,
    });
  }

  // 3) Agnes 兜底翻译（限量，按热度优先），译文回写 tx-cache 持久化
  if (needTranslate.length) {
    // 按热度排序：plugins 已按 stars 排好序，用 desc→plugin 首次出现位置近似热度
    const descOrder = new Map();
    plugins.forEach((p) => {
      const d = String(p.description || '').trim();
      if (d && !descOrder.has(d)) descOrder.set(d, p);
    });
    needTranslate.sort((a, b) => (descOrder.get(b.desc)?.stars || 0) - (descOrder.get(a.desc)?.stars || 0));

    const n = Math.min(needTranslate.length, MAX_TRANSLATE);
    console.log(
      AGNES_KEY
        ? `[agnes] 兜底翻译 ${n} / ${needTranslate.length} 条（Key 已载入，上限 ${MAX_TRANSLATE}/次）`
        : `[agnes] 未找到 Key，跳过 ${needTranslate.length} 条兜底翻译（英文原样展示）`
    );
    let ok = 0;
    for (let i = 0; i < n && AGNES_KEY; i++) {
      const { desc } = needTranslate[i];
      const zh = await translateToZh(desc);
      if (zh) {
        ok++;
        txCache[sha1(desc)] = zh;
        const p = descOrder.get(desc);
        if (p) p.zh = zh;
      }
    }
    if (ok) {
      await writeFile(
        TX_CACHE_FILE,
        JSON.stringify({ v: TX_CACHE_VERSION, tx: txCache })
      ).catch(() => {});
      console.log(`[agnes] 新译 ${ok} 条已回写 tx-cache（${txCacheSize0} → ${Object.keys(txCache).length}）`);
    }
  }

  // 4) 排序 + 输出
  plugins.sort(
    (a, b) => b.stars - a.stars || new Date(b.updatedAt) - new Date(a.updatedAt) || a.name.localeCompare(b.name)
  );
  const byCat = plugins.reduce((m, p) => ((m[p.category] = (m[p.category] || 0) + 1), m), {});
  const zhCount = plugins.filter((p) => p.zh).length;
  await writeFile(
    OUT_FILE,
    JSON.stringify({ generatedAt: new Date().toISOString(), count: plugins.length, plugins }),
    'utf8'
  );
  console.log(
    `\n[done] plugins.json：${plugins.length} 条（中文 ${zhCount}，分类 ${JSON.stringify(byCat)}）→ ${OUT_FILE}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

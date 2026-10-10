// fetch-cards-snapshot.mjs — 为 dsh-plugin-cards 构建全量快照（schema v3，双源发现 + 分层合规快筛）。
//
// 数据口径（1.2.0，按官方要求出发）：
//   官方无插件注册表；「符合官方要求可安装」的唯一权威标准是宿主 app-boot 硬门禁：
//   package.json 必须声明 dsh.bundle（缺失拒绝安装）+ semver version + dsh.engine 兼容。
//   发现层双源：
//     源 A（主力）: npm keywords:dsh-plugin —— 天然带版本号、天然可安装包形态（6091+）
//     源 B:        GitHub topic:dsh-plugin（质量口径 ★>=0 + 12mo + dsh kw）—— git 安装通道 + stars/topics
//                  1.1.0：★>=3 → ★>=0（用户决策 2026-09-30：目录须完整覆盖官方 topic 页，不按星数筛）。
//   快筛：npm 包读 registry <pkg>/latest 的完整 manifest（含自定义 dsh 字段）；git 仓库读 raw package.json。
//   1.2.0 分层合规（L2 引擎兼容 + L3 展示合规，官方规则口径）：
//     engineCompat: dsh.engine 与桌面端运行时（HOST_ENGINE_VERSION）semver 相交判定
//                   （1=兼容 / 0=不兼容 / null=未声明或解析失败，客户端只过滤 0）；
//     metaScore:    0.2.0 展示规范三件套计分（icon / exports ./locale/* / exports ./package.json，0-3），
//                   仅参与排序权重，不做过滤；
//     探针缓存 schema v2（新增 engine/engineCompat/metaScore 字段），旧缓存条目自动重探。
//   归并校验（1.1.0）：npm 条目仅当 repository 指向「源 B 收割到的 topic 仓库」才合并富化
//   （stars/topics/updated_at，source=both）；指向宿主本体仓（HOST_REPOS）的一律视为无仓库
//   （不借官方主仓星数冒充出品）。source=npm 的条目 = 不在官方 topic 页，由客户端默认视图隐藏。
//   1.3.0 市场口径（用户决策 2026-10-11）：快照只收录「官方 topic:dsh-plugin 内、通过官方硬门禁」的仓库
//   —— 产出前剔除 npm 独立条目（source=npm）、未声明 dsh.bundle（installable=false）、
//   探测失败（null，下轮重建补回）与引擎不兼容（engineCompat=0）。快照 = 市场内容，口径在数据源侧收口。
//
// 产出 public/cards-snapshot.json：
//   { version:3, builtAt, quality:true, total,
//     items:[{ full_name, npm, name, version, installable, source, stargazers_count, updated_at, description, topics,
//              engine, engineCompat, metaScore }] }
//   installable: true（声明 dsh.bundle）/ false（未声明）/ null（探测失败，客户端按未校验显示）
//
// 用法：
//   node scripts/fetch-cards-snapshot.mjs                # 全量构建（双源 + 快筛，约 12 分钟）
//   GITHUB_TOKEN=xxx node …                              # 提 GitHub 限额
//   node scripts/fetch-cards-snapshot.mjs --skip-probe   # 跳过快筛（快速刷新列表）
//   node scripts/fetch-cards-snapshot.mjs --from-json d.json  # 从 GitHub 源 dump 离线重建（跳过在线收割）
//
// ⚠️ GitHub Search API 硬约束（实测）：单查询最多前 1000 条（第 11 页起 422）→ 分桶；
//    同类型限定符后者覆盖前者 → 星数/时间必须合并单区间。
//    快筛断点续跑：data/probe-cache.json（7 天有效），重跑只补缺。

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';
import { satisfies, validRange } from 'semver';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const OUT = join(ROOT, 'public', 'cards-snapshot.json');
const PROBE_CACHE = join(ROOT, 'data', 'probe-cache.json');
const PROBE_TTL_MS = 7 * 24 * 3600 * 1000;
// 1.2.0 引擎兼容判定的宿主基准版本（与 DSH Desktop 运行时 desktopVersion 对齐，发版时同步更新）
const HOST_ENGINE_VERSION = '0.2.0-rc.2';

const TOKEN = process.env.GITHUB_TOKEN || '';
const GH_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-plugin-hub-snapshot' };
if (TOKEN) GH_HEADERS.Authorization = 'Bearer ' + TOKEN;
const PAGE_MS = TOKEN ? 2200 : 7000;
const PROBE_CONC = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normTopics = (kw) => (Array.isArray(kw) ? kw : []).map((k) => String(k).toLowerCase()).filter(Boolean).slice(0, 20);
const ghFromUrl = (u) => {
  const m = /github\.com[/:]([^/]+)\/([^/#?.]+)/i.exec(String(u || ''));
  return m ? m[1] + '/' + m[2].replace(/\.git$/, '') : '';
};

// ---- 源 A：npm keywords:dsh-plugin ----
// CI 数据中心 IP 会被 npm registry search 限流（429）：退避重试 + 连续失败切 npmmirror 镜像
let NPM_HOST_IDX = 0; // 跨页保持：一旦切换镜像，后续分页沿用
const NPM_HOSTS = ['registry.npmjs.org', 'registry.npmmirror.com'];
async function searchPage(from, SIZE) {
  for (let attempt = 1; ; attempt++) {
    const host = NPM_HOSTS[NPM_HOST_IDX];
    let r;
    try {
      r = await fetch(`https://${host}/-/v1/search?text=keywords:dsh-plugin&size=${SIZE}&from=${from}`,
        { signal: AbortSignal.timeout(20000) });
    } catch (e) { // 超时/网络错误也走退避
      if (attempt >= 6) throw e;
      console.log(`npm search ${e.name}（from=${from}）第 ${attempt} 次重试，5s 后`);
      await sleep(5000);
      continue;
    }
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) {
      if (attempt >= 6) throw new Error('npm search HTTP ' + r.status + '（重试耗尽）');
      const retryAfter = Number(r.headers.get('retry-after')) || 0;
      const waitMs = Math.min((retryAfter || Math.pow(2, attempt) * 3) * 1000, 90000);
      console.log(`npm search HTTP ${r.status}（from=${from}，host=${host}）${Math.round(waitMs / 1000)}s 后第 ${attempt} 次重试`);
      if (attempt >= 3 && NPM_HOST_IDX === 0) {
        NPM_HOST_IDX = 1;
        console.log('→ 连续 429/5xx，切换 npmmirror 镜像继续');
      }
      await sleep(waitMs);
      continue;
    }
    throw new Error('npm search HTTP ' + r.status);
  }
}
async function fetchNpm() {
  const out = new Map();
  const SIZE = 250;
  for (let from = 0; ; from += SIZE) {
    const d = await searchPage(from, SIZE);
    const objs = d.objects || [];
    for (const o of objs) {
      const p = o.package || {};
      if (!p.name) continue;
      out.set(p.name, {
        npm: p.name,
        name: p.name,
        version: p.version || '',
        description: (p.description || '').slice(0, 500),
        topics: normTopics(p.keywords),
        updated_at: p.date || '',
        full_name: ghFromUrl(p.links && p.links.repository),
        stargazers_count: 0,
        source: 'npm',
      });
    }
    console.log(`npm search: +${objs.length} cum=${out.size} (total=${d.total})`);
    if (from + SIZE >= (d.total || 0) || objs.length === 0) break;
    await sleep(800);
  }
  return out;
}

// ---- 源 A+：种子补录（绕过 search 索引延迟与 GitHub 质量门槛）----
// 两个已知漏录场景（2026-09-26 实测 dsh-plugin-cards@0.8.9 双源全漏）：
//   ① npm search 索引对新发布包有数小时~数天延迟（发布 19 分钟后 search 端点 0 命中）；
//   ② GitHub 源 B 有 12mo 更新门槛 + 需 repo 自行打 topic。
// 种子清单按包名直拉 npmmirror /latest manifest（无索引延迟、国内可达、CORS ✓），必进快照。
const SEED_PACKAGES = [
  'dsh-plugin-cards', // 社区目录/安装卡片插件本体
  'dsh-plugin',       // 插件管理器
];
async function fetchSeeds() {
  const out = new Map();
  for (const name of SEED_PACKAGES) {
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(name)}`, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const m = await r.json();
        if (!m.name) throw new Error('manifest 无包名');
        // 0.9.1：改拉完整 packument（/latest 无 time 字段）→ time[latest] = 最新版发布时间，
        // seed-only 条目（GitHub 侧被 ★>=3 门槛滤掉）也能带上卡片「更新于」时间。
        const latestTag = m['dist-tags'] && m['dist-tags'].latest;
        out.set(m.name, {
          npm: m.name,
          name: m.name,
          version: latestTag || m.version || '',
          description: (m.description || '').slice(0, 500),
          topics: normTopics(m.keywords),
          updated_at: (m.time && latestTag && m.time[latestTag]) || '',
          full_name: ghFromUrl(m.repository && (typeof m.repository === 'string' ? m.repository : m.repository.url)),
          stargazers_count: 0,
          source: 'npm',
        });
        console.log(`seed: +${m.name}@${m.version}`);
        break;
      } catch (e) {
        if (attempt >= 3) { console.log(`seed: ${name} 拉取失败（${e.message}），跳过`); break; }
        await sleep(3000);
      }
    }
  }
  return out;
}

// ---- 源 B：GitHub topic:dsh-plugin 分桶收割 ----
const CREATED_BASE = '2015-01-01'; // created 二分的宇宙下界（DSH 生态不存在更早仓库，f(下界)=桶全量）
function searchUrl(bucket, page) {
  const pushedAfter = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const lo = bucket.smin ?? 0; // 1.1.0：★>=0 = 不限星数（lo 为 0 时不发 stars 限定符）
  const hi = bucket.smax ?? null;
  let q = 'topic:dsh-plugin';
  if (lo !== null && lo > 0 && hi !== null) q += ` stars:${lo}..${hi}`;
  else if (lo !== null && lo > 0) q += ` stars:>=${lo}`;
  else if (hi !== null) q += ` stars:<=${hi}`;
  // ⚠️ 同类型限定符后者覆盖前者（实测）→ 基础 pushedAfter 与分桶 pushed 必须合并成单一区间
  const pmin = [pushedAfter, bucket.pmin].filter(Boolean).sort().pop(); // 取更晚（更严格）下界
  const pmax = bucket.pmax ?? null;
  if (pmin && pmax) q += ` pushed:${pmin}..${pmax}`;
  else if (pmin) q += ` pushed:>=${pmin}`;
  else if (pmax) q += ` pushed:<${pmax}`;
  // created 区间（0.9.18-hub）：pushed 天粒度不可拆时的替代切分维度（与 pushed 属不同限定符类型，可共存取交集）
  if (bucket.cmin && bucket.cmax) q += ` created:${bucket.cmin}..${bucket.cmax}`;
  else if (bucket.cmin) q += ` created:>=${bucket.cmin}`;
  else if (bucket.cmax) q += ` created:<${bucket.cmax}`;
  q += ' dsh in:name,description,topics';
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`;
}

async function ghApi(url, attempt = 0) {
  const r = await fetch(url, { headers: GH_HEADERS });
  if (r.status === 403 || r.status === 429) {
    if (attempt >= 2) return null;
    console.log(`  ${r.status} 退避 65s…`);
    await sleep(65000);
    return ghApi(url, attempt + 1);
  }
  if (!r.ok) return null;
  return r.json();
}

/** 通用日期维度二分找「中位切点」（0.9.18-hub：由 findPushedSplit 泛化，支持 pushed/created 两维度）：
 *  f(x)=count(field:>=x) 单调递减，找 f(x)≈total/2 的 x。bucket() 对两半递归（每层严格划分、
 *  计数严格变小）→ 任何总量 log 级收敛到每片 ≤1000。
 *  ⚠️ 不能要求单切点两侧都 ≤1000：total>2000 时 f(x)∈[total-1000,1000] 为空集 —— 这正是
 *  2026-10-10 审计发现的 0 星截断根因（旧固定候选 [7,30,90,180] 天同理必失败，0 星桶 8375 条只收到 3063）。
 *  ⚠️ pushed 有第二类失败（2026-10-10 深夜实测）：0★/1★ 新仓潮 1.2 万条 pushed 全压在最近 1-2 天
 *  → f(x) 只会等于 total（窗内）或 0（窗外），天粒度无切点 → f(hi)=0 → 必然返回 null。
 *  此时应降级 created 维度（新仓 created 分散在 8-10 月，可拆）。
 *  返回 null 仅当天粒度仍拆不开（单日堆积）或探测异常。 */
async function findDateSplit(b, total, field) {
  const DAY = 864e5;
  const pre = field === 'pushed' ? 'p' : 'c'; // 桶键前缀：pushed→pmin/pmax，created→cmin/cmax
  let lo, hi; // 不变量：f(lo) ≥ total/2（过老侧），f(hi) ≤ total/2（过新侧）
  if (field === 'pushed') {
    lo = b.pmin ? Date.parse(b.pmin) : Date.now() - 365 * DAY;
    hi = b.pmax ? Date.parse(b.pmax) : Date.now() + DAY;
  } else {
    lo = b.cmin ? Date.parse(b.cmin) : Date.parse(CREATED_BASE);
    hi = b.cmax ? Date.parse(b.cmax) : Date.now() + DAY;
  }
  for (let i = 0; i < 14 && hi - lo > 36 * 3600 * 1000; i++) {
    await sleep(PAGE_MS); // 二分探测与翻页同限额，逐发节流（此前背靠背易触发 403）
    const mid = new Date((lo + hi) / 2).toISOString().slice(0, 10);
    const d = await ghApi(searchUrl({ ...b, [pre + 'min']: mid }, 1)); // 同星数/另一日期约束随 b 保留
    const n = d ? d.total_count : -1;
    if (n < 0) return null;
    if (n > total / 2) lo = Date.parse(mid);
    else hi = Date.parse(mid);
  }
  // hi 处 f(hi) ≤ total/2 且 f(lo) > total/2：新侧 = f(hi)，老侧 = total − f(hi)。
  // 两侧都必须非空（防同日堆积退化为 0/total 切分 → 子桶与父桶同量级递归空转）
  await sleep(PAGE_MS);
  const probe = await ghApi(searchUrl({ ...b, [pre + 'min']: new Date(hi).toISOString().slice(0, 10) }, 1));
  const fh = probe ? probe.total_count : -1;
  if (fh > 0 && fh < total) return new Date(hi).toISOString().slice(0, 10);
  return null;
}

async function harvestGithub() {
  const seen = new Map();
  const absorb = (list) => {
    for (const it of list || []) {
      if (!it || it.fork || it.archived || seen.has(it.full_name)) continue;
      seen.set(it.full_name, it);
    }
  };
  async function bucket(b, depth) {
    const first = await ghApi(searchUrl(b, 1));
    if (!first) { console.log(`  bucket 跳过: ${JSON.stringify(b)}`); return; }
    const total = first.total_count || 0;
    const list1 = first.items || [];
    absorb(list1);
    console.log(`bucket ${JSON.stringify(b)} total=${total} cum=${seen.size} depth=${depth}`);
    if (total === 0) return;
    const pages = Math.min(Math.ceil(total / 100), 10);
    for (let p = 2; p <= pages; p++) {
      await sleep(PAGE_MS);
      const d = await ghApi(searchUrl(b, p));
      if (!d) break;
      absorb(d.items || []);
      console.log(`  page ${p}/${pages} cum=${seen.size}`);
    }
    if (total <= 1000 || pages < 10) return;
    if (depth >= 32) { console.log('  深度护栏'); return; } // 星链 + 日期二分叠加，8 层不够（0 星二分独占 ~9 层）
    await sleep(PAGE_MS);
    const last = await ghApi(searchUrl(b, 10));
    const items10 = last ? last.items || [] : [];
    const s = items10.length ? items10[items10.length - 1].stargazers_count : 0;
    const lo = b.smin ?? 0;
    if (s > lo) {
      await bucket({ ...b, smax: s - 1 }, depth + 1);
      await sleep(PAGE_MS);
      await bucket({ ...b, smin: s }, depth + 1);
    } else {
      // 同星数大量堆积（0 星桶实测 8375+ 条）→ 日期维度二分。
      // 0.9.18-hub：先探测 pushed 是否退化（0★/1★ 新仓潮实测 f(≥now-2d)=total → 天粒度无切点，
      // 白烧 ~14 发探测），退化直接走 created；未退化则 pushed 优先、created 兜底。
      let dim = null, split = null;
      await sleep(PAGE_MS);
      const tailProbe = await ghApi(searchUrl({ ...b, pmin: new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10) }, 1));
      const tailN = tailProbe ? tailProbe.total_count : -1;
      if (tailN >= total) {
        dim = 'created';
        split = await findDateSplit(b, total, 'created');
      } else {
        split = await findDateSplit(b, total, 'pushed');
        if (split) dim = 'pushed';
        else {
          dim = 'created';
          split = await findDateSplit(b, total, 'created');
        }
      }
      if (!split) { console.log('  pushed/created 二分均失败（天粒度堆积超限或探测异常），保留已抓部分'); return }
      console.log(`  ${dim} 二分 @${split}`);
      await bucket({ ...b, [dim === 'pushed' ? 'pmax' : 'cmax']: split }, depth + 1);
      await sleep(PAGE_MS);
      await bucket({ ...b, [dim === 'pushed' ? 'pmin' : 'cmin']: split }, depth + 1);
    }
  }
  await bucket({}, 0);
  const out = new Map();
  for (const it of seen.values()) {
    out.set(it.full_name, {
      full_name: it.full_name,
      npm: '',
      name: it.name,
      version: '',
      installable: null,
      stargazers_count: it.stargazers_count || 0,
      updated_at: it.updated_at || '',
      description: (it.description || '').slice(0, 500),
      topics: normTopics(it.topics),
      source: 'github',
    });
  }
  return out;
}

// ---- 合并双源（github full_name ↔ npm links.repository 关联）----
// 0.9.0 修复（2026-09-26 实测）：monorepo 子包（如 @szx-a/dsh-layered-memory-architecture，
// repository 指向 deepseek-ai/deepseek-harness）按 URL 归并时 N:1 被当 1:1，后者覆盖前者 →
// 官方主仓条目 npm 字段被最后一个子包污染。改为：每个 npm 包独立成条（可装单元），
// GitHub 仓库信息（stars/topics/updated_at）作富化；仓库无 npm 包时保留 git-only 条目。
/** 宿主本体仓库：不是插件，不作为目录条目（其 npm 子包仍经源 A 入列并富化仓库信息） */
const HOST_REPOS = new Set(['deepseek-ai/deepseek-harness']);
/** 排序：可装优先（installable false 沉底），同级按 stars —— 用户第一屏都是能装的 */
const sortItems = (items) => {
  const rank = (x) => (x.installable === false ? 1 : 0);
  return items.sort((a, b) => rank(a) - rank(b) || b.stargazers_count - a.stargazers_count);
};
function merge(npmMap, ghMap) {
  const merged = new Map();
  for (const [fn, g] of ghMap) {
    if (HOST_REPOS.has(fn.toLowerCase())) continue; // 宿主本体不作为插件条目
    merged.set('gh:' + fn, g);
  }
  for (const [pn, n] of npmMap) {
    // 0.9.1 修复：ghMap 的 key 是裸 full_name（harvestGithub/--from-json 均无 'gh:' 前缀），
    // 上一版误查 'gh:' + full_name 导致归并永远 miss（914 条 both 将分裂、npm 条目 stars/topics 降级）。
    // 1.1.0 校验收紧：仅当 repository 指向源 B（topic 收割）里的「非宿主本体」仓库才归并富化；
    // 指向宿主本体仓（如 monorepo 子包/误填 repository 的包）一律视为无 GitHub 仓库：
    // 清空 full_name、不借官方主仓星数（防「借 237k★ 置顶冒充官方出品」），source 保持 npm
    //（不在官方 topic 页 → 客户端默认视图隐藏）。
    const pointsToHost = n.full_name && HOST_REPOS.has(n.full_name.toLowerCase());
    const g = n.full_name && !pointsToHost ? ghMap.get(n.full_name) : null;
    if (g) {
      // 每包一条目，仓库信息富化（不删除、不覆盖其他包的条目）
      merged.set('npm:' + pn, {
        ...n,
        stargazers_count: g.stargazers_count || 0,
        topics: g.topics.length ? g.topics : n.topics,
        updated_at: [g.updated_at, n.updated_at].sort().pop() || '',
        source: 'both',
      });
    } else if (pointsToHost) {
      merged.set('npm:' + pn, { ...n, full_name: '', stargazers_count: 0, source: 'npm' });
    } else {
      merged.set('npm:' + pn, { ...n });
    }
  }
  return merged;
}

// ---- 快筛：dsh.bundle 声明 + version + 分层合规字段（带 7 天断点缓存，schema v2）----
// 1.2.0：从 manifest 提取 L2 引擎兼容（dsh.engine vs HOST_ENGINE_VERSION，semver includePrerelease）
// 与 L3 展示合规三件套（icon / exports ./locale/* / exports ./package.json）。缓存条目缺 v:2 视为过期重探。
function manifestCompliance(m) {
  const dsh = m && m.dsh ? m.dsh : null;
  const engine = dsh && typeof dsh.engine === 'string' ? dsh.engine.trim() : '';
  let engineCompat = null;
  if (engine) {
    // 1.2.1 修复：官方惯例 engine 写作 "dsh >=x.y.z"，须剥掉 "dsh" 前缀再判；
    // 且 semver.satisfies 对非法 range 不抛异常而是返回 false（catch 兜底无效）——必须先 validRange 校验。
    const range = engine.replace(/^dsh\s*/i, '').trim();
    engineCompat = validRange(range, { includePrerelease: true })
      ? (satisfies(HOST_ENGINE_VERSION, range, { includePrerelease: true }) ? 1 : 0)
      : null; // 非法 range 不判不兼容，交给宿主安装时终审
  }
  let metaScore = 0;
  const exp = (m && m.exports) || {};
  const expKeys = Object.keys(exp);
  if (m && m.icon) metaScore++;
  if (expKeys.some((k) => k === './locale/*.json' || k.startsWith('./locale/'))) metaScore++;
  if (exp['./package.json']) metaScore++;
  return { installable: !!(dsh && dsh.bundle), version: (m && m.version) || '', engine, engineCompat, metaScore, ts: Date.now() };
}

async function loadProbeCache() {
  try {
    const c = JSON.parse(await readFile(PROBE_CACHE, 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch { return {}; }
}
async function saveProbeCache(c) {
  await writeFile(PROBE_CACHE, JSON.stringify(c)).catch(() => {});
}

async function probeManifest(item, cache) {
  const keys = [];
  if (item.npm) keys.push('npm:' + item.npm);
  if (item.full_name) keys.push('gh:' + item.full_name);
  for (const k of keys) {
    const hit = cache[k];
    if (hit && hit.v === 2 && Date.now() - hit.ts < PROBE_TTL_MS && hit.installable !== null) return { ...hit, from: k };
  }
  // npm 通道：registry latest manifest 含全部自定义字段
  if (item.npm) {
    try {
      const r = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(item.npm)}/latest`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const m = await r.json();
        const res = { ...manifestCompliance(m), v: 2 };
        cache['npm:' + item.npm] = res;
        return { ...res, from: 'npm:' + item.npm };
      }
    } catch { /* 落到 git 通道 */ }
  }
  // git 通道：raw package.json（HEAD 重定向默认分支）
  if (item.full_name) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const r = await fetch(`https://raw.githubusercontent.com/${item.full_name}/HEAD/package.json`,
          { signal: AbortSignal.timeout(9000) });
        if (r.status === 404) { const res = { installable: false, version: '', engine: '', engineCompat: null, metaScore: 0, ts: Date.now(), v: 2 }; cache['gh:' + item.full_name] = res; return res; }
        if (r.ok) {
          const m = await r.json();
          const res = { ...manifestCompliance(m), v: 2 };
          cache['gh:' + item.full_name] = res;
          return res;
        }
      } catch { await sleep(500); }
    }
  }
  return { installable: null, version: item.version || '', engine: '', engineCompat: null, metaScore: 0, ts: Date.now() };
}

async function probeAll(items) {
  const cache = await loadProbeCache();
  let done = 0, ok = 0, notOk = 0, unknown = 0;
  const queue = items.slice();
  async function worker() {
    for (;;) {
      const it = queue.shift();
      if (!it) return;
      const res = await probeManifest(it, cache);
      it.installable = res.installable;
      if (res.version) it.version = res.version;
      it.engine = res.engine || '';
      it.engineCompat = typeof res.engineCompat === 'number' ? res.engineCompat : null;
      it.metaScore = typeof res.metaScore === 'number' ? res.metaScore : 0;
      done++;
      if (res.installable === true) ok++; else if (res.installable === false) notOk++; else unknown++;
      if (done % 250 === 0) {
        console.log(`probe ${done}/${items.length} ✓=${ok} ✗=${notOk} ?=${unknown}`);
        await saveProbeCache(cache);
      }
    }
  }
  await Promise.all(Array.from({ length: PROBE_CONC }, worker));
  await saveProbeCache(cache);
  console.log(`快筛完成：可装=${ok} 不可装=${notOk} 未定=${unknown}`);
}

// ---- main ----
const args = process.argv.slice(2);
const fromIdx = args.indexOf('--from-json');
let npmMap = new Map();
let ghMap;
if (fromIdx > -1) {
  const arr = JSON.parse(await readFile(resolve(args[fromIdx + 1]), 'utf8'));
  ghMap = new Map();
  for (const it of arr) {
    ghMap.set(it.full_name, {
      full_name: it.full_name, npm: '', name: it.name, version: '',
      installable: null, stargazers_count: it.stargazers_count ?? it.stars ?? 0,
      updated_at: it.updated_at || '', description: (it.description || '').slice(0, 500),
      topics: normTopics(it.topics), source: 'github',
    });
  }
} else {
  ghMap = await harvestGithub();
}
if (!args.includes('--github-only')) {
  npmMap = await fetchNpm();
  // 种子补录：search 已命中的以 search 为准（updated_at 更全），漏录的种子注入
  const seedMap = await fetchSeeds();
  let seeded = 0;
  for (const [k, v] of seedMap) {
    if (npmMap.has(k)) continue;
    npmMap.set(k, v);
    seeded++;
  }
  console.log(`seed 补录: +${seeded}/${SEED_PACKAGES.length}`);
}

const items = [...merge(npmMap, ghMap).values()];
console.log(`合并后 ${items.length} 条（npm ${npmMap.size} / github ${ghMap.size}）`);
const skipProbe = args.includes('--skip-probe');
if (!skipProbe) await probeAll(items);

// 1.3.0 市场口径（用户决策 2026-10-11）：快照只收录「官方 topic:dsh-plugin 内、通过官方硬门禁」的仓库。
//   剔除 source=npm（不在 topic 页的 npm 独立包；npm 源已通过 merge 为 topic 仓库富化版本/可装信息）、
//   installable=false（未声明 dsh.bundle，宿主拒装）、engineCompat=0（引擎不兼容，装上即坏）。
//   installable=null（探测失败）同样剔除，交下一轮每日重建自然补回。
//   --skip-probe（快速刷新）时无快筛数据，只剔 npm 侧、不做可装过滤（产物仅供调试，不发布）。
const nNpmOnly = items.filter((x) => x.source === 'npm').length;
const nNotInst = items.filter((x) => x.source !== 'npm' && x.installable === false).length;
const nUnknown = items.filter((x) => x.source !== 'npm' && x.installable == null).length;
const nIncompat = items.filter((x) => x.source !== 'npm' && x.installable === true && x.engineCompat === 0).length;
const scope = skipProbe
  ? items.filter((x) => x.source !== 'npm')
  : items.filter((x) => x.source !== 'npm' && x.installable === true && x.engineCompat !== 0);
console.log(`市场口径过滤：${items.length} → ${scope.length}（npm 独立 ${nNpmOnly}，未声明 bundle ${nNotInst}，探测失败 ${nUnknown}，引擎不兼容 ${nIncompat}${skipProbe ? '，skip-probe 未做可装过滤' : ''}）`);

// 1.3.1 npm 侧哨兵（方案 C 第 2 层，2026-10-11）：发现「声明了 dsh.bundle 但不在官方 topic 页」的包，仅记录不收录。
//   出路：① 作者补打 topic:dsh-plugin → 下轮自动收录（口径自愈）；② 确认值得收录的走种子白名单（第 3 层，待定）。
const sentinels = items.filter((x) => x.source === 'npm' && x.installable === true);
if (sentinels.length) {
  console.log(`🔍 npm 哨兵：${sentinels.length} 个包声明了 dsh.bundle 但不在官方 topic 页（仅记录，未收录）：`);
  for (const s of sentinels.slice(0, 30)) console.log(`   - ${s.npm}${s.version ? ' v' + s.version : ''} ${String(s.description || '').slice(0, 60)}`);
  if (sentinels.length > 30) console.log(`   … 其余 ${sentinels.length - 30} 个略`);
} else {
  console.log('🔍 npm 哨兵：无盲区（声明 dsh.bundle 的 npm 包均已在官方 topic 页）');
}

sortItems(scope);
const out = { version: 3, builtAt: Date.now(), quality: true, total: scope.length, items: scope };
await writeFile(OUT, JSON.stringify(out));
const compat = scope.filter((x) => x.engineCompat === 1).length;
const undeclared = scope.filter((x) => x.engineCompat !== 1 && x.engineCompat !== 0).length;
const rich = scope.filter((x) => x.metaScore >= 2).length;
console.log(`✅ ${OUT}：${scope.length} 条（全部声明 dsh.bundle）引擎兼容 ${compat} / 未声明 engine ${undeclared}，展示合规 ≥2 分 ${rich} 条，builtAt ${new Date(out.builtAt).toISOString()}`);

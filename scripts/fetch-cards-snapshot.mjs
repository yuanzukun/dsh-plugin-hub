// fetch-cards-snapshot.mjs — 为 dsh-plugin-cards 构建全量快照（schema v2，双源发现 + dsh.bundle 快筛 + 版本号）。
//
// 数据口径（0.6.0，按官方要求出发）：
//   官方无插件注册表；「符合官方要求可安装」的唯一权威标准是宿主 app-boot 硬门禁：
//   package.json 必须声明 dsh.bundle（缺失拒绝安装）+ semver version + dsh.engine 兼容。
//   发现层双源：
//     源 A（主力）: npm keywords:dsh-plugin —— 天然带版本号、天然可安装包形态（6091+）
//     源 B:        GitHub topic:dsh-plugin（质量口径 ★>=3 + 12mo + dsh kw，3055）—— git 安装通道 + stars/topics
//   快筛：npm 包读 registry <pkg>/latest 的完整 manifest（含自定义 dsh 字段）；git 仓库读 raw package.json。
//   真机门禁（dsh-plugin-hub-verify）为终审层，后续接入，本脚本预留 verified 字段。
//
// 产出 public/cards-snapshot.json：
//   { version:2, builtAt, quality:true, total,
//     items:[{ full_name, npm, name, version, installable, source, stargazers_count, updated_at, description, topics }] }
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

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const OUT = join(ROOT, 'public', 'cards-snapshot.json');
const PROBE_CACHE = join(ROOT, 'data', 'probe-cache.json');
const PROBE_TTL_MS = 7 * 24 * 3600 * 1000;

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
//   ② GitHub 源 B 有 ★>=3 + 12mo 质量门槛 + 需 repo 自行打 topic。
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
        const r = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        const m = await r.json();
        if (!m.name) throw new Error('manifest 无包名');
        out.set(m.name, {
          npm: m.name,
          name: m.name,
          version: m.version || '',
          description: (m.description || '').slice(0, 500),
          topics: normTopics(m.keywords),
          updated_at: '', // /latest 无发布时间；merge 时由 GitHub 侧补，或留空
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
function searchUrl(bucket, page) {
  const pushedAfter = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const lo = bucket.smin ?? 3;
  const hi = bucket.smax ?? null;
  let q = 'topic:dsh-plugin';
  if (lo !== null && hi !== null) q += ` stars:${lo}..${hi}`;
  else if (lo !== null) q += ` stars:>=${lo}`;
  else if (hi !== null) q += ` stars:<=${hi}`;
  // ⚠️ 同类型限定符后者覆盖前者（实测）→ 基础 pushedAfter 与分桶 pushed 必须合并成单一区间
  const pmin = [pushedAfter, bucket.pmin].filter(Boolean).sort().pop(); // 取更晚（更严格）下界
  const pmax = bucket.pmax ?? null;
  if (pmin && pmax) q += ` pushed:${pmin}..${pmax}`;
  else if (pmin) q += ` pushed:>=${pmin}`;
  else if (pmax) q += ` pushed:<${pmax}`;
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
    if (depth >= 8) { console.log('  深度护栏'); return; }
    await sleep(PAGE_MS);
    const last = await ghApi(searchUrl(b, 10));
    const items10 = last ? last.items || [] : [];
    const s = items10.length ? items10[items10.length - 1].stargazers_count : 0;
    const lo = b.smin ?? 3;
    if (s > lo) {
      await bucket({ ...b, smax: s - 1 }, depth + 1);
      await sleep(PAGE_MS);
      await bucket({ ...b, smin: s }, depth + 1);
    } else {
      // 同星数大量堆积（如 1300 个 4★）→ 按 pushed 日期拆：从近到远试候选切点，
      // 探测取两侧都 ≤1000 的切点（避免固定中点在「全部最近更新」的数据上拆不开而空转）。
      const cands = [7, 30, 90, 180].map((d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10));
      let split = null;
      for (const mid of cands) {
        const dA = await ghApi(searchUrl({ ...b, pmax: mid }, 1));
        const tA = dA ? dA.total_count : -1; // 早于 mid 的条数（老侧）
        if (tA <= 0) continue;
        if (tA <= 1000 && total - tA <= 1000) { split = mid; break }
      }
      if (!split) { console.log('  pushed 拆分失败（切点探测均不满足），保留已抓部分'); return }
      console.log(`  pushed 拆分 @${split}`);
      await bucket({ ...b, pmax: split }, depth + 1);
      await sleep(PAGE_MS);
      await bucket({ ...b, pmin: split }, depth + 1);
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
function merge(npmMap, ghMap) {
  const merged = new Map();
  for (const [fn, g] of ghMap) merged.set('gh:' + fn, g);
  for (const [pn, n] of npmMap) {
    const ghKey = n.full_name ? 'gh:' + n.full_name : null;
    const g = ghKey ? merged.get(ghKey) : null;
    if (g) {
      // 双渠道命中：npm 提供精确 version + 可靠安装通道；github 提供 stars/topics
      merged.set(ghKey, {
        ...g,
        npm: n.npm,
        version: n.version || g.version,
        source: 'both',
        description: g.description || n.description,
        topics: g.topics.length ? g.topics : n.topics,
        updated_at: [g.updated_at, n.updated_at].sort().pop() || '',
      });
    } else {
      merged.set(ghKey || 'npm:' + pn, { ...n });
    }
  }
  return merged;
}

// ---- 快筛：dsh.bundle 声明 + version（带 7 天断点缓存）----
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
    if (hit && Date.now() - hit.ts < PROBE_TTL_MS && hit.installable !== null) return { ...hit, from: k };
  }
  // npm 通道：registry latest manifest 含全部自定义字段
  if (item.npm) {
    try {
      const r = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(item.npm)}/latest`, { signal: AbortSignal.timeout(10000) });
      if (r.ok) {
        const m = await r.json();
        const res = { installable: !!(m.dsh && m.dsh.bundle), version: m.version || '', ts: Date.now() };
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
        if (r.status === 404) { const res = { installable: false, version: '', ts: Date.now() }; cache['gh:' + item.full_name] = res; return res; }
        if (r.ok) {
          const m = await r.json();
          const res = { installable: !!(m.dsh && m.dsh.bundle), version: m.version || '', ts: Date.now() };
          cache['gh:' + item.full_name] = res;
          return res;
        }
      } catch { await sleep(500); }
    }
  }
  return { installable: null, version: item.version || '', ts: Date.now() };
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
if (!args.includes('--skip-probe')) await probeAll(items);

items.sort((a, b) => b.stargazers_count - a.stargazers_count);
const out = { version: 2, builtAt: Date.now(), quality: true, total: items.length, items };
await writeFile(OUT, JSON.stringify(out));
const inst = items.filter((x) => x.installable === true).length;
console.log(`✅ ${OUT}：${items.length} 条（可装 ${inst}）builtAt ${new Date(out.builtAt).toISOString()}`);

// fetch-cards-snapshot.mjs — 为 dsh-plugin-cards 插件构建全量精确快照（0.5.5 快照优先方案的数据源）。
//
// 产出 public/cards-snapshot.json：
//   { version:1, builtAt:<ms>, quality:true, total:<n>, items:[{full_name,name,stargazers_count,updated_at,description,topics}] }
// 插件端校验：items>=1000、builtAt 72h 内、quality 口径一致 → 秒级建立全量索引（分类精确计数+跨页筛选）；
// 安装不受影响：插件端条目保留 full_name → github:owner/repo → 宿主 clone + inspect 校验 dsh.bundle。
//
// 用法：
//   node scripts/fetch-cards-snapshot.mjs                     # 在线分桶收割（quality 口径，约 40 请求/6 分钟）
//   GITHUB_TOKEN=xxx node scripts/fetch-cards-snapshot.mjs    # 带 token 提限额（30 次/分钟）
//   node scripts/fetch-cards-snapshot.mjs --from-json dump.json  # 从本地全量 dump 离线重建（免网络）
//
// GitHub Search API 两个硬约束（实测）：
//   1) 单查询最多返回前 1000 条（per_page=100 第 11 页起 422，total_count 仍显全量）→ 必须分桶；
//   2) 同类型限定符后者覆盖前者（stars:>=3 + stars:<=10 只剩 <=10）→ 星数/时间必须合并单区间。

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname, resolve } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const OUT = join(ROOT, 'public', 'cards-snapshot.json');

const TOKEN = process.env.GITHUB_TOKEN || '';
const HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'dsh-plugin-hub-snapshot' };
if (TOKEN) HEADERS.Authorization = 'Bearer ' + TOKEN;
const PAGE_MS = TOKEN ? 2200 : 7000;   // 限额：认证 30/分钟，未认证 10/分钟
const BACKOFF_MS = 65000;              // 403/429 退避
const MAX_DEPTH = 8;                   // 分桶递归护栏

const QUALITY = true;                  // 与插件「质量过滤」口径一致
function qualityQualifiers() {
  const d = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  return { smin: 3, pushedAfter: d, kw: ' dsh in:name,description,topics' };
}

function searchUrl(bucket, page) {
  let q = 'topic:dsh-plugin';
  const { smin, pushedAfter, kw } = qualityQualifiers();
  const lo = QUALITY ? smin : (bucket.smin ?? null);
  const hi = bucket.smax ?? null;
  if (lo !== null && hi !== null) q += ` stars:${lo}..${hi}`;
  else if (lo !== null) q += ` stars:>=${lo}`;
  else if (hi !== null) q += ` stars:<=${hi}`;
  const pmin = [pushedAfter, bucket.pmin].filter(Boolean).sort().pop();
  const pmax = bucket.pmax ?? null;
  if (pmin && pmax) q += ` pushed:${pmin}..${pmax}`;
  else if (pmin) q += ` pushed:>=${pmin}`;
  else if (pmax) q += ` pushed:<${pmax}`;
  if (QUALITY) q += kw;
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(url, attempt = 0) {
  const r = await fetch(url, { headers: HEADERS });
  if (r.status === 403 || r.status === 429) {
    if (attempt >= 2) return { __unavailable: true };
    console.log(`  ${r.status} 退避 ${BACKOFF_MS / 1000}s…`);
    await sleep(BACKOFF_MS);
    return api(url, attempt + 1);
  }
  if (r.status === 422) return { __unavailable: true, message: 'bad query' };
  if (!r.ok) return { __unavailable: true, message: 'HTTP ' + r.status };
  return r.json();
}

// ---- 在线分桶收割 ----
async function harvest() {
  const seen = new Map();
  const absorb = (list) => {
    for (const it of list) {
      if (!it || it.fork || it.archived || seen.has(it.full_name)) continue;
      seen.set(it.full_name, it);
    }
  };
  const keep = (it) => ({
    full_name: it.full_name,
    name: it.name,
    stargazers_count: it.stargazers_count || 0,
    updated_at: it.updated_at || '',
    description: (it.description || '').slice(0, 500),
    topics: (it.topics || []).slice(0, 20),
  });

  async function bucket(b, depth) {
    const first = await api(searchUrl(b, 1));
    if (first.__unavailable) { console.log(`  bucket 跳过: ${JSON.stringify(b)}`); return; }
    const total = first.total_count || 0;
    const list1 = first.items || [];
    absorb(list1);
    console.log(`bucket ${JSON.stringify(b)} total=${total} cum=${seen.size} depth=${depth}`);
    if (total === 0) return;
    const pages = Math.min(Math.ceil(total / 100), 10);
    for (let p = 2; p <= pages; p++) {
      await sleep(PAGE_MS);
      const d = await api(searchUrl(b, p));
      if (d.__unavailable) break;
      absorb(d.items || []);
      console.log(`  page ${p}/${pages} cum=${seen.size}`);
    }
    if (total <= 1000 || pages < 10) return; // 本桶已收完
    if (depth >= MAX_DEPTH) { console.log('  深度护栏，保留已抓部分'); return; }
    // 拆桶：取第 10 页末位星数为新下界；同星数堆积（低星区）按 pushed 日期中点拆
    await sleep(PAGE_MS);
    const last = await api(searchUrl(b, 10));
    const items10 = last.__unavailable ? [] : (last.items || []);
    const s = items10.length ? items10[items10.length - 1].stargazers_count : 0;
    const lo = QUALITY ? qualityQualifiers().smin : (b.smin ?? 0);
    if (s > lo) {
      await bucket({ ...b, smax: s - 1 }, depth + 1);
      await sleep(PAGE_MS);
      await bucket({ ...b, smin: s }, depth + 1);
    } else {
      const mid = new Date(Date.now() - 365 * 24 * 3600 * 1000 / 2).toISOString().slice(0, 10);
      await bucket({ ...b, pmax: mid }, depth + 1);
      await sleep(PAGE_MS);
      await bucket({ ...b, pmin: mid }, depth + 1);
    }
  }

  await bucket({}, 0);
  return [...seen.values()].map(keep);
}

// ---- 离线重建：从本地 dump（如 dsh-plugin/scripts/dsh-all.json）归一化 ----
async function fromJson(path) {
  const arr = JSON.parse(await readFile(resolve(path), 'utf8'));
  if (!Array.isArray(arr)) throw new Error('dump 不是数组');
  return arr.map((it) => ({
    full_name: it.full_name || it.name,
    name: it.name,
    stargazers_count: it.stargazers_count ?? it.stars ?? 0,
    updated_at: it.updated_at || '',
    description: (it.description || '').slice(0, 500),
    topics: (it.topics || []).slice(0, 20),
  }));
}

const fromIdx = process.argv.indexOf('--from-json');
const items = fromIdx > -1 ? await fromJson(process.argv[fromIdx + 1]) : await harvest();

items.sort((a, b) => b.stargazers_count - a.stargazers_count);
const out = { version: 1, builtAt: Date.now(), quality: QUALITY, total: items.length, items };
await writeFile(OUT, JSON.stringify(out));
console.log(`✅ ${OUT}：${items.length} 条（${new Date(out.builtAt).toISOString()}）`);

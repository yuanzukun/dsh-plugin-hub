// patch-snapshot-remerge.mjs — 对现有 cards-snapshot.json 重应用 0.9.0 归并规则（一次性补丁）。
//
// 背景：2026-09-26 实测 merge() 旧逻辑把 monorepo 子包 N:1 覆盖归并（@szx-a/dsh-layered-memory-
// architecture 污染 deepseek-ai/deepseek-harness 主仓条目），且部分 npm 包被折叠丢失。
// 本脚本用「源 A 重收割 + 现有快照作 gh 侧底料」重跑新归并，不需要 GitHub API（国内可跑）。
//
// 规则与 fetch-cards-snapshot.mjs 0.9.0 一致：
//   - 每个 npm 包独立成条，GitHub 仓库信息（stars/topics/updated_at）富化
//   - HOST_REPOS 宿主本体不作条目
//   - installable 优先排序
//   - 新出现的 npm 包经 npmmirror /latest 快筛 installable/version；已知名沿用现快照值
//
// 用法：node scripts/patch-snapshot-remerge.mjs

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const OUT = join(ROOT, 'public', 'cards-snapshot.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normTopics = (kw) => (Array.isArray(kw) ? kw : []).map((k) => String(k).toLowerCase()).filter(Boolean).slice(0, 20);
const ghFromUrl = (u) => {
  const m = /github\.com[/:]([^/]+)\/([^/#?.]+)/i.exec(String(u || ''));
  return m ? m[1] + '/' + m[2].replace(/\.git$/, '') : '';
};
const HOST_REPOS = new Set(['deepseek-ai/deepseek-harness']);
const sortItems = (items) => {
  const rank = (x) => (x.installable === false ? 1 : 0);
  return items.sort((a, b) => rank(a) - rank(b) || b.stargazers_count - a.stargazers_count);
};

// ---- 源 A 重收割（与主脚本同口径：npmjs 为主，连续 429/5xx 切 npmmirror）----
let HOST_IDX = 0;
const HOSTS = ['registry.npmjs.org', 'registry.npmmirror.com'];
async function searchPage(from, SIZE) {
  for (let attempt = 1; ; attempt++) {
    const host = HOSTS[HOST_IDX];
    let r;
    try {
      r = await fetch(`https://${host}/-/v1/search?text=keywords:dsh-plugin&size=${SIZE}&from=${from}`, { signal: AbortSignal.timeout(20000) });
    } catch (e) {
      if (attempt >= 6) throw e;
      console.log(`npm search ${e.name}（from=${from}）重试 ${attempt}，5s 后`);
      await sleep(5000);
      continue;
    }
    if (r.ok) return r.json();
    if (r.status === 429 || r.status >= 500) {
      if (attempt >= 6) throw new Error('npm search HTTP ' + r.status + '（重试耗尽）');
      const waitMs = Math.min((Number(r.headers.get('retry-after')) || Math.pow(2, attempt) * 3) * 1000, 90000);
      console.log(`npm search HTTP ${r.status}（host=${host}）等 ${Math.round(waitMs / 1000)}s 重试 ${attempt}`);
      if (attempt >= 3 && HOST_IDX === 0) { HOST_IDX = 1; console.log('→ 切 npmmirror'); }
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
/** 新包快筛：npmmirror /latest（与主脚本 probe 通道一致） */
async function probeNew(item) {
  try {
    const r = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(item.npm)}/latest`, { signal: AbortSignal.timeout(10000) });
    if (r.ok) {
      const m = await r.json();
      item.installable = !!(m.dsh && m.dsh.bundle);
      if (m.version) item.version = m.version;
    }
  } catch { /* 保持 null（未定） */ }
  return item;
}

const snap = JSON.parse(await readFile(OUT, 'utf8'));
console.log(`现有快照：${snap.items.length} 条（built ${new Date(snap.builtAt).toISOString()}）`);

// 现有条目索引：npm 身份表（沿用其 installable/版本等已筛值）；GitHub 富化信息表（full_name →
// stars/topics/updated_at）从**所有**带 full_name 的旧条目收集（含 both 条目，否则富化信息丢失降级）
const prevByNpm = new Map();
const ghInfo = new Map();
for (const it of snap.items) {
  if (it.npm) prevByNpm.set(it.npm, it);
  if (it.full_name && !HOST_REPOS.has(it.full_name.toLowerCase()) && !ghInfo.has(it.full_name)) ghInfo.set(it.full_name, it);
}
console.log(`底料：npm 身份 ${prevByNpm.size}，GitHub 富化信息 ${ghInfo.size}（宿主本体已剔除）`);

const npmMap = await fetchNpm();
// 种子补录（与主脚本 0.9.0 同口径）：search 索引对发布中/新发布包有延迟，按包名直拉 manifest 必进
const SEED_PACKAGES = ['dsh-plugin-cards', 'dsh-plugin'];
for (const name of SEED_PACKAGES) {
  if (npmMap.has(name)) continue;
  try {
    const r = await fetch(`https://registry.npmmirror.com/${encodeURIComponent(name)}/latest`, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) { console.log(`seed: ${name} HTTP ${r.status} 跳过`); continue; }
    const m = await r.json();
    npmMap.set(m.name, {
      npm: m.name, name: m.name, version: m.version || '',
      description: (m.description || '').slice(0, 500),
      topics: normTopics(m.keywords), updated_at: '',
      full_name: ghFromUrl(m.repository && (typeof m.repository === 'string' ? m.repository : m.repository.url)),
      stargazers_count: 0, source: 'npm',
    });
    console.log(`seed: +${m.name}@${m.version}`);
  } catch (e) { console.log(`seed: ${name} 失败（${e.message}）跳过`); }
}

// 新归并（与主脚本 0.9.0 同规则；富化信息取自 ghInfo，含旧 both 条目）
const merged = new Map();
for (const [pn, n] of npmMap) {
  const g = n.full_name ? ghInfo.get(n.full_name) : null;
  merged.set('npm:' + pn, {
    ...n,
    stargazers_count: g ? g.stargazers_count || 0 : 0,
    topics: g && g.topics && g.topics.length ? g.topics : n.topics,
    updated_at: g ? ([g.updated_at, n.updated_at].sort().pop() || '') : n.updated_at,
    installable: null,
    source: g ? 'both' : 'npm',
  });
}
// gh-only 条目：未被任何 npm 包富化引用的才保留（避免与 npm 条目重复展示）
for (const [fn, g] of ghInfo) {
  if (![...merged.values()].some((m) => m.full_name === fn)) merged.set('gh:' + fn, { ...g });
}
console.log(`重归并：${merged.size} 条`);

// 快筛：沿用已知值，仅探新包
const items = [...merged.values()];
let reused = 0, fresh = 0;
const queue = [];
for (const it of items) {
  const known = prevByNpm.get(it.npm);
  if (known && typeof known.installable === 'boolean') {
    it.installable = known.installable;
    if (!it.version && known.version) it.version = known.version;
    reused++;
  } else { queue.push(it); fresh++; }
}
console.log(`快筛：沿用 ${reused}，新探 ${fresh}`);
const CONC = 8;
let done = 0;
async function worker() {
  for (;;) {
    const it = queue.shift();
    if (!it) return;
    await probeNew(it);
    if (++done % 250 === 0) console.log(`probe ${done}/${queue.length + done}`);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

sortItems(items);
const out = { version: 2, builtAt: Date.now(), quality: true, total: items.length, items };
await writeFile(OUT, JSON.stringify(out));
const inst = items.filter((x) => x.installable === true).length;
const both = items.filter((x) => x.source === 'both').length;
console.log(`✅ ${OUT}：${items.length} 条（可装 ${inst}，both ${both}）builtAt ${new Date(out.builtAt).toISOString()}`);

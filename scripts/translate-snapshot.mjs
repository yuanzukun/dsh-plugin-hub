// translate-snapshot.mjs — 为 cards-snapshot.json 批量预翻译英文描述 → description_zh（0.9.10 快车道）。
//
// 背景：客户端 0.9.10 起卡片描述优先读快照自带 description_zh 字段，运行时 LLM/MyMemory
// 翻译降级为兜底 —— 此前英文残留的根因是运行时翻译按页懒执行 + MyMemory 匿名配额耗尽静默回退。
// 本脚本在 hub 侧集中翻译一次、全量分发，所有用户首屏即全中文（离线也中文）。
//
// 用法（在 fetch-cards-snapshot.mjs 之后执行）：
//   LLM_API_KEY=sk-xxx node scripts/translate-snapshot.mjs
//   LLM_API_KEY=sk-xxx LLM_ENDPOINT=https://api.deepseek.com/v1 LLM_MODEL=deepseek-chat node scripts/translate-snapshot.mjs
//   node scripts/translate-snapshot.mjs --dry-run   # 不调 LLM、不写盘，只统计待翻译量
//
// 设计：
//   - 持久缓存 data/tx-cache.json（schema v1，按描述 sha1 增量；重复描述共享一条译文，
//     镜像/抢注包的同文描述天然去重）→ 每日构建只翻译新增/变更描述，token 成本近零
//   - 原文本身含中文的条目不翻译（客户端原样显示）
//   - LLM 不可用/失败时优雅跳过（exit 0），客户端运行时翻译兜底 —— CI 不因翻译中断
//   - 译文校验：须含 CJK、非空、≤600 字符，否则丢弃该条（防模型跑飞输出污染快照）

import { writeFile, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

const ROOT = dirname(fileURLToPath(import.meta.url)) + '/..';
const SNAP = join(ROOT, 'public', 'cards-snapshot.json');
const TX_CACHE = join(ROOT, 'data', 'tx-cache.json');
const CACHE_VERSION = 1;
const TX_MAX = 600; // 与客户端 compactItem descZh 截断一致

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');

// ---- Key/端点解析（与 fetch.mjs 的 Agnes 通道对齐）----
// 1) LLM_API_KEY + LLM_ENDPOINT/LLM_MODEL（CI：secrets.DEEPSEEK_API_KEY → DeepSeek）
// 2) AGNES_KEY 环境变量（Agnes 官方源）
// 3) ~/.workbuddy/agnes_api_key.txt（本机约定，fetch.mjs 同款回退）
async function resolveTarget() {
  if (process.env.LLM_API_KEY) {
    return { key: process.env.LLM_API_KEY.trim(), endpoint: (process.env.LLM_ENDPOINT || 'https://api.deepseek.com/v1'), model: process.env.LLM_MODEL || 'deepseek-chat' };
  }
  let agnes = process.env.AGNES_KEY ? String(process.env.AGNES_KEY).trim() : '';
  if (!agnes) {
    try { agnes = (await readFile(join(homedir(), '.workbuddy', 'agnes_api_key.txt'), 'utf8')).trim(); } catch { /* 无 Key */ }
  }
  if (agnes) return { key: agnes, endpoint: 'https://api.agnes-ai.cn/v1', model: process.env.LLM_MODEL || 'agnes-2.0-flash' };
  return null;
}

const BATCH = Math.max(1, Number(process.env.TX_BATCH) || 25);
const CONC = Math.max(1, Number(process.env.TX_CONC) || 3);
const MAX_TOKENS = Math.max(1000, Number(process.env.TX_MAX_TOKENS) || 4000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (s) => createHash('sha1').update(s, 'utf8').digest('hex');
const hasCJK = (s) => /[\u4e00-\u9fff]/.test(s);

async function loadJSON(p, fallback) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return fallback; }
}

async function main() {
  const snap = await loadJSON(SNAP, null);
  if (!snap || !Array.isArray(snap.items) || !snap.items.length) {
    console.error('translate: cards-snapshot.json 不存在或为空，跳过');
    process.exit(0); // 优雅：快照缺失不阻断 CI（快照构建步骤自身会报错）
  }
  const cache = await loadJSON(TX_CACHE, null);
  const tx = cache && cache.v === CACHE_VERSION && cache.tx ? cache.tx : {};

  // ---- 收集待翻译（唯一描述哈希）----
  const need = new Map(); // hash -> desc（跨条目共享）
  let alreadyZh = 0, empty = 0, cached = 0;
  for (const it of snap.items) {
    const d = typeof it.description === 'string' ? it.description.trim() : '';
    if (!d) { empty++; continue; }
    if (hasCJK(d)) { alreadyZh++; continue; } // 原文即中文，客户端原样显示
    const h = sha1(d);
    if (tx[h]) { cached++; it.description_zh = tx[h]; continue; }
    if (!need.has(h)) need.set(h, d);
  }
  console.log(`translate: 条目 ${snap.items.length}（原文中文 ${alreadyZh} / 空 ${empty} / 缓存命中 ${cached} / 待翻译唯一描述 ${need.size}）`);
  if (DRY) { console.log('translate: --dry-run，结束'); return; }
  if (!need.size) { console.log('translate: 无待翻译项'); return; }

  const target = await resolveTarget();
  if (!target) {
    console.warn('translate: 未找到可用 Key（LLM_API_KEY / AGNES_KEY / ~/.workbuddy/agnes_api_key.txt），跳过翻译（客户端运行时翻译兜底）');
    return;
  }
  const { key: API_KEY, endpoint: ENDPOINT_RAW, model: MODEL } = target;
  const ENDPOINT = ENDPOINT_RAW.replace(/\/+$/, '');
  console.log(`translate: 使用 ${ENDPOINT}（model=${MODEL}）`);

  // ---- 批量翻译：BATCH 条/请求，CONC 并发，失败退避重试 2 次 ----
  const hashes = [...need.keys()];
  const batches = [];
  for (let i = 0; i < hashes.length; i += BATCH) batches.push(hashes.slice(i, i + BATCH));

  async function txBatch(batch, attempt) {
    const pairs = {};
    for (const h of batch) pairs[h] = need.get(h);
    const body = {
      model: MODEL,
      messages: [
        { role: 'system', content: '你是翻译引擎。输入是一个 JSON 对象，value 为英文插件/软件描述。把每个 value 翻译成简体中文：产品名、人名、代码、URL 保留不译，风格简洁自然。只输出一个 JSON 对象：key 原样保留，value 为译文，不要输出任何其他文字或代码块标记。' },
        { role: 'user', content: JSON.stringify(pairs) },
      ],
      temperature: 0.1,
      max_tokens: MAX_TOKENS,
      stream: false,
    };
    let r;
    try {
      r = await fetch(ENDPOINT + '/chat/completions', {
        method: 'POST',
        signal: AbortSignal.timeout(120000),
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + API_KEY },
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (attempt < 2) { await sleep(5000 * (attempt + 1) * 2); return txBatch(batch, attempt + 1); }
      throw e;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      if ((r.status === 429 || r.status >= 500) && attempt < 2) {
        await sleep(15000);
        return txBatch(batch, attempt + 1);
      }
      throw new Error('LLM HTTP ' + r.status + ' ' + String(t).slice(0, 140));
    }
    const d = await r.json();
    const text = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
    if (typeof text !== 'string' || !text) throw new Error('LLM 空响应');
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM 响应无 JSON');
    let parsed;
    try { parsed = JSON.parse(m[0]); } catch (e) { throw new Error('LLM JSON 解析失败: ' + e.message); }
    const out = {};
    for (const h of batch) {
      const v = typeof parsed[h] === 'string' ? parsed[h].trim() : '';
      if (v && v.length <= TX_MAX && hasCJK(v) && v !== need.get(h)) out[h] = v; // 校验：含 CJK、非原文复述
    }
    return out;
  }

  let done = 0, ok = 0, fail = 0;
  const queue = batches.slice();
  // 429 全局冷却：免费档 Key 也能慢速稳跑（检测到限流 → 全队暂停 60s，期间不烧批次）
  let cooling = null;
  const cooldown = () => {
    if (!cooling) cooling = sleep(60000).then(() => { cooling = null; console.log('translate: 429 冷却结束，继续'); });
    return cooling;
  };
  await Promise.all(Array.from({ length: CONC }, async () => {
    for (;;) {
      const b = queue.shift();
      if (!b) return;
      for (let attempt = 0; ; attempt++) {
        try {
          const map = await txBatch(b, 0);
          for (const h in map) tx[h] = map[h];
          ok += Object.keys(map).length;
          break;
        } catch (e) {
          const rateLimited = /HTTP 429/.test(e.message);
          if (rateLimited && attempt < 8) {
            console.warn(`translate: 429 限流，全局冷却 60s（批次 ${b.length} 条第 ${attempt + 1} 次重挂回队列）`);
            queue.push(b); // 挂回队尾，冷却后由任一 worker 续跑
            await cooldown();
            break; // 让出 worker，其他 worker 也走冷却
          }
          if (rateLimited) { fail += b.length; console.warn(`translate: 批次 429 重试耗尽（${b.length} 条）: ${e.message}`); break; }
          if (attempt < 2) { await sleep(5000 * (attempt + 1)); continue; } // 非 429（网络抖动/5xx）短退避重试
          fail += b.length;
          console.warn(`translate: 批次失败（${b.length} 条）: ${e.message}`);
          break;
        }
      }
      done += b.length;
      if (done % (BATCH * 4) < BATCH) {
        console.log(`translate: 进度 ~${Math.min(done, hashes.length)}/${hashes.length} 唯一描述（✓${ok} ✗${fail}）`);
        await writeFile(TX_CACHE, JSON.stringify({ v: CACHE_VERSION, tx })).catch(() => {}); // 周期落盘：中断不丢已翻条目
      }
    }
  }));

  // ---- 回写快照 + 缓存 ----
  let applied = 0;
  for (const it of snap.items) {
    const d = typeof it.description === 'string' ? it.description.trim() : '';
    if (!d || hasCJK(d)) continue;
    const zh = tx[sha1(d)];
    if (zh) { it.description_zh = zh; applied++; }
  }
  if (!DRY) {
    await writeFile(SNAP, JSON.stringify(snap));
    await writeFile(TX_CACHE, JSON.stringify({ v: CACHE_VERSION, tx }));
  }
  console.log(`✅ translate: 回写 description_zh ${applied} 条（翻译成功 ${ok} / 失败 ${fail}，缓存累计 ${Object.keys(tx).length}），快照 ${(JSON.stringify(snap).length / 1048576).toFixed(2)}MB`);
  if (fail > 0 && ok === 0) console.warn('translate: 全部批次失败 —— 检查 LLM_API_KEY / 额度（快照已保留无 zh 原样，客户端运行时翻译兜底）');
}

main().catch((e) => { console.error('translate: 意外错误', e); process.exit(0); }); // 优雅退出，不阻断快照发布

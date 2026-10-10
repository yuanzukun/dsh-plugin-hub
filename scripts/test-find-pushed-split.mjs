// findPushedSplit 离线单测：mock ghApi 验证中位切分的收敛性 / 平衡性 / 单日堆积边界
// 用法：node scripts/test-find-pushed-split.mjs
const DAY = 864e5
const now = Date.now()
const PAGE_MS = 0
const sleep = async () => {}

// ---- 被测函数（与 fetch-cards-snapshot.mjs 语义同步；ghApi 顶层注入）----
function searchUrl(bucket, page) {
  const pushedAfter = new Date(now - 365 * DAY).toISOString().slice(0, 10)
  const lo = bucket.smin ?? 0
  const hi = bucket.smax ?? null
  let q = 'topic:dsh-plugin'
  if (lo !== null && lo > 0 && hi !== null) q += ` stars:${lo}..${hi}`
  else if (lo !== null && lo > 0) q += ` stars:>=${lo}`
  else if (hi !== null) q += ` stars:<=${hi}`
  const pmin = [pushedAfter, bucket.pmin].filter(Boolean).sort().pop()
  const pmax = bucket.pmax ?? null
  if (pmin && pmax) q += ` pushed:${pmin}..${pmax}`
  else if (pmin) q += ` pushed:>=${pmin}`
  else if (pmax) q += ` pushed:<${pmax}`
  q += ' dsh in:name,description,topics'
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`
}

async function findPushedSplit(b, total) {
  const base = now - 365 * DAY
  let lo = b.pmin ? Date.parse(b.pmin) : base
  let hi = b.pmax ? Date.parse(b.pmax) : now + DAY
  for (let i = 0; i < 14 && hi - lo > 36 * 3600 * 1000; i++) {
    const mid = new Date((lo + hi) / 2).toISOString().slice(0, 10)
    const d = await ghApi(searchUrl({ ...b, pmin: mid }, 1))
    const n = d ? d.total_count : -1
    if (n < 0) return null
    if (n > total / 2) lo = Date.parse(mid)
    else hi = Date.parse(mid)
  }
  const probe = await ghApi(searchUrl({ ...b, pmin: new Date(hi).toISOString().slice(0, 10) }, 1))
  const fh = probe ? probe.total_count : -1
  if (fh > 0 && fh < total) return new Date(hi).toISOString().slice(0, 10)
  return null
}

// ---- mock：f(x)=count(pushed>=x)（新侧计数，随 x 变新单调递减）----
let ghApi = null

// 模拟 bucket() 递归：中位切分直到每片 ≤1000，返回需要的分桶层数与总探测次数
async function simulateFullSplit(dist, total) {
  let probes = 0
  const realGhApi = ghApi
  ghApi = async (url) => { probes++; return realGhApi(url) }
  async function bucket(b, depth) {
    if (depth > 32) return { depth, ok: false }
    const first = await ghApi(searchUrl(b, 1))
    const t = first.total_count
    if (t <= 1000) return { depth, ok: true }
    const split = await findPushedSplit(b, t)
    if (!split) return { depth, ok: false }
    const a = await bucket({ ...b, pmax: split }, depth + 1)
    const c = await bucket({ ...b, pmin: split }, depth + 1)
    return { depth: Math.max(a.depth, c.depth), ok: a.ok && c.ok }
  }
  const r = await bucket({ smax: 0 }, 0)
  ghApi = realGhApi
  return { ...r, probes }
}

async function run(name, dist, total, expectNull) {
  // mock 严格还原 GitHub 语义：pushed:>=X | pushed:<Y | pushed:X..Y（双端闭区间，Day 粒度）
  ghApi = async (url) => {
    const q = decodeURIComponent(url)
    const f = (x) => dist(x) // f(x)=count(pushed>=x)
    const cdf = (x) => total - f(x) // count(pushed<x)，宇宙 = 本场景 total
    let lo = -Infinity, hi = Infinity
    const range = /pushed:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(q)
    const gte = /pushed:>=(\d{4}-\d{2}-\d{2})/.exec(q)
    const lt = /pushed:<(\d{4}-\d{2}-\d{2})/.exec(q)
    if (range) { lo = Date.parse(range[1]); hi = Date.parse(range[2]) + DAY }
    else if (gte) lo = Date.parse(gte[1])
    else if (lt) hi = Date.parse(lt[1])
    const upper = hi === Infinity ? total : cdf(hi)
    const lower = lo === -Infinity ? 0 : cdf(lo)
    return { total_count: Math.max(0, upper - lower) }
  }
  const split = await findPushedSplit({ smax: 0 }, total)
  const fh = split ? dist(Date.parse(split)) : -1
  const balance = fh > 0 && fh < total ? Math.min(fh, total - fh) / total : 0
  const sim = await simulateFullSplit(dist, total)
  // expectNull：天粒度不可拆（单日堆积）→ 切点应为 null；否则要求切点平衡且整树可收敛
  const ok = expectNull ? split === null : split !== null && balance >= 0.2 && sim.ok && sim.depth <= 32
  console.log(`${ok ? '✅' : '❌'} ${name}: 首切=${split} 新侧=${fh} (${(balance * 100).toFixed(0)}%) 完整递归 ok=${sim.ok} 最深=${sim.depth} 探测总次数=${sim.probes}`)
  return ok
}

// 场景 1：线性递增（新仓多），总量 8382 —— 真实 0 星桶量级
const w = []; let sw = 0
for (let i = 0; i < 365; i++) { w.push(365 - i); sw += 365 - i }
const linear = (x) => {
  if (x > now) return 0
  const daysAgo = Math.max(0, Math.floor((now - x) / DAY))
  if (daysAgo >= 365) return 8382
  let s = 0
  for (let i = 0; i < daysAgo; i++) s += w[i]
  return Math.round((s / sw) * 8382)
}

// 场景 2：均匀分布
const uniform = (x) => {
  if (x > now) return 0
  const daysAgo = Math.min(365, Math.max(0, Math.floor((now - x) / DAY)))
  return Math.round((daysAgo / 365) * 8382)
}

// 场景 3：单日堆积（全部集中在最近 2 天）→ 天粒度拆不开，应返回 null
const pileup = (x) => (x <= now - 2 * DAY ? 8382 : 0)

// 场景 4：阶梯分布（30 天内 3000 + 其余 5382 均布）
const step = (x) => {
  if (x > now) return 0
  const daysAgo = Math.max(0, Math.floor((now - x) / DAY))
  if (daysAgo >= 365) return 8382
  return daysAgo < 30 ? Math.round((daysAgo / 30) * 3000) : 3000 + Math.round(((daysAgo - 30) / 335) * 5382)
}

// 场景 5：超大量（官方 topic 总量级 18479）
const big = (x) => {
  if (x > now) return 0
  const daysAgo = Math.min(365, Math.max(0, Math.floor((now - x) / DAY)))
  return Math.round((daysAgo / 365) * 18479)
}

const results = []
results.push(await run('线性分布 8382（真实 0 星桶）', linear, 8382))
results.push(await run('均匀分布 8382', uniform, 8382))
results.push(await run('单日堆积 8382（应判不可拆）', pileup, 8382, true))
results.push(await run('阶梯分布 8382', step, 8382))
results.push(await run('均匀分布 18479（官方总量级）', big, 18479))
const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)

// findDateSplit 离线单测：mock ghApi 验证 pushed/created 双维度中位切分的收敛性 / 平衡性 / 退化降级
// 场景对齐 2026-10-10 深夜实测：0★/1★ 新仓潮 1.2 万条 created 分散在 8-10 月，但搜索索引 pushed 全部
// 钉在最近 1-2 天（f(x) 只会等于 total 或 0）→ pushed 天粒度无切点，必须降级 created 维度。
// 用法：node scripts/test-find-pushed-split.mjs
const DAY = 864e5
const now = Date.now()
const PAGE_MS = 0
const sleep = async () => {}
const CREATED_BASE = '2015-01-01'
const dayFloor = (x) => Math.floor(x / DAY) * DAY // GitHub 日期限定符为 Day 粒度

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
  if (bucket.cmin && bucket.cmax) q += ` created:${bucket.cmin}..${bucket.cmax}`
  else if (bucket.cmin) q += ` created:>=${bucket.cmin}`
  else if (bucket.cmax) q += ` created:<${bucket.cmax}`
  q += ' dsh in:name,description,topics'
  return `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100&page=${page}`
}

async function findDateSplit(b, total, field) {
  const pre = field === 'pushed' ? 'p' : 'c' // 桶键前缀：pushed→pmin/pmax，created→cmin/cmax
  let lo, hi
  if (field === 'pushed') {
    lo = b.pmin ? Date.parse(b.pmin) : now - 365 * DAY
    hi = b.pmax ? Date.parse(b.pmax) : now + DAY
  } else {
    lo = b.cmin ? Date.parse(b.cmin) : Date.parse(CREATED_BASE)
    hi = b.cmax ? Date.parse(b.cmax) : now + DAY
  }
  for (let i = 0; i < 14 && hi - lo > 36 * 3600 * 1000; i++) {
    await sleep(PAGE_MS)
    const mid = new Date((lo + hi) / 2).toISOString().slice(0, 10)
    const d = await ghApi(searchUrl({ ...b, [pre + 'min']: mid }, 1))
    const n = d ? d.total_count : -1
    if (n < 0) return null
    if (n > total / 2) lo = Date.parse(mid)
    else hi = Date.parse(mid)
  }
  await sleep(PAGE_MS)
  const probe = await ghApi(searchUrl({ ...b, [pre + 'min']: new Date(hi).toISOString().slice(0, 10) }, 1))
  const fh = probe ? probe.total_count : -1
  if (fh > 0 && fh < total) return new Date(hi).toISOString().slice(0, 10)
  return null
}

// ---- mock ----
// 每个场景提供 created CDF 的 g(x)=count(createdAt < x)；计数时对区间端点做天粒度量化。
// pushedPinned=true（新仓潮实况）：所有仓库 pushed 钉在当下 → pushed:>=x 计数只有 total（x≤now）或 0（x>now）；
// pushedPinned=false（常态）：pushed 与 created 同点，两区间直接相交。
let ghApi = null
let TOTAL = 0

function makeMock(g, pushedPinned) {
  return async (url) => {
    const q = decodeURIComponent(url)
    const iv = { pushed: [-Infinity, Infinity], created: [-Infinity, Infinity] }
    const range = /pushed:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(q)
    const gte = /pushed:>=(\d{4}-\d{2}-\d{2})/.exec(q)
    const lt = /pushed:<(\d{4}-\d{2}-\d{2})/.exec(q)
    if (range) { iv.pushed = [Date.parse(range[1]), Date.parse(range[2]) + DAY] }
    else if (gte) iv.pushed = [Date.parse(gte[1]), Infinity]
    else if (lt) iv.pushed = [-Infinity, Date.parse(lt[1])]
    const crange = /created:(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})/.exec(q)
    const cgte = /created:>=(\d{4}-\d{2}-\d{2})/.exec(q)
    const clt = /created:<(\d{4}-\d{2}-\d{2})/.exec(q)
    if (crange) { iv.created = [Date.parse(crange[1]), Date.parse(crange[2]) + DAY] }
    else if (cgte) iv.created = [Date.parse(cgte[1]), Infinity]
    else if (clt) iv.created = [-Infinity, Date.parse(clt[1])]
    let count
    if (pushedPinned) {
      // pushed 钉在 now：pushed 约束命中等价于 lo_p ≤ now < hi_p（Day 粒度）
      const pushedHit = dayFloor(iv.pushed[0] === -Infinity ? 0 : iv.pushed[0]) <= dayFloor(now) &&
        (iv.pushed[1] === Infinity || dayFloor(now) < dayFloor(iv.pushed[1]))
      if (!pushedHit) return { total_count: 0 }
      const lo = iv.created[0] === -Infinity ? 0 : g(dayFloor(iv.created[0]))
      const hi = iv.created[1] === Infinity ? TOTAL : g(dayFloor(iv.created[1]))
      count = hi - lo
    } else {
      const lo = Math.max(iv.pushed[0], iv.created[0])
      const hi = Math.min(iv.pushed[1], iv.created[1])
      const a = lo === -Infinity ? 0 : g(dayFloor(lo))
      const b = hi === Infinity ? TOTAL : g(dayFloor(hi))
      count = b - a
    }
    return { total_count: Math.max(0, count) }
  }
}

// 模拟 bucket() 递归（双维度），返回需要的层数与总探测次数
async function simulateFullSplit(g, pushedPinned, total, startBucket) {
  let probes = 0
  const realGhApi = ghApi
  ghApi = async (url) => { probes++; return realGhApi(url) }
  async function bucket(b, depth) {
    if (depth > 32) return { depth, ok: false }
    const first = await ghApi(searchUrl(b, 1))
    const t = first.total_count
    if (t <= 1000) return { depth, ok: true }
    // 简化：星数链不建模（场景分布全同星），日期维度直接承担全部切分
    let dim = null, split = null
    const tailProbe = await ghApi(searchUrl({ ...b, pmin: new Date(now - 2 * DAY).toISOString().slice(0, 10) }, 1))
    const tailN = tailProbe.total_count
    if (tailN >= t) {
      dim = 'created'; split = await findDateSplit(b, t, 'created')
    } else {
      split = await findDateSplit(b, t, 'pushed')
      if (split) dim = 'pushed'
      else { dim = 'created'; split = await findDateSplit(b, t, 'created') }
    }
    if (!split) return { depth, ok: false }
    const a = await bucket({ ...b, [dim === 'pushed' ? 'pmax' : 'cmax']: split }, depth + 1)
    const c = await bucket({ ...b, [dim === 'pushed' ? 'pmin' : 'cmin']: split }, depth + 1)
    return { depth: Math.max(a.depth, c.depth), ok: a.ok && c.ok }
  }
  const r = await bucket(startBucket, 0)
  ghApi = realGhApi
  return { ...r, probes }
}

async function run(name, g, pushedPinned, total, opts) {
  const { expectPushedNull = false, expectCreatedNull = false, expectSimFail = false, startBucket = {} } = opts || {}
  TOTAL = total
  ghApi = makeMock(g, pushedPinned)
  const pushedSplit = await findDateSplit(startBucket, total, 'pushed')
  const createdSplit = await findDateSplit(startBucket, total, 'created')
  const sim = await simulateFullSplit(g, pushedPinned, total, startBucket)
  const okP = expectPushedNull ? pushedSplit === null : pushedSplit !== null
  const okC = expectCreatedNull ? createdSplit === null : createdSplit !== null
  // expectSimFail：双维度都拆不开 → 整树无法完整切分（ok=false）是预期降级行为（保留已抓部分）
  const okS = expectSimFail ? sim.ok === false : sim.ok === true && sim.depth <= 32
  const ok = okP && okC && okS
  console.log(`${ok ? '✅' : '❌'} ${name}: pushed切=${pushedSplit} created切=${createdSplit} 完整递归 ok=${sim.ok} 最深=${sim.depth} 探测=${sim.probes}`)
  return ok
}

// ---- 分布构造：g(x)=count(createdAt<x) ----
function uniformG(total) { // 均匀分布在 365 天
  return (x) => {
    if (x <= now - 365 * DAY) return 0
    if (x > now) return total
    return Math.round(((x - (now - 365 * DAY)) / (365 * DAY)) * total)
  }
}
function recentG(total, winDays) { // 均匀散布在最近 winDays 天
  return (x) => {
    if (x <= now - winDays * DAY) return 0
    if (x > now) return total
    return Math.round(((x - (now - winDays * DAY)) / (winDays * DAY)) * total)
  }
}

const results = []
// 场景 1：常态均匀（pushed 未退化）→ pushed 切分成功、整树收敛
results.push(await run('均匀 8382：pushed 可拆', uniformG(8382), false, 8382))
// 场景 2：新仓潮实况——created 散布 60 天、pushed 钉死当下（退化）→ pushed 判 null、created 兜底拆开
results.push(await run('新仓潮 12200：pushed 退化 → created 兜底', recentG(12200, 60), true, 12200, { expectPushedNull: true }))
// 场景 3：created 也单日堆积（Day 粒度无切点）→ 两维度都判 null，保留已抓部分
results.push(await run('单日堆积 8382：均不可拆', recentG(8382, 1), true, 8382, { expectPushedNull: true, expectCreatedNull: true, expectSimFail: true, startBucket: { pmin: new Date(now - 1 * DAY).toISOString().slice(0, 10) } }))
// 场景 4：超大量均匀（官方 topic 总量级）
results.push(await run('均匀 18479（官方总量级）', uniformG(18479), false, 18479))

const pass = results.filter(Boolean).length
console.log(`\n${pass}/${results.length} 通过`)
process.exit(pass === results.length ? 0 : 1)

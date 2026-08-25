// app.js — 渲染插件目录：搜索 / 分类筛选 / 排序 / 一键复制安装命令
const $ = (s) => document.querySelector(s);
const grid = $('#grid');
const chipsEl = $('#chips');
const searchEl = $('#search');
const sortEl = $('#sort');
const metaEl = $('#meta');

let PLUGINS = [];
let activeCat = '全部';
let kw = '';
let page = 0;
const PAGE_SIZE = 60;

function fmtDate(s) {
  if (!s) return '';
  const d = new Date(s);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function categories() {
  const m = new Map();
  for (const p of PLUGINS) m.set(p.category, (m.get(p.category) || 0) + 1);
  return [['全部', PLUGINS.length], ...[...m.entries()].sort((a, b) => b[1] - a[1])];
}

function renderChips() {
  chipsEl.innerHTML = '';
  for (const [cat, n] of categories()) {
    const el = document.createElement('div');
    el.className = 'chip' + (cat === activeCat ? ' active' : '');
    el.innerHTML = `${cat}<span class="n">${n}</span>`;
    el.onclick = () => {
      activeCat = cat;
      page = 0;
      renderChips();
      render();
    };
    chipsEl.appendChild(el);
  }
}

function filtered() {
  let list = PLUGINS.filter((p) => activeCat === '全部' || p.category === activeCat);
  if (kw) {
    const q = kw.toLowerCase();
    list = list.filter(
      (p) =>
        (p.name || '').toLowerCase().includes(q) ||
        (p.zh || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q) ||
        (p.topics || []).join(' ').toLowerCase().includes(q)
    );
  }
  const s = sortEl.value;
  list.sort((a, b) =>
    s === 'stars' ? b.stars - a.stars : s === 'updated' ? new Date(b.updatedAt) - new Date(a.updatedAt) : (a.name || '').localeCompare(b.name || '')
  );
  return list;
}

function render() {
  const list = filtered();
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  if (page >= totalPages) page = totalPages - 1;
  if (page < 0) page = 0;
  const slice = list.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  if (!list.length) {
    grid.innerHTML = '<div class="empty">没有匹配的插件 🤔</div>';
    renderPager(0, 0);
    return;
  }
  grid.innerHTML = '';
  for (const p of slice) {
    const card = document.createElement('article');
    card.className = 'card';
    const srcBadge = p.installSource === 'npm' ? '<span class="pill">npm</span>' : '<span class="pill">github</span>';
    card.innerHTML = `
      <h3>
        <a href="${p.url}" target="_blank" rel="noopener">${p.name}</a>
        <span class="tag-cat">${p.category}</span>
      </h3>
      <div class="zh">${p.zh || '<span style="color:#9ca3af">（待翻译）</span>'}</div>
      <div class="desc">${escapeHtml(p.description || '')}</div>
      <div class="row">
        ${srcBadge}
        ${p.stars ? `<span class="pill">⭐ ${p.stars?.toLocaleString?.() ?? p.stars}</span>` : ''}
        ${p.language ? `<span class="pill">${p.language}</span>` : ''}
        <span>${fmtDate(p.updatedAt)}</span>
      </div>
      <div class="cmd">
        <code>${escapeHtml(p.install)}</code>
        <button class="copy" data-cmd="${escapeHtml(p.install)}">复制</button>
      </div>`;
    grid.appendChild(card);
  }
  grid.querySelectorAll('.copy').forEach((b) => {
    b.onclick = () => copy(b.dataset.cmd);
  });
  renderPager(list.length, totalPages);
}

function renderPager(total, totalPages) {
  const pager = $('#pager');
  if (!pager) return;
  if (total === 0) {
    pager.innerHTML = '';
    return;
  }
  const from = page * PAGE_SIZE + 1;
  const to = Math.min(total, (page + 1) * PAGE_SIZE);
  pager.innerHTML = `
    <button id="prev" ${page === 0 ? 'disabled' : ''}>← 上一页</button>
    <span class="pg-info">第 ${page + 1} / ${totalPages} 页 · 显示 ${from}-${to} / 共 ${total}</span>
    <button id="next" ${page >= totalPages - 1 ? 'disabled' : ''}>下一页 →</button>`;
  const prev = $('#prev');
  const next = $('#next');
  if (prev) prev.onclick = () => { page--; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  if (next) next.onclick = () => { page++; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  const t = $('#toast');
  t.textContent = '已复制：' + text;
  t.classList.add('show');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.remove('show'), 1800);
}

async function init() {
  try {
    const res = await fetch('plugins.json', { cache: 'no-store' });
    const data = await res.json();
    PLUGINS = data.plugins || [];
    metaEl.textContent = `共 ${data.count ?? PLUGINS.length} 个插件 · 更新于 ${fmtDate(data.generatedAt)}`;
  } catch (e) {
    metaEl.textContent = '数据加载失败（请用本地服务器或部署后访问）';
    grid.innerHTML = '<div class="empty">无法加载 plugins.json。若直接双击打开本文件，请改用本地服务器（如 <code>python -m http.server</code>）或部署后访问。</div>';
    return;
  }
  renderChips();
  render();
}

searchEl.addEventListener('input', (e) => {
  kw = e.target.value.trim();
  page = 0;
  render();
});
sortEl.addEventListener('change', () => { page = 0; render(); });
init();

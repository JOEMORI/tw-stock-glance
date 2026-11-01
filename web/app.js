// 台股收盤速覽：iPhone 網頁版（加到主畫面使用）
// 個股資料直接向 FinMind 查（允許跨網域）；證交所開放資料、櫃買、集保等由 GitHub Actions 每天整理成 data/*.json。
// 自選股、觀察清單、設定都只存在這支手機（localStorage），不會上傳。
import { getWatchlist, setWatchlist, getObserve, setObserve, getSettings, setSettings } from './lib/storage.js';
import { loadStock, getStockInfo, loadEntity } from './lib/api.js';
import { analyze, aggregate, sma, levels, breakouts, PERIODS, priceDigits, streak, signalReliability, weakSignal, SIGNAL_DIR, revenueSeries } from './lib/indicators.js';
import { patchData } from './lib/patch.js';
import { setClosed } from './lib/time.js';
import { getRelations, relationMetrics } from './lib/relations.js';
import { THEMES } from './lib/sectors.js';
import { CATS, impactText } from './lib/intel.js';
import { reviewStock } from './lib/review.js';
import { esc, fmtP, fmtInt, sInt, sPct, tone, arrow, md } from './lib/format.js';

const $ = (id) => document.getElementById(id);
const S = { latest: null, intel: null, info: {}, watch: [], observe: [], data: {}, an: {}, rel: {}, anns: {}, period: 'd', rFilter: { days: 1, cat: 'all' }, chart: null, settings: {} };
const nameOf = (id) => S.info[id]?.name || id;
const toast = (t) => { let el = $('toast'); if (!el) { el = document.createElement('div'); el.id = 'toast'; el.className = 'toast'; el.setAttribute('role', 'status'); document.body.appendChild(el); } el.textContent = t; clearTimeout(toast.t); if (t) toast.t = setTimeout(() => (el.textContent = ''), 4000); };

// ---------- 字體大小 ----------
function applyFs(v) {
  document.documentElement.dataset.fs = v;
  document.querySelectorAll('[data-fs]').forEach((b) => b.tagName === 'BUTTON' && b.setAttribute('aria-pressed', String(b.dataset.fs === String(v))));
  try { localStorage.setItem('fs', String(v)); } catch (e) { /* 略過 */ }
  if (S.chart) requestAnimationFrame(() => route());
}
document.querySelector('.fs').addEventListener('click', (e) => { const b = e.target.closest('[data-fs]'); if (b) applyFs(b.dataset.fs); });

// ---------- 資料 ----------
async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-cache' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}
async function loadLatest() {
  if (!S.latest) {
    S.latest = await getJSON('data/latest.json').catch(() => null);
    if (S.latest?.holidays) setClosed(S.latest.holidays);
  }
  return S.latest;
}
async function loadIntel() {
  if (!S.intel) S.intel = (await getJSON('data/intel.json').catch(() => ({ items: [] }))).items || [];
  return S.intel;
}
async function loadAnns(id) {
  if (!(id in S.anns)) S.anns[id] = await getJSON(`data/anns/${id}.json`).catch(() => []);
  return S.anns[id];
}
async function loadOne(id, force = false) {
  try {
    const raw = await loadStock(id, { force, want: S.latest?.detail?.date });
    S.data[id] = raw;
    const pd = patchData(raw, S.latest?.detail, id);
    const a = analyze(pd);
    if (pd.patched) a.patched = pd.patched;
    S.an[id] = a;
    return raw.error || null;
  } catch (e) {
    return e.message;
  }
}
const isOtc = (id) => S.info[id]?.type === 'tpex';
function idxPct(id) {
  const rows = S.latest?.index?.[id] || [];
  return rows.length > 1 ? (rows.at(-1)[4] / rows.at(-2)[4] - 1) * 100 : null;
}
const relOf = (id) => { const a = S.an[id]; if (!a || a.empty) return null; a._rel = a._rel || signalReliability(a.daily); return a._rel; };
const useful = (id) => { const a = S.an[id]; const r = relOf(id); return a && !a.empty ? a.events.filter((e) => !weakSignal(r, e)) : []; };

// 注意程度（與電腦版同規則）
function attention(id) {
  const a = S.an[id];
  if (!a || a.empty) return { score: -1, level: 'gray', why: [] };
  const why = [];
  let sc = 0;
  for (const e of useful(id)) {
    if (e.d < 0 && SIGNAL_DIR[e.key]) { sc += 3; why.push(e.t); }
    else if (e.d > 0 && SIGNAL_DIR[e.key]) { sc += 1.5; why.push(e.t); }
    else if (e.key === 'inst') { sc += 0.5; why.push(e.t); }
  }
  const m = idxPct(isOtc(id) ? 'TPEx' : 'TAIEX');
  if (m != null && S.latest?.date === a.last.time) {
    const gap = a.pct - m;
    if (Math.abs(gap) >= 3) { sc += 2; why.push(`${gap < 0 ? '弱' : '強'}於大盤 ${Math.abs(gap).toFixed(1)} 個百分點`); }
    else if (Math.abs(gap) >= 1.5) sc += 1;
  }
  const lv = a.levels || {};
  if (lv.sup) { const d = (1 - lv.sup.price / a.last.close) * 100; if (d >= 0 && d <= 2) { sc += 1; why.push(`離支撐 ${fmtP(lv.sup.price, priceDigits(a.last.close))} 只剩 ${d.toFixed(1)}%`); } }
  const ann = (S.anns[id] || []).find((x) => x.d >= (S.latest?.date || '9'));
  if (ann) { sc += 2; why.push('有新公告'); }
  return { score: sc, level: sc >= 4 ? 'red' : sc >= 2 ? 'orange' : 'gray', why };
}
const LV = { red: '需要處理', orange: '留意', gray: '' };

function spark(a, w = 300, h = 30) {
  const c = a.daily.slice(-20).map((x) => x.close);
  const lo = Math.min(...c), hi = Math.max(...c);
  return c.map((v, i) => `${((i / (c.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4)).toFixed(1)}`).join(' ');
}

// ---------- 首頁：自選股 ----------
async function viewHome() {
  setHead('DAILY CLOSE', '收盤速覽' + (S.latest?.date ? ' ' + md(S.latest.date) : ''));
  const L = S.latest;
  const ix = (id, label) => { const r = L?.index?.[id] || []; if (r.length < 2) return ''; const v = r.at(-1)[4], p = r.at(-2)[4], d = v - p, pc = (v / p - 1) * 100; return `<span>${label} <b>${fmtP(v, 2)}</b> <span class="${tone(d)}">${arrow(d)}${sPct(pc)}</span></span>`; };
  const ids = S.watch;
  const order = [...ids].sort((x, y) => attention(y).score - attention(x).score);
  $('view').innerHTML = `
    <div class="card strip num">${ix('TAIEX', '加權')}${ix('TPEx', '櫃買')}${L?.breadth ? `<span>漲 <span class="up">${L.breadth.up}</span> · 跌 <span class="down">${L.breadth.dn}</span></span>` : ''}</div>
    ${order.map(card).join('') || '<p class="empty">還沒有自選股，到「設定」新增。</p>'}
    ${S.observe.length ? `<h2 class="small muted" style="margin:8px 0 0">觀察清單</h2>${S.observe.map(obsRow).join('')}` : ''}
    <p class="note">依「今天要不要看」排序 · 資料 ${L?.builtAt ? new Date(L.builtAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '–'} 更新<br><button type="button" class="btn" id="reload" style="margin-top:8px">重新整理</button></p>`;
  $('reload').onclick = () => refresh(true);
}
function card(id) {
  const a = S.an[id];
  if (!a) return `<a class="sc" href="#/s/${id}"><span class="r1"><span class="nm">${esc(nameOf(id))} <small class="muted">${id}</small></span><span class="muted small">載入中</span></span></a>`;
  if (a.empty) return `<a class="sc" href="#/s/${id}"><span class="r1"><span class="nm">${esc(nameOf(id))}</span><span class="muted small">查無資料</span></span></a>`;
  const at = attention(id);
  const dg = priceDigits(a.last.close);
  const col = a.chg >= 0 ? 'var(--up)' : 'var(--down)';
  return `<a class="sc ${at.level}" href="#/s/${id}">
    <span class="r1"><span class="nm">${esc(nameOf(id))} <small class="muted" style="font-weight:400">${id}</small></span>
    <span class="px num"><b>${fmtP(a.last.close, dg)}</b><br><span class="${tone(a.chg)} small">${arrow(a.chg)}${a.chg > 0 ? '+' : a.chg < 0 ? '−' : ''}${fmtP(Math.abs(a.chg), dg)}（${sPct(a.pct)}）</span></span></span>
    <span class="why">${at.level !== 'gray' ? `<span class="lvl ${at.level}">${LV[at.level]}</span>` : ''}${esc(at.why.slice(0, 2).join('、') || '沒有有效的新訊號')}</span>
    <svg viewBox="0 0 300 30" preserveAspectRatio="none" aria-hidden="true"><polyline points="${spark(a)}" fill="none" stroke="${col}" stroke-width="2" vector-effect="non-scaling-stroke"/></svg></a>`;
}
function obsRow(id) {
  const c = S.latest?.closes?.[id];
  return `<a class="sc" href="#/s/${id}" style="border-left-width:1px"><span class="r1"><span class="nm" style="font-size:1rem">${esc(nameOf(id))} <small class="muted" style="font-weight:400">${id}</small></span><span class="px num">${c ? `<b>${fmtP(c[0])}</b> <span class="${tone(c[1])} small">${sPct(c[1])}</span>` : ''}</span></span></a>`;
}

// ---------- 個股頁 ----------
async function viewStock(id) {
  setHead(id, nameOf(id));
  if (!S.an[id]) { $('view').innerHTML = '<p class="empty">載入中…</p>'; await loadOne(id); }
  const a = S.an[id];
  if (!a || a.empty) { $('view').innerHTML = `<a class="back" href="#/">‹ 自選股</a><p class="empty">查無 ${esc(id)} 的資料</p>`; return; }
  loadAnns(id).then(() => { const el = $('annBox'); if (el) el.innerHTML = annHTML(id); });
  const dg = priceDigits(a.last.close);
  const inWatch = S.watch.includes(id), inObs = S.observe.includes(id);
  const rel = relOf(id);
  $('view').innerHTML = `
    <a class="back" href="#/">‹ 自選股</a>
    <div class="sh"><span><span class="nm">${esc(nameOf(id))}</span> <span class="muted small">${id}</span><br><span class="muted small">${esc((S.info[id]?.industries || []).join('、'))}</span></span>
      <span class="px num" style="text-align:right"><b>${fmtP(a.last.close, dg)}</b><br><span class="${tone(a.chg)}">${arrow(a.chg)}${a.chg > 0 ? '+' : a.chg < 0 ? '−' : ''}${fmtP(Math.abs(a.chg), dg)}（${sPct(a.pct)}）</span></span></div>
    <span class="muted small">資料日期 ${a.last.time.replaceAll('-', '/')}${a.patched ? '（最新一天來自交易所）' : ''} · 量 ${fmtInt(a.last.volume)} 張</span>
    <div class="seg" role="group" aria-label="K 線週期">${[['d', '日K'], ['w', '週K'], ['m', '月K']].map(([v, l]) => `<button type="button" data-p="${v}" aria-pressed="${S.period === v}">${l}</button>`).join('')}</div>
    <div id="legend" class="legend num"></div>
    <div id="chart" class="chart"></div>
    <section class="card"><h2>今日重點</h2>${highlights(id)}</section>
    <section class="card"><h2>明天看哪些價位</h2>${ladder(a)}</section>
    <section class="card"><h2>今日訊號</h2><div class="tags">${a.events.length ? a.events.map((e) => { const r = rel?.[e.key]; return `<span class="tag ${tone(e.d)}${weakSignal(rel, e) ? ' weak' : ''}">${esc(e.t)}${r && r.n ? `<small>${r.verdict === 'few' ? r.n + ' 次' : Math.round(r.rate * 100) + '% 準'}</small>` : ''}</span>`; }).join('') : '<span class="empty">今天沒有新訊號</span>'}</div>
      ${a.states.length ? `<div class="tags" style="margin-top:6px">${a.states.map((s) => `<span class="tag">${esc(s.t)}</span>`).join('')}</div>` : ''}</section>
    <details class="card"><summary>三大法人（近 10 日，張）</summary>${instHTML(a, id)}</details>
    <details class="card"><summary>融資融券</summary>${marginHTML(a)}</details>
    <details class="card"><summary>月營收</summary>${revHTML(id)}</details>
    <details class="card"><summary>公司公告</summary><div id="annBox">${annHTML(id)}</div></details>
    <details class="card"><summary>新聞</summary>${newsHTML(a)}</details>
    <details class="card" id="relD"><summary>關聯脈絡</summary><div id="relBox" class="empty">打開時載入</div></details>
    <details class="card"><summary>對答案（近 20 個交易日）</summary>${reviewHTML(id)}</details>
    <div class="row">${inWatch ? `<button type="button" class="btn" id="unwatch">從自選股移除</button>` : `<button type="button" class="btn primary" id="addWatch">＋ 自選股</button>${inObs ? '' : '<button type="button" class="btn" id="addObs">＋ 觀察</button>'}`}</div>`;
  document.querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-p]'); if (!b) return; S.period = b.dataset.p; document.querySelectorAll('[data-p]').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); drawChart(a); };
  $('relD').addEventListener('toggle', () => { if ($('relD').open) relHTML(id); }, { once: true });
  if ($('addWatch')) $('addWatch').onclick = async () => { S.watch.push(id); await setWatchlist(S.watch); toast('已加入自选股'.replace('选', '選')); viewStock(id); };
  if ($('addObs')) $('addObs').onclick = async () => { S.observe.push(id); await setObserve(S.observe); toast('已加入觀察清單'); viewStock(id); };
  if ($('unwatch')) $('unwatch').onclick = async () => { S.watch = S.watch.filter((x) => x !== id); await setWatchlist(S.watch); toast('已移除'); location.hash = '#/'; };
  drawChart(a);
}
function highlights(id) {
  const a = S.an[id];
  const lines = [];
  const ev = useful(id);
  lines.push(ev.length ? ev.map((e) => e.t).join('、') : a.events.length ? '新訊號在本股歷史上都不準，不列入' : '沒有新訊號');
  const m = idxPct(isOtc(id) ? 'TPEx' : 'TAIEX');
  if (m != null && S.latest?.date === a.last.time) {
    const theme = (S.latest.themes || []).find((t) => t.ids.includes(id));
    const gap = a.pct - m;
    let v = Math.abs(gap) < 1.5 ? '和大盤差不多' : gap > 0 ? '強於大盤' : '弱於大盤';
    if (theme && Math.abs(a.pct - theme.r1) < Math.max(1, Math.abs(theme.r1) / 2) && Math.abs(theme.r1 - m) >= 0.8) v = '跟著族群一起動';
    lines.push(`漲跌拆解：本股 <span class="${tone(a.pct)}">${sPct(a.pct)}</span>、${isOtc(id) ? '櫃買' : '加權'} <span class="${tone(m)}">${sPct(m)}</span>${theme ? `、${esc(theme.name)} <span class="${tone(theme.r1)}">${sPct(theme.r1)}</span>` : ''}，${v}`);
  }
  const fs = streak(a.inst.map((x) => x.foreign));
  if (fs.n >= 2) lines.push(`外資連 ${fs.n} ${fs.dir > 0 ? '買' : '賣'}`);
  return `<ul class="list">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`;
}
function ladder(a) {
  const lv = a.levels || {};
  const dg = priceDigits(a.last.close);
  const c = a.last.close;
  const ma = sma(a.daily, 20).at(-1)?.value;
  const rows = [];
  if (lv.res2) rows.push(['up', '壓力 2', lv.res2.price, '站上就沒有近半年的壓力']);
  if (lv.res) rows.push(['up', '壓力', lv.res.price, `收盤站上 ${fmtP(lv.res.price * 1.01, dg)} 才算突破`]);
  if (ma) rows.push(['', '月線', ma, c >= ma ? '跌回以下短線轉弱' : '收回以上短線轉強']);
  rows.push(['now', '今日', c, '']);
  if (lv.sup) rows.push(['down', '支撐', lv.sup.price, `跌破 ${fmtP(lv.sup.price * 0.99, dg)} 算跌破${lv.sup2 ? `，下一道 ${fmtP(lv.sup2.price, dg)}` : ''}`]);
  if (lv.sup2) rows.push(['down', '支撐 2', lv.sup2.price, '近半年低點區']);
  rows.sort((x, y) => y[2] - x[2]);
  return `<div class="lad num">${rows.map(([k, l, p, t]) => `<b class="${k === 'now' ? 'now' : k}">${fmtP(p, dg)}</b><span class="muted small">${l}${k === 'now' ? '' : ' ' + sPct((p / c - 1) * 100, 1)}</span><span class="small">${esc(t)}</span>`).join('')}</div>`;
}
function instHTML(a, id) {
  const r = a.inst;
  if (!r.length) return '<p class="empty">無資料</p>';
  const sum = (k) => r.reduce((s, x) => s + x[k], 0);
  const q = S.latest?.qfii?.map?.[id];
  return `${[['外資', 'foreign'], ['投信', 'trust'], ['自營商', 'dealer']].map(([l, k]) => `<div class="kv"><span>${l}</span><b class="num ${tone(sum(k))}">${sInt(sum(k))} 張</b></div>`).join('')}
    ${q ? `<div class="kv"><span>外資持股</span><b class="num">${fmtInt(q[0])} 張（${q[1].toFixed(2)}%）</b></div>` : ''}
    <ul class="list num small" style="margin-top:6px">${r.slice().reverse().slice(0, 10).map((x) => `<li style="display:flex;justify-content:space-between"><span>${md(x.date)}</span><span class="${tone(x.total)}">合計 ${sInt(x.total)}</span></li>`).join('')}</ul>`;
}
function marginHTML(a) {
  const m = a.margin;
  if (!m) return '<p class="empty">無資料</p>';
  return `<div class="kv"><span>融資餘額</span><b class="num">${fmtInt(m.fin)} 張</b></div><div class="kv"><span>融資 5 日變化</span><b class="num ${tone(m.finChg)}">${sPct(m.finChg, 1)}</b></div><div class="kv"><span>融券餘額</span><b class="num">${fmtInt(m.short)} 張</b></div><div class="kv"><span>券資比</span><b class="num">${m.ratio == null ? '–' : m.ratio.toFixed(1) + '%'}</b></div><p class="muted small">資料日期 ${md(m.date)}</p>`;
}
function revHTML(id) {
  const rows = revenueSeries(S.data[id]?.revenue || []).slice(-6).reverse();
  if (!rows.length) return '<p class="empty">無資料</p>';
  return rows.map((r) => `<div class="kv num"><span>${r.label}</span><span>${(r.revenue / 1e8).toFixed(2)} 億　<span class="${tone(r.yoy)}">年 ${sPct(r.yoy, 1)}</span></span></div>`).join('');
}
function annHTML(id) {
  const l = S.anns[id];
  if (!l) return '<p class="empty">載入中</p>';
  if (!l.length) return '<p class="empty">近 45 天沒有公告</p>';
  return `<ul class="list">${l.slice(0, 15).map((x) => `<li><span class="muted small num">${md(x.d)} ${x.t}</span><br>${esc(x.s)}</li>`).join('')}</ul>`;
}
function newsHTML(a) {
  const l = (a.news || []).filter((n) => /^https?:/.test(n.link || ''));
  if (!l.length) return '<p class="empty">近期沒有新聞</p>';
  return `<ul class="list">${l.slice(0, 10).map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><br><span class="muted small">${md(n.date)} · ${esc(n.source || '')}</span></li>`).join('')}</ul>`;
}
async function relHTML(id) {
  const box = $('relBox');
  const list = await getRelations(id);
  const a = S.an[id];
  const ss = a.daily.map((x) => [x.time, x.close]);
  const rows = [];
  for (const e of list) {
    if (e.kind === 'tw' && e.id !== 'TAIEX') { const c = S.latest?.closes?.[e.id]; rows.push(`<li style="display:flex;justify-content:space-between;gap:8px"><span><a href="#/s/${e.id}">${esc(e.name || e.id)}</a> <span class="muted small">${esc(e.rel)}</span></span><span class="num">${c ? `${fmtP(c[0])} <span class="${tone(c[1])}">${sPct(c[1])}</span>` : ''}</span></li>`); continue; }
    let m = null;
    try { m = relationMetrics(ss, await loadEntity(e), e.kind); } catch (err) { /* 略過 */ }
    rows.push(`<li style="display:flex;justify-content:space-between;gap:8px"><span>${esc(e.name || e.id)} <span class="muted small">${esc(e.rel)}</span></span><span class="num">${m ? `${fmtP(m.value, e.kind === 'fx' ? 3 : 2)} <span class="${tone(m.r1)}">${sPct(m.r1)}</span> <span class="muted small">相關 ${m.corr == null ? '–' : m.corr.toFixed(2)}</span>` : '–'}</span></li>`);
  }
  box.className = '';
  box.innerHTML = rows.length ? `<ul class="list">${rows.join('')}</ul><p class="muted small">美股為前一晚收盤；相關係數為近 60 日。</p>` : '<p class="empty">沒有內建關聯，可在電腦版新增</p>';
}
function reviewHTML(id) {
  let r = null;
  try { r = reviewStock(patchData(S.data[id], S.latest?.detail, id)); } catch (e) { r = null; }
  if (!r || !r.days.length) return '<p class="empty">近期沒有可對答案的提醒</p>';
  return `<p class="small">方向訊號 ${r.total} 次，3 日後方向正確 ${r.hit} 次${r.total ? `（${Math.round((r.hit / r.total) * 100)}%）` : ''}</p>
    <ul class="list small">${r.days.slice(0, 5).map((d) => `<li><span class="num muted">${md(d.date)}</span> ${d.items.map((x) => `${esc(x.t)} → <b>${x.res}</b>`).join('；')}</li>`).join('')}</ul>`;
}
function drawChart(a) {
  const el = $('chart');
  if (!el || !window.LightweightCharts) return;
  if (S.chart) { try { S.chart.remove(); } catch (e) { /* 略過 */ } }
  const LC = window.LightweightCharts;
  const cfg = PERIODS[S.period];
  const c = aggregate(a.daily, S.period);
  const dg = priceDigits(a.last.close);
  const cs = getComputedStyle(document.documentElement);
  const up = cs.getPropertyValue('--up').trim(), dn = cs.getPropertyValue('--down').trim();
  const fsz = Math.round(11 * (parseFloat(cs.fontSize) / 16));
  const chart = LC.createChart(el, { autoSize: true, layout: { background: { type: 'solid', color: '#FFFFFF' }, textColor: '#5C5C5C', fontSize: fsz }, grid: { vertLines: { color: '#F3F1EC' }, horzLines: { color: '#F3F1EC' } }, rightPriceScale: { borderColor: '#E2E0DA' }, timeScale: { borderColor: '#E2E0DA', rightOffset: 2 }, crosshair: { mode: LC.CrosshairMode.Normal }, localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' }, handleScroll: { vertTouchDrag: false } });
  S.chart = chart;
  const pf = { type: 'price', precision: dg, minMove: Math.pow(10, -dg) };
  const candle = chart.addSeries(LC.CandlestickSeries, { upColor: up, downColor: dn, wickUpColor: up, wickDownColor: dn, borderVisible: false, priceFormat: pf, priceLineVisible: false });
  candle.setData(c.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
  const vol = chart.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  vol.setData(c.map((x) => ({ time: x.time, value: x.volume, color: (x.close >= x.open ? up : dn) + '66' })));
  const mas = [[5, '#C9772B'], [20, '#3D6FD8']].map(([n, col]) => { const s = chart.addSeries(LC.LineSeries, { color: col, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false }); const d = sma(c, n); s.setData(d); return { n, col, m: new Map(d.map((x) => [x.time, x.value])) }; });
  const lv = levels(c, cfg.k, cfg.win);
  const line = (z, t, strong) => z && candle.createPriceLine({ price: z.price, color: strong ? '#1A1A1A' : '#9A968C', lineWidth: 1, lineStyle: strong ? LC.LineStyle.Dashed : LC.LineStyle.Dotted, axisLabelVisible: true, title: t });
  line(lv.res, '壓', true); line(lv.sup, '撐', true); line(lv.res2, '', false); line(lv.sup2, '', false);
  const bk = breakouts(c, cfg.look);
  LC.createSeriesMarkers(candle, bk.map((b) => ({ time: b.time, position: b.type === 'up' ? 'aboveBar' : 'belowBar', color: b.type === 'up' ? up : dn, shape: b.type === 'up' ? 'arrowUp' : 'arrowDown' })));
  const n = c.length;
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - Math.min(cfg.show, 70)), to: n + 1 });
  const legend = (i) => { const x = c[i]; if (!x) return; $('legend').innerHTML = `<span>${x.time.replaceAll('-', '/')}</span><span>開 ${fmtP(x.open, dg)}</span><span>高 ${fmtP(x.high, dg)}</span><span>低 ${fmtP(x.low, dg)}</span><span>收 <b>${fmtP(x.close, dg)}</b></span>${mas.map((m) => `<span style="color:${m.col}">MA${m.n} ${m.m.get(x.time) ? fmtP(m.m.get(x.time), dg) : '–'}</span>`).join('')}`; };
  legend(n - 1);
  chart.subscribeCrosshairMove((p) => { const i = p && p.logical != null ? Math.round(p.logical) : n - 1; legend(i >= 0 && i < n ? i : n - 1); });
}

// ---------- 情報雷達 ----------
function linksFor(id) {
  const out = [];
  if (S.watch.includes(id)) out.push('自選股');
  if (S.observe.includes(id)) out.push('觀察清單');
  for (const w of S.watch) {
    if ((S.rel[w] || []).some((e) => e.kind === 'tw' && e.id === id)) out.push(`${nameOf(w)}的關聯`);
    if (w !== id && THEMES.some((t) => t.ids.includes(w) && t.ids.includes(id))) out.push(`${nameOf(w)}同題材`);
  }
  return [...new Set(out)];
}
async function viewRadar() {
  setHead('INTEL RADAR', '情報雷達');
  const items = await loadIntel();
  for (const w of S.watch) if (!S.rel[w]) S.rel[w] = await getRelations(w);
  const dates = [...new Set(items.map((x) => x.d))].sort().reverse();
  const f = S.rFilter;
  const since = dates[Math.min(f.days, dates.length) - 1] || '';
  const all = items.filter((x) => x.d >= since).map((x) => ({ ...x, links: linksFor(x.id) })).map((x) => ({ ...x, imp: x.important || x.links.length > 0 }));
  const shown = all.filter((x) => (f.cat === 'all' ? x.imp : x.cat === f.cat)).sort((a, b) => (b.links.length > 0) - (a.links.length > 0) || b.score - a.score);
  const cnt = {};
  for (const x of all) cnt[x.cat] = (cnt[x.cat] || 0) + 1;
  $('view').innerHTML = `
    <div class="seg" role="group" aria-label="期間">${[[1, '最新一天'], [5, '近 5 天'], [20, '近 20 天']].map(([v, l]) => `<button type="button" data-days="${v}" aria-pressed="${f.days === v}">${l}</button>`).join('')}</div>
    <div class="chips" role="group" aria-label="類別"><button type="button" data-cat="all" aria-pressed="${f.cat === 'all'}">重要情報</button>${Object.entries(CATS).filter(([k]) => cnt[k]).map(([k, c]) => `<button type="button" data-cat="${k}" aria-pressed="${f.cat === k}">${c.name} ${cnt[k]}</button>`).join('')}</div>
    <p class="muted small">${since ? md(since) + ' 起' : ''}分類 ${all.length} 則，顯示 ${shown.length} 則</p>
    ${shown.slice(0, 50).map(intelCard).join('') || '<p class="empty">這段期間沒有達到門檻的情報</p>'}
    <p class="note">資料每個交易日收盤後由交易所公告整理</p>`;
  $('view').querySelector('.seg').onclick = (e) => { const b = e.target.closest('[data-days]'); if (b) { f.days = Number(b.dataset.days); viewRadar(); } };
  $('view').querySelector('.chips').onclick = (e) => { const b = e.target.closest('[data-cat]'); if (b) { f.cat = b.dataset.cat; viewRadar(); } };
}
function intelCard(it) {
  const c = CATS[it.cat] || { name: it.cat, color: '#555' };
  const r = it.react;
  const imp = impactText(it);
  const fl = [...it.links.map((l) => `<span class="flag link">${esc(l)}</span>`), r?.leaked ? `<span class="flag warn">公告前已漲 ${sPct(r.pre5, 1)}</span>` : '', it.report ? `<span class="flag">認列 ${esc(it.report.label)}</span>` : '', c.nature ? `<span class="flag">${c.nature}</span>` : ''].join('');
  return `<a class="card ic" href="#/s/${it.id}" style="text-decoration:none;color:inherit">
    <span class="top"><span class="cat" style="background:${c.color}">${c.name}</span><span class="imp ${it.cat === 'sell' ? tone(it.perShare ?? it.profit) : ''}">${esc(imp)}</span></span>
    <span class="t"><b>${esc(it.name && it.name !== it.id ? it.name : nameOf(it.id))}</b> <span class="muted small">${it.id} · ${md(it.d)}</span><br>${esc(it.s)}</span>
    ${r && !r.pending ? `<span class="m num">反應日 <span class="${tone(r.day)}">${sPct(r.day, 1)}</span> · 至今 <span class="${tone(r.since)}">${sPct(r.since, 1)}</span></span>` : ''}
    ${fl ? `<span>${fl}</span>` : ''}</a>`;
}

// ---------- 每週 ----------
async function viewWeek() {
  setHead('WEEKLY', '每週回顧');
  const cal = await getJSON('data/calendar.json').catch(() => ({ confs: {}, exr: {} }));
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  const end = new Date(Date.now() + 8 * 3600000 + 14 * 86400000).toISOString().slice(0, 10);
  const rows = S.watch.map((id) => {
    const a = S.an[id];
    if (!a || a.empty) return '';
    const w = aggregate(a.daily, 'w');
    const lw = w.at(-1), pw = w.at(-2);
    const ch = pw ? (lw.close / pw.close - 1) * 100 : null;
    const lv = levels(w, PERIODS.w.k, PERIODS.w.win);
    const dg = priceDigits(lw.close);
    return `<div class="kv num"><span><a href="#/s/${id}">${esc(nameOf(id))}</a></span><span>${fmtP(lw.close, dg)} <span class="${tone(ch)}">${sPct(ch, 1)}</span><br><span class="muted small">週壓 ${lv.res ? fmtP(lv.res.price, dg) : '–'} · 週撐 ${lv.sup ? fmtP(lv.sup.price, dg) : '–'}</span></span></div>`;
  }).join('');
  const ev = [];
  for (const id of S.watch) {
    for (const c of cal.confs?.[id] || []) if (c.date >= today && c.date <= end) ev.push([c.date, `${nameOf(id)} 法說會`]);
    for (const x of cal.exr?.[id] || []) if (x.date >= today && x.date <= end) ev.push([x.date, `${nameOf(id)} ${x.type || '除權息'}`]);
  }
  const y = Number(today.slice(0, 4));
  for (const [d, t] of [[`${y}-03-31`, '年報'], [`${y}-05-15`, '第一季財報'], [`${y}-08-14`, '第二季財報'], [`${y}-11-14`, '第三季財報']]) if (d >= today && d <= end) ev.push([d, `${t}公布期限（自選股全部）`]);
  const m10 = today.slice(0, 8) + '10';
  if (m10 >= today) ev.push([m10, '上月營收公布期限（自選股全部）']);
  ev.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  $('view').innerHTML = `<section class="card"><h2>本週自選股</h2>${rows || '<p class="empty">載入中</p>'}</section>
    <section class="card"><h2>未來兩週</h2>${ev.length ? `<ul class="list">${ev.map(([d, t]) => `<li><span class="num muted">${md(d)}</span>　${esc(t)}</li>`).join('')}</ul>` : '<p class="empty">沒有已知事件</p>'}</section>
    <p class="note">完整週報（含預估對照、族群）請用電腦版</p>`;
}

// ---------- 設定 ----------
async function viewSettings() {
  setHead('SETTINGS', '設定');
  const st = await getSettings();
  const list = (arr, key) => arr.map((id) => `<li><a href="#/s/${id}">${esc(nameOf(id))} <span class="muted small">${id}</span></a><button type="button" class="x" data-del="${key}:${id}" aria-label="移除 ${esc(nameOf(id))}">×</button></li>`).join('') || '<li class="empty">無</li>';
  $('view').innerHTML = `
    <section class="card"><h2>自選股</h2><ul class="list wl">${list(S.watch, 'w')}</ul>
      <form id="addF" class="row" style="margin-top:8px"><label class="sr" for="addI" style="position:absolute;left:-9999px">新增股票</label><input id="addI" list="stockList" placeholder="代號或名稱" autocomplete="off"><button class="btn primary" type="submit">新增</button></form><datalist id="stockList"></datalist></section>
    <section class="card"><h2>觀察清單</h2><ul class="list wl">${list(S.observe, 'o')}</ul></section>
    <section class="card"><h2>漲跌顏色</h2><div class="seg"><button type="button" data-conv="tw" aria-pressed="${st.convention !== 'us'}">紅漲綠跌</button><button type="button" data-conv="us" aria-pressed="${st.convention === 'us'}">綠漲紅跌</button></div></section>
    <section class="card"><h2>FinMind token（選填）</h2><p class="muted small">查詢太頻繁被擋時，到 finmindtrade.com 免費註冊後貼上。</p><form id="tokF" class="row"><input id="tokI" value="${esc(st.token || '')}" placeholder="token" autocomplete="off"><button class="btn" type="submit">儲存</button></form></section>
    <section class="card"><h2>加到主畫面</h2><p class="small">在 Safari 打開這個網址，按下方「分享」再選「加入主畫面」，之後就像 App 一樣從桌面開啟。自選股與設定只存在這支手機。</p></section>
    <p class="note">資料：FinMind、證交所、櫃買中心、集保 · 版本 1.2.0</p>`;
  $('stockList').innerHTML = Object.keys(S.info).filter((id) => /^\d{4}$/.test(id)).map((id) => `<option value="${id} ${esc(S.info[id].name)}"></option>`).join('');
  $('addF').onsubmit = async (e) => {
    e.preventDefault();
    const t = $('addI').value.trim();
    const m = t.match(/^(\d{4,6})/);
    const id = m ? m[1] : Object.keys(S.info).find((k) => S.info[k].name === t);
    if (!id) return toast('找不到「' + t + '」');
    if (!S.watch.includes(id)) { S.watch.push(id); await setWatchlist(S.watch); loadOne(id); }
    viewSettings();
  };
  $('view').querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    const [k, id] = b.dataset.del.split(':');
    if (k === 'w') { S.watch = S.watch.filter((x) => x !== id); await setWatchlist(S.watch); }
    else { S.observe = S.observe.filter((x) => x !== id); await setObserve(S.observe); }
    viewSettings();
  }));
  $('view').querySelectorAll('[data-conv]').forEach((b) => (b.onclick = async () => { await setSettings({ ...st, convention: b.dataset.conv }); document.documentElement.dataset.conv = b.dataset.conv; viewSettings(); }));
  $('tokF').onsubmit = async (e) => { e.preventDefault(); await setSettings({ ...st, token: $('tokI').value.trim() }); toast('已儲存'); };
}

// ---------- 路由 ----------
function setHead(eb, t) { $('eyebrow').textContent = eb; $('title').textContent = t; }
async function route() {
  const h = location.hash || '#/';
  const tab = h.startsWith('#/radar') ? 'radar' : h.startsWith('#/week') ? 'week' : h.startsWith('#/settings') ? 'settings' : 'home';
  document.querySelectorAll('.tabs a').forEach((a) => a.setAttribute('aria-current', a.dataset.tab === tab ? 'page' : 'false'));
  if (S.chart && !h.startsWith('#/s/')) { try { S.chart.remove(); } catch (e) { /* 略過 */ } S.chart = null; }
  const m = h.match(/^#\/s\/(\w+)/);
  if (m) await viewStock(m[1]);
  else if (tab === 'radar') await viewRadar();
  else if (tab === 'week') await viewWeek();
  else if (tab === 'settings') await viewSettings();
  else await viewHome();
}
window.addEventListener('hashchange', () => { window.scrollTo(0, 0); route(); });

async function refresh(force = false) {
  if (force) { S.latest = null; S.intel = null; S.anns = {}; }
  await loadLatest();
  const ids = [...S.watch];
  for (let i = 0; i < ids.length; i += 2) {
    await Promise.all(ids.slice(i, i + 2).map((id) => Promise.all([loadOne(id, force), loadAnns(id)])));
    if ((location.hash || '#/') === '#/') viewHome();
  }
  route();
  loadIntel().then((items) => {
    const d = [...new Set(items.map((x) => x.d))].sort().at(-1);
    const n = items.filter((x) => x.d === d && (x.important || linksFor(x.id).length)).length;
    $('radarN').textContent = n ? String(n) : '';
  });
}

async function init() {
  let fs = '1';
  try { fs = localStorage.getItem('fs') || '1'; } catch (e) { /* 略過 */ }
  applyFs(fs);
  const st = await getSettings();
  document.documentElement.dataset.conv = st.convention || 'tw';
  [S.watch, S.observe] = await Promise.all([getWatchlist(), getObserve()]);
  try { S.info = await getStockInfo(); } catch (e) { S.info = {}; }
  await loadLatest();
  route();
  await refresh(false);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();

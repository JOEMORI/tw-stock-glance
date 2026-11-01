import { initScale, uiScale } from './lib/ui.js';
initScale();
import { getWatchlist, setWatchlist, getSettings, setSettings, getObserve, setObserve, getKeywords } from './lib/storage.js';
import { buildIntel } from './lib/intel.js';
import { loadStock, getCachedStock, getStockInfo, loadEntity, loadEntityLong, finmindUsage, pruneCaches, FM_LIMIT, loadFinancials } from './lib/api.js';
import { signalReliability, weakSignal, SIGNAL_DIR, analyze, aggregate, sma, levels, breakouts, PERIODS, priceDigits, streak, kd, rsi, macd, signalHistory, SIGNAL_NAMES, alertSignals, quarterly } from './lib/indicators.js';
import { getRelations, addRelation, removeRelation, relationMetrics, entityKey, getHidden, hasBuiltin } from './lib/relations.js';
import { ensureMarket, readMarket, ensureDetail, readDetail } from './lib/market.js';
import { patchData } from './lib/patch.js';
import { loadIndex } from './lib/indexes.js';
import { reviewStock, H as REVIEW_H } from './lib/review.js';
import { recordDay, loadJournal, itemsFromAnalysis, scorecard, JKEYS, HORIZONS, MIN_N } from './lib/journal.js';
import { THEMES, industryGroups, sectorTable, rankBy, screen, SCREEN, peers, marketSeries, metrics, SKIP_INDUSTRY } from './lib/sectors.js';
import { collectConferences } from './lib/conferences.js';
import { loadCalendar, addCustomEvent, removeCustomEvent } from './lib/calendar.js';
import { loadShareholding, holdingSeries } from './lib/tdcc.js';
import { googleNews } from './lib/gnews.js';
import { initHolidays, gapNote } from './lib/holidays.js';
import { loadForeignHolding } from './lib/qfii.js';
import { collectAnnouncements } from './lib/announce.js';
import { lastReadyTime } from './lib/time.js';
import { $, esc, fmtP, fmtInt, sInt, sPct, tone, arrow, md, fmtCorr, palette, segHTML } from './lib/format.js';

const LC = window.LightweightCharts;

// 可點的股票名稱：點了開啟該股的速覽
const stockLink = (id, name, cls = '') => `<a href="#${esc(id)}" class="stock-link ${cls}" data-open="${esc(id)}">${esc(name || id)}</a>`;

const state = {
  watch: [], info: {}, data: {}, an: {}, cur: null, period: 'd', settings: null, chart: null, busy: false,
  rel: {}, market: null, secMode: 'theme', secPeriod: 'r5', secSel: null,
  sh: null, gn: {}, relNews: {}, cal: {}, relM: {}, confs: {}, ind: 'none', cmp: 'none', cmpData: {}, alerts: {}, hist: {}, fin: {},
};

function nameOf(id) {
  return state.info[id]?.name || id;
}

function setStatus(text, isErr = false) {
  const el = $('status');
  el.textContent = text;
  el.classList.toggle('err', isErr);
}

// ---------- 自選股 ----------
// 自選股只用一張總表呈現；頂端固定列的股票按鈕用來在看細節時快速切換
function renderWatch() {
  const ord = displayOrder();
  const ids = state.watch.includes(state.cur) || !state.cur ? ord : [...ord, state.cur];
  $('pills').innerHTML = ids.map((id) => {
    const a = state.an[id];
    const pct = a && !a.empty ? `<span class="num ${tone(a.chg)}">${sPct(a.pct, 1)}</span>` : '';
    const extra = state.watch.includes(id) ? '' : ' extra';
    return `<button type="button" class="pill${extra}" data-pick="${esc(id)}" aria-current="${id === state.cur}">${esc(nameOf(id))}${pct}</button>`;
  }).join('');
  renderOverview();
}

$('pills').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pick]');
  if (b) openStock(b.dataset.pick, true);
});

$('ovList').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    e.stopPropagation();
    const id = del.dataset.del;
    state.watch = state.watch.filter((x) => x !== id);
    await setWatchlist(state.watch);
    if (state.cur === id && state.watch.length) selectStock(state.watch[0]);
    else renderWatch();
    renderMain();
    return;
  }
  if (e.target.closest('a, button')) return;
  const tr = e.target.closest('[data-row]');
  if (tr) openStock(tr.dataset.row, true);
});

// 側欄收合：狀態記在本機
function setSide(collapsed) {
  document.body.classList.toggle('side-collapsed', collapsed);
  chrome.storage.local.set({ sideCollapsed: collapsed }); // K 線圖會自動依新寬度重排
}
$('sideToggle').addEventListener('click', () => setSide(true));
$('sideOpen').addEventListener('click', () => setSide(false));
chrome.storage.local.get('sideCollapsed').then(({ sideCollapsed }) => document.body.classList.toggle('side-collapsed', !!sideCollapsed));

document.querySelector('.jump-links').addEventListener('click', (e) => {
  const b = e.target.closest('[data-jump]');
  if (b) document.getElementById(b.dataset.jump)?.scrollIntoView({ behavior: 'smooth' });
});

$('addForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const msg = $('addMsg');
  const id = resolveStock($('addInput').value);
  if (!id) return (msg.textContent = '找不到「' + $('addInput').value.trim() + '」，請輸入代號或完整名稱');
  if (state.watch.includes(id)) return (msg.textContent = id + ' 已在自選股');
  if (Object.keys(state.info).length && !state.info[id]) return (msg.textContent = '查無代號 ' + id);
  state.watch.push(id);
  await setWatchlist(state.watch);
  $('addInput').value = '';
  msg.textContent = '已加入 ' + nameOf(id);
  selectStock(id);
  await loadOne(id, false);
});

// 代號或名稱轉成代號：接受「2330」「2330 台積電」「台積電」，名稱只有一個符合時才採用
function resolveStock(text) {
  const t = String(text || '').trim();
  if (!t) return null;
  const m = t.toUpperCase().match(/^(\d{4,6}[A-Z]?)\b/);
  if (m) return m[1];
  const ids = Object.keys(state.info);
  const exact = ids.filter((id) => state.info[id]?.name === t);
  if (exact.length) return exact[0];
  const part = ids.filter((id) => (state.info[id]?.name || '').includes(t) && /^\d{4}$/.test(id));
  return part.length === 1 ? part[0] : null;
}
function fillStockList() {
  const ids = Object.keys(state.info).filter((id) => /^\d{4}[A-Z]?$/.test(id));
  $('stockList').innerHTML = ids.map((id) => `<option value="${id} ${esc(state.info[id].name)}"></option>`).join('');
}
$('findForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = resolveStock($('findInput').value);
  if (!id) return setStatus('找不到「' + $('findInput').value.trim() + '」', true);
  $('findInput').value = '';
  $('findInput').blur();
  openStock(id);
});
// 從下拉選單點選時直接開啟
$('findInput').addEventListener('input', (e) => {
  if (e.inputType === 'insertReplacementText' || !e.inputType) { const id = resolveStock(e.target.value); if (id && /\s/.test(e.target.value)) $('findForm').requestSubmit(); }
});
// 鍵盤：← → 切換自選股，/ 跳到查詢框
document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === '/') { e.preventDefault(); $('findInput').focus(); return; }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (!state.watch.length) return;
  const ord = displayOrder();
  const i = ord.indexOf(state.cur);
  const n = ord.length;
  const next = ord[i < 0 ? 0 : (i + (e.key === 'ArrowRight' ? 1 : -1) + n) % n];
  e.preventDefault();
  openStock(next, false);
});

function selectStock(id) {
  state.cur = id;
  history.replaceState(null, '', '#' + id);
  renderWatch();
  renderMain();
  loadRelations(id);
  if (!state.an[id]) loadOne(id, false);
  if (state.scoreCur) renderScore();
  loadFin(id);
}

// 從族群、同業、強勢股、關聯、行事曆點進來的股票（可以不在自選股）
const isStockId = (id) => /^\d{4,6}[A-Z]?$/.test(id || '');
function openStock(id, scroll = true) {
  if (!isStockId(id)) return;
  if (id !== state.cur) selectStock(id);
  if (scroll) document.getElementById('secChart').scrollIntoView({ behavior: 'smooth' });
  finmindUsage().then((n) => { if (n >= FM_LIMIT - 30) setStatus(`FinMind 本小時已查詢 ${n} 次，接近上限 ${FM_LIMIT}，之後點開的股票可能暫時抓不到`, true); });
}
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-open]');
  if (!a) return;
  e.preventDefault();
  openStock(a.dataset.open);
});
// 網址 # 只記錄股票代號；區塊跳轉不改網址，避免把區塊名稱當成股票代號
window.addEventListener('hashchange', () => openStock(decodeURIComponent(location.hash.slice(1))));
$('sWatch').addEventListener('click', async () => {
  if (state.watch.includes(state.cur)) return;
  state.watch.push(state.cur);
  await setWatchlist(state.watch);
  renderWatch();
  renderMain();
  await loadOne(state.cur, false); // 補抓完整資料（含新聞）
  loadOverviewCal();
});

// ---------- 關聯脈絡 ----------
async function loadRelations(id) {
  const list = await getRelations(id);
  state.rel[id] = list.map((e) => ({ e, series: state.rel[id]?.find((r) => entityKey(r.e) === entityKey(e))?.series || null, err: null }));
  renderRelations();
  for (const r of state.rel[id]) {
    if (r.series) continue;
    try {
      r.series = await entitySeries(r.e);
    } catch (err) {
      r.err = err.message;
    }
    if (state.cur === id) renderRelations();
  }
  await injectAuto(id);
  loadCal(id);
  loadRelNews(id);
}

// 沒有內建關聯的股票：從全市場找近 60 日走勢最接近的同業，自動列為關聯（用全市場行情，不佔 FinMind 額度）
async function injectAuto(id) {
  const m = state.market;
  if (!m || m.dates.length < 30 || hasBuiltin(id) || !state.rel[id]) return;
  const hidden = await getHidden(id);
  const have = new Set(state.rel[id].map((r) => entityKey(r.e)));
  const p = peers(m, state.info, id);
  const top = p.rows.filter((r) => !r.self && r.corr != null && r.corr >= 0.3).sort((x, y) => y.corr - x.corr).slice(0, 3);
  for (const t of top) {
    const e = { kind: 'tw', id: t.id, name: t.name, rel: '高相關同業（自動）', why: `近 60 日走勢相關 ${t.corr.toFixed(2)}，同屬${p.sources.join('、')}`, auto: true };
    if (have.has(entityKey(e)) || hidden.has(entityKey(e))) continue;
    state.rel[id].push({ e, series: marketSeries(m, t.id), err: null });
  }
  if (state.cur === id) renderRelations();
}

function renderRelations() {
  const id = state.cur;
  if (!state.rel[id]) {
    $('relations').innerHTML = '<span class="empty">關聯資料載入中</span>';
    $('relNote').textContent = '';
    return;
  }
  const list = state.rel[id];
  const a = state.an[id];
  const ss = a && !a.empty ? a.daily.map((x) => [x.time, x.close]) : null;
  const rows = list.map((r) => ({ ...r, m: ss && r.series ? relationMetrics(ss, r.series, r.e.kind) : null }));
  state.relM[id] = rows;
  $('relations').innerHTML = rows.length
    ? rows.map(({ e, m, err }) => {
        const where = e.kind === 'us' ? '美股' : e.kind === 'fx' ? '匯率' : e.id === 'TAIEX' ? '指數' : '台股';
        const unit = e.kind === 'us' ? ' <span class="rel-unit">美元</span>' : e.kind === 'fx' ? ' <span class="rel-unit">台幣</span>' : '';
        const dg = e.kind === 'fx' ? 3 : e.id === 'TAIEX' ? 2 : null;
        const price = m
          ? `<span class="rel-price num">${fmtP(m.value, dg ?? priceDigits(m.value))}${unit}<span class="rel-chg ${tone(m.r1)}">${arrow(m.r1)}${sPct(m.r1)}</span></span>`
          : `<span class="rel-price muted small">${err ? esc(err) : '載入中'}</span>`;
        const meta = m
          ? `<span class="rel-meta num"><span>${e.kind === 'us' ? '美股 ' : ''}${md(m.date)} 收盤</span><span>5 日 <span class="${tone(m.r5)}">${sPct(m.r5, 1)}</span></span><span>相關 ${fmtCorr(m.corr)}（上週 ${fmtCorr(m.corrPrev)}）</span></span>`
          : '';
        const clickable = e.kind !== 'tw' || e.id === 'TAIEX';
        return `<div class="rel${clickable ? ' rel-click' : ''}"${clickable ? ` data-ent="${esc(JSON.stringify({ kind: e.kind, id: e.id, name: e.name, q: e.q || e.kw }))}" title="點開看走勢"` : ''}><span class="rel-tag">${esc(e.rel)} · ${where}</span><span class="rel-name">${e.kind === 'tw' && e.id !== 'TAIEX' ? stockLink(e.id, e.name) : esc(e.name || e.id)} <span class="rel-id num">${esc(e.id)}</span></span>${price}${meta}${e.why ? `<span class="rel-why">${esc(e.why)}</span>` : ''}<button type="button" class="rel-del" data-key="${esc(entityKey(e))}" aria-label="移除關聯 ${esc(e.name || e.id)}">×</button></div>`;
      }).join('')
    : '<span class="empty">尚未設定關聯對象，可在下方新增</span>';
  const scored = rows.filter((r) => r.m && r.m.corr != null && r.e.kind !== 'fx').sort((x, y) => y.m.corr - x.m.corr);
  const top = scored[0];
  const weak = scored.filter((r) => Math.abs(r.m.corr) < 0.2).map((r) => r.e.name || r.e.id);
  $('relNote').textContent = top
    ? `近 60 日與 ${top.e.name || top.e.id} 連動最明顯（相關 ${fmtCorr(top.m.corr)}）。` + (weak.length ? `${weak.join('、')} 的相關係數低於 0.2，日常股價幾乎不跟著它走，關係較偏基本面而非短線連動。` : '')
    : '';
  renderHighlights();
  journalToday();
  // 關聯載入後，比較選單補上關聯對象；之前選的對象這時才出現就重畫
  const had = $('cmpSel').value;
  const pick = fillCmpSel();
  if (pick?.key !== had && a && !a.empty) renderChart(a);
}

$('relations').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-key]');
  if (!b) {
    const t = e.target.closest('[data-ent]');
    if (t && !e.target.closest('a')) openEntity(JSON.parse(t.dataset.ent));
    return;
  }
  await removeRelation(state.cur, b.dataset.key);
  state.rel[state.cur] = (state.rel[state.cur] || []).filter((r) => entityKey(r.e) !== b.dataset.key);
  renderRelations();
});

$('relForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = $('relKind').value;
  const id = $('relId').value.trim().toUpperCase();
  const rel = $('relRel').value.trim();
  if (!id || !rel) return;
  if (kind === 'tw' && !/^\d{4,6}[A-Z]?$/.test(id) && id !== 'TAIEX') return ($('relMsg').textContent = '台股請輸入數字代號');
  const name = $('relName').value.trim() || (kind === 'tw' ? state.info[id]?.name : '') || id;
  const ent = { kind, id, name, rel, why: $('relWhy').value.trim() };
  $('relMsg').textContent = '查詢 ' + id + ' 中';
  try {
    await loadEntity(ent);
  } catch (err) {
    return ($('relMsg').textContent = '查不到 ' + id + '：' + err.message);
  }
  await addRelation(state.cur, ent);
  $('relMsg').textContent = '已加入 ' + name;
  e.target.reset();
  loadRelations(state.cur);
});

// ---------- 同業比較 ----------
const PEER_SHOW = 12;
state.peerSort = 'corr';
state.peerAll = false;

function renderPeers() {
  $('peerSort').innerHTML = segHTML([{ l: '相關', v: 'corr' }, { l: '今日', v: 'r1' }, { l: '5 日', v: 'r5' }, { l: '20 日', v: 'r20' }], state.peerSort);
  const m = state.market;
  if (!m || m.dates.length < 2 || !state.cur) {
    $('peers').innerHTML = '<tr><td class="l empty" colspan="8">全市場行情載入後顯示</td></tr>';
    $('peerNote').textContent = '';
    return;
  }
  const p = peers(m, state.info, state.cur);
  if (p.rows.length < 2) {
    $('peers').innerHTML = '<tr><td class="l empty" colspan="8">找不到同業分類，可在關聯脈絡自行加入比較對象</td></tr>';
    $('peerNote').textContent = '';
    return;
  }
  const k = state.peerSort;
  // 本身置頂，同題材的同業排在前面，其餘依選擇的欄位排序
  const rows = p.rows.slice().sort((a, b) => (a.self ? -1 : b.self ? 1 : a.themed !== b.themed ? (a.themed ? -1 : 1) : (b[k] ?? -9) - (a[k] ?? -9)));
  const self = p.rows.find((r) => r.self);
  const by5 = p.rows.filter((r) => r.r5 != null).sort((a, b) => b.r5 - a.r5);
  const rank = by5.findIndex((r) => r.self) + 1;
  $('peerNote').textContent = `來源：${p.sources.join('、')}，共 ${p.rows.length - 1} 檔同業 · 相關係數為近 ${p.days} 個交易日` + (self && rank ? ` · ${nameOf(state.cur)} 5 日漲幅在同業中排第 ${rank}` : '');
  const shown = rows;
  $('peers').innerHTML = shown.map((x) => `<tr${x.self ? ' class="self"' : ''}><td class="l${x.self || state.watch.includes(x.id) ? ' hold' : ''}">${x.self ? esc(x.name) : stockLink(x.id, x.name)} <span class="muted small">${x.id}</span>${x.themed && !x.self ? ' <span class="tag small">同題材</span>' : ''}</td><td>${fmtP(x.close)}</td>${chgTd(x, 1)}${chgTd(x, 5)}${chgTd(x, 20)}<td>${x.vr == null ? '–' : x.vr.toFixed(1)}</td><td class="${tone(x.fs)}">${x.fs > 0 ? '連 ' + x.fs + ' 買' : x.fs < 0 ? '連 ' + -x.fs + ' 賣' : '–'}</td><td>${x.self ? '–' : fmtCorr(x.corr)}</td></tr>`).join('');
}

$('peerSort').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.peerSort = b.dataset.v;
  renderPeers();
});

// ---------- 族群強弱與強勢股 ----------
function currentGroups() {
  const m = state.market;
  if (state.secMode === 'theme') return THEMES;
  const last = m.prices[m.prices.length - 1] || {};
  return industryGroups(state.info, Object.keys(last));
}

// 漲跌儲存格：上面是漲跌（元），下面小字是百分比
function chgTd(x, n) {
  const d = x['d' + n], r = x['r' + n];
  if (r == null) return '<td>–</td>';
  const amt = d == null ? '' : (d > 0 ? '+' : d < 0 ? '−' : '') + fmtP(Math.abs(d), priceDigits(x.close));
  return `<td class="chg ${tone(r)}">${amt}<small>${sPct(r, 1)}</small></td>`;
}

function renderSectors() {
  const m = state.market;
  $('secMode').innerHTML = segHTML([{ l: '題材族群', v: 'theme' }, { l: '產業分類', v: 'industry' }], state.secMode);
  $('secPeriod').innerHTML = segHTML([{ l: '今日', v: 'r1' }, { l: '5 日', v: 'r5' }, { l: '20 日', v: 'r20' }], state.secPeriod);
  if (!m || m.dates.length < 2) {
    $('secList').innerHTML = '<span class="empty">全市場行情載入中，第一次約需 2 分鐘</span>';
    return;
  }
  const table = sectorTable(m, currentGroups(), state.info);
  const ranked = rankBy(table, state.secPeriod);
  const max = Math.max(1, ...ranked.map((s) => Math.abs(s[state.secPeriod])));
  if (!ranked.some((s) => s.name === state.secSel)) state.secSel = ranked[0]?.name || null;
  $('secNote').textContent = `資料日期 ${md(m.dates.at(-1))} · 族群漲幅為成分股平均 · 點族群看成分股` + (m.dates.length < 21 ? ' · 資料不足 20 天，20 日排名暫缺' : '');
  $('secList').innerHTML = ranked.map((s, i) => {
    const v = s[state.secPeriod];
    const w = (Math.abs(v) / max) * 50;
    return `<button type="button" class="sec-row${s.name === state.secSel ? ' on' : ''}" data-sec="${esc(s.name)}"><span class="muted num">${i + 1}</span><span>${esc(s.name)}</span><span class="bar"><i></i><span style="left:${v >= 0 ? 50 : 50 - w}%;width:${w}%;background:var(--${v >= 0 ? 'up' : 'down'})"></span></span><span class="num ${tone(v)}" style="text-align:right">${sPct(v, 1)}</span><span class="muted small num" title="今日上漲家數">${s.up}/${s.members.length}</span></button>`;
  }).join('');
  const sel = table.find((s) => s.name === state.secSel);
  $('secSelName').textContent = sel ? sel.name + ' 成分股' : '';
  $('secMembers').innerHTML = sel
    ? sel.members.slice().sort((a, b) => (b[state.secPeriod] ?? -999) - (a[state.secPeriod] ?? -999)).map((x) => `<tr><td class="l${state.watch.includes(x.id) ? ' hold' : ''}">${stockLink(x.id, x.name)} <span class="muted small">${x.id}</span></td><td>${fmtP(x.close)}</td>${chgTd(x, 1)}${chgTd(x, 5)}${chgTd(x, 20)}<td>${x.vr == null ? '–' : x.vr.toFixed(1)}</td><td class="${tone(x.fs)}">${x.fs > 0 ? '連 ' + x.fs + ' 買' : x.fs < 0 ? '連 ' + -x.fs + ' 賣' : '–'}</td></tr>`).join('')
    : '';

  const sc = screen(table);
  $('screenNote').textContent = `條件：${state.secMode === 'theme' ? '題材' : '產業'}族群 5 日漲幅前 ${SCREEN.topN} 名（${sc.top.join('、')}）· 站上 20 日線 · 量比 ${SCREEN.vr} 倍以上 · 外資連 ${SCREEN.fs} 日以上買超`;
  const card = (p) => `<div class="pick" data-open="${p.id}"><div class="pn">${stockLink(p.id, p.name)} <span class="muted small num">${p.id}</span></div><div class="pp num"><b>${fmtP(p.close)}</b> <span class="${tone(p.r1)}">${arrow(p.r1)}${chgTd(p, 1).replace(/<\/?td[^>]*>/g, '').replace('<small>', '（').replace('</small>', '）')}</span></div><span class="muted small">${esc(p.sector)} · 5 日 <span class="num ${tone(p.r5)}">${sPct(p.r5, 1)}</span></span><div class="tags">${p.checks.map((c) => `<span class="tag ${c.ok ? '' : 'miss'}">${esc(c.t)}</span>`).join('')}</div></div>`;
  $('picks').innerHTML = sc.picks.length ? sc.picks.map((p) => card(p)).join('') : '<span class="empty">今天沒有個股同時符合全部條件</span>';
  $('near').innerHTML = sc.near.map((p) => card(p, true)).join('');
  $('nearWrap').hidden = !sc.near.length;
}

$('secList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sec]');
  if (!b) return;
  state.secSel = b.dataset.sec;
  renderSectors();
});
$('secMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.secMode = b.dataset.v;
  state.secSel = null;
  renderSectors();
});
$('secPeriod').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.secPeriod = b.dataset.v;
  state.secSel = null;
  renderSectors();
});

async function loadMarket() {
  state.market = await readMarket();
  renderSectors();
  try {
    state.market = await ensureMarket({ onProgress: (t) => { if (!state.busy) setStatus(t); } });
    if (state.market.incomplete) setStatus(`全市場行情已有 ${state.market.dates.length} 天，部分日期下載失敗（交易所暫時限流），下次打開會自動補齊`);
  } catch (e) {
    setStatus('全市場行情：' + e.message, true);
  }
  renderSectors();
  renderPeers();
  renderMarketStrip();
  // 最新交易日明細（開高低收、三大法人）：FinMind 落後時補上自選股的最新一天
  try { applyDetail(await ensureDetail(state.market.dates.at(-1))); } catch (e) { /* 下次再補 */ }
  journalToday();
  renderObsSide();
  radarBadge();
  // 外資持股放在全市場行情之後下載，避免同時查證交所被限流
  const ld = latestDate();
  if (ld) loadForeignHolding(ld).then((v) => { state.qfii = v || false; const a = state.an[state.cur]; if (a && !a.empty) renderInst(a); }).catch(() => {});
  if (state.cur) injectAuto(state.cur);
}

// 大盤概況：加權、櫃買、漲跌家數、外資買賣超（約略）、前一晚美股半導體、匯率
// 指數改用交易所的日資料（收盤後約 14:30 就有），FinMind 的較長歷史只在交易所查不到時備用
function mergeIdx(rows, id) {
  const ex = state.idxRows?.[id];
  if (!ex || !ex.length) return rows;
  if (!rows || !rows.length) return ex;
  return [...rows.filter((r) => r[0] < ex[0][0]), ...ex];
}
// 關聯對象的收盤序列；加權、櫃買指數用交易所最新資料接在 FinMind 歷史後面
async function entitySeries(e) {
  if (e.kind !== 'tw' || (e.id !== 'TAIEX' && e.id !== 'TPEx')) return loadEntity(e);
  const ex = (await loadIndex(e.id)) || [];
  let base = [];
  try { base = await loadEntity(e); } catch (err) { if (!ex.length) throw err; }
  const exS = ex.map((x) => [x[0], x[4]]);
  return exS.length ? [...base.filter((x) => x[0] < exS[0][0]), ...exS] : base;
}
async function loadMarketStrip(force = false) {
  state.idxRows = state.idxRows || {};
  for (const [key, id] of [['taiex', 'TAIEX'], ['tpex', 'TPEx']]) {
    const rows = await loadIndex(id, { force });
    if (rows) { state.idxRows[id] = rows; state.mkt = state.mkt || {}; state.mkt[key] = rows.map((r) => [r[0], r[4]]); renderMarketStrip(); if (key === 'taiex') renderWatch(); }
  }
  const ents = [
    { key: 'taiex', e: { kind: 'tw', id: 'TAIEX' } },
    { key: 'tpex', e: { kind: 'tw', id: 'TPEx' } },
    { key: 'soxx', e: { kind: 'us', id: 'SOXX' } },
    { key: 'usd', e: { kind: 'fx', id: 'USD' } },
  ];
  state.mkt = state.mkt || {};
  for (const x of ents) {
    if (state.idxRows[x.e.id]) continue; // 交易所已有指數資料
    try { state.mkt[x.key] = await loadEntity(x.e); } catch (e) { /* 單項失敗略過 */ }
    renderMarketStrip();
  }
  if (state.cur) renderHighlights();
  // 匯率與原物料（第二列）
  for (const x of COMMOD) {
    try { state.mkt[x.key] = await loadEntity(x.e); } catch (e) { /* 單項失敗略過 */ }
    renderMarketStrip();
  }
}
// 匯率（台銀即期買入）與原物料；黃金用國際金價，白銀、銅、原油用美國 ETF 代表
const COMMOD = [
  { key: 'jpy', label: '日圓／台幣', dg: 4, e: { kind: 'fx', id: 'JPY', name: '日圓／台幣', q: '日圓 匯率' } },
  { key: 'eur', label: '歐元／台幣', dg: 3, e: { kind: 'fx', id: 'EUR', name: '歐元／台幣', q: '歐元 匯率' } },
  { key: 'cny', label: '人民幣／台幣', dg: 3, e: { kind: 'fx', id: 'CNY', name: '人民幣／台幣', q: '人民幣 匯率' } },
  { key: 'gold', label: '黃金（美元／盎司）', dg: 2, e: { kind: 'gold', id: 'GOLD', name: '國際金價', q: '國際金價 黃金' } },
  { key: 'slv', label: '白銀（SLV）', dg: 2, e: { kind: 'us', id: 'SLV', name: '白銀 ETF（SLV）', q: '白銀 價格' } },
  { key: 'cper', label: '銅（CPER）', dg: 2, e: { kind: 'us', id: 'CPER', name: '銅 ETF（CPER）', q: '銅價' } },
  { key: 'uso', label: '原油（USO）', dg: 2, e: { kind: 'us', id: 'USO', name: '原油 ETF（USO）', q: '國際油價 原油' } },
];

function renderMarketStrip() {
  const m = state.mkt || {};
  const chg = (s, dg = 2) => {
    if (!s || s.length < 2) return '–';
    const n = s.length;
    const d = s[n - 1][1] - s[n - 2][1];
    const r = (s[n - 1][1] / s[n - 2][1] - 1) * 100;
    return `<b>${fmtP(s[n - 1][1], dg)}</b> <span class="${tone(r)}">${arrow(r)}${d > 0 ? '+' : d < 0 ? '−' : ''}${fmtP(Math.abs(d), dg)}（${sPct(r)}）</span>`;
  };
  let taiex = m.taiex;
  const dx = state.detail?.idx?.taiex;
  if (dx && (!taiex?.length || state.detail.date > taiex.at(-1)[0])) taiex = [['', dx[0] - dx[1]], [state.detail.date, dx[0]]]; // 用交易所公布的漲跌點數
  const items = [['加權指數', chg(taiex), { kind: 'tw', id: 'TAIEX', name: '加權指數' }], ['櫃買指數', chg(m.tpex), { kind: 'tw', id: 'TPEx', name: '櫃買指數' }]];
  const mk = state.market;
  if (mk && mk.dates.length) {
    const last = mk.prices[mk.prices.length - 1];
    let up = 0, dn = 0, flat = 0;
    for (const v of Object.values(last)) { const r = v[2]; if (r > 0) up++; else if (r < 0) dn++; else flat++; }
    items.push([`漲跌家數 ${md(mk.dates.at(-1))}`, `<span class="up">漲 ${up}</span> · <span class="down">跌 ${dn}</span> · 平 ${flat}`]);
    const inst = mk.inst[mk.inst.length - 1];
    if (inst && mk.instDates.at(-1) === mk.dates.at(-1)) {
      let v = 0;
      for (const [id, net] of Object.entries(inst)) if (last[id]) v += net * last[id][0];
      const yi = v / 1e5;
      items.push(['外資買賣超（約）', `<b class="${tone(yi)}">${sInt(yi)} 億</b>`]);
    }
  }
  if (m.soxx) items.push(['美股半導體 ETF 前一晚', chg(m.soxx), { kind: 'us', id: 'SOXX', name: '美股半導體 ETF（SOXX）', q: '費城半導體 OR SOXX 半導體股' }]);
  if (m.usd) items.push(['美元／台幣', chg(m.usd, 3), { kind: 'fx', id: 'USD', name: '美元／台幣', q: '新台幣 匯率 美元' }]);
  const html = (list) => list.map(([k, v, e]) => (e
    ? `<button type="button" class="it it-click" data-ent="${esc(JSON.stringify(e))}" title="點開看走勢"><span>${k}</span><span>${v}</span></button>`
    : `<span class="it"><span>${k}</span><span>${v}</span></span>`)).join('');
  $('market').innerHTML = html(items);
  const c2 = COMMOD.filter((x) => m[x.key]).map((x) => [x.label, chg(m[x.key], x.dg), x.e]);
  $('market2').innerHTML = c2.length ? '<span class="mkt-h">匯率與原物料</span>' + html(c2) : '';
}

// ---------- 資料 ----------
const patchOne = (id, data) => patchData(data, state.detail, id);
function analyzeOne(id) {
  const data = state.data[id];
  if (!data) return;
  const pd = patchOne(id, data);
  const a = withAlerts(analyze(pd), id);
  if (a && pd.patched) a.patched = pd.patched;
  state.an[id] = a;
}
// 交易所明細到手後，重算所有已載入的股票
function applyDetail(d) {
  if (!d) return;
  state.detail = d;
  for (const id of Object.keys(state.data)) analyzeOne(id);
  renderWatch();
  renderOverview();
  renderAsOf();
  if (state.cur) renderMain();
  renderMarketStrip();
}

async function loadOne(id, force) {
  try {
    const data = await loadStock(id, { force, lite: !state.watch.includes(id), want: state.detail?.date });
    state.data[id] = data;
    analyzeOne(id);
    if (data.error && state.an[id]?.patched) return null; // FinMind 失敗但交易所已補上最新一天
    return data.error ? id + '：' + data.error + '（顯示上次資料）' : null;
  } catch (e) {
    return nameOf(id) + '：' + e.message;
  } finally {
    renderWatch();
    if (id === state.cur) renderMain();
  }
}

async function refreshAll(force) {
  if (state.busy) return;
  state.busy = true;
  $('refresh').disabled = true;
  const errors = [];
  // 目前看的股票先更新，其餘兩檔一組同時更新
  const order = [...state.watch].sort((x, y) => (x === state.cur ? -1 : y === state.cur ? 1 : 0));
  let done = 0;
  setStatus(`更新中 0/${order.length}`);
  for (let i = 0; i < order.length; i += 2) {
    const res = await Promise.all(order.slice(i, i + 2).map((id) => loadOne(id, force).finally(() => setStatus(`更新中 ${++done}/${order.length}`))));
    for (const err of res) if (err) errors.push(err);
  }
  state.busy = false;
  $('refresh').disabled = false;
  const times = Object.values(state.data).map((d) => d.fetchedAt).filter(Boolean);
  const t = times.length ? new Date(Math.max(...times)) : null;
  if (errors.length) setStatus(errors[0] + (errors.length > 1 ? ` 等 ${errors.length} 項` : ''), true);
  else {
    const last = latestDate();
    const gap = gapNote(last, lastReadyTime());
    setStatus((t ? '更新於 ' + t.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' }) : '') + (gap ? ` · 最新交易日 ${md(last)}；${gap}` : ''));
  }
  renderAsOf();
  renderOverview();
  loadOverviewCal();
}

function latestDate() {
  const dates = Object.values(state.an).filter((a) => a && !a.empty).map((a) => a.last.time);
  return dates.length ? dates.sort().at(-1) : null;
}
function renderAsOf() {
  const d = latestDate();
  $('asof').textContent = d ? d.replaceAll('-', '/') : '';
}

// ---------- 主畫面 ----------
function renderMain() {
  const id = state.cur;
  const a = id ? state.an[id] : null;
  if (!id) {
    $('sName').textContent = '請先新增自選股';
    return;
  }
  const info = state.info[id];
  $('sName').textContent = nameOf(id);
  $('sWatch').hidden = state.watch.includes(id);
  $('sObs').hidden = state.watch.includes(id) || (state.observe || []).includes(id);
  $('sMeta').textContent = [id, info ? (info.type === 'twse' ? '上市' : info.type === 'tpex' ? '上櫃' : info.type) : '', info?.industries?.join('、')].filter(Boolean).join(' · ');
  if (!a || a.empty) {
    $('sClose').textContent = '';
    $('sChg').textContent = '';
    $('stats').innerHTML = `<div class="stat"><span class="muted small">${a?.empty ? '查無行情資料' : '資料載入中，約數秒'}</span></div>`;
    return;
  }
  const dg = priceDigits(a.last.close);
  $('sClose').textContent = fmtP(a.last.close, dg);
  $('sChg').className = 'num ' + tone(a.chg);
  $('sChg').textContent = `${arrow(a.chg)}${a.chg > 0 ? '+' : a.chg < 0 ? '−' : ''}${fmtP(Math.abs(a.chg), dg)}（${sPct(a.pct)}）`;

  const ps = a.priceStreak;
  const stats = [
    ['資料日期', a.last.time.replaceAll('-', '/'), ''],
    ['昨收', fmtP(a.prev.close, dg), ''],
    ['振幅', sPct(((a.last.high - a.last.low) / a.prev.close) * 100).replace('+', ''), ''],
    ['成交量 / 昨量（張）', fmtInt(a.last.volume) + ' / ' + fmtInt(a.prev.volume), ''],
    ['本益比', a.per?.PER ? a.per.PER.toFixed(2) : '–', ''],
    ['殖利率', a.per?.dividend_yield ? a.per.dividend_yield.toFixed(2) + '%' : '–', ''],
    ['連漲連跌', ps.dir === 0 ? '平盤' : (ps.dir > 0 ? '連漲 ' : '連跌 ') + ps.n + ' 天', tone(ps.dir)],
  ];
  $('stats').innerHTML = stats.map(([k, v, c]) => `<div class="stat"><span class="muted small">${k}</span><b class="${c}">${esc(v)}</b></div>`).join('');

  renderChart(a);
  renderInst(a);
  renderMargin(a);
  renderRevenue(a);
  const rel = relOf(state.cur);
  $('signals').innerHTML = a.events.length
    ? a.events.map((s) => { const r = rel?.[s.key]; const badge = r && r.n ? `<small class="rel-b ${r.verdict}">${r.verdict === 'few' ? `歷史 ${r.n} 次` : `歷史 ${Math.round(r.rate * 100)}% 準`}</small>` : ''; return `<span class="tag ${tone(s.d)}${weakSignal(rel, s) ? ' weak' : ''}" title="${r && r.n ? `本股過去兩年出現 ${r.n} 次，5 日後方向符合 ${Math.round(r.rate * 100)}%${weakSignal(rel, s) ? '，不列入今日重點與通知' : ''}` : ''}">${esc(s.t)}${badge}</span>`; }).join('')
    : '<span class="empty">今天沒有新發生的訊號</span>';
  $('states').innerHTML = a.states.length
    ? a.states.map((s) => `<span class="tag state">${esc(s.t)}</span>`).join('')
    : '<span class="empty">無</span>';
  renderNews(a);
  renderRelations();
  renderPeers();
  renderCalendar();
  renderValuation(a);
  renderShareholding();
  renderRelNews();
  renderHighlights();
  renderSigHist(a);
  renderReview();
  renderLadder(a);
  renderAlertForm();
  renderFinancials();
}

function renderChart(a) {
  const cfg = PERIODS[state.period];
  const c = aggregate(a.daily, state.period);
  const dg = priceDigits(a.last.close);
  const col = palette();
  if (state.chart) state.chart.remove();
  const el = $('chart');
  el.classList.toggle('with-ind', state.ind !== 'none');
  $('indSeg').innerHTML = segHTML([{ l: '無', v: 'none' }, { l: 'KD', v: 'kd' }, { l: 'MACD', v: 'macd' }, { l: 'RSI', v: 'rsi' }], state.ind);
  const chart = LC.createChart(el, {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#FFFFFF' }, textColor: '#5C5C5C', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: Math.round(12 * uiScale()) },
    grid: { vertLines: { color: '#F3F1EC' }, horzLines: { color: '#F3F1EC' } },
    rightPriceScale: { borderColor: '#E2E0DA' },
    timeScale: { borderColor: '#E2E0DA', rightOffset: 4 },
    crosshair: { mode: LC.CrosshairMode.Normal },
    localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
  });
  state.chart = chart;
  const priceFormat = { type: 'price', precision: dg, minMove: Math.pow(10, -dg) };
  const candle = chart.addSeries(LC.CandlestickSeries, {
    upColor: col.up, downColor: col.down, wickUpColor: col.up, wickDownColor: col.down, borderVisible: false, priceFormat, priceLineVisible: false,
  });
  candle.setData(c.map((x) => ({ time: x.time, open: x.open, high: x.high, low: x.low, close: x.close })));
  candle.priceScale().applyOptions({ scaleMargins: { top: 0.06, bottom: 0.24 } });

  const vol = chart.addSeries(LC.HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
  chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
  vol.setData(c.map((x) => ({ time: x.time, value: x.volume, color: (x.close >= x.open ? col.up : col.down) + '73' })));

  const maMaps = cfg.ma.map((n, i) => {
    const s = chart.addSeries(LC.LineSeries, { color: col.ma[i], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat });
    const data = sma(c, n);
    s.setData(data);
    return { n, map: new Map(data.map((d) => [d.time, d.value])) };
  });

  const lv = levels(c, cfg.k, cfg.win);
  const last = c[c.length - 1].close;
  // 圖內不放文字：價格標在右側價格軸，名稱（壓力、支撐）貼在價格軸外側
  const tags = [];
  const line = (z, name, strong) => { if (!z) return; candle.createPriceLine({ price: z.price, color: strong ? '#1A1A1A' : '#9A968C', lineWidth: 1, lineStyle: strong ? LC.LineStyle.Dashed : LC.LineStyle.Dotted, axisLabelVisible: true, title: '' }); tags.push({ price: z.price, name, strong }); };
  line(lv.res, '壓力', true); line(lv.sup, '支撐', true); line(lv.res2, '壓力 2', false); line(lv.sup2, '支撐 2', false);
  const placeTags = () => {
    const box = $('lvTags');
    const pos = tags.map((t) => ({ ...t, y: candle.priceToCoordinate(t.price) })).filter((t) => t.y != null).sort((x, y) => x.y - y.y);
    // 標籤太近時往下推，避免重疊
    const h = 20 * uiScale();
    for (let i = 1; i < pos.length; i++) if (pos[i].y - pos[i - 1].y < h) pos[i].y = pos[i - 1].y + h;
    box.innerHTML = pos.map((t) => `<span class="${t.strong ? 'on' : ''}" style="top:${t.y - h / 2}px">${t.name}</span>`).join('');
  };
  state.placeTags = placeTags;
  chart.timeScale().subscribeVisibleLogicalRangeChange(() => requestAnimationFrame(placeTags));
  const zt = (z) => `${fmtP(z.price, dg)}（距 ${sPct((z.price / last - 1) * 100, 1)}）`;
  const zone = (z) => (z.hi - z.lo > 0 ? `區間 ${fmtP(z.lo, dg)}–${fmtP(z.hi, dg)}，` : '') + `測試 ${z.touches} 次`;
  $('lvRes').textContent = lv.res ? zt(lv.res) : '區間新高，暫無前高壓力';
  $('lvSup').textContent = lv.sup ? zt(lv.sup) : '區間新低，暫無前低支撐';
  $('lvRes2').textContent = lv.res ? zone(lv.res) + (lv.res2 ? `；第二道 ${zt(lv.res2)}` : '') : '';
  $('lvSup2').textContent = lv.sup ? zone(lv.sup) + (lv.sup2 ? `；第二道 ${zt(lv.sup2)}` : '') : '';

  const bk = breakouts(c, cfg.look);
  // 標記一律不加文字，滑到那根 K 棒時在上方資訊列說明
  const marks = bk.map((b) => ({
    time: b.time,
    position: b.type === 'up' ? 'aboveBar' : 'belowBar',
    color: b.type === 'up' ? col.up : col.down,
    shape: b.type === 'up' ? 'arrowUp' : 'arrowDown',
  }));
  const evAt = new Map();
  const note = (t, txt) => evAt.set(t, [...(evAt.get(t) || []), txt]);
  for (const b of bk) note(b.time, b.type === 'up' ? '▲ 帶量突破' : '▼ 跌破');
  for (const ev of chartEvents(a, c)) { marks.push({ time: ev.time, position: 'belowBar', color: '#5C5C5C', shape: 'circle', size: 0.6 }); note(ev.time, '● ' + ev.text); }
  marks.sort((x, y) => (x.time < y.time ? -1 : x.time > y.time ? 1 : 0));
  LC.createSeriesMarkers(candle, marks);
  const lb = bk.at(-1);
  const sigEl = $('lvSig');
  sigEl.className = 'num ' + (lb ? (lb.type === 'up' ? 'up' : 'down') : '');
  sigEl.textContent = lb ? `${lb.type === 'up' ? '▲' : '▼'} ${lb.time.replaceAll('-', '/')} ${lb.type === 'up' ? '帶量突破' : '跌破'} ${fmtP(lb.price, dg)}` : '無';

  const n = c.length;
  const indLegend = addIndicator(chart, c, col, dg);
  chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - cfg.show), to: n + 3 });
  requestAnimationFrame(() => requestAnimationFrame(placeTags));

  const legend = (i) => {
    const x = c[i];
    if (!x) return;
    const pc = i > 0 ? c[i - 1].close : x.open;
    const mas = maMaps.map((m, k) => { const v = m.map.get(x.time); return `<span class="m${k + 1}">MA${m.n} ${v == null ? '–' : fmtP(v, dg)}</span>`; }).join('');
    $('legend').innerHTML = `<span>${x.time.replaceAll('-', '/')}</span><span>開 <b>${fmtP(x.open, dg)}</b></span><span>高 <b>${fmtP(x.high, dg)}</b></span><span>低 <b>${fmtP(x.low, dg)}</b></span><span>收 <b class="${tone(x.close - pc)}">${fmtP(x.close, dg)}</b></span><span>量 <b>${fmtInt(x.volume)}</b> 張</span>${mas}${evAt.has(x.time) ? `<span class="ev">${esc(evAt.get(x.time).join('、'))}</span>` : ''}`;
  };
  legend(n - 1);
  indLegend(c[n - 1]?.time);
  chart.subscribeCrosshairMove((p) => {
    const i = p && p.logical != null ? Math.round(p.logical) : n - 1;
    const k = i >= 0 && i < n ? i : n - 1;
    legend(k);
    indLegend(c[k]?.time);
  });

  drawCompare(chart, c, cfg, dg);
  $('chartNote').textContent = (a.patched ? `最新一天（${md(a.patched)}）的行情與三大法人來自交易所，FinMind 尚未更新；本益比、融資融券仍是前一天。` : '') + `價格已做除權息還原（最新價為實際成交價）。壓力與支撐：最近 ${cfg.win} 根 K 棒的轉折點，價格相近的合併成區間，測試次數越多越重要；虛線為第一道、點線為第二道，價位標在右側。▲ 帶量突破${cfg.lookText}高點，▼ 跌破${cfg.lookText}低點，● 除權息、法說會、關聯公司財報；滑到 K 棒上會在圖上方寫出是什麼事件。均線 ${cfg.ma.join('、')}。`;
}

// ---------- 美股、匯率、指數走勢視窗 ----------
$('market2').addEventListener('click', (e) => {
  const t = e.target.closest('[data-ent]');
  if (t) openEntity(JSON.parse(t.dataset.ent));
});
$('market').addEventListener('click', (e) => {
  const t = e.target.closest('[data-ent]');
  if (t) openEntity(JSON.parse(t.dataset.ent));
});
$('entClose').addEventListener('click', () => $('entDlg').close());
$('entDlg').addEventListener('click', (e) => { if (e.target === $('entDlg')) $('entDlg').close(); });
$('entDlg').addEventListener('close', () => { if (state.entChart) { state.entChart.remove(); state.entChart = null; } });
$('entSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b || !state.ent) return;
  state.entRange = b.dataset.v;
  drawEntity();
});

async function openEntity(e) {
  state.ent = { e, rows: null };
  state.entRange = state.entRange || '1y';
  const kindText = e.kind === 'us' ? '美國 ETF／股票' : e.kind === 'fx' ? '匯率（台銀即期買入）' : e.kind === 'gold' ? '走勢圖以黃金 ETF（GLD）代表' : '指數';
  $('entName').innerHTML = `${esc(e.name || e.id)} <span class="muted small">${esc(e.id)} · ${kindText}</span>`;
  $('entQuote').textContent = '載入中';
  $('entStats').innerHTML = '';
  $('entNote').textContent = '';
  $('entNews').innerHTML = '<li class="empty">載入中</li>';
  if (!$('entDlg').open) $('entDlg').showModal();
  try {
    state.ent.rows = await loadEntityLong(e);
  } catch (err) {
    if (!state.idxRows?.[e.id]) { $('entQuote').textContent = '載入失敗：' + err.message; return; }
    state.ent.rows = null;
  }
  if (e.kind === 'tw' && state.idxRows?.[e.id]) state.ent.rows = mergeIdx(state.ent.rows, e.id);
  if (state.ent?.e !== e) return;
  drawEntity();
  googleNews(e.q || e.name || e.id, { days: 7, limit: 8 })
    .then((items) => { if (state.ent?.e === e) $('entNews').innerHTML = items.length ? items.map((n) => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a> <span class="muted small">${esc(n.source || '')} ${n.date ? md(toLocal(n.date)) : ''}</span></li>`).join('') : '<li class="empty">近 7 天沒有相關新聞</li>'; })
    .catch(() => { $('entNews').innerHTML = '<li class="empty">新聞載入失敗</li>'; });
}

function drawEntity() {
  const { e, rows } = state.ent || {};
  if (!rows || !rows.length) return;
  const ranges = [{ l: '3 個月', v: '3m', n: 63 }, { l: '1 年', v: '1y', n: 250 }, { l: '2 年', v: '2y', n: 1e9 }];
  $('entSeg').innerHTML = segHTML(ranges.map(({ l, v }) => ({ l, v })), state.entRange);
  const fx = e.kind === 'fx';
  const dg = fx ? 3 : 2;
  const n = rows.length;
  const last = rows[n - 1];
  const prev = rows[n - 2] || last;
  const d = last[4] - prev[4];
  const r = (last[4] / prev[4] - 1) * 100;
  $('entQuote').innerHTML = `<b class="ent-px">${fmtP(last[4], dg)}</b> <span class="${tone(r)}">${arrow(r)}${d > 0 ? '+' : d < 0 ? '−' : ''}${fmtP(Math.abs(d), dg)}（${sPct(r)}）</span> <span class="muted small">${last[0].replaceAll('-', '/')} ${e.kind === 'us' ? '美國時間收盤' : '收盤'}</span>`;
  const ch = (k) => (n > k ? (last[4] / rows[n - 1 - k][4] - 1) * 100 : null);
  const yr = rows.slice(-250);
  const hi = Math.max(...yr.map((x) => x[2]));
  const lo = Math.min(...yr.map((x) => x[3]));
  const rel = (state.relM[state.cur] || []).find((x) => x.e.kind === e.kind && x.e.id === e.id);
  const stats = [['5 日', ch(5)], ['20 日', ch(20)], ['60 日', ch(60)], ['1 年', ch(250)]].map(([k, v]) => [k, sPct(v, 1), tone(v)]);
  stats.push(['52 週高／低', `${fmtP(hi, dg)} / ${fmtP(lo, dg)}`, '']);
  stats.push(['距 52 週高', sPct((last[4] / hi - 1) * 100, 1), '']);
  if (rel?.m) stats.push([`與 ${nameOf(state.cur)} 相關`, fmtCorr(rel.m.corr), '']);
  $('entStats').innerHTML = stats.map(([k, v, c]) => `<div class="stat"><span class="muted small">${k}</span><b class="${c}">${esc(v)}</b></div>`).join('');
  const show = ranges.find((x) => x.v === state.entRange).n;
  const data = rows.slice(-show);
  if (state.entChart) state.entChart.remove();
  const col = palette();
  const chart = LC.createChart($('entChart'), {
    autoSize: true,
    layout: { background: { type: 'solid', color: '#FFFFFF' }, textColor: '#5C5C5C', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: Math.round(12 * uiScale()) },
    grid: { vertLines: { color: '#F3F1EC' }, horzLines: { color: '#F3F1EC' } },
    rightPriceScale: { borderColor: '#E2E0DA' },
    timeScale: { borderColor: '#E2E0DA' },
    localization: { locale: 'zh-TW', dateFormat: 'yyyy/MM/dd' },
  });
  state.entChart = chart;
  const priceFormat = { type: 'price', precision: dg, minMove: Math.pow(10, -dg) };
  if (fx) {
    const s = chart.addSeries(LC.LineSeries, { color: '#1A1A1A', lineWidth: 2, priceFormat, priceLineVisible: false });
    s.setData(data.map((x) => ({ time: x[0], value: x[4] })));
  } else {
    const s = chart.addSeries(LC.CandlestickSeries, { upColor: col.up, downColor: col.down, borderUpColor: col.up, borderDownColor: col.down, wickUpColor: col.up, wickDownColor: col.down, priceFormat, priceLineVisible: false });
    s.setData(data.map((x) => ({ time: x[0], open: x[1] || x[4], high: x[2] || x[4], low: x[3] || x[4], close: x[4] })));
    const ma = chart.addSeries(LC.LineSeries, { color: col.ma[1], lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    const m20 = [];
    for (let i = 19; i < rows.length; i++) { let t = 0; for (let k = i - 19; k <= i; k++) t += rows[k][4]; m20.push({ time: rows[i][0], value: t / 20 }); }
    ma.setData(m20.filter((x) => x.time >= data[0][0]));
  }
  chart.timeScale().fitContent();
  $('entNote').textContent = (e.kind === 'gold' ? '上方價格與圖為黃金 ETF（GLD，美元），漲跌幅與金價接近；國際金價每盎司報價見大盤概況列。' : '') + (e.kind === 'us' ? '美股收盤在台灣時間清晨，對台股的影響反映在當天開盤。' : '') + (fx ? '數字變大代表台幣貶值（1 單位外幣換更多台幣），對出口與外銷占比高的公司通常有利。' : '藍線為 20 日均線。') + '資料來源 FinMind。';
}

// ---------- 疊加比較 ----------
// 在 K 線上疊一條大盤或關聯對象的走勢，從圖上第一天起換算到本股價位，看同期誰強誰弱
function cmpChoices(id) {
  const otc = state.info[id]?.type === 'tpex';
  const idx = otc ? { kind: 'tw', id: 'TPEx', name: '櫃買指數' } : { kind: 'tw', id: 'TAIEX', name: '加權指數' };
  const out = [{ key: 'none', label: '無' }, { key: 'idx', label: idx.name, e: idx }];
  for (const r of state.rel[id] || []) if (r.e.kind !== 'fx' && r.e.id !== 'TAIEX') out.push({ key: entityKey(r.e), label: (r.e.name || r.e.id) + (r.e.kind === 'us' ? '（美股）' : ''), e: r.e });
  return out;
}
// 填選單；選過的對象這檔沒有時先顯示「無」，但保留選擇，換到有的股票時繼續疊加
function fillCmpSel() {
  const ch = cmpChoices(state.cur);
  const cur = ch.some((x) => x.key === state.cmp) ? state.cmp : 'none';
  $('cmpSel').innerHTML = ch.map((x) => `<option value="${esc(x.key)}"${x.key === cur ? ' selected' : ''}>${esc(x.label)}</option>`).join('');
  return ch.find((x) => x.key === cur);
}
function drawCompare(chart, c, cfg, dg) {
  const pick = fillCmpSel();
  const leg = $('cmpLegend');
  leg.innerHTML = '';
  if (!pick || !pick.e) return;
  const ck = pick.e.kind + ':' + pick.e.id;
  let rows = state.cmpData[ck];
  if (rows && (pick.e.id === 'TAIEX' || pick.e.id === 'TPEx')) rows = mergeIdx(rows, pick.e.id);
  // 加權指數用交易所最新一天補上（FinMind 可能還沒更新）
  const dx = state.detail?.idx?.taiex;
  if (rows && pick.e.id === 'TAIEX' && dx && state.detail.date > rows.at(-1)[0]) rows = [...rows, [state.detail.date, dx[0], dx[0], dx[0], dx[0]]];
  if (!rows) {
    leg.textContent = '比較資料載入中';
    loadEntityLong(pick.e)
      .then((r) => { state.cmpData[ck] = r; const a = state.an[state.cur]; if (a && !a.empty && state.cmp === pick.key) renderChart(a); })
      .catch((err) => { leg.textContent = '比較資料載入失敗：' + err.message; });
    return;
  }
  // 對齊：日 K 時美股用前一晚收盤；週 K、月 K 取該期最後一天的收盤
  const daily = state.period === 'd';
  const vals = [];
  let j = -1;
  for (let i = 0; i < c.length; i++) {
    const end = daily ? c[i].time : c[i + 1]?.time || '9999';
    const ok = (d) => (daily ? (pick.e.kind === 'us' ? d < end : d <= end) : d < end);
    while (j + 1 < rows.length && ok(rows[j + 1][0])) j++;
    vals.push(j >= 0 ? rows[j][4] : null);
  }
  let b = Math.max(0, c.length - cfg.show);
  while (b < c.length && vals[b] == null) b++;
  if (b >= c.length - 1) return (leg.textContent = '比較對象在這段期間沒有資料');
  const f = c[b].close / vals[b];
  const line = chart.addSeries(LC.LineSeries, { color: '#0E7C86', lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, priceFormat: { type: 'price', precision: dg, minMove: Math.pow(10, -dg) } });
  line.setData(c.map((x, i) => (vals[i] == null ? null : { time: x.time, value: vals[i] * f })).filter(Boolean));
  const rc = (c.at(-1).close / c[b].close - 1) * 100;
  const re = (vals.at(-1) / vals[b] - 1) * 100;
  leg.innerHTML = `<span><i class="cmp-dot"></i>${esc(pick.label)}</span><span>從 ${c[b].time.replaceAll('-', '/')} 起：對方 <b class="${tone(re)}">${sPct(re, 1)}</b></span><span>本股 <b class="${tone(rc)}">${sPct(rc, 1)}</b></span><span class="muted">${rc - re >= 0 ? '本股較強' : '本股較弱'} ${Math.abs(rc - re).toFixed(1)} 個百分點（已換算到本股價位）</span>`;
}
$('cmpSel').addEventListener('change', (e) => {
  state.cmp = e.target.value;
  try { chrome.storage.local.set({ cmp: state.cmp }); } catch (err) { /* 略過 */ }
  const a = state.an[state.cur];
  if (a && !a.empty) renderChart(a);
});

// K 線上的事件：除權息、本股法說會、關聯公司財報（只標已發生的，未來事件看行事曆）
function chartEvents(a, c) {
  const out = [];
  const barTime = (date) => { let t = null; for (const x of c) { if (x.time <= date) t = x.time; else break; } return t; };
  const add = (date, text) => { if (date > a.last.time || date < c[0].time) return; const t = barTime(date); if (t) out.push({ time: t, text }); };
  for (const e of a.exDiv || []) add(e.time, e.cash ? '除息' : '除權');
  for (const cf of state.confs[state.cur] || []) add(cf.date, '法說會');
  for (const r of state.rel[state.cur] || []) for (const ev of r.e.events || []) add(ev.date, (r.e.name || r.e.id) + '財報');
  return out;
}

// 副圖指標：KD（9,3,3）、MACD（12,26,9）、RSI（6、12）
function addIndicator(chart, c, col, dg) {
  const none = () => { $('indLegend').innerHTML = ''; };
  if (state.ind === 'none') { none(); return none; }
  const opt = (color) => ({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  const ref = (s, v) => s.createPriceLine({ price: v, color: '#B9B5AC', lineWidth: 1, lineStyle: LC.LineStyle.Dotted, axisLabelVisible: false });
  let fmt = () => '';
  if (state.ind === 'kd') {
    const d = kd(c);
    const k = chart.addSeries(LC.LineSeries, opt(col.ma[0]), 1);
    const dd = chart.addSeries(LC.LineSeries, opt(col.ma[1]), 1);
    k.setData(d.map((x) => ({ time: x.time, value: x.k })));
    dd.setData(d.map((x) => ({ time: x.time, value: x.d })));
    ref(k, 80); ref(k, 20);
    const m = new Map(d.map((x) => [x.time, x]));
    fmt = (t) => { const x = m.get(t); return x ? `<span class="m1">K ${x.k.toFixed(1)}</span><span class="m2">D ${x.d.toFixed(1)}</span><span>80 以上偏熱、20 以下偏冷</span>` : ''; };
  } else if (state.ind === 'rsi') {
    const r6 = rsi(c, 6);
    const r12 = rsi(c, 12);
    const a1 = chart.addSeries(LC.LineSeries, opt(col.ma[0]), 1);
    const a2 = chart.addSeries(LC.LineSeries, opt(col.ma[1]), 1);
    a1.setData(r6);
    a2.setData(r12);
    ref(a1, 70); ref(a1, 30);
    const m6 = new Map(r6.map((x) => [x.time, x.value]));
    const m12 = new Map(r12.map((x) => [x.time, x.value]));
    fmt = (t) => `<span class="m1">RSI6 ${m6.get(t)?.toFixed(1) ?? '–'}</span><span class="m2">RSI12 ${m12.get(t)?.toFixed(1) ?? '–'}</span><span>70 以上偏熱、30 以下偏冷</span>`;
  } else if (state.ind === 'macd') {
    const d = macd(c);
    const h = chart.addSeries(LC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, 1);
    h.setData(d.map((x) => ({ time: x.time, value: x.osc, color: (x.osc >= 0 ? col.up : col.down) + '99' })));
    const l1 = chart.addSeries(LC.LineSeries, opt(col.ma[0]), 1);
    const l2 = chart.addSeries(LC.LineSeries, opt(col.ma[1]), 1);
    l1.setData(d.map((x) => ({ time: x.time, value: x.dif })));
    l2.setData(d.map((x) => ({ time: x.time, value: x.macd })));
    const m = new Map(d.map((x) => [x.time, x]));
    const p = Math.max(dg, 2);
    fmt = (t) => { const x = m.get(t); return x ? `<span class="m1">DIF ${x.dif.toFixed(p)}</span><span class="m2">MACD ${x.macd.toFixed(p)}</span><span class="${tone(x.osc)}">OSC ${x.osc.toFixed(p)}</span>` : ''; };
  }
  try { chart.panes()[1]?.setHeight(140); } catch (e) { /* 舊版圖表元件沒有分割窗格 */ }
  return (t) => { $('indLegend').innerHTML = fmt(t); };
}

$('indSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.ind = b.dataset.v;
  chrome.storage.local.set({ ind: state.ind });
  const a = state.an[state.cur];
  if (a && !a.empty) renderChart(a);
});

function renderInst(a) {
  const rows = a.inst;
  if (!rows.length) {
    $('instBars').innerHTML = '';
    $('instSum').innerHTML = '<span class="empty">無資料</span>';
    $('instToday').textContent = '';
    return;
  }
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.total)));
  $('instBars').innerHTML = '<span class="mid"></span>' + rows.map((r) => {
    const h = (Math.abs(r.total) / max) * 50;
    const top = r.total >= 0 ? 50 - h : 50;
    return `<div class="col" title="${r.date} 合計 ${sInt(r.total)} 張"><span style="top:${top}%;height:${h}%;background:var(--${r.total >= 0 ? 'up' : 'down'})"></span></div>`;
  }).join('');
  const t = rows.at(-1);
  $('instToday').className = 'num small ' + tone(t.total);
  $('instToday').textContent = t.date.slice(5).replace('-', '/') + ' 合計 ' + sInt(t.total) + ' 張';
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  $('instSum').innerHTML = [['外資', 'foreign'], ['投信', 'trust'], ['自營商', 'dealer']]
    .map(([l, k]) => { const v = sum(k); return `<div class="kv"><span>${l}（${rows.length} 日買賣超）</span><span class="num ${tone(v)}">${sInt(v)} 張</span></div>`; })
    .join('') + foreignHoldHTML(state.cur);
}

// 外資持股：交易所每日公布；投信、自營商不公布持股
function foreignHoldHTML(id) {
  const q = state.qfii;
  const h = q?.map?.[id];
  if (!h) return `<div class="hold-box"><span class="muted small">外資持股：${q ? (q.partial ? '交易所暫時無回應，下次打開再補' : '交易所無此股資料') : q === false ? '交易所暫時無回應，下次打開再試' : '載入中'}；投信、自營商持股交易所不公布</span></div>`;
  const p = q.prev?.[id];
  const dlt = p ? h[0] - p[0] : null;
  return `<div class="hold-box">
    <div class="kv"><span>外資持股</span><span class="num"><b>${fmtInt(h[0])} 張</b>（${h[1].toFixed(2)}%）</span></div>
    ${dlt != null ? `<div class="kv"><span>較 ${md(q.prevDate)}</span><span class="num ${tone(dlt)}">${sInt(dlt)} 張</span></div>` : ''}
    <div class="kv"><span>發行張數</span><span class="num">${fmtInt(h[2])} 張</span></div>
    <span class="muted small num">資料日期 ${md(q.date)} · 投信、自營商持股交易所不公布，只有每日買賣超</span></div>`;
}

function renderMargin(a) {
  const m = a.margin;
  if (!m) return ($('margin').innerHTML = '<span class="empty">無資料（部分股票不能信用交易）</span>');
  $('margin').innerHTML = `
    <div class="kv"><span>融資餘額</span><span class="num">${fmtInt(m.fin)} 張</span></div>
    <div class="kv"><span>融資 5 日變化</span><span class="num ${tone(m.finChg)}">${sPct(m.finChg, 1)}</span></div>
    <div class="kv"><span>融券餘額</span><span class="num">${fmtInt(m.short)} 張</span></div>
    <div class="kv"><span>券資比</span><span class="num">${m.ratio == null ? '–' : m.ratio.toFixed(1) + '%'}</span></div>
    <span class="muted small num">資料日期 ${m.date.replaceAll('-', '/')}，融資融券約晚間 21:30 公布</span>`;
}

function renderRevenue(a) {
  const r = a.revenue;
  if (!r.length) {
    $('revBars').innerHTML = '<span class="empty">無資料</span>';
    return;
  }
  const max = Math.max(...r.map((x) => x.revenue));
  $('revBars').innerHTML = r.map((x, i) => `<span class="${i === r.length - 1 ? 'last' : ''}" style="height:${((x.revenue / max) * 100).toFixed(1)}%" title="${x.label} ${(x.revenue / 1e6).toFixed(1)} 百萬 年增 ${sPct(x.yoy, 1)}"></span>`).join('');
  const l = r.at(-1);
  $('revFrom').textContent = r[0].label;
  $('revTo').textContent = l.label;
  $('revYoy').className = 'num small ' + tone(l.yoy);
  $('revYoy').textContent = `${l.label.slice(5)} 月年增 ${sPct(l.yoy, 1)}`;
  const s = a.revenueStreak;
  $('revNote').textContent = `${l.label} 營收 ${(l.revenue / 1e8).toFixed(2)} 億` + (s.n >= 2 ? `，連續 ${s.n} 個月年${s.dir > 0 ? '增' : '減'}` : '');
}

function renderAnns() {
  const list = (state.anns || {})[state.cur] || [];
  $('anns').innerHTML = list.length
    ? list.slice(0, 12).map((x) => `<li><details><summary><span class="muted small num">${md(x.d)} ${x.t}</span> ${esc(x.s)}</summary><p class="small">${esc(x.b).replace(/\r?\n/g, '<br>')}</p></details></li>`).join('')
    : '<li class="empty">近 45 天沒有收到公告（插件安裝後才開始累積，開放資料只保留最近一兩天）</li>';
}

// ---------- 新聞：去重、標出相關自選股 ----------
const normT = (t) => String(t || '').replace(/\s*[-|｜]\s*[^-|｜]{1,20}$/, '').replace(/[\s「」『』【】（）()［］\[\]、，。：:！!？?…．.‧·%+\-－—"'“”]/g, '');
function bigrams(t) { const b = new Set(); for (let i = 0; i < t.length - 1; i++) b.add(t.slice(i, i + 2)); return b; }
function similar(a, b) {
  if (a.n === b.n) return true;
  let inter = 0;
  for (const x of a.g) if (b.g.has(x)) inter++;
  return inter / Math.min(a.g.size, b.g.size) >= 0.6;
}
// 把多個來源的新聞合併：同一件事只留最早一則，記下其他媒體數與相關的自選股
function mergeNews(items) {
  const names = state.watch.map((id) => [id, nameOf(id).replace(/-KY$/, '')]);
  const out = [];
  for (const n of items
    .filter((x) => /^https?:\/\//.test(x.link || '') && !/股市爆料同學會/.test(x.title))
    .map((x) => ({ ...x, date: x.date && x.date.includes('T') ? toLocal(x.date) : x.date }))
    .sort((x, y) => (x.date < y.date ? -1 : 1))) {
    const key = { n: normT(n.title) };
    key.g = bigrams(key.n);
    if (key.n.length < 6) continue;
    const tags = new Set(n.ids || []);
    for (const [id, nm] of names) if (n.title.includes(nm) || n.title.includes(id)) tags.add(id);
    const dup = out.find((o) => similar(o.key, key));
    if (dup) { dup.more++; for (const t of tags) dup.tags.add(t); if (n.source && !dup.srcs.includes(n.source)) dup.srcs.push(n.source); continue; }
    out.push({ ...n, key, tags, more: 0, srcs: [n.source].filter(Boolean) });
  }
  return out.sort((x, y) => (x.date < y.date ? 1 : -1));
}
// 個股新聞查詢：公司名加上股票相關字，避免同名的建案、飯店、診所等新聞
const ownQuery = (id) => `"${nameOf(id).replace(/-KY$/, '')}" (${id} OR 股價 OR 營收 OR 外資 OR 法說 OR 財報 OR 股東 OR 訂單)`;
// 標題要直接提到這檔（名稱或代號），且不是港股、促銷等同名新聞
const NEWS_OFF = /港股|香港|\(H\)|樓盤|呎價|房兩房|優惠|門票|必食|診所|飯店|酒店/;
function aboutStock(n, id) {
  const nm = nameOf(id).replace(/-KY$/, '');
  return (n.title.includes(nm) || n.title.includes(id)) && !NEWS_OFF.test(n.title);
}
function newsItems(id) {
  return [...(state.data[id]?.news || []), ...(state.gn[id] || [])].filter((n) => aboutStock(n, id)).map((n) => ({ ...n, ids: [id] }));
}
function renderNews() {
  renderAnns();
  const all = state.newsAll;
  const ids = all ? state.watch : [state.cur];
  const raw = ids.flatMap(newsItems);
  const list = mergeNews(raw).slice(0, all ? 20 : 10);
  const dupN = raw.length - mergeNews(raw).length;
  $('newsNote').textContent = all ? `自選股 ${state.watch.length} 檔近期新聞合併，重複報導已合成一則${dupN > 0 ? `（合併掉 ${dupN} 則）` : ''}。` : dupN > 0 ? `已合併 ${dupN} 則重複報導。` : '';
  $('news').innerHTML = list.length
    ? list.map((n) => {
        const tags = [...n.tags].filter((t) => all || t !== state.cur).map((t) => `<button type="button" class="ntag" data-open="${t}">${esc(nameOf(t))}</button>`).join('');
        return `<li><span class="ntags">${tags}</span><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a><span class="muted small num">${esc((n.date || '').slice(5, 16).replace('-', '/'))} · ${esc(n.srcs.join('、') || n.source || '')}${n.more ? ` · 另有 ${n.more} 則相同報導` : ''}</span></li>`;
      }).join('')
    : '<li class="empty">近一週沒有直接提到這檔的新聞</li>';
}
$('newsSeg').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.newsAll = b.dataset.v === 'all';
  $('newsSeg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderNews();
  if (state.newsAll) {
    // 其他自選股的 Google 新聞還沒載入的補上
    for (const id of state.watch) {
      if (state.gn[id]) continue;
      try { state.gn[id] = await googleNews(ownQuery(id), { days: 7, limit: 10 }); } catch (err) { state.gn[id] = []; }
      if (state.newsAll) renderNews();
    }
  }
});
$('news').addEventListener('click', (e) => {
  const t = e.target.closest('.ntag[data-open]');
  if (t) openStock(t.dataset.open);
});

// ---------- 週期切換 ----------
document.querySelector('[data-p]').parentElement.addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]');
  if (!b) return;
  state.period = b.dataset.p;
  document.querySelectorAll('.seg [data-p]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  const a = state.an[state.cur];
  if (a && !a.empty) renderChart(a);
});

// ---------- 設定 ----------
function applyConvention() {
  document.documentElement.dataset.convention = state.settings.convention;
}

document.querySelector('.settings').addEventListener('toggle', (e) => {
  if (!e.target.open) return;
  $('setConvention').value = state.settings.convention;
  $('setNotify').checked = !!state.settings.notify;
  $('setToken').value = state.settings.token || '';
});

$('saveSettings').addEventListener('click', async () => {
  await setSettings({ convention: $('setConvention').value, notify: $('setNotify').checked, token: $('setToken').value });
  state.settings = await getSettings();
  applyConvention();
  document.querySelector('.settings').open = false;
  renderWatch();
  renderMain();
});

$('refresh').addEventListener('click', async () => {
  loadMarketStrip(true);
  const mk = loadMarket();
  await refreshAll(true);
  await mk;
});

// 背景更新完成時同步畫面
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || state.busy) return;
  let changed = false;
  for (const [key, { newValue }] of Object.entries(changes)) {
    if (!key.startsWith('stock:') || !newValue) continue;
    const id = key.slice(6);
    if (state.data[id]?.fetchedAt === newValue.fetchedAt) continue;
    state.data[id] = newValue;
    state.an[id] = analyze(newValue);
    changed = true;
  }
  if (!changed) return;
  renderWatch();
  renderMain();
  renderAsOf();
});


// ---------- 持股 ----------
function toLocal(iso) {
  // Google 新聞時間轉成台灣時間字串 YYYY-MM-DD HH:MM
  return new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ');
}

// ---------- 關聯行事曆 ----------
const WD = ['日', '一', '二', '三', '四', '五', '六'];
async function loadCal(id) {
  try {
    state.cal[id] = await loadCalendar({ id, name: nameOf(id), industries: state.info[id]?.industries }, (state.rel[id] || []).map((r) => r.e), { divs: state.data[id]?.div });
  } catch (e) {
    state.cal[id] = [];
  }
  if (state.cur === id) renderCalendar();
}

function renderCalendar() {
  const list = state.cal[state.cur];
  if (!list) {
    $('calendar').innerHTML = '<span class="empty">行事曆載入中</span>';
    $('calNote').textContent = '';
    return;
  }
  const today = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
  $('calendar').innerHTML = list.length
    ? list.map((c) => {
        const wd = WD[new Date(c.date + 'T00:00:00Z').getUTCDay()];
        const days = Math.round((Date.parse(c.date) - Date.parse(today)) / 86400000);
        const when = days < 0 ? '已過' : days === 0 ? '今天' : days === 1 ? '明天' : `${days} 天後`;
        const del = c.uid ? `<button type="button" class="rel-del cal-del" data-uid="${esc(c.uid)}" aria-label="刪除事件">×</button>` : '';
        const note = [c.note, c.src ? '來源：' + c.src : ''].filter(Boolean).join('，');
        return `<div class="cal-row${days < 0 ? ' past' : ''}"><span class="cal-date num">${md(c.date)}（${wd}）<br><span class="muted small">${when}</span></span><span class="cal-who"><span class="ntag${c.who.self ? ' self' : ''}">${esc(c.who.rel)}</span><span class="cal-name">${!c.who.self && /^\d{4}$/.test(c.who.id) ? stockLink(c.who.id, c.who.name) : esc(c.who.name)}</span></span><span class="cal-what"><b>${esc(c.t)}</b>${note ? `<span class="muted small">${esc(note)}</span>` : ''}</span>${del}</div>`;
      }).join('')
    : '<span class="empty">未來 45 天沒有已知事件</span>';
  renderHighlights();
  $('calNote').textContent = '台股法說會來自證交所與櫃買中心的重大訊息公告，插件每天收集，公司通常在一到兩週前才公告，所以剛安裝時會比較少。美股財報日只列已有官方公告的日期，其他可以自行新增。';
}

$('calendar').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-uid]');
  if (!b) return;
  await removeCustomEvent(b.dataset.uid);
  loadCal(state.cur);
});
$('calForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const who = $('calWho').value.trim();
  await addCustomEvent({ stockId: state.cur, date: $('calDate').value, who: who || nameOf(state.cur), t: $('calTitle').value.trim() });
  e.target.reset();
  loadCal(state.cur);
});

// ---------- 今日重點 ----------
const PRI = ['跌破支撐', '突破壓力', '帶量突破', '跌破 20', '創 60', '今日除', '今日跌破', '今日站上', '轉為連', '量能'];
const pri = (t) => { const i = PRI.findIndex((k) => t.includes(k)); return i < 0 ? 99 : i; };
const tstDate = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
const daysTo = (d) => Math.round((Date.parse(d) - Date.parse(tstDate())) / 86400000);
const whenText = (n) => (n === 0 ? '今天' : n === 1 ? '明天' : `${n} 天後`);

// 今日漲跌拆解：本股和大盤、族群、關聯美股前一晚比較，推估是跟著誰動
function renderAttrib() {
  const id = state.cur;
  const a = state.an[id];
  const el = $('attrib');
  if (!a || a.empty) return (el.innerHTML = '');
  const date = a.last.time;
  const r = a.pct;
  const chips = [['本股', r, true]];
  // 大盤：上市看加權、上櫃看櫃買，日期要和本股最新一天相同
  const otc = state.info[id]?.type === 'tpex';
  const idxDay = (s) => (s && s.length > 1 && s.at(-1)[0] === date ? (s.at(-1)[1] / s.at(-2)[1] - 1) * 100 : null);
  let mkt = otc ? idxDay(state.mkt?.tpex) : idxDay(state.mkt?.taiex);
  const dx = state.detail?.idx?.taiex;
  if (mkt == null && !otc && dx && state.detail.date === date) mkt = (dx[1] / (dx[0] - dx[1])) * 100;
  if (mkt != null) chips.push([otc ? '櫃買' : '加權', mkt]);
  // 族群：本股所屬題材（沒有題材就用官方產業）的其他成分股平均
  let sec = null;
  const mk = state.market;
  if (mk && mk.dates.at(-1) === date) {
    const theme = THEMES.find((t) => t.ids.includes(id));
    const cat = (state.info[id]?.industries || []).find((c) => !SKIP_INDUSTRY.test(c));
    const ids = theme ? theme.ids : cat ? Object.keys(state.info).filter((x) => (state.info[x]?.industries || []).includes(cat)) : [];
    const rs = ids.filter((x) => x !== id).map((x) => metrics(mk, x)?.r1).filter((x) => x != null);
    if (rs.length >= 2) { sec = rs.reduce((s, x) => s + x, 0) / rs.length; chips.push([(theme ? theme.name : cat) + '族群', sec]); }
  }
  // 關聯美股：相關 0.2 以上、前一晚漲跌最大的一檔
  const us = (state.relM[id] || []).filter((x) => x.m && x.e.kind === 'us' && (x.m.corr ?? 0) >= 0.2).sort((x, y) => Math.abs(y.m.r1) - Math.abs(x.m.r1))[0];
  if (us) chips.push([(us.e.name || us.e.id) + ' 前一晚', us.m.r1]);
  // 判斷：與族群差距小且族群明顯偏離大盤 → 跟族群；與大盤差距小 → 跟大盤；都差很多 → 個股因素
  let verdict = '';
  const near = (x, y) => Math.abs(x - y) <= Math.max(1, Math.abs(y) * 0.5);
  if (sec != null && near(r, sec) && (mkt == null || Math.abs(sec - mkt) >= 0.8)) verdict = '主要跟著族群一起動';
  else if (mkt != null && near(r, mkt) && Math.abs(r) < 2) verdict = '和大盤差不多，沒有明顯個股因素';
  else if (us && Math.sign(us.m.r1) === Math.sign(r) && Math.abs(us.m.r1) >= 1.5) verdict = `和 ${us.e.name || us.e.id} 前一晚同方向，可能受美股帶動`;
  else if (mkt != null) verdict = `明顯${r > mkt ? '強' : '弱'}於大盤${sec != null ? '與族群' : ''}，可能有個股因素（看下方公告與新聞）`;
  el.innerHTML = `<span class="muted small">漲跌拆解</span>${chips.map(([k, v, self]) => `<span class="ac${self ? ' self' : ''}"><span>${esc(k)}</span><b class="num ${tone(v)}">${sPct(v)}</b></span>`).join('')}${verdict ? `<span class="verdict">→ ${verdict}</span>` : ''}`;
}

function renderHighlights() {
  renderAttrib();
  const id = state.cur;
  const a = state.an[id];
  if (!a || a.empty) return ($('highlights').innerHTML = '');
  const dg = priceDigits(a.last.close);
  const lines = [];
  const ev = usefulEvents(id).sort((x, y) => pri(x.t) - pri(y.t));
  const lv = a.levels || {};
  if (ev.length) lines.push(['今日', ev.slice(0, 3).map((e) => e.t).join('、')]);
  else lines.push(['今日', (a.events.length ? '新訊號在本股歷史上都不準，不列入' : '沒有新訊號') + (lv.res ? `，上方壓力 ${fmtP(lv.res.price, dg)}（${sPct((lv.res.price / a.last.close - 1) * 100, 1)}）` : '') + (lv.sup ? `，下方支撐 ${fmtP(lv.sup.price, dg)}（${sPct((lv.sup.price / a.last.close - 1) * 100, 1)}）` : '')]);
  const rvY = reviewOf(id)?.days?.[0];
  if (rvY && rvY.date < a.last.time && rvY.items.length) lines.push(['昨天', `${md(rvY.date)} 提醒的 ${rvY.items.map((x) => x.t.replace(/（.*）/, '') + '→' + x.res).slice(0, 2).join('，')}`]);
  const ann = ((state.anns || {})[id] || []).find((x) => daysTo(x.d) >= -2);
  if (ann) lines.push(['公告', `${md(ann.d)} ${ann.s.slice(0, 60)}`]);
  const rv = state.data[id]?.revenue || [];
  const lr = rv.at(-1);
  if (lr && Date.now() - new Date(lr.y, lr.m, 1).getTime() < 15 * 86400000) {
    const ly = rv.find((x) => x.y === lr.y - 1 && x.m === lr.m);
    if (ly) lines.push(['營收', `${lr.m} 月營收已公布，年增 ${sPct((lr.revenue / ly.revenue - 1) * 100, 1)}`]);
  }
  // 只挑和本股真的有連動（相關 0.2 以上）的關聯，依「漲跌幅 × 相關係數」排序
  const rm = (state.relM[id] || []).filter((r) => r.m && r.e.kind !== 'fx' && r.e.id !== 'TAIEX' && (r.m.corr ?? 0) >= 0.2);
  const best = rm.map((r) => ({ r, score: Math.abs(r.m.r1) * r.m.corr })).sort((x, y) => y.score - x.score)[0];
  if (best && best.r.e.kind !== 'us' && Math.abs(best.r.m.r1) >= 1) lines.push(['關聯', `${best.r.e.rel} ${best.r.e.name || best.r.e.id} ${best.r.e.kind === 'us' ? '前一晚' : '今日'} ${sPct(best.r.m.r1)}（與本股相關 ${fmtCorr(best.r.m.corr)}）`]);
  const next = (state.cal[id] || []).filter((e) => daysTo(e.date) >= 0 && daysTo(e.date) <= 14 && !(e.t === '上月營收公布期限' && daysTo(e.date) > 3))[0];
  if (next) lines.push(['事件', `${whenText(daysTo(next.date))}（${md(next.date)}）${next.who.self ? '' : next.who.name + ' '}${next.t}${next.who.self ? '' : '（' + next.who.rel + '）'}`]);
  if (lines.length < 3) {
    const st = a.states.find((x) => /外資|投信/.test(x.t));
    const s = state.sh ? holdingSeries(state.sh, id) : [];
    const v = a.valuation?.per;
    if (st) lines.push(['籌碼', st.t]);
    else if (s.length > 1 && Math.abs(s.at(-1).big - s.at(-2).big) >= 0.3) lines.push(['籌碼', `千張大戶本週 ${sPct(s.at(-1).big - s.at(-2).big, 2).replace('%', ' 個百分點')}`]);
    else if (v && (v.pct >= 85 || v.pct <= 15)) lines.push(['估值', `本益比 ${v.cur.toFixed(1)}，在近三年 ${v.pct.toFixed(0)}% 位置（${v.pct >= 85 ? '偏高' : '偏低'}）`]);
  }
  $('highlights').innerHTML = lines.slice(0, 3).map(([k, v]) => `<li><span>${k}</span><span>${esc(v)}</span></li>`).join('');
}

// ---------- 自選股總表 ----------
async function loadOverviewCal() {
  renderSideCal();
  for (const id of state.watch) {
    if (state.cal[id] || !state.data[id]) continue;
    try {
      state.cal[id] = await loadCalendar({ id, name: nameOf(id), industries: state.info[id]?.industries }, await getRelations(id), { divs: state.data[id].div });
    } catch (e) {
      state.cal[id] = [];
    }
  }
  renderOverview();
  renderSideCal();
}

// 側欄自選股：每檔三行（名稱與漲跌／今日新訊號／距壓力支撐、外資、大戶、下個事件）
function renderOverview() {
  if (!state.watch.length) return ($('ovList').innerHTML = '<li class="ov-item muted small">還沒有自選股，請在上方輸入代號新增</li>');
  $('ovList').innerHTML = displayOrder().map((id) => {
    const a = state.an[id];
    const att = attention(id);
    const del = `<button type="button" class="del" data-del="${esc(id)}" aria-label="從自選股移除 ${esc(nameOf(id))}">×</button>`;
    const head = (px) => `<div class="ov-l1"><span class="ov-name">${stockLink(id, nameOf(id))}<small>${id}</small></span>${px}</div>`;
    const attr = ` data-row="${esc(id)}" class="ov-item${id === state.cur ? ' on' : ''} lvl-${a && !a.empty ? att.level : 'gray'}"`;
    if (!a || a.empty) return `<li${attr}>${head('<span class="muted small">載入中</span>')}${del}</li>`;
    const dg = priceDigits(a.last.close);
    const lv = a.levels || {};
    const fs = streak(a.inst.map((x) => x.foreign));
    const s = state.sh ? holdingSeries(state.sh, id) : [];
    const bigD = s.length > 1 ? s.at(-1).big - s.at(-2).big : null;
    const next = (state.cal[id] || []).filter((e) => daysTo(e.date) >= 0 && !(e.t === '上月營收公布期限' && daysTo(e.date) > 3))[0];
    const relI = relOf(id);
    const ev = a.events.slice().sort((x, y) => pri(x.t) - pri(y.t));
    const facts = [
      lv.res ? `壓 ${sPct((lv.res.price / a.last.close - 1) * 100, 1)}` : null,
      lv.sup ? `撐 ${sPct((lv.sup.price / a.last.close - 1) * 100, 1)}` : null,
      fs.n >= 2 ? `<span class="${tone(fs.dir)}">外資連 ${fs.n} ${fs.dir > 0 ? '買' : '賣'}</span>` : null,
      bigD != null && Math.abs(bigD) >= 0.1 ? `大戶 <span class="${tone(bigD)}">${sPct(bigD, 2).replace('%', '')}</span>` : null,
    ].filter(Boolean).join(' · ');
    const nextTxt = next ? `${md(next.date)}（${whenText(daysTo(next.date))}）${esc(next.who.self ? next.t : next.who.name + ' ' + next.t)}` : '';
    return `<li${attr}>${head(`<span class="ov-px num">${fmtP(a.last.close, dg)}<span class="small ${tone(a.chg)}">${arrow(a.chg)}${sPct(a.pct)}</span></span>`)}
      ${att.level !== 'gray' ? `<span class="lvl-t ${att.level}">${LEVEL_TEXT[att.level]}</span>` : ''}
      ${ev.length ? `<div class="tags">${ev.map((e) => `<span class="tag ${tone(e.d)}${weakSignal(relI, e) ? ' weak' : ''}">${esc(e.t)}</span>`).join('')}</div>` : ''}
      <div class="ov-l3 num">${facts}${nextTxt ? `<br>${nextTxt}` : ''}</div>${del}</li>`;
  }).join('');
}

// ---------- 價位提醒 ----------
// 把自訂提醒價的穿越加進訊號（今天剛穿越 = 新訊號，仍在提醒價外 = 持續狀態）
function withAlerts(a, id) {
  if (!a || a.empty) return a;
  const base = { events: a.events.filter((x) => x.key !== 'alert'), states: a.states.filter((x) => !/提醒價/.test(x.t)) };
  const al = alertSignals(a, state.alerts[id]);
  return { ...a, events: [...al.events, ...base.events], states: [...al.states, ...base.states] };
}

function renderAlertForm() {
  const al = state.alerts[state.cur] || {};
  $('alertAbove').value = al.above || '';
  $('alertBelow').value = al.below || '';
  $('alertMsg').textContent = al.above || al.below ? '收盤更新後若穿越會通知你' : '';
}

async function saveAlert(al) {
  if (al && (al.above > 0 || al.below > 0)) state.alerts[state.cur] = al;
  else delete state.alerts[state.cur];
  await chrome.storage.sync.set({ alerts: state.alerts });
  for (const id of Object.keys(state.an)) if (state.an[id] && !state.an[id].empty) state.an[id] = withAlerts(state.an[id], id);
  renderWatch();
  renderMain();
}
$('alertForm').addEventListener('submit', (e) => {
  e.preventDefault();
  saveAlert({ above: Number($('alertAbove').value) || 0, below: Number($('alertBelow').value) || 0 });
});
$('alertClear').addEventListener('click', () => saveAlert(null));

// ---------- 訊號的歷史表現 ----------

// ---------- 訊號可信度、注意程度、今日一句話 ----------
function relOf(id) {
  const a = state.an[id];
  if (!a || a.empty) return null;
  state.relC = state.relC || {};
  const k = id + a.last.time + a.daily.length;
  if (!state.relC[k]) { try { state.relC[k] = signalReliability(a.daily); } catch (e) { state.relC[k] = {}; } }
  return state.relC[k];
}
const usefulEvents = (id) => { const a = state.an[id]; const rel = relOf(id); return a && !a.empty ? a.events.filter((e) => !weakSignal(rel, e)) : []; };
function mktPct() {
  const t = state.mkt?.taiex;
  return t && t.length > 1 ? (t.at(-1)[1] / t.at(-2)[1] - 1) * 100 : null;
}
// 注意程度：本股有效的看空訊號、明顯偏離大盤、貼近支撐、近期事件與公告
function attention(id) {
  const a = state.an[id];
  if (!a || a.empty) return { score: -1, level: 'gray', why: [] };
  const why = [];
  let sc = 0;
  for (const e of usefulEvents(id)) {
    if (e.key === 'alert') { sc += 3; why.push(e.t); }
    else if (e.d < 0 && SIGNAL_DIR[e.key]) { sc += 3; why.push(e.t); }
    else if (e.d > 0 && SIGNAL_DIR[e.key]) { sc += 1.5; why.push(e.t); }
    else if (e.key === 'volume' || e.key === 'inst') { sc += 0.5; }
  }
  const m = mktPct();
  if (m != null) {
    const gap = a.pct - m;
    if (Math.abs(gap) >= 3) { sc += 2; why.push(`${gap < 0 ? '弱' : '強'}於大盤 ${Math.abs(gap).toFixed(1)} 個百分點`); }
    else if (Math.abs(gap) >= 1.5) sc += 1;
  }
  const lv = a.levels || {};
  if (lv.sup) { const d = (1 - lv.sup.price / a.last.close) * 100; if (d >= 0 && d <= 2) { sc += 1; why.push(`離支撐 ${fmtP(lv.sup.price, priceDigits(a.last.close))} 只剩 ${d.toFixed(1)}%`); } }
  const ev = (state.cal[id] || []).find((e) => { const dd = daysTo(e.date); return dd >= 0 && dd <= 1 && !/營收公布期限|公布期限/.test(e.t); });
  if (ev) { sc += 1.5; why.push(`${whenText(daysTo(ev.date))} ${ev.who.self ? '' : ev.who.name + ' '}${ev.t}`); }
  const ann = ((state.anns || {})[id] || []).find((x) => daysTo(x.d) >= -1);
  if (ann) { sc += 2; why.push('有新公告'); }
  return { score: sc, level: sc >= 4 ? 'red' : sc >= 2 ? 'orange' : 'gray', why, ev };
}
function displayOrder() {
  return [...state.watch].map((id, i) => ({ id, i, s: attention(id).score })).sort((x, y) => y.s - x.s || x.i - y.i).map((x) => x.id);
}
const LEVEL_TEXT = { red: '需要處理', orange: '留意', gray: '照常' };


// ---------- 明天看哪些價位 ----------
function renderLadder(a) {
  const lv = a.levels || {};
  const dg = priceDigits(a.last.close);
  const c = a.last.close;
  const d = (p) => sPct((p / c - 1) * 100, 1);
  const ma = sma(a.daily, 20).at(-1)?.value;
  const rows = [];
  if (lv.res2) rows.push(['res', '壓力 2', lv.res2.price, `站上 ${fmtP(lv.res2.price, dg)}，近半年的壓力就全部突破，上方沒有明顯關卡`]);
  if (lv.res) rows.push(['res', '壓力', lv.res.price, `收盤站上 ${fmtP(lv.res.price * 1.01, dg)}（多 1%）才算突破${lv.res.touches > 1 ? `，這裡測試過 ${lv.res.touches} 次` : ''}；站不上屬反彈`]);
  if (ma) rows.push(['ma', '月線', ma, c >= ma ? `目前在月線上方，跌回 ${fmtP(ma, dg)} 以下短線轉弱` : `目前在月線下方，收回 ${fmtP(ma, dg)} 以上短線轉強`]);
  rows.push(['now', '今日收盤', c, '']);
  if (lv.sup) rows.push(['sup', '支撐', lv.sup.price, `收盤跌破 ${fmtP(lv.sup.price * 0.99, dg)}（少 1%）算跌破${lv.sup.touches > 1 ? `，這裡守過 ${lv.sup.touches} 次` : ''}${lv.sup2 ? `，下一道看 ${fmtP(lv.sup2.price, dg)}` : '，下方沒有更近的支撐'}`]);
  if (lv.sup2) rows.push(['sup', '支撐 2', lv.sup2.price, `再跌破代表近半年的低點區也失守`]);
  rows.sort((x, y) => y[2] - x[2]);
  $('ladder').innerHTML = `<div class="row-between"><h3>明天看哪些價位</h3><span class="muted small">依日 K 壓力支撐與月線</span></div>
    <div class="lad">${rows.map(([k, label, p, t]) => `<div class="lad-r ${k}"><b class="num">${fmtP(p, dg)}</b><span class="lad-k">${label}${k === 'now' ? '' : `<small class="num">${d(p)}</small>`}</span><span>${esc(t)}</span></div>`).join('')}</div>`;
}


// ---------- 指標成績單 ----------
// 今天的指標：技術訊號與籌碼（itemsFromAnalysis）加上只有畫面上算得到的：強弱於大盤、關聯美股、題材排名、千張大戶
function journalExtra(id, a) {
  const out = {};
  const m = mktPct();
  if (m != null && state.mkt.taiex.at(-1)[0] === a.last.time) {
    if (a.pct - m >= 2) out.rsUp = 1;
    else if (a.pct - m <= -2) out.rsDn = -1;
  }
  const us = (state.relM[id] || []).filter((x) => x.m && x.e.kind === 'us' && (x.m.corr ?? 0) >= 0.2 && x.m.date < a.last.time && Math.abs(x.m.r1) >= 1.5);
  if (us.length) out.usrel = Math.sign(us.sort((x, y) => Math.abs(y.m.r1) - Math.abs(x.m.r1))[0].m.r1);
  const mk = state.market;
  if (mk && mk.dates.at(-1) === a.last.time) {
    const theme = THEMES.find((t) => t.ids.includes(id));
    if (theme) {
      if (!state.themeRank || state.themeRank.date !== a.last.time) {
        const r = rankBy(sectorTable(mk, THEMES, state.info), 'r5').map((x) => x.name);
        state.themeRank = { date: a.last.time, r };
      }
      const r = state.themeRank.r;
      const pos = r.indexOf(theme.name);
      if (pos >= 0 && pos < 3) out.secTop = 1;
      else if (pos >= 0 && pos >= r.length - 3) out.secBot = -1;
    }
  }
  const sh = state.sh ? holdingSeries(state.sh, id) : [];
  if (sh.length > 1 && daysTo(sh.at(-1).date) >= -6) {
    const d = sh.at(-1).big - sh.at(-2).big;
    if (d >= 0.3) out.bigUp = 1;
    else if (d <= -0.3) out.bigDn = -1;
  }
  return out;
}
let jrTimer = null;
function journalToday() {
  clearTimeout(jrTimer);
  jrTimer = setTimeout(async () => {
    const latest = state.market?.dates?.at(-1) || state.detail?.date;
    if (!latest) return;
    const m = mktPct();
    const regime = m == null || state.mkt.taiex.at(-1)[0] !== latest ? null : m >= 0 ? 'u' : 'd';
    for (const id of state.watch) {
      const a = state.an[id];
      if (!a || a.empty || a.last.time !== latest) continue;
      try { await recordDay(latest, id, { ...itemsFromAnalysis(a), ...journalExtra(id, a) }, regime); } catch (e) { /* 略過 */ }
    }
    renderScore();
  }, 1500);
}
async function closesFor(ids) {
  const out = {};
  for (const id of ids) {
    let a = state.an[id];
    if (!a) { const c = await getCachedStock(id); if (c) a = analyze(patchOne(id, c)); }
    if (a && !a.empty) out[id] = a.daily;
  }
  return out;
}
async function renderScore() {
  const jr = await loadJournal();
  const cur = state.scoreCur ? state.cur : null;
  const ids = [...new Set(jr.flatMap((d) => Object.keys(d.data || {})))];
  const closes = await closesFor(cur ? [cur] : ids);
  const sc = scorecard(jr, closes, { only: cur });
  const rel = cur ? relOf(cur) : null;
  $('scoreBtH').hidden = !cur;
  const days = jr.length;
  $('scoreNote').innerHTML = days
    ? `從 ${md(jr[0].date)} 開始記錄，共 ${days} 個交易日${cur ? `（${esc(nameOf(cur))}）` : `、${ids.length} 檔`}。${days < 30 ? '剛開始累積，評語要等每個指標 5 日後滿 20 次才會出現，大約需要 2 到 3 個月。' : ''}`
    : '還沒有記錄。每個交易日收盤後（打開頁面或 16:40 自動更新時）會記下當天的指標。';
  const pc = (h) => (h && h.n ? `${Math.round((h.ok / h.n) * 100)}%<small> /${h.n}</small>` : '–');
  const VERD = { good: ['可參考', 'ok'], bad: ['不準', 'bad'], flat: ['沒有方向', 'mid'], few: ['累積中', 'wait'] };
  $('scoreBody').innerHTML = sc.length
    ? sc.map((s) => {
        const v = VERD[s.verdict];
        const h5 = s.h[5];
        const bt = rel?.[s.key];
        const drift = s.drift === 'better' ? '，近 60 天變準' : s.drift === 'worse' ? '，近 60 天變差' : '';
        return `<tr><td class="l">${esc(JKEYS[s.key] || s.key)}</td><td>${s.n}</td><td>${pc(s.h[1])}</td><td><b>${pc(h5)}</b></td><td>${pc(s.h[20])}</td><td class="${tone(s.avgRet5)}">${s.avgRet5 == null ? '–' : sPct(s.avgRet5, 2)}</td><td>${s.recentRate == null ? '–' : Math.round(s.recentRate * 100) + '%'}</td><td>${pc(s.regime.u)}</td><td>${pc(s.regime.d)}</td>${cur ? `<td>${bt && bt.n ? `${Math.round(bt.rate * 100)}%<small> /${bt.n}</small>` : '–'}</td>` : ''}<td class="l"><span class="rv ${v[1]}">${v[0]}${s.verdict === 'few' ? ` ${h5?.n || 0}/${MIN_N}` : ''}</span>${drift}</td></tr>`;
      }).join('')
    : `<tr><td class="l empty" colspan="${cur ? 11 : 10}">尚無資料</td></tr>`;
}
$('scoreSeg').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  state.scoreCur = b.dataset.v === 'cur';
  $('scoreSeg').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderScore();
});


// ---------- 觀察清單與情報雷達數字 ----------
function renderObsSide() {
  const ob = state.observe || [];
  $('obsWrap').hidden = !ob.length;
  const last = state.market?.prices?.at(-1) || {};
  $('obsList').innerHTML = ob.map((id) => {
    const p = last[id];
    return `<li><button type="button" data-open="${id}">${esc(nameOf(id))}</button><span class="num">${p ? `${fmtP(p[0])} <span class="${tone(p[2])}">${sPct(p[2] * 100, 1)}</span>` : ''}</span></li>`;
  }).join('');
}
$('obsList').addEventListener('click', (e) => { const b = e.target.closest('[data-open]'); if (b) openStock(b.dataset.open); });
$('sObs').addEventListener('click', async () => {
  state.observe = [...new Set([...(state.observe || []), state.cur])];
  await setObserve(state.observe);
  $('sObs').hidden = true;
  renderObsSide();
});
// 情報雷達按鈕上的數字：最新一天的重要情報
async function radarBadge() {
  try {
    const { anns = {} } = await chrome.storage.local.get('anns');
    const { qfii } = await chrome.storage.local.get('qfii');
    const shares = {};
    for (const [id, v] of Object.entries(qfii?.map || {})) shares[id] = v[2];
    const links = {};
    for (const id of [...state.watch, ...(state.observe || [])]) links[id] = ['自選股'];
    // 最新一個正常交易日（週末偶爾有零星公告，至少 10 則才算）
    const cnt = {};
    for (const a of Object.values(anns).flat()) cnt[a.d] = (cnt[a.d] || 0) + 1;
    const latest = Object.keys(cnt).filter((d) => cnt[d] >= 10).sort().at(-1);
    const items = buildIntel({ anns, market: state.market, shares, keywords: await getKeywords(), links, since: latest });
    const { intelBadge } = await chrome.storage.local.get('intelBadge');
    const n = intelBadge && intelBadge.date === latest ? intelBadge.n : items.filter((x) => x.important).length;
    $('radarBadge').textContent = n ? `${md(latest)} ${n} 則` : '';
  } catch (e) { /* 略過 */ }
}

// ---------- 自選股合併時間軸 ----------
function renderSideCal() {
  const el = $('sideCal');
  if (!el) return;
  const map = new Map();
  for (const id of state.watch) {
    for (const e of state.cal[id] || []) {
      const dd = daysTo(e.date);
      if (dd < 0 || dd > 14) continue;
      // 本股事件以「日期＋事件名稱」合併（例如四檔的財報期限）；關聯公司事件以公司合併
      const k = e.date + '|' + (e.who.self ? e.t : (e.who.id || e.who.name) + e.t);
      const x = map.get(k) || { date: e.date, t: e.who.self ? e.t : `${e.who.name} ${e.t}`, self: !!e.who.self, ids: new Set(), rel: [] };
      x.ids.add(id);
      if (!e.who.self) x.rel.push(`${nameOf(id)}的${e.who.rel}`);
      map.set(k, x);
    }
  }
  const list = [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)).slice(0, 12);
  if (!list.length) return (el.innerHTML = '<li class="muted small">未來兩週沒有已知事件</li>');
  el.innerHTML = list.map((x) => {
    const ids = [...x.ids];
    const who = x.self ? (ids.length === state.watch.length && ids.length > 1 ? '自選股全部' : ids.map((i) => stockLink(i, nameOf(i))).join('、')) : [...new Set(x.rel)].map(esc).join('、');
    const dd = daysTo(x.date);
    return `<li class="${dd <= 1 ? 'soon' : ''}"><span class="tl-d num">${md(x.date)}<br><span class="muted">${whenText(dd)}</span></span><span class="tl-dot${x.self ? '' : ' rel'}"></span><span class="tl-b"><b>${esc(x.t)}</b><span class="muted small">${who}</span></span></li>`;
  }).join('');
}

// ---------- 對答案 ----------
function reviewOf(id) {
  const data = state.data[id];
  if (!data) return null;
  const pd = patchOne(id, data);
  const key = id + ':' + pd.price.at(-1)[0] + ':' + pd.price.length;
  if (state.rv?.[key]) return state.rv[key];
  state.rv = state.rv || {};
  try { state.rv[key] = reviewStock(pd); } catch (e) { state.rv[key] = null; }
  return state.rv[key];
}
const RES_CLS = { 應驗: 'ok', 守住: 'ok', 突破: 'ok', 未應驗: 'bad', 跌破: 'bad', 未突破: 'mid', 待觀察: 'wait' };
function renderReview() {
  const id = state.cur;
  const r = id && reviewOf(id);
  if (!r || !r.days.length) return ($('review').innerHTML = '');
  const row = (d) => d.items.map((x, k) => `<tr>${k === 0 ? `<td rowspan="${d.items.length}" class="l num">${md(d.date)}<br><span class="muted small">收 ${fmtP(d.close)}</span></td>` : ''}<td class="l">${esc(x.t)}</td><td><span class="rv ${RES_CLS[x.res]}">${x.res}</span></td><td class="num ${tone(x.move)}">${x.done ? '' : '目前 '}${sPct(x.move, 1)}</td></tr>`).join('');
  const pct = r.total ? Math.round((r.hit / r.total) * 100) : null;
  const all = state.watch.map((w) => reviewOf(w)).filter(Boolean);
  const T = all.reduce((s2, x) => s2 + x.total, 0);
  const Hh = all.reduce((s2, x) => s2 + x.hit, 0);
  $('review').innerHTML = `
    <div class="row-between"><h3>對答案：之前的提醒後來怎麼了</h3><span class="muted small">以當時看得到的資料重算</span></div>
    <p class="small">本股近 20 個交易日的方向訊號 <b>${r.total}</b> 次，${REVIEW_H} 日後方向正確 <b>${r.hit}</b> 次${pct != null ? `（${pct}%）` : ''}${state.watch.length > 1 && T ? `；自選股合計 ${T} 次，正確 ${Hh} 次（${Math.round((Hh / T) * 100)}%）` : ''}。${r.total < 5 ? '次數還少，參考就好。' : pct != null && pct < 50 ? '低於一半，這檔的訊號最近不太可靠。' : ''}</p>
    <div class="tbl-wrap"><table class="tbl rv-tbl"><thead><tr><th class="l">提醒日</th><th class="l">當時的提醒</th><th>結果</th><th>${REVIEW_H} 日後漲跌</th></tr></thead><tbody>${r.days.slice(0, 3).map(row).join('')}</tbody></table></div>
    ${r.days.length > 3 ? `<details><summary class="small">再往前 ${r.days.length - 3} 天</summary><div class="tbl-wrap"><table class="tbl rv-tbl"><tbody>${r.days.slice(3).map(row).join('')}</tbody></table></div></details>` : ''}
    <p class="muted small">方向訊號（站上／跌破月線、突破／跌破等）看 ${REVIEW_H} 個交易日後收盤是否同方向（漲跌 0.3% 以內不算）；距壓力支撐 3% 以內時看之後 ${REVIEW_H} 天收盤有沒有穿越 1%。</p>`;
}

function renderSigHist(a) {
  const id = state.cur;
  const keyed = a.events.filter((e) => SIGNAL_NAMES[e.key]);
  if (!keyed.length) return ($('sigHist').innerHTML = '');
  const cacheKey = id + a.last.time + a.daily.length;
  if (!state.hist[cacheKey]) state.hist[cacheKey] = signalHistory(a.daily);
  const h = state.hist[cacheKey];
  const rows = keyed.map((e) => {
    const x = h[e.key];
    if (!x) return `<tr><td class="l">${esc(SIGNAL_NAMES[e.key])}</td><td>0</td><td colspan="3" class="muted">過去兩年沒有出現過</td></tr>`;
    return `<tr><td class="l">${esc(SIGNAL_NAMES[e.key])}</td><td>${x.n}</td><td class="${tone(x.avg5)}">${sPct(x.avg5, 1)}</td><td>${x.up5} / ${x.n}（${((x.up5 / x.n) * 100).toFixed(0)}%）</td><td class="${tone(x.avg20)}">${x.avg20 == null ? '–' : sPct(x.avg20, 1)}</td></tr>`;
  }).join('');
  const other = a.events.filter((e) => !SIGNAL_NAMES[e.key]).map((e) => e.t);
  const minN = Math.min(...keyed.map((e) => h[e.key]?.n || 0));
  $('sigHist').innerHTML = `<table class="num"><thead><tr><th class="l">今日訊號在本股過去兩年的表現</th><th>出現次數</th><th>5 日後平均</th><th>5 日後上漲</th><th>20 日後平均</th></tr></thead><tbody>${rows}</tbody></table>
    <p>以還原股價計算，從 ${md(Object.values(h)[0]?.from || '')} 起算。${minN < 8 ? '次數少於 8 次的結果參考價值有限。' : ''}上漲比例接近 50% 代表這個訊號在這檔股票上沒有明顯方向。${other.length ? other.join('、') + ' 沒有足夠的歷史資料可以統計。' : ''}</p>`;
}

// ---------- 季財報 ----------
async function loadFin(id) {
  if (state.fin[id]) return renderFinancials();
  try {
    state.fin[id] = quarterly(await loadFinancials(id));
  } catch (e) {
    state.fin[id] = { error: e.message };
  }
  if (state.cur === id) renderFinancials();
}

function renderFinancials() {
  const q = state.fin[state.cur];
  if (!q) return ($('financials').innerHTML = '<span class="empty">載入中</span>');
  if (q.error) return ($('financials').innerHTML = `<span class="empty">${esc(q.error)}</span>`);
  if (!q.length) return ($('financials').innerHTML = '<span class="empty">查無季財報資料</span>');
  const l = q[q.length - 1];
  const ly = q.length > 4 ? q[q.length - 5] : null;
  const max = Math.max(...q.map((x) => Math.abs(x.eps))) || 1;
  const hasNeg = q.some((x) => x.eps < 0);
  const mid = hasNeg ? 50 : 100;
  const bars = q.map((x) => {
    const h = (Math.abs(x.eps) / max) * (hasNeg ? 50 : 100);
    return `<div class="col" title="${x.label} EPS ${x.eps.toFixed(2)}"><span style="top:${x.eps >= 0 ? mid - h : mid}%;height:${h}%;background:${x === l ? 'var(--ink)' : '#B9B5AC'}"></span></div>`;
  }).join('');
  const kv = (k, v, prev, unit = '', dg = 1) => `<div class="kv"><span>${k}</span><span class="num">${v == null ? '–' : v.toFixed(dg) + unit}${prev != null && v != null ? ` <span class="muted small">去年同季 ${prev.toFixed(dg)}${unit}</span>` : ''}</span></div>`;
  $('finDate').textContent = l.label;
  $('financials').innerHTML = `<div class="eps-bars"><span class="mid" style="top:${mid}%"></span>${bars}</div>
    <div class="eps-labels">${q.map((x) => `<span>${x.label}</span>`).join('')}</div>
    ${kv('EPS（元）', l.eps, ly?.eps, '', 2)}
    ${kv('毛利率', l.gm, ly?.gm, '%')}
    ${kv('營益率', l.om, ly?.om, '%')}
    ${l.epsYoy != null ? `<span class="small ${tone(l.epsYoy)}">EPS 年增 ${sPct(l.epsYoy, 1)}</span>` : ''}`;
}

// ---------- 估值位置 ----------
function band(label, v, dg = 1) {
  if (!v) return `<div class="kv"><span>${label}</span><span class="muted">資料不足或為負值</span></div>`;
  const pos = (x) => ((x - v.min) / (v.max - v.min || 1)) * 100;
  const word = v.pct >= 80 ? '偏高' : v.pct <= 20 ? '偏低' : '中間';
  return `<div class="band"><div class="kv"><span>${label} <b class="num">${v.cur.toFixed(dg)}</b></span><span class="num">近三年 ${v.pct.toFixed(0)}% 位置（${word}）</span></div>
    <div class="track"><s style="left:${pos(v.q1)}%"></s><s style="left:${pos(v.med)}%"></s><s style="left:${pos(v.q3)}%"></s><i style="left:${pos(v.cur)}%"></i></div>
    <div class="row-between muted small num"><span>低 ${v.min.toFixed(dg)}</span><span>中位數 ${v.med.toFixed(dg)}</span><span>高 ${v.max.toFixed(dg)}</span></div></div>`;
}

function renderValuation(a) {
  const v = a.valuation || {};
  $('valuation').innerHTML = band('本益比', v.per, 1) + band('股價淨值比', v.pbr, 2) +
    '<span class="muted small">位置 = 近三年有多少比例的日子比現在便宜。偏高不代表會跌，只代表市場給的價格比過去貴。</span>';
}

// ---------- 大戶持股 ----------
function renderShareholding() {
  if (!state.sh) {
    $('shareholding').innerHTML = '<span class="empty">集保資料載入中</span>';
    return;
  }
  const s = holdingSeries(state.sh, state.cur);
  if (!s.length) {
    $('shareholding').innerHTML = '<span class="empty">查無這檔的集保資料</span>';
    $('shDate').textContent = '';
    return;
  }
  const l = s[s.length - 1];
  const p = s.length > 1 ? s[s.length - 2] : null;
  const d = (k) => (p ? l[k] - p[k] : null);
  const ch = (k) => (p ? `<span class="${tone(d(k))}">${d(k) > 0 ? '+' : d(k) < 0 ? '−' : ''}${Math.abs(d(k)).toFixed(2)}</span>` : '');
  $('shDate').textContent = '集保 ' + l.date.slice(5).replace('-', '/');
  const max = Math.max(...s.map((x) => x.big)) || 1;
  const min = Math.min(...s.map((x) => x.big));
  $('shareholding').innerHTML = `
    <div class="kv"><span>千張大戶</span><span class="num"><b>${l.big.toFixed(2)}%</b> ${ch('big')}</span></div>
    <div class="kv"><span>400 張以上</span><span class="num">${l.b400.toFixed(2)}% ${ch('b400')}</span></div>
    <div class="kv"><span>未滿 50 張</span><span class="num">${l.small.toFixed(2)}% ${ch('small')}</span></div>
    <div class="kv"><span>股東人數</span><span class="num">${fmtInt(l.people)} ${p ? `<span class="${tone(-(l.people - p.people))}">${sInt(l.people - p.people)}</span>` : ''}</span></div>
    ${s.length > 1 ? `<div class="sh-bars" title="千張大戶持股比例">${s.map((x, i) => `<span class="${i === s.length - 1 ? 'last' : ''}" style="height:${(20 + ((x.big - min) / (max - min || 1)) * 80).toFixed(0)}%"></span>`).join('')}</div>` : ''}
    <span class="muted small">${p ? '數字旁為與上週相比（百分點）。大戶增加、股東人數減少，代表籌碼往大戶集中。' : '集保公開資料只提供最新一週，之後每週自動累積，下週起就能看到變化。'}</span>`;
  renderHighlights();
}

// ---------- 關聯新聞 ----------
// 關聯新聞只查公司（不查指數、ETF、匯率），標題要直接提到該公司才保留
const NEWS_SKIP = new Set(['TAIEX', 'SOXX', 'USD']);
// 標題還要帶有投資或業務相關字眼，避免一般消費新聞（例如優惠活動、展覽）
const BIZ = /財報|營收|獲利|盈餘|EPS|股價|股東|訂單|出貨|供應鏈|法說|資本支出|美股|台股|投資|併購|收購|展望|財測|需求|晶片|AI|伺服器|產能|擴產|代工|客戶|大漲|大跌|上漲|下跌|漲停|跌停|買超|賣超|目標價|評等|建案|房市|推案|耳機|電競|裁員|關稅/i;
const PROMO = /優惠|折扣|特價|抽獎|開箱|限時|雙11|雙十一|促銷|團購/;
function keywords(e) {
  if (e.kw) return e.kw;
  return [e.name, e.kind === 'us' ? e.id : null].filter((x) => x && x.length >= 2);
}

async function loadRelNews(id) {
  const rels = state.rel[id] || [];
  const own = await googleNews(ownQuery(id), { days: 7, limit: 10 });
  state.gn[id] = own;
  if (state.cur === id && state.an[id] && !state.an[id].empty) renderNews(state.an[id]);
  const out = [];
  for (const r of rels) {
    if (r.e.kind === 'fx' || NEWS_SKIP.has(r.e.id) || r.e.auto) continue;
    const kw = keywords(r.e);
    const q = kw.length > 1 ? kw.map((k) => `"${k}"`).join(' OR ') : r.e.q || r.e.name || r.e.id;
    const items = await googleNews(q, { days: 10, limit: 20 });
    const ctx = r.e.ctx ? new RegExp(r.e.ctx, 'i') : BIZ;
    const hit = items.filter((it) => kw.some((k) => it.title.toLowerCase().includes(k.toLowerCase())) && ctx.test(it.title) && !PROMO.test(it.title)).slice(0, 3);
    for (const it of hit) out.push({ ...it, tag: r.e.name || r.e.id, rel: r.e.rel });
    state.relNews[id] = out.slice();
    if (state.cur === id) renderRelNews();
  }
  state.relNews[id] = out;
  if (state.cur === id) renderRelNews();
}

function renderRelNews() {
  const list = state.relNews[state.cur];
  if (!list) return ($('relNews').innerHTML = '<li class="empty">載入中</li>');
  const seen = new Set();
  const rows = list.filter((n) => { const k = n.title.slice(0, 24); if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, 12);
  $('relNews').innerHTML = rows.length
    ? rows.map((n) => `<li><span><span class="ntag">${esc(n.tag)}</span><a href="${esc(n.link)}" target="_blank" rel="noopener noreferrer">${esc(n.title)}</a></span><span class="muted small num">${esc(toLocal(n.date).slice(5).replace('-', '/'))} · ${esc(n.source)} · ${esc(n.rel)}</span></li>`).join('')
    : '<li class="empty">近 10 天沒有直接提到關聯公司的新聞</li>';
}

// ---------- 啟動 ----------
async function init() {
  state.settings = await getSettings();
  applyConvention();
  state.watch = await getWatchlist();
  const fromHash = decodeURIComponent(location.hash.slice(1));
  state.cur = isStockId(fromHash) ? fromHash : state.watch[0] || null;
  renderWatch();
  try {
    state.info = await getStockInfo();
    fillStockList();
  } catch (e) {
    setStatus('股票名稱清單載入失敗：' + e.message, true);
  }
  // 先用本機快取立刻畫出來，網路資料到了再更新
  state.detail = await readDetail().catch(() => null);
  for (const id of new Set([state.cur, ...state.watch].filter(Boolean))) {
    const c = await getCachedStock(id);
    if (c) { state.data[id] = c; analyzeOne(id); }
  }
  renderWatch();
  renderMain();
  renderOverview();
  renderAsOf();
  loadMarketStrip();
  setTimeout(() => pruneCaches(state.watch).catch(() => {}), 30000);
  state.alerts = (await chrome.storage.sync.get('alerts')).alerts || {};
  if (state.cur) loadFin(state.cur);
  state.observe = await getObserve().catch(() => []);
  renderObsSide();
  try { const st = await chrome.storage.local.get(['ind', 'cmp']); state.ind = st.ind || 'none'; state.cmp = st.cmp || 'none'; } catch (e) { /* 預設不顯示 */ }
  collectConferences().then((c) => { state.confs = c; }).catch(() => {});
  collectAnnouncements().then((x) => { state.anns = x; renderAnns(); renderHighlights(); renderWatch(); radarBadge(); }).catch(() => {});
  await initHolidays();
  // 全市場行情（交易所）和 FinMind 是不同來源，同時下載
  const mk = loadMarket();
  // 從別處點進來、不在自選股的股票（在新分頁開啟時）先載入，不必等自選股全部更新完
  if (state.cur && !state.watch.includes(state.cur)) {
    setStatus('載入 ' + nameOf(state.cur));
    const err = await loadOne(state.cur, false);
    if (err) setStatus(err, true);
  }
  await refreshAll(false);
  loadShareholding().then((sh) => { state.sh = sh; renderShareholding(); renderOverview(); journalToday(); }).catch((e) => { $('shareholding').innerHTML = `<span class="empty">${esc(e.message)}</span>`; });
  if (state.cur) await loadRelations(state.cur);
  await mk;
}

init();

// 視窗大小改變時重新對齊壓力支撐標籤
new ResizeObserver(() => requestAnimationFrame(() => state.placeTags?.())).observe($('chart'));

// ---------- 名詞說明 ----------
// 畫面上出現這些詞時，滑鼠移過去顯示白話解釋（虛線底線標示）
const GLOSS = {
  '振幅': '當天最高價與最低價的差距，除以昨收。數字越大，當天上下震盪越劇烈。',
  '量比': '今天成交量除以前 20 天平均成交量。1.5 倍以上代表明顯放量，常伴隨消息或趨勢轉變。',
  '本益比': '股價除以近四季每股盈餘，等於用現在的獲利要幾年回本。同產業互相比較才有意義。',
  '殖利率': '近一年現金股利除以股價，類似存股的年利率。',
  '券資比': '融券餘額除以融資餘額。偏高代表放空的人相對多，股價上漲時空方回補可能推升股價（軋空）。',
  '融資餘額': '投資人向券商借錢買股、還沒還的張數。短時間大增代表散戶追價，籌碼較不穩。',
  '融券餘額': '投資人借股票先賣出（放空）、還沒買回的張數。',
  '融資 5 日變化': '融資餘額和 5 個交易日前相比的增減幅度。',
  'KD': '看收盤價在近 9 天高低區間的位置。80 以上偏熱、20 以下偏冷；K 由下往上穿過 D 稱黃金交叉，常視為轉強。',
  'MACD': '短期與長期均線的差距。柱狀由負轉正代表短線動能轉強，由正轉負代表轉弱。',
  'RSI': '近幾天上漲幅度佔全部漲跌的比例。70 以上偏熱、30 以下偏冷。',
  '千張大戶': '持有 1,000 張以上的股東合計持股比例（集保每週公布）。上升代表籌碼往大戶集中。',
  '外資持股': '外資與陸資合計持有的張數與佔發行股數比例，交易所每天公布。',
  '相關': '近 60 個交易日兩者每日漲跌的連動程度。1 代表完全同向、0 代表沒關係、負數代表反向。0.3 以上算有明顯連動。',
  '站上 20 日線': '收盤價高於近 20 日平均價（月線），通常視為短期趨勢向上。',
  '月線': '近 20 個交易日的平均收盤價，代表大約一個月的平均成本。',
  '上方壓力': '過去多次漲到附近就回落的價位區間，測試次數越多越難突破。',
  '下方支撐': '過去多次跌到附近就反彈的價位區間，測試次數越多越重要；跌破時常加速下跌。',
  '連漲連跌': '收盤連續上漲或下跌的天數。',
  '估值位置': '目前本益比、股價淨值比在近三年資料中的百分位，越高代表相對過去越貴。',
  '股價淨值比': '股價除以每股淨值，代表市場用幾倍的帳面價值買這家公司。',
  '漲跌拆解': '把本股今天的漲跌和大盤、同族群、關聯美股前一晚比較，推估是跟著誰動。只是推估，不代表確定原因。',
  '自營商': '證券公司用自己的錢買賣，包含自行買賣與避險（多為權證避險），短線進出為主。',
  '投信': '基金公司（國內投信）的買賣，連續買超常被視為作帳或看好。',
  '外資': '外國機構投資人的買賣，金額通常最大，對權值股影響明顯。',
};
const GLOSS_KEYS = Object.keys(GLOSS).sort((a, b) => b.length - a.length);
function applyGloss(root) {
  for (const el of root.querySelectorAll('th, .stat > span, .kv > span:first-child, .level > span.muted, .tag, .attrib > span.muted, #indSeg button, h3')) {
    if (el.dataset.gloss) continue;
    const text = el.textContent.trim();
    const k = GLOSS_KEYS.find((key) => text === key || text.startsWith(key + ' ') || text.startsWith(key + '（') || (key.length >= 3 && text.includes(key)));
    if (!k) continue;
    el.dataset.gloss = k;
    el.title = GLOSS[k];
    el.classList.add('term');
  }
}
let glossQueued = false;
new MutationObserver(() => {
  if (glossQueued) return;
  glossQueued = true;
  requestAnimationFrame(() => { glossQueued = false; applyGloss(document.body); });
}).observe(document.body, { childList: true, subtree: true });

// 字體大小改變：圖表內的字也跟著放大（圖表本身不受整頁縮放影響，滑鼠位置才會對準）
window.addEventListener('scalechange', () => { const a = state.an[state.cur]; if (a && !a.empty) renderChart(a); if (state.ent?.rows && $('entDlg').open) drawEntity(); });

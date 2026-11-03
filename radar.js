import { initScale } from './lib/ui.js';
initScale();
// 情報雷達頁：全市場公告篩選、觀察清單、關鍵字、各類消息的事後影響
import { getWatchlist, getObserve, setObserve, getKeywords, setKeywords, getSettings } from './lib/storage.js';
import { getStockInfo } from './lib/api.js';
import { collectAnnouncements } from './lib/announce.js';
import { readMarket, ensureMarket } from './lib/market.js';
import { loadForeignHolding } from './lib/qfii.js';
import { getRelations } from './lib/relations.js';
import { THEMES } from './lib/sectors.js';
import { googleNews } from './lib/gnews.js';
import { CATS, buildIntel, fetchInsider, impactText } from './lib/intel.js';
import { $, esc, fmtP, sPct, tone, md } from './lib/format.js';
import { loadThemes, stageHTML, moversHTML, clustersHTML, validHTML, howHTML } from './lib/theme-ui.js';
import { THEME_DEFS } from './lib/themes.js';
import { pttThemes } from './lib/ptt.js';
import { SKIP_INDUSTRY } from './lib/sectors.js';

const state = { info: {}, watch: [], observe: [], kws: [], market: null, items: [], days: 1, cat: 'sell', early: {} };
const nameOf = (id) => state.info[id]?.name || id;
const setStatus = (t, err) => { $('status').textContent = t; $('status').classList.toggle('err', !!err); };
const open = (id) => { location.href = 'dashboard.html#' + id; };

// 每檔公司和你的自選股、觀察清單有什麼關係
async function buildLinks() {
  const links = {};
  const add = (id, t) => { (links[id] = links[id] || []); if (!links[id].includes(t)) links[id].push(t); };
  for (const w of state.watch) {
    add(w, '自選股');
    for (const r of await getRelations(w).catch(() => [])) if (r.kind === 'tw' && /^\d{4}$/.test(r.id)) add(r.id, `${nameOf(w)}的${r.rel}`);
    for (const t of THEMES) if (t.ids.includes(w)) for (const id of t.ids) if (id !== w) add(id, `${nameOf(w)}同題材`);
  }
  for (const o of state.observe) add(o, '觀察清單');
  return links;
}

async function build() {
  setStatus('整理公告中');
  const [anns, insider, links] = await Promise.all([collectAnnouncements().catch(() => ({})), fetchInsider().catch(() => []), buildLinks()]);
  const { qfii } = await chrome.storage.local.get('qfii');
  let q = qfii;
  if (!q && state.market?.dates?.length) q = await loadForeignHolding(state.market.dates.at(-1)).catch(() => null);
  const shares = {};
  for (const [id, v] of Object.entries(q?.map || {})) shares[id] = v[2];
  const names = Object.fromEntries(Object.entries(state.info).map(([id, v]) => [id, v.name]));
  state.items = buildIntel({ anns, insider, market: state.market, shares, names, keywords: state.kws, links });
  state.anns = anns;
  await saveLog();
  await saveCal();
  // 給速覽頁按鈕上的數字用（與這裡最新一天的重要情報一致）
  const d1 = sinceDate(1);
  chrome.storage.local.set({ intelBadge: { date: d1, n: state.items.filter((x) => x.d >= d1 && x.important).length } });
  render();
  const latest = state.items[0]?.d;
  $('asof').textContent = latest ? latest.replaceAll('-', '/') : '';
  setStatus(`全市場 ${Object.values(anns).reduce((s, l) => s + l.filter((a) => a.d === latest).length, 0)} 則公告（${md(latest)}）`);
  checkEarly();
}

// 期間：最近 N 個有公告的日子
function sinceDate(n) {
  const ds = [...new Set(state.items.map((x) => x.d))].sort().reverse();
  return ds[Math.min(n, ds.length) - 1] || '';
}

function itemHTML(it, compact = false) {
  const c = CATS[it.cat];
  const r = it.react;
  const imp = impactText(it);
  const flags = [];
  for (const l of it.links) flags.push(`<span class="flag link">${esc(l)}</span>`);
  for (const k of it.kw || []) flags.push(`<span class="flag kw">關鍵字：${esc(k)}</span>`);
  if (r?.leaked) flags.push(`<span class="flag warn">公告前 5 日已漲 ${sPct(r.pre5, 1)}，可能已反應</span>`);
  if (it.report) flags.push(`<span class="flag">預計認列於 ${it.report.label}財報（${md(it.report.deadline)} 前公布）</span>`);
  const e = state.early[key(it)];
  if (e) flags.push(`<span class="flag warn">${esc(e)}</span>`);
  const detail = [];
  if (it.cat === 'sell') {
    if (it.profit != null) detail.push(`處分${it.profit >= 0 ? '利益' : '損失'} ${it.foreign ? it.foreign + ' ' : ''}${money(Math.abs(it.profit))}`);
    if (it.total) detail.push(`交易總額 ${money(it.total)}`);
    if (it.perShare == null && it.profit != null && !it.foreign) detail.push('缺發行股數，無法換算每股');
    if (it.profit == null) detail.push('金額未能自動解析，請看原文');
    detail.push('一次性業外收入');
  } else if (it.cat === 'buyback') {
    if (it.buyShares) detail.push(`預定買回 ${Math.round(it.buyShares / 1000).toLocaleString('en-US')} 張`);
    if (it.range) detail.push(`價格區間 ${it.range}`);
  } else if (it.cat === 'capital') {
    if (it.newShares) detail.push(`${it.dir === 'dilute' ? '發行' : '減少'} ${Math.round(it.newShares / 1000).toLocaleString('en-US')} 張`);
    if (it.dir === 'cashCut') detail.push('現金減資（退還股款）' + (it.refund ? '，' + it.refund : ''));
    if (it.dir === 'dilute' && it.pctShares == null) detail.push('股數未能自動解析，請看原文');
  } else if (it.cat === 'order') {
    if (it.total) detail.push(`合約金額 ${it.foreign ? it.foreign + ' ' : ''}${money(it.total)}`);
    detail.push('屬持續性營收，實際貢獻依合約期間');
  } else if (it.cat === 'insider') {
    if (it.pctOwn != null) detail.push(`佔其持股 ${it.pctOwn.toFixed(0)}%`);
  }
  const react = r
    ? r.pending ? '公告後尚未交易' : `反應日 <span class="${tone(r.day)}">${sPct(r.day, 1)}</span>${r.vr ? `（量 ${r.vr.toFixed(1)} 倍）` : ''} · 至今 <span class="${tone(r.since)}">${sPct(r.since, 1)}</span>`
    : '';
  return `<li>
    <span><span class="cat" style="background:${c.color}">${c.name}</span>${c.nature ? `<span class="nat">${c.nature}</span>` : ''}</span>
    <span class="body">
      <span class="ttl"><button type="button" class="nm" data-open="${it.id}">${esc(it.name)}</button> <span class="muted small">${it.id} · ${md(it.d)} ${it.t || ''}</span>　${esc(it.s)}</span>
      ${detail.length ? `<span class="meta">${esc(detail.join(' · '))}</span>` : ''}
      ${flags.length ? `<span class="flags">${flags.join('')}</span>` : ''}
      ${compact ? '' : `<details><summary class="muted">公告原文</summary><pre>${esc(it.b || '')}</pre></details>`}
    </span>
    <span class="iside">
      ${imp ? `<span class="imp ${it.cat === 'sell' ? tone(it.perShare ?? it.profit) : it.cat === 'capital' && it.dir === 'dilute' ? 'down' : ''}">${esc(imp)}</span>` : ''}
      ${react ? `<span class="react num">${react}</span>` : ''}
      ${state.watch.includes(it.id) ? '<span class="muted small">自選股</span>' : state.observe.includes(it.id) ? '<span class="muted small">觀察中</span>' : `<button type="button" class="btn small" data-obs="${it.id}">＋ 觀察</button>`}
    </span></li>`;
}
const money = (v) => (v >= 1e8 ? (v / 1e8).toFixed(2) + ' 億元' : v >= 1e4 ? Math.round(v / 1e4).toLocaleString('en-US') + ' 萬元' : Math.round(v).toLocaleString('en-US') + ' 元');
const key = (it) => `${it.id}|${it.d}|${it.cat}|${it.s.slice(0, 24)}`;

function render() {
  const since = sinceDate(state.days);
  const top = state.items.filter((x) => x.d >= since && x.important).sort((a, b) => b.score - a.score || b.d.localeCompare(a.d));
  const allN = state.items.filter((x) => x.d >= since).length;
  $('topNote').textContent = `${since ? md(since) + ' 起' : ''}分類到 ${allN} 則，篩出 ${top.length} 則重要情報，依影響大小排序。`;
  $('top').innerHTML = top.length ? top.slice(0, 40).map((x) => itemHTML(x)).join('') : '<li class="empty">這段期間沒有達到門檻的情報</li>';
  const counts = {};
  for (const x of state.items.filter((y) => y.d >= since)) counts[x.cat] = (counts[x.cat] || 0) + 1;
  $('catSeg').innerHTML = Object.entries(CATS).map(([k, c]) => `<button type="button" data-cat="${k}" aria-pressed="${k === state.cat}">${c.name} <span class="muted">${counts[k] || 0}</span></button>`).join('');
  const list = state.items.filter((x) => x.d >= since && x.cat === state.cat);
  $('catList').innerHTML = list.length ? list.slice(0, 60).map((x) => itemHTML(x, true)).join('') : '<li class="empty">這段期間沒有這類公告</li>';
  renderObs();
  renderKws();
  renderImpact();
}

// ---------- 事後影響統計（存檔累積，開放資料只有近幾天） ----------
async function saveLog() {
  const { intelLog = {} } = await chrome.storage.local.get('intelLog');
  for (const it of state.items) {
    const k = key(it);
    const r = it.react;
    const old = intelLog[k] || { cat: it.cat, d: it.d, imp: it.important };
    if (r && !r.pending) {
      old.day = r.day; old.pre5 = r.pre5;
      if (r.r5 != null) old.r5 = r.r5;
      if (r.r20 != null) old.r20 = r.r20;
    }
    intelLog[k] = old;
  }
  const cut = new Date(Date.now() - 400 * 86400000).toISOString().slice(0, 10);
  for (const k of Object.keys(intelLog)) if (intelLog[k].d < cut) delete intelLog[k];
  state.log = intelLog;
  await chrome.storage.local.set({ intelLog });
}
function renderImpact() {
  const by = {};
  for (const x of Object.values(state.log || {})) (by[x.cat] = by[x.cat] || []).push(x);
  const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const rows = Object.entries(CATS).filter(([k]) => by[k]).map(([k, c]) => {
    const l = by[k];
    const day = l.map((x) => x.day).filter((v) => v != null);
    const r5 = l.map((x) => x.r5).filter((v) => v != null);
    const r20 = l.map((x) => x.r20).filter((v) => v != null);
    const pre = l.filter((x) => x.pre5 != null);
    const a1 = avg(day), a5 = avg(r5), a20 = avg(r20);
    return `<tr><td class="l">${c.name}</td><td>${l.length}</td><td class="${tone(a1)}">${a1 == null ? '–' : sPct(a1, 2)}</td><td class="${tone(a5)}">${a5 == null ? '–' : sPct(a5, 2)}<small class="muted"> /${r5.length}</small></td><td>${r5.length ? Math.round((r5.filter((v) => v > 0).length / r5.length) * 100) + '%' : '–'}</td><td class="${tone(a20)}">${a20 == null ? '–' : sPct(a20, 2)}<small class="muted"> /${r20.length}</small></td><td>${pre.length ? Math.round((pre.filter((x) => x.pre5 >= 5).length / pre.length) * 100) + '%' : '–'}</td></tr>`;
  });
  $('impact').innerHTML = rows.join('') || '<tr><td class="l empty" colspan="7">尚無資料</td></tr>';
  const n5 = Object.values(state.log || {}).filter((x) => x.r5 != null).length;
  $('impactNote').textContent = n5 < 30 ? `目前 5 日後有結果的只有 ${n5} 則，至少累積 1 到 2 個月再看。` : '平均報酬已用還原股價計算，除權息不影響。';
}

// 處分利益預計認列的財報季，寫進行事曆（速覽頁與時間軸會讀取）
async function saveCal() {
  const { intelCal = {} } = await chrome.storage.local.get('intelCal');
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
  for (const it of state.items) {
    if (!it.report || it.profit == null || Math.abs(it.perShare ?? 0) < 0.1) continue;
    const list = intelCal[it.id] || (intelCal[it.id] = []);
    const t = `${it.report.label}財報（含處分${it.profit >= 0 ? '利益' : '損失'}）`;
    if (!list.some((x) => x.date === it.report.deadline && x.t === t)) list.push({ date: it.report.deadline, t, note: `${md(it.d)} 公告${it.perShare != null ? `，每股約 ${it.perShare.toFixed(2)} 元` : ''}；法定期限，多數公司會提早公布` });
  }
  for (const id of Object.keys(intelCal)) { intelCal[id] = intelCal[id].filter((x) => x.date >= today); if (!intelCal[id].length) delete intelCal[id]; }
  await chrome.storage.local.set({ intelCal });
}

// 媒體是否比公告先報：只查最重要的 8 則
const CAT_WORD = { sell: '處分', buyback: '庫藏股', capital: '增資', order: '合約', insider: '轉讓', clarify: '', fix: '更正', kw: '' };
async function checkEarly() {
  const since = sinceDate(state.days);
  const top = state.items.filter((x) => x.d >= since && x.important && x.cat !== 'insider').sort((a, b) => b.score - a.score).slice(0, 8);
  for (const it of top) {
    const k = key(it);
    if (k in state.early) continue;
    state.early[k] = null;
    try {
      const nm = it.name.replace(/-KY$|\*$/, '');
      const news = await googleNews(`"${nm}" ${CAT_WORD[it.cat] || ''}`.trim(), { days: 10, limit: 10 });
      const annAt = Date.parse(`${it.d}T${it.t || '00:00'}:00+08:00`);
      const early = news.filter((n) => n.title.includes(nm) && n.date && Date.parse(n.date) < annAt - 2 * 3600000).sort((a, b) => (a.date < b.date ? -1 : 1))[0];
      if (early) {
        const h = Math.round((annAt - Date.parse(early.date)) / 3600000);
        state.early[k] = `媒體比公告早 ${h >= 24 ? Math.round(h / 24) + ' 天' : h + ' 小時'}報導（${early.source || '新聞'}）`;
        render();
      }
    } catch (e) { /* 略過 */ }
  }
}

// ---------- 觀察清單與關鍵字 ----------
function renderObs() {
  const mk = state.market;
  const last = mk?.prices?.at(-1) || {};
  $('obs').innerHTML = state.observe.length
    ? state.observe.map((id) => {
        const p = last[id];
        const n = state.items.filter((x) => x.id === id).length;
        return `<li><span><button type="button" class="nm linklike" data-open="${id}">${esc(nameOf(id))}</button> <span class="muted small">${id}</span>${n ? `<br><span class="muted small">近期情報 ${n} 則</span>` : ''}</span><span class="num">${p ? `<b>${fmtP(p[0])}</b> <span class="small ${tone(p[2])}">${sPct(p[2] * 100, 2)}</span>` : ''} <button type="button" class="x" data-unobs="${id}" aria-label="移除 ${esc(nameOf(id))}">×</button></span></li>`;
      }).join('')
    : '<li class="muted small">還沒有觀察的公司，可在情報旁按「＋ 觀察」</li>';
}
function renderKws() {
  $('kws').innerHTML = state.kws.map((k) => `<button type="button" data-kw="${esc(k)}" aria-label="移除關鍵字 ${esc(k)}">${esc(k)} ×</button>`).join('') || '<span class="muted small">尚未設定</span>';
}
async function addObserve(id) {
  if (!id || state.observe.includes(id) || state.watch.includes(id)) return;
  state.observe.push(id);
  await setObserve(state.observe);
  state.items = state.items.map((x) => (x.id === id && !x.links.includes('觀察清單') ? { ...x, links: [...x.links, '觀察清單'], important: true } : x));
  render();
}
function resolve(text) {
  const t = String(text || '').trim();
  const m = t.match(/^(\d{4,6}[A-Z]?)\b/);
  if (m) return m[1];
  const ids = Object.keys(state.info).filter((id) => state.info[id]?.name === t || (state.info[id]?.name || '').includes(t));
  return ids.length === 1 || state.info[ids[0]]?.name === t ? ids[0] : null;
}

document.addEventListener('click', async (e) => {
  const o = e.target.closest('[data-open]');
  if (o) return open(o.dataset.open);
  const a = e.target.closest('[data-obs]');
  if (a) return addObserve(a.dataset.obs);
  const u = e.target.closest('[data-unobs]');
  if (u) { state.observe = state.observe.filter((x) => x !== u.dataset.unobs); await setObserve(state.observe); return render(); }
  const k = e.target.closest('[data-kw]');
  if (k) { state.kws = state.kws.filter((x) => x !== k.dataset.kw); await setKeywords(state.kws); return build(); }
  const c = e.target.closest('[data-cat]');
  if (c) { state.cat = c.dataset.cat; return render(); }
  const d = e.target.closest('#daySeg [data-v]');
  if (d) { state.days = Number(d.dataset.v); document.querySelectorAll('#daySeg button').forEach((x) => x.setAttribute('aria-pressed', String(x === d))); render(); checkEarly(); }
});
$('obsForm').addEventListener('submit', (e) => { e.preventDefault(); const id = resolve($('obsInput').value); if (!id) return setStatus('找不到「' + $('obsInput').value + '」', true); $('obsInput').value = ''; addObserve(id); });
$('kwForm').addEventListener('submit', async (e) => { e.preventDefault(); const k = $('kwInput').value.trim(); if (!k) return; $('kwInput').value = ''; state.kws.push(k); await setKeywords(state.kws); build(); });
$('refresh').addEventListener('click', async () => {
  await chrome.storage.local.set({ annsAt: 0, insider: null });
  build();
});

// ---------- 題材雷達 ----------
const trLink = (id, name) => `<button type="button" class="nm linklike" data-open="${id}">${esc(name)}</button>`;
async function renderThemes() {
  const d = state.themes;
  if (!d) { $('trBody').innerHTML = '<p class="empty">題材資料尚未產生（每個交易日 17:05 由 GitHub 整理），或暫時連不上。</p>'; return; }
  $('trNote').textContent = `資料日期 ${md(d.date)} · 更新於 ${new Date(d.builtAt).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`;
  const themeOf = (id) => THEME_DEFS.find((t) => t.ids.includes(id))?.name;
  const industryOf = (id) => (state.info[id]?.industries || []).find((c) => !SKIP_INDUSTRY.test(c));
  const tab = state.trTab || 'stage';
  const open = [...$('trBody').querySelectorAll('details[open][data-key]')].map((x) => x.dataset.key); // 重畫時保留展開狀態
  $('trBody').innerHTML = tab === 'movers' ? moversHTML(d, state.info, trLink, themeOf, industryOf) : tab === 'clusters' ? clustersHTML(d, state.info, trLink) : tab === 'valid' ? validHTML(d) : tab === 'how' ? howHTML() : stageHTML(d, state.info, trLink, state.ptt);
  $('trBody').querySelectorAll('details[data-key]').forEach((x) => { if (open.includes(x.dataset.key)) x.open = true; });
  if (tab === 'stage' && state.ptt === undefined) loadPtt();
}
// PTT 從你的瀏覽器直接讀（GitHub 那邊被擋），快取 3 小時；讀不到就只顯示搜尋連結。
async function loadPtt() {
  state.ptt = 'loading';
  renderThemes();
  try {
    // 成分股名稱用題材資料附的名稱，不必等個股資料載完
    const names = { ...(state.themes?.names || {}), ...Object.fromEntries(Object.entries(state.info || {}).map(([k, v]) => [k, v.name])) };
    state.ptt = await pttThemes(THEME_DEFS, names);
  } catch (e) { state.ptt = null; }
  if ((state.trTab || 'stage') === 'stage') renderThemes();
}
$('trTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tr]');
  if (!b) return;
  state.trTab = b.dataset.tr;
  $('trTabs').querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  renderThemes();
});

async function init() {
  loadThemes(async (u) => { const r = await fetch(u, { cache: 'no-cache' }); if (!r.ok) throw new Error(r.status); return r.json(); }).then((d) => { state.themes = d; renderThemes(); });
  const { convention } = await getSettings();
  document.documentElement.dataset.convention = convention;
  [state.watch, state.observe, state.kws] = await Promise.all([getWatchlist(), getObserve(), getKeywords()]);
  try { state.info = await getStockInfo(); } catch (e) { state.info = {}; }
  renderThemes();
  $('stockList').innerHTML = Object.keys(state.info).filter((id) => /^\d{4}$/.test(id)).map((id) => `<option value="${id} ${esc(state.info[id].name)}"></option>`).join('');
  state.market = await readMarket();
  await build();
  // 全市場行情若不是最新，背景補齊後重算股價反應
  ensureMarket().then((m) => { if (m.dates.at(-1) !== state.market?.dates?.at(-1)) { state.market = m; build(); } }).catch(() => {});
}
init();

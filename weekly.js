import { getWatchlist, getSettings, localKeys } from './lib/storage.js';
import { loadStock, getStockInfo, loadEntity, loadDividends } from './lib/api.js';
import { analyze, aggregate, levels, breakouts, sma, instDaily, priceDigits, weekBand, weekKeyOf } from './lib/indicators.js';
import { getRelations, relationMetrics } from './lib/relations.js';
import { ensureMarket, readMarket } from './lib/market.js';
import { THEMES, sectorTable, rankBy, screen, SCREEN } from './lib/sectors.js';
import { loadCalendar } from './lib/calendar.js';
import { loadShareholding, holdingSeries } from './lib/tdcc.js';
import { $, esc, fmtP, fmtInt, sInt, sPct, tone, arrow, md, fmtCorr } from './lib/format.js';

const W = ['日', '一', '二', '三', '四', '五', '六'];
const wd = (date) => W[new Date(date + 'T00:00:00Z').getUTCDay()];
const weekKey = (t) => {
  const d = new Date(t + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
function isoWeek(date) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const y0 = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - y0) / 86400000 + 1) / 7);
}
const link = (id, name) => `<a class="stock-link" href="dashboard.html#${esc(id)}">${esc(name || id)}</a>`;
const setStatus = (t, err = false) => { $('status').textContent = t; $('status').classList.toggle('err', err); };

$('print').addEventListener('click', () => window.print());

// 每檔的週資料
function weekStats(a, data) {
  const d = a.daily;
  const wk = weekKey(d.at(-1).time);
  const thisWeek = d.filter((x) => weekKey(x.time) === wk);
  const before = d.filter((x) => weekKey(x.time) < wk);
  const prevKey = before.length ? weekKey(before.at(-1).time) : null;
  const prevWeek = before.filter((x) => weekKey(x.time) === prevKey);
  const close = thisWeek.at(-1).close;
  const prevClose = before.length ? before.at(-1).close : thisWeek[0].open;
  const vol = thisWeek.reduce((s, x) => s + x.volume, 0);
  const pvol = prevWeek.reduce((s, x) => s + x.volume, 0);
  const days = new Set(thisWeek.map((x) => x.time));
  const inst = instDaily(data.inst || []).filter((x) => days.has(x.date));
  const sum = (k) => inst.reduce((s, x) => s + x[k], 0);
  const weekly = aggregate(d, 'w');
  const lv = levels(weekly, 2, 52);
  // 本週發生的訊號
  const events = [];
  for (const b of breakouts(d, 20)) if (days.has(b.time)) events.push({ t: `${md(b.time)} ${b.type === 'up' ? '帶量突破 20 日高點' : '跌破 20 日低點'}`, d: b.type === 'up' ? 1 : -1 });
  const ma = new Map(sma(d, 20).map((x) => [x.time, x.value]));
  for (let i = 1; i < d.length; i++) {
    if (!days.has(d[i].time)) continue;
    const m = ma.get(d[i].time), mp = ma.get(d[i - 1].time);
    if (m == null || mp == null) continue;
    if (d[i].close > m && d[i - 1].close <= mp) events.push({ t: `${md(d[i].time)} 站上月線`, d: 1 });
    if (d[i].close < m && d[i - 1].close >= mp) events.push({ t: `${md(d[i].time)} 跌破月線`, d: -1 });
  }
  const band = weekBand(d);
  return {
    first: thisWeek[0].time, last: thisWeek.at(-1).time, close, chg: close - prevClose, pct: (close / prevClose - 1) * 100,
    vol, volRatio: pvol ? vol / pvol : null,
    foreign: sum('foreign'), trust: sum('trust'), dealer: sum('dealer'),
    res: lv.res?.price ?? null, sup: lv.sup?.price ?? null, events,
    low: band?.low ?? close, high: band?.high ?? close,
    spark: d.slice(-10).map((x) => x.close),
  };
}

function sparkSVG(vals, color) {
  const mn = Math.min(...vals), mx = Math.max(...vals);
  const pts = vals.map((v, i) => `${(2 + (i * 116) / (vals.length - 1)).toFixed(1)},${(33 - ((v - mn) / (mx - mn || 1)) * 30).toFixed(1)}`).join(' ');
  return `<svg width="120" height="36" viewBox="0 0 120 36" aria-hidden="true"><polyline points="${pts}" fill="none" stroke="${color}" stroke-width="1.75" stroke-linejoin="round" stroke-linecap="round"/></svg>`;
}

async function init() {
  const settings = await getSettings();
  document.documentElement.dataset.convention = settings.convention;
  const cs = getComputedStyle(document.documentElement);
  const UP = cs.getPropertyValue('--up').trim(), DOWN = cs.getPropertyValue('--down').trim();
  const ids = await getWatchlist();
  let info = {};
  try { info = await getStockInfo(); } catch (e) { /* 名稱用代號 */ }
  const name = (id) => info[id]?.name || id;

  setStatus('整理自選股資料');
  const rows = [];
  for (const id of ids) {
    try {
      const data = await loadStock(id);
      const a = analyze(data);
      if (!a.empty) rows.push({ id, name: name(id), data, a, w: weekStats(a, data) });
    } catch (e) { /* 單檔失敗略過 */ }
  }
  if (!rows.length) return setStatus('沒有可用的自選股資料，請先開啟收盤速覽頁更新', true);

  const lastDay = rows.map((r) => r.w.last).sort().at(-1);
  const firstDay = rows.map((r) => r.w.first).sort()[0];
  // 上週記下的波動區間（背景每週六存，或上週打開週報時存）
  const thisKey = weekKeyOf(lastDay);
  const prevKey = new Date(Date.parse(thisKey + 'T00:00:00Z') - 7 * 86400000).toISOString().slice(0, 10);
  const stored = await chrome.storage.local.get(['wkPred:' + prevKey, 'wk:' + prevKey]);
  const prevPred = stored['wkPred:' + prevKey] || stored['wk:' + prevKey]?.preds || {};
  $('wkLabel').textContent = `WEEKLY REPORT · ${lastDay.slice(0, 4)} 第 ${isoWeek(lastDay)} 週`;
  $('wkRange').textContent = `涵蓋 ${md(firstDay)}（${wd(firstDay)}）至 ${md(lastDay)}（${wd(lastDay)}）`;
  document.title = `每週報告 ${md(firstDay)}–${md(lastDay)}`;

  // 持股總覽
  let sh = null;
  try { sh = await loadShareholding(); } catch (e) { /* 略過 */ }
  $('overview').innerHTML = rows.map(({ id, name: n, w, a }) => {
    const dg = priceDigits(w.close);
    const s = sh ? holdingSeries(sh, id) : [];
    const big = s.length ? `${s.at(-1).big.toFixed(2)}%${s.length > 1 ? `（${sPct(s.at(-1).big - s.at(-2).big, 2).replace('%', '')}）` : ''}` : '–';
    return `<tr><td class="l"><b>${link(id, n)}</b> <span class="muted small">${id}</span></td><td>${fmtP(w.close, dg)}</td><td class="${tone(w.pct)}">${arrow(w.pct)}${sPct(w.pct)}</td><td>${w.volRatio == null ? '–' : w.volRatio.toFixed(2) + ' 倍'}</td><td class="${tone(w.foreign)}">${sInt(w.foreign)}</td><td>${w.res == null ? '–' : fmtP(w.res, dg)}</td><td>${w.sup == null ? '–' : fmtP(w.sup, dg)}</td><td>${big}</td></tr>`;
  }).join('');

  // 個股細節
  $('details').innerHTML = rows.map(({ id, name: n, a, w }) => {
    const dg = priceDigits(w.close);
    const rev = a.revenue.at(-1);
    const pos = Math.min(100, Math.max(0, ((w.close - w.low) / (w.high - w.low)) * 100));
    const sig = [...w.events, ...a.signals.filter((s) => /營收|融資|外資|投信/.test(s.t))];
    return `<article class="wk-card">
      <div class="wk-head"><div><span class="muted small num">${id}</span><br><span class="nm">${link(id, n)}</span></div>
        <div class="px">${sparkSVG(w.spark, w.pct >= 0 ? UP : DOWN)}<div style="text-align:right"><b class="num">${fmtP(w.close, dg)}</b><br><span class="num ${tone(w.pct)}">${arrow(w.pct)}${sPct(w.pct)}（週）</span></div></div></div>
      <div class="wk-cols">
        <div><span class="muted small">三大法人（本週，張）</span>
          <div class="kv"><span>外資</span><span class="num ${tone(w.foreign)}">${sInt(w.foreign)}</span></div>
          <div class="kv"><span>投信</span><span class="num ${tone(w.trust)}">${sInt(w.trust)}</span></div>
          <div class="kv"><span>自營商</span><span class="num ${tone(w.dealer)}">${sInt(w.dealer)}</span></div></div>
        <div><span class="muted small">月營收</span>${rev ? `<b class="num ${tone(rev.yoy)}" style="font-size:20px;font-weight:500">年增 ${sPct(rev.yoy, 1)}</b><span class="muted small num">${rev.label} · ${(rev.revenue / 1e8).toFixed(2)} 億${a.revenueStreak.n >= 2 ? ` · 連 ${a.revenueStreak.n} 月年${a.revenueStreak.dir > 0 ? '增' : '減'}` : ''}</span>` : '<span class="empty">無資料</span>'}</div>
        <div><span class="muted small">本週訊號</span><div class="tags">${sig.length ? sig.map((s) => `<span class="tag ${tone(s.d)}">${esc(s.t)}</span>`).join('') : '<span class="empty">本週沒有觸發訊號</span>'}</div></div>
      </div>
      ${(() => {
        const pp = prevPred[id];
        if (!pp) return '';
        const where = w.close > pp.high ? '高於區間' : w.close < pp.low ? '低於區間' : '落在區間內';
        return `<div class="check muted">上週預估本週區間 ${fmtP(pp.low, dg)}–${fmtP(pp.high, dg)}，本週收 ${fmtP(w.close, dg)}：<b class="${where === '落在區間內' ? '' : where === '高於區間' ? 'up' : 'down'}">${where}</b></div>`;
      })()}
      <div class="range"><div class="row-between"><span class="muted small">下週波動區間（約 68% 機率）</span><span class="muted small">依近 20 日波動度估算，不是方向預測</span></div>
        <div class="track"><i style="left:${pos}%"></i></div>
        <div class="row-between num small"><span>${fmtP(w.low, dg)}</span><span class="muted">目前 ${fmtP(w.close, dg)}</span><span>${fmtP(w.high, dg)}</span></div></div>
    </article>`;
  }).join('');

  // 關聯
  setStatus('整理關聯對象');
  const relBlocks = [];
  const relFacts = [];
  for (const r of rows) {
    const list = await getRelations(r.id);
    const ss = r.a.daily.map((x) => [x.time, x.close]);
    const items = [];
    for (const e of list) {
      try {
        const m = relationMetrics(ss, await loadEntity(e), e.kind);
        if (m) items.push({ e, m });
      } catch (err) { /* 略過 */ }
    }
    for (const it of items) if (it.m.corr != null && it.m.corrPrev != null && Math.abs(it.m.corr - it.m.corrPrev) >= 0.05 && it.e.kind !== 'fx') relFacts.push({ stock: r.name, ...it });
    relBlocks.push(`<div><h3>${esc(r.name)}</h3><div class="table-box"><table class="tbl num"><thead><tr><th class="l">關聯對象</th><th class="l">關係</th><th>本週</th><th>相關（上週）</th></tr></thead><tbody>${items.map(({ e, m }) => {
      const dc = m.corr != null && m.corrPrev != null ? m.corr - m.corrPrev : 0;
      const tr = Math.abs(dc) >= 0.05 ? (dc > 0 ? ' ↑' : ' ↓') : '';
      return `<tr><td class="l">${e.kind === 'tw' && e.id !== 'TAIEX' ? link(e.id, e.name) : esc(e.name || e.id)} <span class="muted small">${esc(e.id)}</span></td><td class="l">${esc(e.rel)}</td><td class="${tone(m.r5)}">${sPct(m.r5, 1)}</td><td>${fmtCorr(m.corr)}（${fmtCorr(m.corrPrev)}）${tr}</td></tr>`;
    }).join('') || '<tr><td class="l empty" colspan="4">尚未設定關聯對象</td></tr>'}</tbody></table></div></div>`);
  }
  $('relations').innerHTML = relBlocks.join('');

  // 族群輪動與強勢股
  setStatus('整理全市場行情');
  let market = await readMarket();
  if (market.dates.length < 11 || market.dates.at(-1) < lastDay) {
    try { market = await ensureMarket({ onProgress: (t) => setStatus(t) }); } catch (e) { setStatus('全市場行情：' + e.message, true); }
  }
  let rotFact = null, topFact = null;
  if (market.dates.length >= 11) {
    const end = market.dates.length - 1;
    const now = rankBy(sectorTable(market, THEMES, info, end), 'r5');
    const prev = rankBy(sectorTable(market, THEMES, info, end - 5), 'r5');
    const prevRank = new Map(prev.map((s, i) => [s.name, i + 1]));
    $('rotation').innerHTML = now.map((s, i) => {
      const pr = prevRank.get(s.name);
      const diff = pr ? pr - (i + 1) : 0;
      const lead = s.members.slice().sort((a, b) => b.r5 - a.r5)[0];
      return `<tr><td>${i + 1}</td><td class="l">${esc(s.name)}</td><td class="${tone(s.r5)}">${sPct(s.r5, 1)}</td><td>${pr ?? '–'}${diff ? `（${diff > 0 ? '↑' : '↓'}${Math.abs(diff)}）` : '（–）'}</td><td class="l">${link(lead.id, lead.name)} <span class="${tone(lead.r5)}">${sPct(lead.r5, 1)}</span></td></tr>`;
    }).join('');
    const riser = now.map((s, i) => ({ s, up: (prevRank.get(s.name) ?? i + 1) - (i + 1), rank: i + 1 })).sort((a, b) => b.up - a.up)[0];
    topFact = now[0];
    if (riser && riser.up >= 2) rotFact = riser;
    $('rotNote').textContent = `資料日期 ${md(market.dates.at(-1))}。排名上升代表資金流入；連續兩週以上排在前三的族群，趨勢較明確。`;
    const sc = screen(sectorTable(market, THEMES, info));
    $('screenNote').textContent = `條件：題材族群 5 日漲幅前 ${SCREEN.topN} 名（${sc.top.join('、')}）· 站上 20 日線 · 量比 ${SCREEN.vr} 倍以上 · 外資連 ${SCREEN.fs} 日以上買超。只代表近期走勢符合條件，不構成投資建議。`;
    const list = sc.picks.length ? sc.picks : sc.near;
    $('picks').innerHTML = (sc.picks.length ? '' : '<p class="note" style="grid-column:1/-1">本週末沒有個股同時符合全部條件，以下為符合其中兩項的個股。</p>') + list.map((p) => `<div class="pick"><div class="ph"><span class="pn">${link(p.id, p.name)} <span class="muted small num">${p.id}</span></span><span class="num ${tone(p.r5)}">${sPct(p.r5, 1)}</span></div><span class="muted small">${esc(p.sector)} · 5 日漲幅</span><div class="tags">${p.checks.map((c) => `<span class="tag ${c.ok ? '' : 'miss'}">${esc(c.t)}</span>`).join('')}</div></div>`).join('');
  } else {
    $('rotation').innerHTML = '<tr><td colspan="5" class="l empty">全市場行情不足兩週，請先開啟收盤速覽頁讓它下載</td></tr>';
  }

  // 下週行事曆
  setStatus('整理行事曆');
  const nextMon = new Date(weekKey(lastDay) + 'T00:00:00Z');
  nextMon.setUTCDate(nextMon.getUTCDate() + 7);
  const days = [...Array(5)].map((_, i) => { const d = new Date(nextMon); d.setUTCDate(d.getUTCDate() + i); return d.toISOString().slice(0, 10); });
  const cal = [];
  const seenEv = new Set();
  for (const r of rows) {
    try {
      const evs = await loadCalendar({ id: r.id, name: r.name, industries: info[r.id]?.industries }, await getRelations(r.id), { from: days[0], to: days[4], divs: r.data.div });
      for (const e of evs) {
        const rev = e.t === '上月營收公布期限';
        const k = rev ? e.date + e.t : e.date + e.who.id + e.t;
        if (seenEv.has(k)) continue;
        seenEv.add(k);
        const who = rev ? '自選股' : e.who.self ? e.who.name : `${e.who.name}（${r.name} 的${e.who.rel}）`;
        cal.push({ d: e.date, t: `${who} ${e.t}${e.note ? '：' + e.note : ''}` });
      }
    } catch (e) { /* 略過 */ }
  }
  cal.sort((a, b) => (a.d < b.d ? -1 : 1));
  $('calendar').innerHTML = cal.length
    ? cal.map((c) => `<div><span class="muted num">${md(c.d)}（${wd(c.d)}）</span><span>${esc(c.t)}</span></div>`).join('')
    : `<div><span class="muted num">${md(days[0])}–${md(days[4])}</span><span>自選股與關聯公司下週沒有已知的法說會、財報、除權息或營收公布。</span></div>`;

  // 摘要
  const sorted = rows.slice().sort((x, y) => y.w.pct - x.w.pct);
  const ups = rows.filter((r) => r.w.pct > 0).length;
  const s = [];
  s.push(`自選股 ${rows.length} 檔，${ups} 漲 ${rows.length - ups} 跌。表現最好的是 ${sorted[0].name}（${sPct(sorted[0].w.pct)}）` + (rows.length > 1 ? `，最弱的是 ${sorted.at(-1).name}（${sPct(sorted.at(-1).w.pct)}）。` : '。'));
  const fBig = rows.slice().sort((x, y) => Math.abs(y.w.foreign) - Math.abs(x.w.foreign))[0];
  if (fBig && fBig.w.foreign) s.push(`外資本週對 ${fBig.name} ${fBig.w.foreign > 0 ? '買超' : '賣超'} ${fmtInt(Math.abs(fBig.w.foreign))} 張，是自選股中動作最大的一檔。`);
  if (topFact) s.push(`題材族群本週最強是 ${topFact.name}（${sPct(topFact.r5, 1)}）` + (rotFact ? `；${rotFact.s.name} 排名上升 ${rotFact.up} 名，升到第 ${rotFact.rank}。` : '。'));
  if (relFacts.length) {
    const f = relFacts.sort((x, y) => Math.abs(y.m.corr - y.m.corrPrev) - Math.abs(x.m.corr - x.m.corrPrev))[0];
    s.push(`${f.stock} 與 ${f.e.name || f.e.id} 的連動${f.m.corr > f.m.corrPrev ? '變強' : '變弱'}，相關係數由 ${fmtCorr(f.m.corrPrev)} ${f.m.corr > f.m.corrPrev ? '升' : '降'}到 ${fmtCorr(f.m.corr)}。`);
  }
  if (cal.length) s.push(`下週有 ${cal.length} 個已知事件，見行事曆。`);
  const checked = rows.filter((r) => prevPred[r.id]);
  if (checked.length) {
    const hit = checked.filter((r) => r.w.close >= prevPred[r.id].low && r.w.close <= prevPred[r.id].high).length;
    s.push(`上週預估的波動區間：${checked.length} 檔中有 ${hit} 檔本週收在區間內（理論上約 68%）。`);
  }
  $('summary').innerHTML = s.map((x) => `<li>${esc(x)}</li>`).join('');
  setStatus('資料日期 ' + md(lastDay));

  // 存檔：本週內容與下週預估區間，可在「週次」切換回看
  const preds = Object.fromEntries(rows.map((r) => [r.id, { close: r.w.close, low: r.w.low, high: r.w.high, date: r.w.last }]));
  const label = `${lastDay.slice(0, 4)} 第 ${isoWeek(lastDay)} 週（${md(firstDay)}–${md(lastDay)}）`;
  await chrome.storage.local.set({ ['wk:' + thisKey]: { label, savedAt: Date.now(), html: $('report').innerHTML, preds }, ['wkPred:' + thisKey]: preds });
  await pruneArchive();
  await fillWeekSelect(thisKey);
}

async function pruneArchive() {
  const allKeys = await localKeys();
  const keys = allKeys.filter((k) => k.startsWith('wk:')).sort();
  const old = keys.slice(0, Math.max(0, keys.length - 26));
  const oldPred = allKeys.filter((k) => k.startsWith('wkPred:')).sort().slice(0, -27);
  if (old.length || oldPred.length) await chrome.storage.local.remove([...old, ...oldPred]);
}

async function fillWeekSelect(current) {
  const weeks = (await localKeys()).filter((k) => k.startsWith('wk:')).sort().reverse();
  const all = await chrome.storage.local.get(weeks);
  $('wkSel').innerHTML = weeks.map((k) => `<option value="${esc(k)}"${k === 'wk:' + current ? ' selected' : ''}>${esc(all[k].label)}${k === 'wk:' + current ? '（最新）' : ''}</option>`).join('');
  $('wkSel').onchange = async () => {
    const k = $('wkSel').value;
    const isCurrent = k === 'wk:' + current;
    $('report').hidden = !isCurrent;
    $('archive').hidden = isCurrent;
    if (!isCurrent) {
      const { [k]: rec } = await chrome.storage.local.get(k);
      $('archive').innerHTML = `<p class="note">這是 ${esc(rec.label)} 的存檔，內容停在當週，不會再更新。</p>` + rec.html;
      setStatus('存檔：' + rec.label);
    } else setStatus('最新一週');
  };
}

init();

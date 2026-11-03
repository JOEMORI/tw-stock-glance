// 題材雷達：把「股價還沒大動之前就會出現的跡象」整理成每天一份、可長期對答案的紀錄。
// 由 build-data.mjs 在 GitHub Actions 呼叫（Node），結果寫到 data/themes.json，插件與手機版都讀這份。
//
// 每個題材每天記六種訊號（依通常出現的先後）：
//   en   英文新聞量升溫（國外消息通常比台灣早）
//   rev  成分股營收年增加速（每月 10 日前公布）
//   chip 籌碼悄悄累積（外資多日小買、千張大戶增加，但股價還沒大漲）
//   us   美股對照股前一晚大漲
//   zh   中文新聞量升溫
//   ptt  PTT 股板討論量升溫（散戶開始注意）
//   px   股價異動（放量上漲家數），最晚出現，用來確認
// 並依訊號組合判斷階段：醞釀、發動、過熱、平靜。每天的訊號與題材籃子的漲跌都存檔，之後自動算各訊號事後 5、20 日表現。
import { THEME_DEFS } from '../lib/themes.js';
import { adjSeries, metrics } from '../lib/sectors.js';
import { fetchDataset } from '../lib/api.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (tw-stock-glance personal research)' };
const today = () => new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
const daysAgo = (n) => new Date(Date.now() + 8 * 3600000 - n * 86400000).toISOString().slice(0, 10);
const avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100);
const get = async (k, d) => (await chrome.storage.local.get(k))[k] ?? d;
const set = (k, v) => chrome.storage.local.set({ [k]: v });

// ---------- 新聞量（Google 新聞 RSS） ----------
async function rss(q, lang, win = ' when:30d') {
  const loc = lang === 'en' ? 'hl=en-US&gl=US&ceid=US:en' : 'hl=zh-TW&gl=TW&ceid=TW:zh-Hant';
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + win)}&${loc}`, { headers: UA });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const xml = await r.text();
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const title = (m[1].match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const pub = Date.parse((m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '');
    if (pub) items.push({ title: title.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'"), pub });
  }
  return items;
}
// 新聞量：用「單日」則數比較（一天很少超過 100 則上限）。
// 近況 = 最近 3 天的日均；基準 = 前 8 到 28 天中抽 6 天的日均（之後累積滿 3 週改用自己的每日紀錄）。
// 只比近一個月內，避免 Google 對較舊新聞收錄較少造成偏差。
async function dayCount(q, lang, d) {
  const a = daysAgo(d + 1), b = daysAgo(d - 1); // after 是不含當天，所以前後各留一天，取得 d 那一天
  try { return Math.min(100, (await rss(q, lang, ` after:${a} before:${b}`)).length); } catch (e) { return null; } finally { await sleep(300); }
}
async function newsDays(q, lang, logged) {
  const recentDays = [1, 2, 3];
  const recent = [];
  for (const d of recentDays) recent.push(await dayCount(q, lang, d));
  let base = null;
  if (logged.length >= 21) base = avg(logged.slice(-28, -7));
  else {
    const sample = [];
    for (const d of [9, 12, 15, 19, 23, 27]) sample.push(await dayCount(q, lang, d));
    base = avg(sample.filter((v) => v != null));
  }
  const r = avg(recent.filter((v) => v != null));
  return { day: recent[0], recent: r, base, n7: recent.filter((v) => v != null).reduce((s, v) => s + v, 0), x: r != null && base ? r / base : null, sat: recent.some((v) => v >= 100) };
}

// ---------- PTT 股板標題 ----------
async function pttTitles(maxPages = 35) {
  const out = [];
  let url = 'https://www.ptt.cc/bbs/Stock/index.html';
  const stop = daysAgo(8).slice(5).replace('-', '/');
  for (let i = 0; i < maxPages && url; i++) {
    const r = await fetch(url, { headers: UA });
    if (!r.ok) break;
    const html = await r.text();
    const body = html.split('<div class="r-list-sep"></div>')[0]; // 置底文章不算
    const blocks = body.split('<div class="r-ent">').slice(1);
    let oldest = '99/99';
    for (const b of blocks) {
      const t = (b.match(/<a href="[^"]+">([^<]+)<\/a>/) || [])[1];
      const date = ((b.match(/class="date">\s*([^<]+)</) || [])[1] || '').trim().padStart(5, '0');
      if (t && date) { out.push({ title: t, date }); if (date < oldest) oldest = date; }
    }
    if (oldest < stop) break;
    const prev = html.match(/href="(\/bbs\/Stock\/index\d+\.html)">&lsaquo;/);
    url = prev ? 'https://www.ptt.cc' + prev[1] : null;
    await sleep(800);
  }
  return out;
}

// ---------- 營收（交易所開放資料，每月一次；歷史由 FinMind 補） ----------
async function revenueNow() {
  const out = {};
  for (const [url, ik] of [['https://openapi.twse.com.tw/v1/opendata/t187ap05_L', '公司代號'], ['https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap05_O', '公司代號']]) {
    try {
      const r = await fetch(url, { headers: UA });
      if (!r.ok) continue;
      for (const x of await r.json()) {
        const id = String(x[ik] || '').trim();
        const ym = String(x['資料年月'] || '').trim(); // 例如 11509
        const y = Number(ym.slice(0, -2)) + 1911, m = Number(ym.slice(-2));
        out[id] = { y, m, rev: Number(x['營業收入-當月營收']) * 1000, yoy: Number(x['營業收入-去年同月增減(%)']) };
      }
    } catch (e) { /* 略過 */ }
  }
  return out;
}
// FinMind 補齊成分股兩年營收與股價（回測用），每次最多查 limit 次，查不完下次繼續
async function backfill(ids, limit = 70) {
  let calls = 0;
  for (const id of ids) {
    if (calls >= limit) break;
    const k = 'tr:hist:' + id;
    const c = await get(k, null);
    if (c && Date.now() - c.at < 25 * 86400000) continue;
    try {
      const rev = await fetchDataset('TaiwanStockMonthRevenue', { data_id: id, start_date: daysAgo(800) });
      const px = await fetchDataset('TaiwanStockPrice', { data_id: id, start_date: daysAgo(760) });
      calls += 2;
      await set(k, { at: Date.now(), rev: rev.map((r) => [r.revenue_year, r.revenue_month, r.revenue]), px: px.filter((r) => r.close > 0).map((r) => [r.date, r.close]) });
    } catch (e) { calls += 2; if (/上限/.test(e.message)) break; }
  }
  return calls;
}
// 每月營收年增率序列 { 'YYYY-MM': yoy }
function yoySeries(rev) {
  const m = new Map(rev.map(([y, mo, v]) => [y * 100 + mo, v]));
  const out = {};
  for (const [k, v] of m) { const p = m.get(k - 100); if (p > 0) out[`${Math.floor(k / 100)}-${String(k % 100).padStart(2, '0')}`] = (v / p - 1) * 100; }
  return out;
}
// 營收加速：最近一個月年增 > 15%，且比 3 個月前的年增高 10 個百分點以上
const accel = (ys, key) => {
  const ks = Object.keys(ys).sort();
  const i = ks.indexOf(key);
  if (i < 3) return null;
  return ys[ks[i]] > 15 && ys[ks[i]] - ys[ks[i - 3]] >= 10;
};

// ---------- 美股對照 ----------
async function usMoves(tickers) {
  const out = {};
  for (const t of tickers) {
    try {
      const rows = (await fetchDataset('USStockPrice', { data_id: t, start_date: daysAgo(14) })).filter((r) => r.Close > 0);
      if (rows.length >= 2) out[t] = { date: rows.at(-1).date, r1: (rows.at(-1).Close / rows.at(-2).Close - 1) * 100, r5: rows.length >= 6 ? (rows.at(-1).Close / rows.at(-6).Close - 1) * 100 : null };
    } catch (e) { if (/上限/.test(e.message)) break; }
  }
  return out;
}

// ---------- 放量上漲名單與新族群 ----------
function movers(market) {
  const n = market.dates.length;
  const out = [];
  for (const id of Object.keys(market.prices[n - 1] || {})) {
    const m = metrics(market, id);
    if (m && m.vr != null && m.vr >= 3 && m.r1 >= 5 && m.vol >= 300) out.push({ id, r1: r2(m.r1), r5: r2(m.r5), vr: r2(m.vr), close: m.close });
  }
  return out.sort((a, b) => b.r1 - a.r1);
}
function corr(a, b) {
  const n = a.length; const ma = avg(a), mb = avg(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { s += (a[i] - ma) * (b[i] - mb); sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; }
  return sa && sb ? s / Math.sqrt(sa * sb) : 0;
}
// 近 20 日漲幅前 150 檔中，彼此走勢高度同步（相關 0.6 以上）、又不在同一個既有題材的群組
function clusters(market, known) {
  const n = market.dates.length;
  if (n < 22) return [];
  const cand = [];
  for (const id of Object.keys(market.prices[n - 1] || {})) {
    const m = metrics(market, id);
    if (!m || m.r20 == null || m.vol < 300) continue;
    const s = adjSeries(market, id);
    const rets = [];
    for (let i = n - 20; i < n; i++) rets.push(s[i] && s[i - 1] ? s[i] / s[i - 1] - 1 : 0);
    cand.push({ id, r20: m.r20, rets });
  }
  cand.sort((a, b) => b.r20 - a.r20);
  const top = cand.slice(0, 150);
  const parent = top.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) if (corr(top[i].rets, top[j].rets) >= 0.6) parent[find(i)] = find(j);
  const g = {};
  top.forEach((x, i) => (g[find(i)] = g[find(i)] || []).push(x));
  return Object.values(g)
    .filter((l) => l.length >= 3 && l.length <= 15)
    .map((l) => {
      const inTheme = THEME_DEFS.map((d) => l.filter((x) => d.ids.includes(x.id)).length);
      const best = Math.max(...inTheme);
      return { ids: l.map((x) => x.id), r20: r2(avg(l.map((x) => x.r20))), known: best / l.length >= 0.5 ? THEME_DEFS[inTheme.indexOf(best)].name : null };
    })
    .filter((c) => !c.known)
    .sort((a, b) => b.r20 - a.r20)
    .slice(0, 6);
}
// 新族群的共同關鍵字：成員新聞標題裡，兩檔以上都出現的 2 到 4 字詞
const STOP = /爆料|股市|市場|聚焦|時新|新聞網|財經|鉅亨|工商|經濟日報|股價|台股|漲停|跌停|營收|外資|投信|法人|今日|盤中|個股|概念股|題材|成長|公司|股東|上市|上櫃|買超|賣超|目標價|年增|月增|億元|新聞|報導|焦點|快訊|即時/;
async function clusterWords(c, names) {
  const sets = [];
  for (const id of c.ids.slice(0, 4)) {
    const nm = (names[id] || id).replace(/-KY$|\*$/, '');
    try {
      const items = await rss(`"${nm}"`, 'zh');
      const grams = new Set();
      for (const it of items.slice(0, 20)) {
        const t = it.title.replace(/\s*-\s*[^-]+$/, '').replace(/[^一-龥A-Za-z0-9]/g, ' ');
        for (const w of t.split(/\s+/)) for (let L = 2; L <= 4; L++) for (let i = 0; i + L <= w.length; i++) { const g = w.slice(i, i + L); if (!STOP.test(g) && !Object.values(names).includes(g) && /[\u4e00-\u9fa5]{2}|[A-Za-z]{3}/.test(g) && !/^\d+$/.test(g)) grams.add(g); }
      }
      sets.push(grams);
    } catch (e) { /* 略過 */ }
    await sleep(500);
  }
  const cnt = {};
  for (const s of sets) for (const g of s) cnt[g] = (cnt[g] || 0) + 1;
  return Object.entries(cnt).filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1] || b[0].length - a[0].length).map(([g]) => g).filter((g, i, a) => !a.slice(0, i).some((x) => x.includes(g))).slice(0, 5);
}

// ---------- 主流程 ----------
export async function themeRadar({ market, sh, names }) {
  const date = market.dates.at(-1);
  const n = market.dates.length;
  const last = market.prices[n - 1] || {};
  const log = await get('tr:log', {});
  const valid = (ids) => ids.filter((id) => last[id]);

  // 新聞
  const news = {};
  for (const d of THEME_DEFS) {
    news[d.name] = {};
    for (const [lang, words] of [['en', d.en], ['zh', d.zh]]) {
      const logged = Object.keys(log).sort().map((k) => log[k]?.[d.name]?.news?.[lang]).filter((v) => v != null);
      news[d.name][lang] = await newsDays(words.map((w) => (w.includes(' ') ? `"${w}"` : w)).join(' OR '), lang, logged);
    }
  }
  // PTT
  let ptt = [];
  try { ptt = await pttTitles(); } catch (e) { ptt = []; }
  const pttDay = {};
  for (const p of ptt) for (const d of THEME_DEFS) if (d.zh.some((k) => p.title.includes(k)) || d.ids.some((id) => names[id] && p.title.includes(names[id]))) (pttDay[d.name] = pttDay[d.name] || {}), (pttDay[d.name][p.date] = (pttDay[d.name][p.date] || 0) + 1);
  const pttDates = [...new Set(ptt.map((p) => p.date))].sort();
  // 營收
  const revNow = await revenueNow();
  const allIds = [...new Set(THEME_DEFS.flatMap((d) => valid(d.ids)))];
  const calls = await backfill(allIds);
  const hist = {};
  for (const id of allIds) hist[id] = await get('tr:hist:' + id, null);
  // 美股
  const us = await usMoves([...new Set(THEME_DEFS.flatMap((d) => d.us))]);
  // 放量上漲
  const mv = movers(market);
  const mvLog = await get('tr:movers', {});
  mvLog[date] = mv.map((x) => x.id);
  for (const k of Object.keys(mvLog)) if (k < daysAgo(120)) delete mvLog[k];
  await set('tr:movers', mvLog);
  const mvDates = Object.keys(mvLog).sort();

  const themes = [];
  for (const d of THEME_DEFS) {
    const ids = valid(d.ids);
    if (!ids.length) continue;
    const ms = ids.map((id) => metrics(market, id)).filter(Boolean);
    const r1 = avg(ms.map((m) => m.r1).filter((v) => v != null));
    const r5 = avg(ms.map((m) => m.r5).filter((v) => v != null));
    const r20 = avg(ms.map((m) => m.r20).filter((v) => v != null));
    const nw = news[d.name];
    // 新聞升溫：最近一週則數是前 3 週平均的 1.5 倍以上，且至少 minN 則；前幾週也到 100 則（滿載）時不判斷
    // 新聞升溫：最近 3 天日均是基準的 1.5 倍以上，且 3 天合計至少 minN 則
    const hot = (lang, minN) => { const x = nw?.[lang]; return !!(x && x.x != null && x.x >= 1.5 && x.n7 >= minN && !x.sat); };
    // PTT：近 3 天日均是更早日均的 2 倍以上、近 3 天至少 3 篇
    const pd = pttDay[d.name] || {};
    const p3 = pttDates.slice(-3).reduce((s, k) => s + (pd[k] || 0), 0);
    const pOld = pttDates.slice(0, -3);
    const pBase = pOld.length ? pOld.reduce((s, k) => s + (pd[k] || 0), 0) / pOld.length : null;
    const pttHot = p3 >= 3 && pBase != null && p3 / 3 >= Math.max(0.5, pBase * 2);
    // 營收加速：成分股中加速的比例
    let revAcc = 0, revN = 0, revYoy = [];
    for (const id of ids) {
      const h = hist[id];
      const ys = h ? yoySeries(h.rev) : {};
      const now = revNow[id];
      if (now && Number.isFinite(now.yoy)) ys[`${now.y}-${String(now.m).padStart(2, '0')}`] = now.yoy;
      const key = Object.keys(ys).sort().at(-1);
      if (!key) continue;
      revN++;
      revYoy.push(ys[key]);
      if (accel(ys, key)) revAcc++;
    }
    const revHot = revN >= 2 && revAcc / revN >= 0.4;
    // 籌碼：外資近 5 日至少 3 天買超的成分股比例、千張大戶週變化，且題材近 20 日漲幅不到 10%
    const instDays = market.inst.length;
    const buy3 = ids.filter((id) => market.inst.filter((x) => (x[id] || 0) > 0).length >= Math.min(3, instDays)).length;
    let bigCh = [];
    if (sh?.weeks?.length >= 2) { const [w1, w0] = sh.weeks.slice(-2); for (const id of ids) { const a = sh.data[w0]?.[id], b = sh.data[w1]?.[id]; if (a && b) bigCh.push(a.big - b.big); } }
    const big = avg(bigCh);
    const chipHot = ids.length >= 2 && buy3 / ids.length >= 0.5 && (big == null || big > 0) && (r20 ?? 0) < 10;
    // 美股：對照股前一晚平均漲 3% 以上，或 5 日平均漲 8% 以上
    const um = d.us.map((t) => us[t]).filter(Boolean);
    const usR1 = avg(um.map((x) => x.r1)), usR5 = avg(um.map((x) => x.r5).filter((v) => v != null));
    const usHot = (usR1 ?? 0) >= 3 || (usR5 ?? 0) >= 8;
    // 股價異動：今天放量上漲的成分股數，以及連續幾天都有
    const mvToday = ids.filter((id) => mvLog[date]?.includes(id));
    let streak = 0;
    for (let i = mvDates.length - 1; i >= 0; i--) { if (ids.some((id) => mvLog[mvDates[i]].includes(id))) streak++; else break; }
    const pxHot = mvToday.length >= 2 || (mvToday.length >= 1 && streak >= 3);

    const sig = { en: hot('en', 6), rev: revHot, chip: chipHot, us: usHot, zh: hot('zh', 9), ptt: pttHot, px: pxHot };
    const early = (sig.en ? 2 : 0) + (sig.rev ? 2 : 0) + (sig.chip ? 2 : 0) + (sig.us ? 1 : 0) + (sig.zh ? 1 : 0) + (sig.ptt ? 0.5 : 0);
    const stage = (r20 ?? 0) >= 20 && (sig.ptt || sig.px) ? '過熱' : sig.px || (r5 ?? 0) >= 6 ? '發動' : early >= 2 && (r20 ?? 0) < 10 ? '醞釀' : '平靜';
    themes.push({
      name: d.name, ids, us: d.us, stage, early, sig,
      r1: r2(r1), r5: r2(r5), r20: r2(r20),
      news: { en: nw?.en ? { n3: nw.en.n7, x: r2(nw.en.x), base: r2(nw.en.base), sat: nw.en.sat } : null, zh: nw?.zh ? { n3: nw.zh.n7, x: r2(nw.zh.x), base: r2(nw.zh.base), sat: nw.zh.sat } : null },
      ptt: { n3: p3, base: r2(pBase) }, rev: { acc: revAcc, n: revN, yoy: r2(avg(revYoy)) },
      chip: { buy3, n: ids.length, big: r2(big) }, usm: { r1: r2(usR1), r5: r2(usR5) },
      mv: { today: mvToday, streak },
    });
  }

  // 存檔：每天每個題材的訊號、階段與籃子漲跌（之後算事後表現）
  log[date] = Object.fromEntries(themes.map((t) => [t.name, { sig: t.sig, stage: t.stage, early: t.early, r1: t.r1, news: { en: news[t.name].en?.day ?? null, zh: news[t.name].zh?.day ?? null } }]));
  for (const k of Object.keys(log)) if (k < daysAgo(800)) delete log[k];
  await set('tr:log', log);

  // 新族群
  const cl = clusters(market);
  for (const c of cl) c.words = await clusterWords(c, names);

  return { date, builtAt: new Date().toISOString(), themes, movers: mv.slice(0, 60), clusters: cl, validation: validate(log), retro: retro(hist), finmindCalls: calls, ptt: { posts: ptt.length, from: pttDates[0], to: pttDates.at(-1) } };
}

// ---------- 對答案：各訊號出現後，題材籃子之後 5、20 個交易日的漲跌 ----------
export function validate(log) {
  const dates = Object.keys(log).sort();
  const cum = (name, i, h) => { let v = 1; for (let k = i + 1; k <= i + h && k < dates.length; k++) v *= 1 + (log[dates[k]]?.[name]?.r1 ?? 0) / 100; return i + h < dates.length ? (v - 1) * 100 : null; };
  const out = {};
  const keys = ['en', 'rev', 'chip', 'us', 'zh', 'ptt', 'px', 'stage:醞釀', 'stage:發動', 'stage:過熱', 'all'];
  for (const k of keys) out[k] = { n: 0, f5: [], f20: [] };
  dates.forEach((d, i) => {
    for (const [name, x] of Object.entries(log[d] || {})) {
      const hits = ['all', ...Object.keys(x.sig || {}).filter((s) => x.sig[s]), 'stage:' + x.stage];
      for (const h of hits) {
        if (!out[h]) continue;
        out[h].n++;
        const a = cum(name, i, 5), b = cum(name, i, 20);
        if (a != null) out[h].f5.push(a);
        if (b != null) out[h].f20.push(b);
      }
    }
  });
  const res = {};
  for (const [k, v] of Object.entries(out)) res[k] = { n: v.n, n5: v.f5.length, f5: r2(avg(v.f5)), up5: v.f5.length ? r2(v.f5.filter((x) => x > 0).length / v.f5.length) : null, n20: v.f20.length, f20: r2(avg(v.f20)) };
  return { from: dates[0], days: dates.length, res };
}

// ---------- 回測（不必等累積）：營收加速 ----------
// 用兩年月營收與股價，看每個月「營收加速」的題材，在營收公布後（次月 10 日）60 個交易日的漲跌，與同期所有題材平均比較
export function retro(hist) {
  const rows = [];
  for (const d of THEME_DEFS) {
    const members = d.ids.filter((id) => hist[id]?.px?.length > 200 && hist[id]?.rev?.length > 15);
    if (members.length < 2) continue;
    const months = new Set();
    const ys = Object.fromEntries(members.map((id) => [id, yoySeries(hist[id].rev)]));
    for (const id of members) for (const k of Object.keys(ys[id])) months.add(k);
    for (const key of [...months].sort()) {
      const flags = members.map((id) => accel(ys[id], key)).filter((v) => v != null);
      if (flags.length < 2) continue;
      const [y, m] = key.split('-').map(Number);
      const pub = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-10`;
      const fwd = members.map((id) => { const px = hist[id].px; const i = px.findIndex((p) => p[0] >= pub); return i >= 0 && i + 60 < px.length ? (px[i + 60][1] / px[i][1] - 1) * 100 : null; }).filter((v) => v != null);
      if (fwd.length < 2) continue;
      rows.push({ theme: d.name, month: key, hot: flags.filter(Boolean).length / flags.length >= 0.4, f60: avg(fwd) });
    }
  }
  const hot = rows.filter((r) => r.hot), cold = rows.filter((r) => !r.hot);
  return { n: rows.length, hot: { n: hot.length, f60: r2(avg(hot.map((r) => r.f60))), up: hot.length ? r2(hot.filter((r) => r.f60 > 0).length / hot.length) : null }, cold: { n: cold.length, f60: r2(avg(cold.map((r) => r.f60))), up: cold.length ? r2(cold.filter((r) => r.f60 > 0).length / cold.length) : null }, cases: hot.sort((a, b) => b.f60 - a.f60).slice(0, 8).map((r) => ({ ...r, f60: r2(r.f60) })) };
}

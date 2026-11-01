import { localKeys } from './storage.js';
import { closedName } from './holidays.js';
// 全市場每日收盤與三大法人：直接向證交所（上市）與櫃買中心（上櫃）各查一次，累積在本機。
// 用來算族群強弱與強勢股篩選，不佔 FinMind 額度。證交所限制查詢頻率，每次間隔 2 秒。
const GAP = 2000;
const NEED_DAYS = 61; // 60 日相關係數需要 61 天；20 日漲幅、均量與上週排名都包含在內
const MKT_VER = 2; // 資料格式版本：v2 起每檔多存「已校正除權息的當日報酬」
const INST_DAYS = 5;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => {
  const t = String(s ?? '').replace(/,/g, '').trim();
  return t === '' || /^-+$/.test(t) ? NaN : Number(t);
};
// 一般股票：4 碼數字、不以 00 開頭（排除 ETF），或 4 碼加字母的特別股不納入
const isStock = (id) => /^[1-9]\d{3}$/.test(id);

export function tstToday(now = Date.now()) {
  return new Date(now + 8 * 3600e3).toISOString().slice(0, 10);
}
function tstHour(now = Date.now()) {
  const d = new Date(now + 8 * 3600e3);
  return d.getUTCHours() + d.getUTCMinutes() / 60;
}

let lastCall = 0;
async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    const wait = lastCall + GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (r.ok) return await r.json();
    } catch (e) {
      /* 重試 */
    }
    await sleep(3000 * (i + 1));
  }
  throw new Error('交易所網站暫時連不上');
}

function rocDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(y) - 1911}/${m}/${d}`;
}

// 當日報酬：收盤 ÷（收盤 − 漲跌）− 1。交易所的漲跌是相對「參考價」，所以一般日子已排除除權息影響。
// 除權息當天證交所標 X、櫃買標「除息／除權」，沒有可用的漲跌，當天報酬記為 0（寧可少算一天，也不要記成假的大跌）。
const ret = (c, chg) => (Number.isFinite(chg) && c - chg > 0 ? Math.round((c / (c - chg) - 1) * 1e5) / 1e5 : 0);

// 單日收盤：{ id: [收盤, 成交張數, 當日報酬] }，無資料回傳 null
async function fetchPrices(date) {
  const p = {};
  const tw = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${date.replaceAll('-', '')}&type=ALLBUT0999&response=json`);
  const t = tw.stat === 'OK' && tw.date === date.replaceAll('-', '') && (tw.tables || []).find((x) => x.fields && x.fields.includes('證券代號') && x.fields.includes('收盤價'));
  if (t) for (const r of t.data) {
    const c = num(r[8]);
    if (!isStock(r[0]) || !(c > 0)) continue;
    const sign = String(r[9]).replace(/<[^>]+>/g, '').trim();
    const chg = sign === '-' ? -num(r[10]) : sign === '+' ? num(r[10]) : sign === '' ? 0 : NaN;
    p[r[0]] = [c, Math.round(num(r[2]) / 1000) || 0, ret(c, chg)];
  }
  const otc = await getJSON(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${encodeURIComponent(date.replaceAll('-', '/'))}&type=EW&response=json`);
  const o = otc.tables && otc.tables[0];
  if (o && o.date === rocDate(date)) for (const r of o.data || []) {
    const c = num(r[2]);
    if (!isStock(r[0]) || !(c > 0)) continue;
    p[r[0]] = [c, Math.round(num(r[7]) / 1000) || 0, ret(c, num(r[3]))];
  }
  return Object.keys(p).length ? p : null;
}

// 單日外資買賣超（張）：{ id: 外資淨買 }
async function fetchInst(date) {
  const out = {};
  const tw = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${date.replaceAll('-', '')}&selectType=ALLBUT0999&response=json`);
  if (tw.stat === 'OK' && tw.date === date.replaceAll('-', '')) for (const r of tw.data || []) { if (isStock(r[0])) out[r[0]] = Math.round((num(r[4]) + num(r[7])) / 1000); }
  const otc = await getJSON(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${encodeURIComponent(date.replaceAll('-', '/'))}&response=json`);
  const o = otc.tables && otc.tables[0];
  if (o && (!o.date || o.date === rocDate(date))) for (const r of o.data || []) { if (isStock(r[0])) out[r[0]] = Math.round(num(r[10]) / 1000); }
  return Object.keys(out).length ? out : null;
}

function weekdaysBack(fromDate, n) {
  const out = [];
  const d = new Date(fromDate + 'T00:00:00Z');
  while (out.length < n) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() - 1);
  }
  return out;
}

// 確保本機有最近 NEED_DAYS 個交易日的收盤，與最近 INST_DAYS 天的法人。回傳整理好的資料。
async function resetIfOldFormat() {
  const { mktVer } = await chrome.storage.local.get('mktVer');
  if (mktVer === MKT_VER) return;
  const keys = await localKeys();
  await chrome.storage.local.remove(keys.filter((k) => k.startsWith('mkt:') || k === 'mktIndex'));
  await chrome.storage.local.set({ mktVer: MKT_VER });
}

export async function ensureMarket({ onProgress } = {}) {
  await resetIfOldFormat();
  const today = tstToday();
  const { mktIndex = {} } = await chrome.storage.local.get('mktIndex');
  const candidates = weekdaysBack(today, NEED_DAYS + 20);
  const trading = [];
  const toFetch = [];
  for (const d of candidates) {
    if (trading.length + toFetch.length >= NEED_DAYS) break;
    if (mktIndex[d] === 'holiday' || closedName(d)) continue; // 證交所公布的休市日不必下載
    if (d === today && tstHour() < 14.75) continue; // 收盤行情約 14:30 後公布
    if (mktIndex[d] === 'ok') trading.push(d);
    else toFetch.push(d);
  }
  let done = 0;
  let fails = 0;
  let skipped = 0;
  const total = toFetch.length;
  for (const d of toFetch) {
    onProgress?.(`下載全市場行情 ${++done}/${total}${total > 10 ? '（第一次約 4 分鐘）' : ''}`);
    // 單日失敗就跳過，下次打開再補；連續失敗 3 次才停止
    let p;
    try {
      p = await fetchPrices(d);
      fails = 0;
    } catch (e) {
      skipped++;
      if (++fails >= 3) break;
      continue;
    }
    if (p) {
      await chrome.storage.local.set({ ['mkt:p:' + d]: p });
      mktIndex[d] = 'ok';
      trading.push(d);
    } else if (d < today) {
      mktIndex[d] = 'holiday';
    }
    await chrome.storage.local.set({ mktIndex });
  }
  trading.sort();
  const dates = trading.slice(-NEED_DAYS);
  const instDates = dates.slice(-INST_DAYS);
  const pKeys = dates.map((d) => 'mkt:p:' + d);
  const iKeys = instDates.map((d) => 'mkt:i:' + d);
  const stored = await chrome.storage.local.get([...pKeys, ...iKeys]);
  let k = 0;
  for (const d of instDates) {
    if (stored['mkt:i:' + d]) continue;
    onProgress?.(`下載法人買賣超 ${++k}`);
    let inst = null;
    try { inst = await fetchInst(d); } catch (e) { continue; }
    if (inst) {
      stored['mkt:i:' + d] = inst;
      await chrome.storage.local.set({ ['mkt:i:' + d]: inst });
    }
  }
  // 清掉用不到的舊資料
  const keep = new Set([...pKeys, ...iKeys]);
  const stale = (await localKeys()).filter((x) => x.startsWith('mkt:') && !keep.has(x));
  if (stale.length) await chrome.storage.local.remove(stale);
  for (const d of Object.keys(mktIndex)) if (d < dates[0]) delete mktIndex[d];
  await chrome.storage.local.set({ mktIndex });

  return {
    incomplete: skipped > 0 || dates.length < NEED_DAYS,
    dates,
    prices: dates.map((d) => stored['mkt:p:' + d] || {}),
    instDates: instDates.filter((d) => stored['mkt:i:' + d]),
    inst: instDates.filter((d) => stored['mkt:i:' + d]).map((d) => stored['mkt:i:' + d]),
  };
}

// 只讀本機已有的資料，不連網
export async function readMarket() {
  const { mktVer } = await chrome.storage.local.get('mktVer');
  if (mktVer !== MKT_VER) return { dates: [], prices: [], instDates: [], inst: [] };
  const { mktIndex = {} } = await chrome.storage.local.get('mktIndex');
  const dates = Object.keys(mktIndex).filter((d) => mktIndex[d] === 'ok').sort().slice(-NEED_DAYS);
  const instDates = dates.slice(-INST_DAYS);
  const stored = await chrome.storage.local.get([...dates.map((d) => 'mkt:p:' + d), ...instDates.map((d) => 'mkt:i:' + d)]);
  const iDates = instDates.filter((d) => stored['mkt:i:' + d]);
  return { dates, prices: dates.map((d) => stored['mkt:p:' + d] || {}), instDates: iDates, inst: iDates.map((d) => stored['mkt:i:' + d]) };
}

// ---------- 最新交易日明細 ----------
// 開高低收、三大法人（外資、投信、自營商）與加權指數，只抓最新一天。
// FinMind 偶爾晚更新或達到查詢上限時，自選股的最新一天改用這份交易所資料補上。
// p[id] = [開, 高, 低, 收, 成交股數]；i[id] = [外資, 投信, 自營商]（股）；idx.taiex = [收盤, 漲跌點數]
const n0 = (v) => num(v) || 0;
export async function ensureDetail(date) {
  if (!date) return null;
  const key = 'mkt:d:' + date;
  const { [key]: c } = await chrome.storage.local.get(key);
  if (c && c.full) return c;
  const out = c || { date, p: {}, i: {}, idx: {}, ok: {} };
  const ymd = date.replaceAll('-', '');
  const slash = encodeURIComponent(date.replaceAll('-', '/'));
  const ok = (r) => r !== '--' && num(r) > 0;
  if (!out.ok.twP) try {
    const tw = await getJSON(`https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?date=${ymd}&type=ALLBUT0999&response=json`);
    if (tw.stat === 'OK' && tw.date === ymd) {
      const t = (tw.tables || []).find((x) => x.fields && x.fields.includes('證券代號') && x.fields.includes('收盤價'));
      for (const r of t?.data || []) if (isStock(r[0]) && ok(r[8])) out.p[r[0]] = [num(r[5]) || num(r[8]), num(r[6]) || num(r[8]), num(r[7]) || num(r[8]), num(r[8]), n0(r[2])];
      const ix = (tw.tables?.[0]?.data || []).find((r) => String(r[0]).trim() === '發行量加權股價指數');
      if (ix) out.idx.taiex = [num(ix[1]), (/-/.test(String(ix[2]).replace(/<[^>]+>/g, '')) ? -1 : 1) * num(ix[3])];
      out.ok.twP = !!t;
    }
  } catch (e) { /* 下次再補 */ }
  if (!out.ok.otcP) try {
    const otc = await getJSON(`https://www.tpex.org.tw/www/zh-tw/afterTrading/otc?date=${slash}&type=EW&response=json`);
    const o = otc.tables && otc.tables[0];
    if (o && o.date === rocDate(date)) {
      for (const r of o.data || []) if (isStock(r[0]) && ok(r[2])) out.p[r[0]] = [num(r[4]) || num(r[2]), num(r[5]) || num(r[2]), num(r[6]) || num(r[2]), num(r[2]), n0(r[7])];
      out.ok.otcP = true;
    }
  } catch (e) { /* 下次再補 */ }
  if (!out.ok.twI) try {
    const tw = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/T86?date=${ymd}&selectType=ALLBUT0999&response=json`);
    if (tw.stat === 'OK' && tw.date === ymd) {
      for (const r of tw.data || []) if (isStock(r[0])) out.i[r[0]] = [n0(r[4]) + n0(r[7]), n0(r[10]), n0(r[11])];
      out.ok.twI = true;
    }
  } catch (e) { /* 下次再補 */ }
  if (!out.ok.otcI) try {
    const otc = await getJSON(`https://www.tpex.org.tw/www/zh-tw/insti/dailyTrade?type=Daily&sect=EW&date=${slash}&response=json`);
    const o = otc.tables && otc.tables[0];
    if (o && (!o.date || o.date === rocDate(date))) {
      for (const r of o.data || []) if (isStock(r[0])) out.i[r[0]] = [n0(r[10]), n0(r[13]), n0(r[22])];
      out.ok.otcI = true;
    }
  } catch (e) { /* 下次再補 */ }
  out.full = !!(out.ok.twP && out.ok.otcP && out.ok.twI && out.ok.otcI);
  const old = (await localKeys()).filter((k) => k.startsWith('mkt:d:') && k !== key);
  if (old.length) await chrome.storage.local.remove(old);
  await chrome.storage.local.set({ [key]: out, mktDetailKey: key });
  return out;
}

export async function readDetail() {
  const { mktDetailKey: k } = await chrome.storage.local.get('mktDetailKey');
  return k ? (await chrome.storage.local.get(k))[k] || null : null;
}

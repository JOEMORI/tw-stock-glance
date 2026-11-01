// FinMind 資料層：一個來源同時涵蓋上市、上櫃的行情、法人、融資融券、月營收、本益比與新聞。
// 未登入每小時約 300 次查詢，每檔股票每次更新用 6 次；設定裡填入免費 token 可提高上限。
import { getSettings, localKeys } from './storage.js';
import { isStale, isoDaysAgo, READY } from './time.js';

const BASE = 'https://api.finmindtrade.com/api/v4/data';
const INFO_TTL = 7 * 86400000;

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// FinMind 查詢次數：記錄最近一小時的查詢時間，畫面上可提醒接近上限
const HOUR = 3600 * 1000;
export const FM_LIMIT = 300;
// 同時查詢時依序記錄，避免互相覆蓋
let countQ = Promise.resolve();
function countCall() {
  countQ = countQ.then(async () => {
    const { fmCalls = [] } = await chrome.storage.local.get('fmCalls');
    const now = Date.now();
    const recent = fmCalls.filter((t) => now - t < HOUR);
    recent.push(now);
    await chrome.storage.local.set({ fmCalls: recent });
  }).catch(() => {});
}
export async function finmindUsage() {
  const { fmCalls = [] } = await chrome.storage.local.get('fmCalls');
  return fmCalls.filter((t) => Date.now() - t < HOUR).length;
}

export async function fetchDataset(dataset, params = {}) {
  const { token } = await getSettings();
  countCall();
  const url = new URL(BASE);
  url.searchParams.set('dataset', dataset);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const headers = token ? { Authorization: 'Bearer ' + token } : {};
  let res;
  try {
    res = await fetch(url, { headers });
  } catch (e) {
    throw new ApiError('連不上資料來源，請檢查網路', 0);
  }
  let body;
  try {
    body = await res.json();
  } catch (e) {
    throw new ApiError('資料來源回應格式錯誤（HTTP ' + res.status + '）', res.status);
  }
  if (res.status === 402 || body.status === 402) {
    throw new ApiError('已達 FinMind 每小時查詢上限。請稍後再試，或在設定填入免費 token 提高上限', 402);
  }
  if (!res.ok || body.status !== 200) throw new ApiError(body.msg || 'HTTP ' + res.status, res.status);
  return Array.isArray(body.data) ? body.data : [];
}

// 股票代號、名稱、產業。每週更新一次。
export async function getStockInfo({ force = false } = {}) {
  const { stockinfo } = await chrome.storage.local.get('stockinfo');
  if (!force && stockinfo && Date.now() - stockinfo.fetchedAt < INFO_TTL) return stockinfo.map;
  try {
    const rows = await fetchDataset('TaiwanStockInfo');
    const map = {};
    for (const r of rows) {
      const e = map[r.stock_id] || (map[r.stock_id] = { name: r.stock_name, industries: [], type: r.type, date: r.date });
      if (r.date >= e.date) {
        e.name = r.stock_name;
        e.type = r.type;
        e.date = r.date;
      }
      if (r.industry_category && !e.industries.includes(r.industry_category)) e.industries.push(r.industry_category);
    }
    await chrome.storage.local.set({ stockinfo: { fetchedAt: Date.now(), map } });
    return map;
  } catch (e) {
    if (stockinfo) return stockinfo.map;
    throw e;
  }
}

function slimPrice(rows) {
  return rows.map((r) => [r.date, r.open, r.max, r.min, r.close, r.Trading_Volume]);
}

function slimMargin(rows) {
  return rows.map((r) => ({ date: r.date, fin: r.MarginPurchaseTodayBalance, short: r.ShortSaleTodayBalance }));
}

function slimNews(rows) {
  const seen = new Set();
  return rows
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : -1))
    .filter((r) => {
      const key = (r.title || '').replace(/\s+/g, '');
      // 排除 CMoney 論壇貼文，只留新聞
      if (!key || seen.has(key) || /股市爆料同學會/.test(r.title)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12)
    .map((r) => ({ date: r.date, title: r.title, source: r.source, link: r.link }));
}

// 取得單檔股票所有資料。快取在當日資料齊全後才會失效；force 強制重抓。
// lite：不在自選股、只是點進來看的股票，不查 FinMind 新聞（新聞最耗查詢次數，改用 Google 新聞）。
export async function loadStock(id, { force = false, lite = false, want = null } = {}) {
  const key = 'stock:' + id;
  const { [key]: cached } = await chrome.storage.local.get(key);
  // 舊版快取沒有本益比歷史或除權息資料，視為過期重抓一次；精簡版快取在加入自選股後補成完整版
  const complete = cached && cached.perHist && cached.div && (lite || !cached.lite);
  // 交易所已有更新的一天、但 FinMind 快取還沒有：30 分鐘後再向 FinMind 補一次
  const lag = want && cached?.price?.length && cached.price.at(-1)[0] < want && Date.now() - cached.fetchedAt > 30 * 60000;
  if (!force && complete && !isStale(cached.fetchedAt) && !lag) {
    // 主資料仍新，但晚間 21:30 融資融券公布後只補抓融資
    if (isStale(cached.marginAt || cached.fetchedAt, Date.now(), READY.margin)) {
      try {
        const margin = await fetchDataset('TaiwanStockMarginPurchaseShortSale', { data_id: id, start_date: isoDaysAgo(40) });
        const upd = { ...cached, margin: slimMargin(margin), marginAt: Date.now() };
        await chrome.storage.local.set({ [key]: upd });
        return upd;
      } catch (e) {
        return cached;
      }
    }
    return cached;
  }
  try {
    const q = (ds, days) => fetchDataset(ds, { data_id: id, start_date: isoDaysAgo(days) });
    // 各資料集同時查詢（原本逐一查，一檔要 3 到 4 秒）
    const [price, inst, margin, revenue, per, divRows] = await Promise.all([
      q('TaiwanStockPrice', 760),
      q('TaiwanStockInstitutionalInvestorsBuySell', 35),
      q('TaiwanStockMarginPurchaseShortSale', 40),
      q('TaiwanStockMonthRevenue', 800),
      q('TaiwanStockPER', 1100),
      q('TaiwanStockDividend', 800),
    ]);
    if (!price.length) throw new ApiError('查無 ' + id + ' 的行情資料', 404);
    let news = [];
    if (!lite) try {
      // FinMind 新聞每次只回傳一天：近 3 天同時查，不足 6 則再補查前 4 天
      let rows = (await Promise.all([0, 1, 2].map((d) => q('TaiwanStockNews', d)))).flat();
      if (rows.length < 6) rows = rows.concat((await Promise.all([3, 4, 5, 6].map((d) => q('TaiwanStockNews', d)))).flat());
      news = slimNews(rows);
    } catch (e) {
      news = cached?.news || [];
    }
    const data = {
      id,
      fetchedAt: Date.now(),
      marginAt: Date.now(),
      price: slimPrice(price),
      inst: inst.map((r) => ({ date: r.date, name: r.name, buy: r.buy, sell: r.sell })),
      margin: slimMargin(margin),
      revenue: revenue.map((r) => ({ y: r.revenue_year, m: r.revenue_month, revenue: r.revenue })),
      per: per.length ? per[per.length - 1] : null,
      perHist: per.map((r) => [r.date, r.PER, r.PBR]),
      div: divRows.map((r) => ({
        cashDate: r.CashExDividendTradingDate || '',
        cash: (r.CashEarningsDistribution || 0) + (r.CashStatutorySurplus || 0),
        stockDate: r.StockExDividendTradingDate || '',
        stock: (r.StockEarningsDistribution || 0) + (r.StockStatutorySurplus || 0),
      })),
      lite,
      news,
    };
    await chrome.storage.local.set({ [key]: data });
    return data;
  } catch (e) {
    if (cached) return { ...cached, error: e.message };
    throw e;
  }
}

// 關聯對象的收盤序列：[[date, close], ...]
export async function loadEntity(e, { force = false } = {}) {
  const key = 'ent:' + e.kind + ':' + e.id;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (!force && cached && !isStale(cached.fetchedAt)) return cached.series;
  try {
    const start = isoDaysAgo(140);
    let series;
    if (e.kind === 'us') {
      series = (await fetchDataset('USStockPrice', { data_id: e.id, start_date: start })).filter((r) => r.Close > 0).map((r) => [r.date, r.Close]);
    } else if (e.kind === 'fx') {
      series = (await fetchDataset('TaiwanExchangeRate', { data_id: e.id, start_date: start })).filter((r) => r.spot_buy > 0).map((r) => [r.date, r.spot_buy]);
    } else if (e.kind === 'gold') {
      // 國際金價（美元／盎司）是 5 分鐘資料，只取近 10 天、每天最後一筆
      const rows = await fetchDataset('GoldPrice', { start_date: isoDaysAgo(10) });
      const m = new Map();
      for (const r of rows) if (r.Price > 0) m.set(String(r.date).slice(0, 10), r.Price);
      series = [...m.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    } else {
      series = (await fetchDataset('TaiwanStockPrice', { data_id: e.id, start_date: start })).filter((r) => r.close > 0).map((r) => [r.date, r.close]);
    }
    if (!series.length) throw new ApiError('查無 ' + e.id + ' 的資料', 404);
    await chrome.storage.local.set({ [key]: { fetchedAt: Date.now(), series } });
    return series;
  } catch (err) {
    if (cached) return cached.series;
    throw err;
  }
}

// 關聯對象兩年走勢（走勢視窗與 K 線疊加比較用）：[[date, open, high, low, close]]，匯率只有收盤
export async function loadEntityLong(e, { force = false } = {}) {
  const key = 'entL:' + e.kind + ':' + e.id;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (!force && cached && !isStale(cached.fetchedAt)) return cached.rows;
  if (e.kind === 'gold') e = { kind: 'us', id: 'GLD' }; // 金價長期走勢用黃金 ETF（GLD）代表
  try {
    const start = isoDaysAgo(760);
    let rows;
    if (e.kind === 'us') {
      rows = (await fetchDataset('USStockPrice', { data_id: e.id, start_date: start })).filter((r) => r.Close > 0).map((r) => [r.date, r.Open, r.High, r.Low, r.Close]);
    } else if (e.kind === 'fx') {
      rows = (await fetchDataset('TaiwanExchangeRate', { data_id: e.id, start_date: start })).filter((r) => r.spot_buy > 0).map((r) => [r.date, r.spot_buy, r.spot_buy, r.spot_buy, r.spot_buy]);
    } else {
      rows = (await fetchDataset('TaiwanStockPrice', { data_id: e.id, start_date: start })).filter((r) => r.close > 0).map((r) => [r.date, r.open, r.max, r.min, r.close]);
    }
    if (!rows.length) throw new ApiError('查無 ' + e.id + ' 的資料', 404);
    await chrome.storage.local.set({ [key]: { fetchedAt: Date.now(), rows } });
    return rows;
  } catch (err) {
    if (cached) return cached.rows;
    throw err;
  }
}

// 除權息日（週報的下週行事曆用），一週更新一次
export async function loadDividends(id) {
  const key = 'div:' + id;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (cached && Date.now() - cached.fetchedAt < 7 * 86400000) return cached.rows;
  const rows = (await fetchDataset('TaiwanStockDividend', { data_id: id, start_date: isoDaysAgo(400) })).map((r) => ({
    cashDate: r.CashExDividendTradingDate || '',
    stockDate: r.StockExDividendTradingDate || '',
    cash: (r.CashEarningsDistribution || 0) + (r.CashStatutorySurplus || 0),
  }));
  await chrome.storage.local.set({ [key]: { fetchedAt: Date.now(), rows } });
  return rows;
}

export async function getCachedStock(id) {
  const key = 'stock:' + id;
  const { [key]: cached } = await chrome.storage.local.get(key);
  return cached || null;
}

// 清理快取：不在自選股且 14 天沒看的個股、3 天前的新聞、30 天前的關聯與除權息、舊版留下的鍵
export async function pruneCaches(watch) {
  const keys = (await localKeys()).filter((k) => /^(stock|gn|ent|entL|div|fin|ern|mops):/.test(k));
  const all = await chrome.storage.local.get(keys);
  const now = Date.now();
  const drop = [];
  for (const [k, v] of Object.entries(all)) {
    if (k.startsWith('stock:') && !watch.includes(k.slice(6)) && now - (v?.fetchedAt || 0) > 14 * 86400000) drop.push(k);
    else if (k.startsWith('gn:') && now - (v?.at || 0) > 3 * 86400000) drop.push(k);
    else if ((k.startsWith('ent:') || k.startsWith('entL:') || k.startsWith('div:') || k.startsWith('fin:')) && now - (v?.fetchedAt || 0) > 30 * 86400000) drop.push(k);
    else if (k.startsWith('ern:') || k.startsWith('mops:')) drop.push(k);
  }
  if (drop.length) await chrome.storage.local.remove(drop);
  return drop.length;
}

// 季財報（綜合損益表），三天更新一次
export async function loadFinancials(id) {
  const key = 'fin:' + id;
  const { [key]: cached } = await chrome.storage.local.get(key);
  if (cached && Date.now() - cached.fetchedAt < 3 * 86400000) return cached.rows;
  try {
    const rows = (await fetchDataset('TaiwanStockFinancialStatements', { data_id: id, start_date: isoDaysAgo(1000) }))
      .map((r) => ({ date: r.date, type: r.type, name: r.origin_name || '', value: r.value }));
    await chrome.storage.local.set({ [key]: { fetchedAt: Date.now(), rows } });
    return rows;
  } catch (e) {
    if (cached) return cached.rows;
    throw e;
  }
}

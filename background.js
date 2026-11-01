// 背景：
// 1. 每個交易日台灣時間 16:40 更新自選股、關聯對象、法說會與全市場行情。
//    只有「今天新發生」的訊號才計入圖示數字與通知，持續狀態（如營收連續年增）不通知。
// 2. 每個交易日台灣時間 21:40 補抓融資融券。
// 3. 每週六台灣時間 09:00 更新集保大戶持股、記下各檔下週波動區間（下週週報用來對照），並通知週報已準備好。
import { getWatchlist, getSettings, getObserve, getKeywords } from './lib/storage.js';
import { classify } from './lib/intel.js';
import { collectAnnouncements } from './lib/announce.js';
import { loadStock, loadEntity } from './lib/api.js';
import { analyze, weekBand, weekKeyOf, alertSignals, signalReliability, weakSignal } from './lib/indicators.js';
import { nextRefreshTime, READY } from './lib/time.js';
import { loadShareholding } from './lib/tdcc.js';
import { getRelations } from './lib/relations.js';
import { ensureMarket, ensureDetail } from './lib/market.js';
import { patchData } from './lib/patch.js';
import { collectConferences } from './lib/conferences.js';
import { collectExRights } from './lib/exright.js';
import { initHolidays } from './lib/holidays.js';
import { recordDay, itemsFromAnalysis } from './lib/journal.js';
import { newAnnouncements } from './lib/announce.js';

const DAILY = 'daily-refresh';
const WEEKLY = 'weekly-report';
const MARGIN = 'margin-refresh';

function nextSaturday9(now = Date.now()) {
  const d = new Date(now);
  d.setUTCHours(1, 0, 0, 0); // 台灣時間 09:00
  while (d.getUTCDay() !== 6 || d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

async function schedule() {
  await initHolidays();
  chrome.alarms.create(DAILY, { when: nextRefreshTime(Date.now()) });
  chrome.alarms.create(WEEKLY, { when: nextSaturday9() });
  chrome.alarms.create(MARGIN, { when: nextRefreshTime(Date.now(), READY.margin) });
}

chrome.runtime.onInstalled.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);

// 每次背景程式啟動時重排一次（補建缺少的排程，並避開新載入的休市日）
schedule();

chrome.alarms.onAlarm.addListener(async (alarm) => {
  try {
    const closed = await initHolidays();
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
    const tradingDay = !closed[today] && ![0, 6].includes(new Date(today + 'T00:00:00Z').getUTCDay());
    if (alarm.name === DAILY && tradingDay) await dailyRefresh();
    if (alarm.name === WEEKLY) await weeklyNotice();
    if (alarm.name === MARGIN && tradingDay) await marginRefresh();
  } finally {
    schedule();
  }
});

async function stockName(id) {
  const { stockinfo } = await chrome.storage.local.get('stockinfo');
  return stockinfo?.map?.[id]?.name || id;
}

async function dailyRefresh() {
  await initHolidays();
  const ids = await getWatchlist();
  const { alerts = {} } = await chrome.storage.sync.get('alerts');
  const flagged = [];
  const alerted = [];
  // 先抓交易所全市場資料與最新一天明細，FinMind 若尚未更新就用交易所資料補
  let detail = null;
  try {
    const mk = await ensureMarket();
    detail = await ensureDetail(mk.dates.at(-1));
  } catch (e) {
    // 交易所連不上時，畫面打開時會再補
  }
  const revNews = [];
  const { revSeen = {} } = await chrome.storage.local.get('revSeen');
  for (const id of ids) {
    try {
      const raw = await loadStock(id, { force: true });
      // 月營收：比上次看到的月份新，就列入通知（第一次只記錄、不通知）
      const rv = raw.revenue || [];
      const lr = rv.at(-1);
      if (lr) {
        const key = lr.y + '-' + lr.m;
        if (revSeen[id] && revSeen[id] !== key) {
          const ly = rv.find((x) => x.y === lr.y - 1 && x.m === lr.m);
          const pm = rv.at(-2);
          revNews.push({ id, m: lr.m, v: lr.revenue, yoy: ly ? (lr.revenue / ly.revenue - 1) * 100 : null, mom: pm ? (lr.revenue / pm.revenue - 1) * 100 : null });
        }
        revSeen[id] = key;
      }
      const a = analyze(patchData(raw, detail, id));
      const al = alertSignals(a, alerts[id]).events;
      if (al.length) alerted.push({ id, t: al.map((x) => x.t).join('、'), close: a.last.close });
      // 指標成績單：記下今天收盤時的指標（只記最新交易日）
      if (!a.empty && detail && a.last.time === detail.date) {
        const tx = detail.idx?.taiex;
        await recordDay(a.last.time, id, itemsFromAnalysis(a), tx ? (tx[1] >= 0 ? 'u' : 'd') : null).catch(() => {});
      }
      // 只通知在本股歷史上有效或樣本不足的訊號；無效、沒有方向的不通知
      const rel = a.empty ? null : signalReliability(a.daily);
      const evs = a.empty ? [] : a.events.filter((e) => !weakSignal(rel, e));
      if (evs.length || al.length) flagged.push({ id, signals: [...al, ...evs].map((s) => s.t) });
      for (const e of await getRelations(id)) await loadEntity(e).catch(() => {});
    } catch (e) {
      // 單檔失敗不影響其他檔，畫面打開時會再試
    }
  }
  await collectConferences({ force: true }).catch(() => {});
  await collectExRights({ force: true }).catch(() => {});
  await chrome.storage.local.set({ revSeen });
  if (revNews.length) {
    const fmtRev = (v) => (v >= 1e8 ? (v / 1e8).toFixed(2) + ' 億' : Math.round(v / 1e4).toLocaleString('en-US') + ' 萬');
    const pc = (x) => (x == null ? '–' : (x > 0 ? '+' : '') + x.toFixed(1) + '%');
    const lines = [];
    for (const x of revNews) lines.push(`${await stockName(x.id)} ${x.m} 月營收 ${fmtRev(x.v)}，年增 ${pc(x.yoy)}、月增 ${pc(x.mom)}`);
    chrome.notifications.create('rev-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', title: '月營收公布', message: lines.join('\n') });
  }
  await noticeAnnouncements(ids);
  await chrome.action.setBadgeBackgroundColor({ color: '#1A1A1A' });
  await chrome.action.setBadgeText({ text: flagged.length ? String(flagged.length) : '' });
  const { notify } = await getSettings();
  // 自訂價位提醒：不管通知設定都發，因為是你自己設的
  if (alerted.length) {
    const lines = [];
    for (const x of alerted.slice(0, 4)) lines.push(`${await stockName(x.id)} 收 ${x.close}：${x.t}`);
    chrome.notifications.create('alert-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', priority: 2, title: '價位提醒', message: lines.join('\n') });
  }
  if (notify && flagged.length) {
    const lines = [];
    for (const f of flagged.slice(0, 3)) lines.push(`${await stockName(f.id)}：${f.signals.slice(0, 2).join('、')}`);
    chrome.notifications.create('close-' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `收盤資料已更新：${flagged.length} 檔有新訊號`,
      message: lines.join('\n'),
    });
  }
}

async function marginRefresh() {
  const ids = await getWatchlist();
  for (const id of ids) await loadStock(id).catch(() => {});
  await noticeAnnouncements(ids);
}

// 自選股的新公司公告（重大訊息）：不受通知開關影響，因為是第一手消息
async function noticeAnnouncements(ids) {
  let list = [];
  const watched = [...new Set([...ids, ...(await getObserve().catch(() => []))])];
  // newAnnouncements 會更新「上次通知時間」，所以先記下時間，再找全市場的關鍵字公告
  const { annsNotified: since = 0 } = await chrome.storage.local.get('annsNotified');
  try { list = await newAnnouncements(watched); } catch (e) { return; }
  try {
    const kws = await getKeywords();
    const anns = await collectAnnouncements();
    const hits = [];
    if (since && kws.length) for (const [id, l] of Object.entries(anns)) for (const a of l) if (a.at > since && !watched.includes(id) && classify(a, kws)?.kw?.length) hits.push({ id, ...a });
    if (hits.length) {
      const lines = [];
      for (const x of hits.slice(0, 4)) lines.push(`${await stockName(x.id)}：${x.s.slice(0, 40)}`);
      chrome.notifications.create('kw-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', title: `情報雷達：關鍵字公告 ${hits.length} 則`, message: lines.join('\n') });
    }
  } catch (e) { /* 略過 */ }
  if (!list.length) return;
  const lines = [];
  for (const x of list.slice(0, 4)) lines.push(`${await stockName(x.id)}：${x.s.slice(0, 40)}`);
  chrome.notifications.create('ann-' + Date.now(), { type: 'basic', iconUrl: 'icons/icon128.png', title: `公司公告 ${list.length} 則`, message: lines.join('\n') });
}

// 記下本週末各檔的下週波動區間，下週的週報拿來對照實際收盤
async function savePredictions() {
  const preds = {};
  let wk = null;
  for (const id of await getWatchlist()) {
    try {
      const a = analyze(await loadStock(id));
      const b = !a.empty && weekBand(a.daily);
      if (b) { preds[id] = b; wk = weekKeyOf(b.date); }
    } catch (e) { /* 略過 */ }
  }
  if (wk) await chrome.storage.local.set({ ['wkPred:' + wk]: preds });
}

async function weeklyNotice() {
  await loadShareholding({ force: true }).catch(() => {});
  await savePredictions().catch(() => {});
  const { notify } = await getSettings();
  if (!notify) return;
  chrome.notifications.create('weekly-' + Date.now(), {
    type: 'basic',
    iconUrl: 'icons/icon128.png',
    title: '本週報告已準備好',
    message: '點這裡查看自選股週表現、族群輪動、關聯變化與下週行事曆。',
  });
}

chrome.notifications.onClicked.addListener((id) => {
  const page = id.startsWith('weekly-') ? 'weekly.html' : 'dashboard.html';
  chrome.tabs.create({ url: chrome.runtime.getURL(page) });
});

// 證交所公布的市場休市日（含補假）。每年一份，快取 7 天；颱風等臨時休市以「交易所無資料」判斷。
import { setClosed } from './time.js';

const TTL = 7 * 86400000;

async function loadYear(y) {
  const key = 'hol:' + y;
  const c = (await chrome.storage.local.get(key))[key];
  if (c && Date.now() - c.at < TTL) return c.map;
  const res = await fetch(`https://www.twse.com.tw/rwd/zh/holidaySchedule/holidaySchedule?response=json&queryYear=${y - 1911}`);
  const j = await res.json();
  const map = {};
  for (const [date, name, note] of j.data || []) {
    // 「開始交易日」「最後交易日」是有交易的日子，排除
    if (/開始交易|最後交易/.test(name)) continue;
    map[date] = /補假/.test(note || '') && new Date(date + 'T00:00:00Z').getUTCDay() % 6 ? name + '補假' : name;
  }
  await chrome.storage.local.set({ [key]: { at: Date.now(), map } });
  return map;
}

let closed = {};
export async function initHolidays() {
  const y = new Date().getUTCFullYear();
  try {
    const maps = await Promise.all([y, y + 1].map((x) => loadYear(x).catch(() => ({}))));
    closed = Object.assign({}, ...maps);
  } catch (e) { closed = {}; }
  setClosed(closed);
  return closed;
}
export const closedName = (date) => closed[date] || null;

// 最新資料日之後、到最近應有資料的交易日之間的平日，逐一說明原因
export function gapNote(lastDate, expectedMs) {
  if (!lastDate) return '';
  const out = [];
  const d = new Date(lastDate + 'T00:00:00Z');
  const end = new Date(expectedMs).toISOString().slice(0, 10);
  for (let i = 0; i < 14; i++) {
    d.setUTCDate(d.getUTCDate() + 1);
    const iso = d.toISOString().slice(0, 10);
    if (iso > end) break;
    if (d.getUTCDay() % 6 === 0) continue;
    const md = `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
    out.push(closed[iso] ? `${md} ${closed[iso]}休市` : `${md} 交易所無成交資料，臨時休市（如颱風）`);
  }
  return out.join('、');
}

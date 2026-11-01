// 時間工具。以 UTC 時分表示台灣時間的資料公布點：
// 行情與法人約 15:00 後齊全，以 16:30（UTC 08:30）為界；融資融券約 21:30（UTC 13:30）公布。
export const READY = { main: [8, 30], margin: [13, 30] };

// 休市日（由 holidays.js 載入後設定）；週末一律休市
let closed = {};
export function setClosed(map) { closed = map || {}; }

function isWeekend(d) {
  const day = d.getUTCDay();
  return day === 0 || day === 6 || !!closed[d.toISOString().slice(0, 10)];
}

// 現在之前最近一次資料公布時間（毫秒），跳過週末與證交所公布的休市日。
export function lastReadyTime(now = Date.now(), [h, m] = READY.main) {
  const d = new Date(now);
  d.setUTCHours(h, m, 0, 0);
  if (d.getTime() > now) d.setUTCDate(d.getUTCDate() - 1);
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() - 1);
  return d.getTime();
}

// 下一次背景自動更新時間，比公布時間晚 10 分鐘。
export function nextRefreshTime(now = Date.now(), [h, m] = READY.main) {
  const d = new Date(now);
  d.setUTCHours(h, m + 10, 0, 0);
  if (d.getTime() <= now) d.setUTCDate(d.getUTCDate() + 1);
  while (isWeekend(d)) d.setUTCDate(d.getUTCDate() + 1);
  return d.getTime();
}

export function isStale(fetchedAt, now = Date.now(), ready = READY.main) {
  return !fetchedAt || fetchedAt < lastReadyTime(now, ready);
}

export function isoDaysAgo(n, now = Date.now()) {
  const d = new Date(now - n * 86400000);
  return d.toISOString().slice(0, 10);
}

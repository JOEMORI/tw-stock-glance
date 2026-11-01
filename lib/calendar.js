// 關聯行事曆：本股與關聯公司的未來事件。
// 來源：
// 1. 台股法說會：證交所、櫃買中心重大訊息開放資料（lib/conferences.js，每天累積）
// 2. 關聯公司已公告的財報日：寫在 lib/relations.js 的 events，附官方來源
// 3. 除權息：FinMind
// 4. 每月 10 日前的營收公布期限
// 5. 自行新增的事件（存在 chrome.storage.sync）
import { loadDividends } from './api.js';
import { collectConferences } from './conferences.js';
import { collectExRights } from './exright.js';

const DAY = 86400000;
export const tstToday = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);
export const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);

// 自行新增的事件：{ uid, stockId, date, who, t, note }
export async function getCustomEvents() {
  const { calCustom = [] } = await chrome.storage.sync.get('calCustom');
  return calCustom;
}
export async function addCustomEvent(ev) {
  const list = await getCustomEvents();
  list.push({ ...ev, uid: Date.now().toString(36) });
  await chrome.storage.sync.set({ calCustom: list });
}
export async function removeCustomEvent(uid) {
  const list = (await getCustomEvents()).filter((e) => e.uid !== uid);
  await chrome.storage.sync.set({ calCustom: list });
}

// stock: { id, name }；rels：關聯對象（getRelations 的 e）
export async function loadCalendar(stock, rels, { from = addDays(tstToday(), -3), to = addDays(tstToday(), 45), divs = null } = {}) {
  const ev = [];
  const push = (e) => { if (e.date >= from && e.date <= to) ev.push(e); };
  const self = { name: stock.name, id: stock.id, rel: '本股', self: true };

  let confs = {};
  try { confs = await collectConferences(); } catch (e) { /* 略過 */ }
  for (const c of confs[stock.id] || []) push({ date: c.date, who: self, t: `法說會${c.time ? ' ' + c.time : ''}`, note: [c.note, c.place].filter(Boolean).join('，') });
  for (const r of rels) {
    if (r.kind === 'tw' && confs[r.id]) for (const c of confs[r.id]) push({ date: c.date, who: { name: r.name, id: r.id, rel: r.rel }, t: `法說會${c.time ? ' ' + c.time : ''}`, note: c.note });
    for (const e of r.events || []) push({ date: e.date, who: { name: r.name, id: r.id, rel: r.rel }, t: e.t, note: e.note || '', src: e.src });
  }
  try {
    for (const d of divs || (await loadDividends(stock.id))) {
      if (d.cashDate) push({ date: d.cashDate, who: self, t: '除息', note: d.cash ? `現金股利 ${d.cash.toFixed(2)} 元` : '' });
      if (d.stockDate) push({ date: d.stockDate, who: self, t: '除權', note: '' });
    }
  } catch (e) { /* 略過 */ }
  // 交易所除權息預告表：公告比 FinMind 股利資料更早
  try {
    const exr = await collectExRights();
    for (const x of exr[stock.id] || []) push({ date: x.date, who: self, t: x.type, note: x.cash ? `現金股利 ${x.cash.toFixed(2)} 元（交易所預告）` : '交易所預告' });
    for (const r of rels) if (r.kind === 'tw' && exr[r.id]) for (const x of exr[r.id]) push({ date: x.date, who: { name: r.name, id: r.id, rel: r.rel }, t: x.type, note: '' });
  } catch (e) { /* 略過 */ }
  // 法定財報公布期限：第一季 5/15、第二季 8/14（金融業 8/31）、第三季 11/14、年報 3/31
  // 情報雷達：處分利益預計認列的財報季
  try {
    const { intelCal = {} } = await chrome.storage.local.get('intelCal');
    for (const x of intelCal[stock.id] || []) push({ date: x.date, who: self, t: x.t, note: x.note });
  } catch (e) { /* 略過 */ }
  for (const d of reportDeadlines(stock.industries || [])) push({ date: d.date, who: self, t: d.t + '公布期限', note: '法定最後期限（遇假日順延），多數公司會提早公布；屆時會有月營收以外的獲利數字' });
  const today = tstToday();
  const tenth = today.slice(8) <= '10' ? today.slice(0, 8) + '10' : addDays(today.slice(0, 8) + '28', 5).slice(0, 8) + '10';
  push({ date: tenth, who: self, t: '上月營收公布期限', note: '多數公司在 10 日前公布' });
  for (const c of await getCustomEvents()) {
    if (c.stockId === stock.id) push({ date: c.date, who: { name: c.who || stock.name, id: c.stockId, rel: c.who && c.who !== stock.name ? '自訂' : '本股', self: !c.who || c.who === stock.name }, t: c.t, note: c.note || '', uid: c.uid });
  }
  const seen = new Set();
  // 同一天同一事件只留一筆（FinMind 與交易所預告可能重複）
  return ev
    .filter((e) => { if (!/^除/.test(e.t)) return true; const k = e.date + e.who.id + '除'; if (seen.has(k + 'x')) return false; seen.add(k + 'x'); return true; })
    .filter((e) => { const k = e.date + e.who.id + e.t; if (seen.has(k)) return false; seen.add(k); return true; })
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.who.self ? -1 : 1));
}

export function reportDeadlines(industries, from = tstToday()) {
  const fin = industries.some((x) => /金融/.test(x));
  const y = Number(from.slice(0, 4));
  const list = [];
  for (const yr of [y, y + 1]) {
    list.push({ date: `${yr}-03-31`, t: `${yr - 1} 年報` });
    list.push({ date: `${yr}-05-15`, t: `${yr} 第一季財報` });
    list.push({ date: `${yr}-${fin ? '08-31' : '08-14'}`, t: `${yr} 第二季財報` });
    list.push({ date: `${yr}-11-14`, t: `${yr} 第三季財報` });
  }
  return list.filter((d) => d.date >= from).slice(0, 1);
}

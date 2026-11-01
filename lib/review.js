// 對答案：用當時看得到的資料，重算過去每一天會給的提醒，再看之後實際怎麼走。
// 不必等累積，打開就有近 20 個交易日的紀錄。
import { analyze, priceDigits } from './indicators.js';

export const H = 3; // 方向訊號看 3 個交易日後

// data 截到 date（含）為止
function cut(data, date) {
  const le = (r) => (Array.isArray(r) ? r[0] : r.date) <= date;
  return { ...data, price: data.price.filter(le), inst: (data.inst || []).filter(le), margin: (data.margin || []).filter(le), news: [] };
}

export function reviewStock(data, days = 20) {
  const full = analyze(data);
  if (full.empty) return null;
  const c = full.daily;
  const n = c.length;
  const out = [];
  for (let i = Math.max(61, n - 1 - days); i < n - 1; i++) {
    const a = analyze(cut(data, c[i].time));
    if (a.empty || a.last.time !== c[i].time) continue;
    const base = c[i].close;
    const after = c.slice(i + 1, i + 1 + H);
    const done = after.length >= H;
    const move = ((after.at(-1).close / base) - 1) * 100;
    const items = [];
    for (const e of a.events) {
      if (!e.d) continue;
      const ok = Math.sign(move) === e.d && Math.abs(move) >= 0.3;
      items.push({ kind: 'dir', t: e.t, d: e.d, res: !done ? '待觀察' : ok ? '應驗' : '未應驗', move, done });
    }
    const lv = a.levels || {};
    if (lv.sup && (base / lv.sup.price - 1) * 100 <= 3) {
      const broke = after.some((x) => x.close < lv.sup.price * 0.99);
      items.push({ kind: 'lv', t: `距支撐 ${lv.sup.price.toFixed(priceDigits(base))}（−${((1 - lv.sup.price / base) * 100).toFixed(1)}%）`, res: broke ? '跌破' : done ? '守住' : '待觀察', move, done: done || broke });
    }
    if (lv.res && (lv.res.price / base - 1) * 100 <= 3) {
      const brk = after.some((x) => x.close > lv.res.price * 1.01);
      items.push({ kind: 'lv', t: `距壓力 ${lv.res.price.toFixed(priceDigits(base))}（+${(((lv.res.price / base) - 1) * 100).toFixed(1)}%）`, res: brk ? '突破' : done ? '未突破' : '待觀察', move, done: done || brk });
    }
    if (items.length) out.push({ date: c[i].time, close: base, next: after[0] ? ((after[0].close / base) - 1) * 100 : null, items });
  }
  const dir = out.flatMap((d) => d.items.filter((x) => x.kind === 'dir' && x.done));
  return { days: out.reverse(), total: dir.length, hit: dir.filter((x) => x.res === '應驗').length };
}

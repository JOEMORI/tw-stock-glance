// 指標成績單：每天收盤把「當時看到的指標」存下來，之後自動對答案。
// 存法：jr:<日期> = { 股票代號: { r: 'u'|'d'（當天大盤漲跌）, k: { 指標鍵: 方向 } } }
// 對答案時用還原後的日收盤，看 1、5、20 個交易日後的漲跌方向是否和指標方向相同（0.3% 以內算沒方向，記為錯）。
import { localKeys } from './storage.js';

export const JKEYS = {
  ma20up: '站上月線', ma20down: '跌破月線', breakup: '帶量突破 20 日高點', breakdown: '跌破 20 日低點',
  high60: '創 60 日新高', low60: '創 60 日新低', supbreak: '跌破支撐', resbreak: '突破壓力',
  instF: '外資轉為連 3 買／賣', instT: '投信轉為連 3 買／賣', instFs: '外資連買／賣（持續）',
  rev: '營收連月年增／減', margin: '融資 5 日大增', alert: '自訂價位提醒',
  usrel: '關聯美股前一晚大漲／跌', secTop: '所屬題材 5 日漲幅前 3', secBot: '所屬題材 5 日漲幅後 3',
  rsUp: '強於大盤 2 個百分點', rsDn: '弱於大盤 2 個百分點', valHi: '本益比在三年高檔', valLo: '本益比在三年低檔',
  bigUp: '千張大戶本週增加', bigDn: '千張大戶本週減少',
};
export const HORIZONS = [1, 5, 20];
export const MIN_N = 20;
const KEEP_DAYS = 400;

// 合併寫入：同一天同一檔可以分幾次補上指標（例如關聯美股要打開該股才算得到）
export async function recordDay(date, id, items, regime) {
  if (!date || !items) return;
  const key = 'jr:' + date;
  const { [key]: day = {} } = await chrome.storage.local.get(key);
  const cur = day[id] || { r: regime || null, k: {} };
  if (regime && !cur.r) cur.r = regime;
  let changed = !day[id];
  for (const [k, d] of Object.entries(items)) if (d && cur.k[k] !== d) { cur.k[k] = d; changed = true; }
  if (!changed) return;
  day[id] = cur;
  await chrome.storage.local.set({ [key]: day });
}

export async function loadJournal() {
  const keys = (await localKeys()).filter((k) => k.startsWith('jr:')).sort();
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  const old = keys.filter((k) => k.slice(3) < cutoff);
  if (old.length) chrome.storage.local.remove(old);
  const keep = keys.filter((k) => k.slice(3) >= cutoff);
  const all = await chrome.storage.local.get(keep);
  return keep.map((k) => ({ date: k.slice(3), data: all[k] }));
}

// 從指標分析結果整理出當天要記的項目（方向 +1 看漲、−1 看跌）
export function itemsFromAnalysis(a) {
  const out = {};
  if (!a || a.empty) return out;
  for (const e of a.events) {
    if (!e.d) continue;
    if (e.key === 'inst') out[/外資/.test(e.t) ? 'instF' : 'instT'] = e.d;
    else if (JKEYS[e.key]) out[e.key] = e.d;
  }
  for (const s of a.states) {
    if (/^外資連/.test(s.t)) out.instFs = s.d;
    else if (/^營收連/.test(s.t)) out.rev = s.d;
    else if (/^融資 5 日增/.test(s.t)) out.margin = -1;
  }
  const v = a.valuation?.per;
  if (v && v.pct >= 85) out.valHi = -1;
  else if (v && v.pct <= 15) out.valLo = 1;
  return out;
}

// 成績單。closes: { id: [{ time, close }] }（還原後日 K）；only：只算某一檔
export function scorecard(journal, closes, { only = null, recentDays = 60 } = {}) {
  const stats = {};
  const recentCut = journal.length ? journal[Math.max(0, journal.length - recentDays)].date : '';
  const idx = {};
  for (const [id, c] of Object.entries(closes)) idx[id] = new Map(c.map((x, i) => [x.time, i]));
  for (const { date, data } of journal) {
    for (const [id, rec] of Object.entries(data || {})) {
      if (only && id !== only) continue;
      const c = closes[id];
      const i = idx[id]?.get(date);
      for (const [k, d] of Object.entries(rec.k || {})) {
        const s = stats[k] || (stats[k] = { key: k, n: 0, h: {}, recent: { n: 0, ok: 0 }, regime: { u: { n: 0, ok: 0 }, d: { n: 0, ok: 0 } }, ret5: 0 });
        s.n++;
        if (c == null || i == null) continue;
        for (const H of HORIZONS) {
          if (i + H >= c.length) continue;
          const mv = (c[i + H].close / c[i].close - 1) * 100;
          const ok = Math.sign(mv) === d && Math.abs(mv) >= 0.3;
          const h = s.h[H] || (s.h[H] = { n: 0, ok: 0 });
          h.n++; if (ok) h.ok++;
          if (H === 5) {
            s.ret5 += mv * d;
            if (date >= recentCut) { s.recent.n++; if (ok) s.recent.ok++; }
            if (rec.r && s.regime[rec.r]) { s.regime[rec.r].n++; if (ok) s.regime[rec.r].ok++; }
          }
        }
      }
    }
  }
  for (const s of Object.values(stats)) {
    const h5 = s.h[5];
    s.rate5 = h5 && h5.n ? h5.ok / h5.n : null;
    s.avgRet5 = h5 && h5.n ? s.ret5 / h5.n : null;
    s.verdict = !h5 || h5.n < MIN_N ? 'few' : s.rate5 >= 0.55 ? 'good' : s.rate5 <= 0.45 ? 'bad' : 'flat';
    const rr = s.recent.n >= 10 ? s.recent.ok / s.recent.n : null;
    s.recentRate = rr;
    s.drift = rr != null && s.rate5 != null && h5.n >= MIN_N ? (rr - s.rate5 >= 0.15 ? 'better' : s.rate5 - rr >= 0.15 ? 'worse' : null) : null;
  }
  return Object.values(stats).sort((a, b) => (b.h[5]?.n || 0) - (a.h[5]?.n || 0) || b.n - a.n);
}

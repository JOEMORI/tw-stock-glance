// 純計算，不碰瀏覽器 API，可在 Node 測試。
// K 棒格式：{ time: 'YYYY-MM-DD', open, high, low, close, volume(張) }

export function toCandles(rows) {
  return rows
    .filter((r) => r[4] > 0 && r[2] > 0 && r[3] > 0)
    .map((r) => ({ time: r[0], open: r[1] || r[4], high: r[2], low: r[3], close: r[4], volume: Math.round(r[5] / 1000) }));
}

// 除權息還原（向前調整）：除權息日之前的價格乘上「參考價 ÷ 前一日收盤」。
// 參考價 =（前一日收盤 − 現金股利）÷（1 + 股票股利 ÷ 10），與交易所算法相同。
// 最新價格不變，所以畫面上的收盤價就是實際成交價；漲跌、均線、壓力支撐、突破訊號都不會被除息缺口誤導。
// divs：[{ cashDate, cash, stockDate, stock }]（stock 為每股配發股票股利的元數）
export function adjustDividends(candles, divs = []) {
  const ev = new Map();
  for (const d of divs) {
    if (d.cashDate && d.cash > 0) { const e = ev.get(d.cashDate) || { cash: 0, stock: 0 }; e.cash += d.cash; ev.set(d.cashDate, e); }
    if (d.stockDate && d.stock > 0) { const e = ev.get(d.stockDate) || { cash: 0, stock: 0 }; e.stock += d.stock; ev.set(d.stockDate, e); }
  }
  const out = candles.map((x) => ({ ...x }));
  const applied = [];
  for (const [date, e] of [...ev.entries()].sort()) {
    const i = candles.findIndex((x) => x.time >= date);
    if (i <= 0) continue; // 除權息日在資料之前或尚未發生
    const prevClose = candles[i - 1].close;
    const ref = (prevClose - e.cash) / (1 + e.stock / 10);
    if (!(ref > 0) || ref >= prevClose) continue;
    const f = ref / prevClose;
    for (let j = 0; j < i; j++) { out[j].open *= f; out[j].high *= f; out[j].low *= f; out[j].close *= f; }
    applied.push({ time: candles[i].time, cash: e.cash, stock: e.stock, factor: f, prevClose, ref });
  }
  return { candles: out, exDiv: applied };
}

function weekKey(t) {
  const d = new Date(t + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// 週 K、月 K：以該期第一個交易日作為時間。
export function aggregate(candles, mode) {
  if (mode === 'd') return candles;
  const out = [];
  let cur = null;
  let key = null;
  for (const x of candles) {
    const k = mode === 'w' ? weekKey(x.time) : x.time.slice(0, 7);
    if (k !== key) {
      if (cur) out.push(cur);
      key = k;
      cur = { ...x };
    } else {
      cur.high = Math.max(cur.high, x.high);
      cur.low = Math.min(cur.low, x.low);
      cur.close = x.close;
      cur.volume += x.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export function sma(candles, n) {
  const out = [];
  let s = 0;
  for (let i = 0; i < candles.length; i++) {
    s += candles[i].close;
    if (i >= n) s -= candles[i - n].close;
    if (i >= n - 1) out.push({ time: candles[i].time, value: s / n });
  }
  return out;
}

function atr(c, n = 14) {
  let s = 0;
  let cnt = 0;
  for (let i = Math.max(1, c.length - n); i < c.length; i++) {
    s += Math.max(c[i].high - c[i].low, Math.abs(c[i].high - c[i - 1].close), Math.abs(c[i].low - c[i - 1].close));
    cnt++;
  }
  return cnt ? s / cnt : 0;
}

// 壓力與支撐（區間版）：
// 1. 在最近 win 根 K 棒找轉折高低點（左右各 k 根都不超過它）
// 2. 價格相近的轉折點合併成一個區間（容許差距：1.2% 或 0.6 倍平均真實波幅，取大者），轉折點越多代表這個價位被測試越多次
// 3. 與現價距離 0.6% 以內的不列入，避免剛跌破又出現一道緊貼的支撐
// 4. 上下各列兩道：res、res2、sup、sup2，附區間上下緣與測試次數
export function levels(candles, k, win) {
  const n = candles.length;
  const empty = { res: null, sup: null, res2: null, sup2: null };
  if (n < 3) return empty;
  const start = Math.max(0, n - win);
  const last = candles[n - 1].close;
  const a = atr(candles);
  const tol = Math.max(last * 0.012, a * 0.6);
  const minDist = last * 0.006;
  const piv = [];
  for (let i = start + k; i <= n - 1 - k; i++) {
    let isHigh = true;
    let isLow = true;
    for (let j = i - k; j <= i + k; j++) {
      if (j === i) continue;
      if (candles[j].high > candles[i].high) isHigh = false;
      if (candles[j].low < candles[i].low) isLow = false;
    }
    if (isHigh) piv.push({ p: candles[i].high, t: candles[i].time });
    if (isLow) piv.push({ p: candles[i].low, t: candles[i].time });
  }
  piv.sort((x, y) => x.p - y.p);
  const zones = [];
  for (const v of piv) {
    const z = zones[zones.length - 1];
    // 區間寬度最多 2 倍容許差距，避免價格一路相近就串成一大段
    if (z && v.p - z.hi <= tol && v.p - z.lo <= tol * 2) {
      z.sum += v.p;
      z.touches++;
      z.hi = v.p;
      if (v.t > z.time) z.time = v.t;
    } else zones.push({ lo: v.p, hi: v.p, sum: v.p, touches: 1, time: v.t });
  }
  // 區間完全在現價上方取中點為壓力、下方取中點為支撐；現價正好落在區間內時，區間上緣是壓力、下緣是支撐
  const above = [];
  const below = [];
  for (const z of zones) {
    const mid = z.sum / z.touches;
    const base = { lo: z.lo, hi: z.hi, touches: z.touches, time: z.time };
    if (z.lo > last) above.push({ ...base, price: mid > last + minDist ? mid : z.hi });
    else if (z.hi < last) below.push({ ...base, price: mid < last - minDist ? mid : z.lo });
    else {
      above.push({ ...base, price: z.hi });
      below.push({ ...base, price: z.lo });
    }
  }
  for (let i = above.length - 1; i >= 0; i--) if (above[i].price <= last + minDist) above.splice(i, 1);
  for (let i = below.length - 1; i >= 0; i--) if (below[i].price >= last - minDist) below.splice(i, 1);
  above.sort((x, y) => x.price - y.price);
  below.sort((x, y) => y.price - x.price);
  const slice = candles.slice(start);
  if (!above.length) {
    const m = slice.reduce((x, y) => (y.high > x.high ? y : x));
    if (m.high > last + minDist) above.push({ price: m.high, lo: m.high, hi: m.high, touches: 1, time: m.time });
  }
  if (!below.length) {
    const m = slice.reduce((x, y) => (y.low < x.low ? y : x));
    if (m.low < last - minDist) below.push({ price: m.low, lo: m.low, hi: m.low, touches: 1, time: m.time });
  }
  const pack = (z) => (z ? { price: z.price, lo: z.lo, hi: z.hi, touches: z.touches, time: z.time } : null);
  return { res: pack(above[0]), res2: pack(above[1]), sup: pack(below[0]), sup2: pack(below[1]) };
}

// 跌破支撐／突破壓力：價位至少被測試 2 次，且收盤穿越 1% 以上，前一天還在另一側
// （只要碰到就算的話，大約每週都會出現一次，沒有參考價值）
export function isBreak(c, p, z, dir) {
  if (!z || z.touches < 2) return false;
  return dir < 0 ? c.close < z.price * 0.99 && p.close >= z.price : c.close > z.price * 1.01 && p.close <= z.price;
}

// 突破：收盤站上前 look 根最高點且成交量大於前 look 根均量 volMult 倍。
// 跌破：收盤跌破前 look 根最低點。連續觸發只標第一根。
export function breakouts(candles, look, volMult = 1.3) {
  const out = [];
  let prevUp = false;
  let prevDown = false;
  for (let i = look; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    let vol = 0;
    for (let j = i - look; j < i; j++) {
      hi = Math.max(hi, candles[j].high);
      lo = Math.min(lo, candles[j].low);
      vol += candles[j].volume;
    }
    const c = candles[i];
    const up = c.close > hi && c.volume > (vol / look) * volMult;
    const down = c.close < lo;
    if (up && !prevUp) out.push({ time: c.time, type: 'up', price: hi });
    if (down && !prevDown) out.push({ time: c.time, type: 'down', price: lo });
    prevUp = up;
    prevDown = down;
  }
  return out;
}

export const PERIODS = {
  d: { label: '日K', ma: [5, 20, 60], k: 3, win: 120, look: 20, show: 70, lookText: '前 20 日' },
  w: { label: '週K', ma: [5, 10, 20], k: 2, win: 104, look: 10, show: 60, lookText: '前 10 週' },
  m: { label: '月K', ma: [3, 6, 12], k: 2, win: 36, look: 6, show: 26, lookText: '前 6 個月' },
};

// 三大法人每日淨買賣（張）
export function instDaily(rows) {
  const map = new Map();
  for (const r of rows) {
    let e = map.get(r.date);
    if (!e) map.set(r.date, (e = { date: r.date, foreign: 0, trust: 0, dealer: 0 }));
    const net = (r.buy - r.sell) / 1000;
    if (r.name.startsWith('Foreign')) e.foreign += net;
    else if (r.name === 'Investment_Trust') e.trust += net;
    else if (r.name.startsWith('Dealer')) e.dealer += net;
  }
  return [...map.values()]
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .map((e) => {
      const f = Math.round(e.foreign);
      const t = Math.round(e.trust);
      const d = Math.round(e.dealer);
      return { date: e.date, foreign: f, trust: t, dealer: d, total: f + t + d };
    });
}

// 從最後一筆往回數連續同方向的筆數
export function streak(values) {
  const n = values.length;
  if (!n) return { n: 0, dir: 0 };
  const dir = Math.sign(values[n - 1]);
  if (dir === 0) return { n: 0, dir: 0 };
  let c = 0;
  for (let i = n - 1; i >= 0 && Math.sign(values[i]) === dir; i--) c++;
  return { n: c, dir };
}

export function revenueSeries(rows) {
  const byKey = new Map(rows.map((r) => [r.y * 100 + r.m, r.revenue]));
  const keys = [...byKey.keys()].sort((a, b) => a - b);
  return keys
    .map((k) => {
      const prev = byKey.get(k - 100);
      const v = byKey.get(k);
      return { key: k, label: Math.floor(k / 100) + '/' + String(k % 100).padStart(2, '0'), revenue: v, yoy: prev ? (v / prev - 1) * 100 : null };
    })
    .slice(-12);
}

export function priceDigits(p) {
  return p >= 1000 ? 0 : p >= 100 ? 1 : 2;
}

// 綜合分析：給畫面與背景通知共用
export function analyze(data) {
  const { candles: daily, exDiv } = adjustDividends(toCandles(data.price || []), data.div || []);
  const n = daily.length;
  if (n < 2) return { empty: true, daily, signals: [] };
  const last = daily[n - 1];
  const prev = daily[n - 2];
  const chg = last.close - prev.close;
  const pct = (chg / prev.close) * 100;
  const signals = [];

  const ma20 = sma(daily, 20);
  if (ma20.length >= 2) {
    const m = ma20[ma20.length - 1].value;
    const mp = ma20[ma20.length - 2].value;
    if (last.close > m && prev.close <= mp) signals.push({ t: '今日站上月線', d: 1, kind: 'event', key: 'ma20up' });
    else if (last.close < m && prev.close >= mp) signals.push({ t: '今日跌破月線', d: -1, kind: 'event', key: 'ma20down' });
  }
  if (n > 21) {
    const avg = daily.slice(n - 21, n - 1).reduce((t, x) => t + x.volume, 0) / 20;
    if (avg > 0 && last.volume >= avg * 1.5) signals.push({ t: '量能放大 ' + (last.volume / avg).toFixed(1) + ' 倍', d: 0, kind: 'event', key: 'volume' });
  }
  const bk = breakouts(daily, PERIODS.d.look);
  const lb = bk[bk.length - 1];
  if (lb && lb.time === last.time) signals.push(lb.type === 'up' ? { t: '帶量突破 20 日高點', d: 1, kind: 'event', key: 'breakup' } : { t: '跌破 20 日低點', d: -1, kind: 'event', key: 'breakdown' });
  if (n >= 60) {
    const w = daily.slice(n - 60);
    if (last.high >= Math.max(...w.map((x) => x.high))) signals.push({ t: '創 60 日新高', d: 1, kind: 'event', key: 'high60' });
    else if (last.low <= Math.min(...w.map((x) => x.low))) signals.push({ t: '創 60 日新低', d: -1, kind: 'event', key: 'low60' });
  }

  // 前一天的支撐壓力被今天收盤突破或跌破
  const prevLv = levels(daily.slice(0, -1), PERIODS.d.k, PERIODS.d.win);
  const dg = priceDigits(last.close);
  if (isBreak(last, prev, prevLv.sup, -1)) signals.push({ t: `跌破支撐 ${prevLv.sup.price.toFixed(dg)}（測試 ${prevLv.sup.touches} 次）`, d: -1, key: 'supbreak', kind: 'event' });
  if (isBreak(last, prev, prevLv.res, 1)) signals.push({ t: `突破壓力 ${prevLv.res.price.toFixed(dg)}（測試 ${prevLv.res.touches} 次）`, d: 1, key: 'resbreak', kind: 'event' });
  const lvNow = levels(daily, PERIODS.d.k, PERIODS.d.win);

  const inst = instDaily(data.inst || []);
  const fs = streak(inst.map((x) => x.foreign));
  // 連買連賣剛滿 3 天算今日新訊號，之後算持續狀態
  if (fs.n >= 3) signals.push({ t: (fs.n === 3 ? '外資轉為連 3 ' : '外資連 ' + fs.n + ' ') + (fs.dir > 0 ? '買' : '賣'), d: fs.dir, kind: fs.n === 3 ? 'event' : 'state', key: 'inst' });
  const ts = streak(inst.map((x) => x.trust));
  if (ts.n >= 3) signals.push({ t: (ts.n === 3 ? '投信轉為連 3 ' : '投信連 ' + ts.n + ' ') + (ts.dir > 0 ? '買' : '賣'), d: ts.dir, kind: ts.n === 3 ? 'event' : 'state', key: 'inst' });

  const mg = data.margin || [];
  let margin = null;
  if (mg.length) {
    const lm = mg[mg.length - 1];
    const ref = mg[Math.max(0, mg.length - 6)];
    const finChg = ref.fin ? ((lm.fin - ref.fin) / ref.fin) * 100 : null;
    margin = { date: lm.date, fin: lm.fin, short: lm.short, finChg, ratio: lm.fin ? (lm.short / lm.fin) * 100 : null };
    if (finChg !== null && Math.abs(finChg) >= 5) signals.push({ t: '融資 5 日' + (finChg > 0 ? '增 ' : '減 ') + Math.abs(finChg).toFixed(1) + '%', d: finChg > 0 ? -1 : 0, kind: 'state' });
  }

  const revenue = revenueSeries(data.revenue || []);
  const ys = streak(revenue.filter((r) => r.yoy !== null).map((r) => r.yoy));
  if (ys.n >= 3) signals.push({ t: '營收連 ' + ys.n + ' 月年' + (ys.dir > 0 ? '增' : '減'), d: ys.dir, kind: 'state' });

  const ex = exDiv.find((e) => e.time === last.time);
  if (ex) signals.push({ t: '今日除' + (ex.cash ? '息 ' + ex.cash.toFixed(2) + ' 元' : '權'), d: 0, kind: 'event', key: 'exdiv' });

  const ps = streak(daily.slice(1).map((x, i) => x.close - daily[i].close));

  return {
    empty: false,
    daily,
    last,
    prev,
    chg,
    pct,
    priceStreak: ps,
    signals,
    events: signals.filter((x) => x.kind === 'event'),
    states: signals.filter((x) => x.kind !== 'event'),
    exDiv,
    inst: inst.slice(-10),
    margin,
    revenue,
    revenueStreak: ys,
    per: data.per,
    valuation: valuation(data.perHist || []),
    levels: lvNow,
    news: data.news || [],
  };
}

// 估值位置：目前本益比、股價淨值比在近三年的百分位（0 = 最低，100 = 最高）
export function valuation(rows) {
  const pick = (k) => {
    const vals = rows.map((r) => r[k]).filter((v) => v > 0);
    if (vals.length < 60) return null;
    const cur = vals[vals.length - 1];
    const sorted = vals.slice().sort((a, b) => a - b);
    const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * (sorted.length - 1)))];
    return { cur, pct: (sorted.filter((v) => v <= cur).length / sorted.length) * 100, min: sorted[0], q1: q(0.25), med: q(0.5), q3: q(0.75), max: sorted[sorted.length - 1], from: rows[0][0] };
  };
  return { per: pick(1), pbr: pick(2) };
}

// ---------- 技術指標 ----------
// KD（台股慣用 9,3,3）
export function kd(c, n = 9) {
  let K = 50;
  let D = 50;
  const out = [];
  for (let i = 0; i < c.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) { hi = Math.max(hi, c[j].high); lo = Math.min(lo, c[j].low); }
    const rsv = hi > lo ? ((c[i].close - lo) / (hi - lo)) * 100 : 50;
    K = (K * 2) / 3 + rsv / 3;
    D = (D * 2) / 3 + K / 3;
    if (i >= n - 1) out.push({ time: c[i].time, k: K, d: D });
  }
  return out;
}

// RSI（Wilder 平滑）
export function rsi(c, n) {
  const out = [];
  let up = 0;
  let dn = 0;
  for (let i = 1; i < c.length; i++) {
    const ch = c[i].close - c[i - 1].close;
    const u = Math.max(ch, 0);
    const d = Math.max(-ch, 0);
    if (i <= n) {
      up += u / n;
      dn += d / n;
      if (i < n) continue;
    } else {
      up = (up * (n - 1) + u) / n;
      dn = (dn * (n - 1) + d) / n;
    }
    out.push({ time: c[i].time, value: dn === 0 ? 100 : 100 - 100 / (1 + up / dn) });
  }
  return out;
}

function ema(vals, n) {
  const k = 2 / (n + 1);
  const out = [];
  let e = null;
  for (let i = 0; i < vals.length; i++) {
    if (vals[i] == null) { out.push(null); continue; }
    e = e == null ? vals[i] : vals[i] * k + e * (1 - k);
    out.push(e);
  }
  return out;
}

// MACD（12,26,9）：DIF、MACD（訊號線）、OSC（柱狀）
export function macd(c, f = 12, sl = 26, sig = 9) {
  const cl = c.map((x) => x.close);
  const ef = ema(cl, f);
  const es = ema(cl, sl);
  const dif = cl.map((_, i) => (i >= sl - 1 ? ef[i] - es[i] : null));
  const dea = ema(dif, sig);
  const out = [];
  let cnt = 0;
  for (let i = 0; i < c.length; i++) {
    if (dif[i] == null) continue;
    if (++cnt < sig) continue;
    out.push({ time: c[i].time, dif: dif[i], macd: dea[i], osc: dif[i] - dea[i] });
  }
  return out;
}

// 下週波動區間：近 20 日對數報酬標準差 × √5，約 68% 機率落在範圍內（不是方向預測）
export function weekBand(daily) {
  const rets = daily.slice(-21).map((x, i, arr) => (i ? Math.log(x.close / arr[i - 1].close) : null)).filter((x) => x != null);
  if (rets.length < 5) return null;
  const mean = rets.reduce((s, x) => s + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((s, x) => s + (x - mean) ** 2, 0) / (rets.length - 1));
  const close = daily[daily.length - 1].close;
  const band = sd * Math.sqrt(5);
  return { close, low: close * Math.exp(-band), high: close * Math.exp(band), date: daily[daily.length - 1].time };
}

export function weekKeyOf(t) {
  const d = new Date(t + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

// ---------- 訊號的歷史表現 ----------
// 在這檔股票過去約兩年的（已還原）日 K 上，找出每種訊號出現的日子，統計之後 5 日、20 日的漲跌。
export const SIGNAL_NAMES = {
  ma20up: '站上月線', ma20down: '跌破月線', volume: '量能放大 1.5 倍', breakup: '帶量突破 20 日高點', breakdown: '跌破 20 日低點',
  high60: '創 60 日新高', low60: '創 60 日新低', supbreak: '跌破支撐', resbreak: '突破壓力',
};
export function signalHistory(daily) {
  const n = daily.length;
  const hits = {};
  const add = (key, i) => {
    if (i + 5 >= n) return;
    (hits[key] = hits[key] || []).push({
      time: daily[i].time,
      f5: (daily[i + 5].close / daily[i].close - 1) * 100,
      f20: i + 20 < n ? (daily[i + 20].close / daily[i].close - 1) * 100 : null,
    });
  };
  const ma = new Array(n).fill(null);
  let s = 0;
  for (let i = 0; i < n; i++) {
    s += daily[i].close;
    if (i >= 20) s -= daily[i - 20].close;
    if (i >= 19) ma[i] = s / 20;
  }
  const bk = breakouts(daily, PERIODS.d.look);
  const up = new Set(bk.filter((b) => b.type === 'up').map((b) => b.time));
  const dn = new Set(bk.filter((b) => b.type === 'down').map((b) => b.time));
  for (let i = 60; i < n - 5; i++) {
    const c = daily[i];
    const p = daily[i - 1];
    if (ma[i] != null && ma[i - 1] != null) {
      if (c.close > ma[i] && p.close <= ma[i - 1]) add('ma20up', i);
      else if (c.close < ma[i] && p.close >= ma[i - 1]) add('ma20down', i);
    }
    let v = 0;
    for (let j = i - 20; j < i; j++) v += daily[j].volume;
    if (v > 0 && c.volume >= (v / 20) * 1.5) add('volume', i);
    if (up.has(c.time)) add('breakup', i);
    if (dn.has(c.time)) add('breakdown', i);
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - 59; j <= i; j++) { hi = Math.max(hi, daily[j].high); lo = Math.min(lo, daily[j].low); }
    if (c.high >= hi) add('high60', i);
    else if (c.low <= lo) add('low60', i);
    const lv = levels(daily.slice(0, i), PERIODS.d.k, PERIODS.d.win);
    if (isBreak(c, p, lv.sup, -1)) add('supbreak', i);
    if (isBreak(c, p, lv.res, 1)) add('resbreak', i);
  }
  const out = {};
  for (const [key, list] of Object.entries(hits)) {
    const f20 = list.filter((x) => x.f20 != null);
    out[key] = {
      n: list.length,
      avg5: list.reduce((t, x) => t + x.f5, 0) / list.length,
      up5: list.filter((x) => x.f5 > 0).length,
      n20: f20.length,
      avg20: f20.length ? f20.reduce((t, x) => t + x.f20, 0) / f20.length : null,
      from: daily[60]?.time,
    };
  }
  return out;
}

// ---------- 自訂價位提醒 ----------
// alert：{ above, below }。今天收盤剛穿越算新訊號；之前已穿越、仍在提醒價之外算持續狀態。
export function alertSignals(a, alert) {
  const ev = [];
  const st = [];
  if (!a || a.empty || !alert) return { events: ev, states: st };
  const dg = priceDigits(a.last.close);
  const c = a.last.close;
  const p = a.prev.close;
  if (alert.below > 0) {
    if (c < alert.below && p >= alert.below) ev.push({ t: '跌破提醒價 ' + alert.below.toFixed(dg), d: -1, kind: 'event', key: 'alert' });
    else if (c < alert.below) st.push({ t: '低於提醒價 ' + alert.below.toFixed(dg), d: -1, kind: 'state' });
  }
  if (alert.above > 0) {
    if (c > alert.above && p <= alert.above) ev.push({ t: '突破提醒價 ' + alert.above.toFixed(dg), d: 1, kind: 'event', key: 'alert' });
    else if (c > alert.above) st.push({ t: '高於提醒價 ' + alert.above.toFixed(dg), d: 1, kind: 'state' });
  }
  return { events: ev, states: st };
}

// ---------- 季財報 ----------
// rows：FinMind 綜合損益表（每季一組 type/value）。回傳最近 8 季：營收、毛利率、營益率、EPS，以及 EPS 年增
export function quarterly(rows) {
  const by = new Map();
  for (const r of rows) {
    const q = by.get(r.date) || {};
    const t = r.type || '';
    const nm = r.name || '';
    if (t === 'Revenue' || /^營業收入/.test(nm)) q.rev = q.rev ?? r.value;
    if (t === 'GrossProfit' || /^營業毛利/.test(nm)) q.gp = q.gp ?? r.value;
    if (t === 'OperatingIncome' || /^營業利益/.test(nm)) q.op = q.op ?? r.value;
    if (t === 'EPS' || /^基本每股盈餘/.test(nm)) q.eps = q.eps ?? r.value;
    by.set(r.date, q);
  }
  const list = [...by.entries()]
    .filter(([, q]) => q.eps != null)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([date, q]) => {
      const m = Number(date.slice(5, 7));
      return { date, label: `${date.slice(2, 4)}Q${Math.ceil(m / 3)}`, eps: q.eps, rev: q.rev ?? null, gm: q.rev && q.gp != null ? (q.gp / q.rev) * 100 : null, om: q.rev && q.op != null ? (q.op / q.rev) * 100 : null };
    });
  list.forEach((q, i) => { const ly = list[i - 4]; q.epsYoy = ly && ly.eps ? ((q.eps - ly.eps) / Math.abs(ly.eps)) * 100 : null; });
  return list.slice(-8);
}

// ---------- 訊號可信度 ----------
// 每個訊號在這檔股票過去約兩年出現後 5 日的方向是否符合（看多訊號要漲、看空訊號要跌）。
// 至少 10 次才判斷：≥55% 有效、≤45% 無效，其餘「沒有明顯方向」。
export const SIGNAL_DIR = { ma20up: 1, ma20down: -1, breakup: 1, breakdown: -1, high60: 1, low60: -1, supbreak: -1, resbreak: 1 };
export const REL_MIN_N = 10;
export function signalReliability(daily) {
  const h = signalHistory(daily);
  const out = {};
  for (const [key, dir] of Object.entries(SIGNAL_DIR)) {
    const x = h[key];
    if (!x) { out[key] = { n: 0, rate: null, verdict: 'few' }; continue; }
    const rate = dir > 0 ? x.up5 / x.n : (x.n - x.up5) / x.n;
    out[key] = { n: x.n, rate, verdict: x.n < REL_MIN_N ? 'few' : rate >= 0.55 ? 'good' : rate <= 0.45 ? 'bad' : 'flat' };
  }
  return out;
}
// 這個訊號在本股歷史上「無效或沒有方向」：今日重點、通知與注意程度都不採用
export const weakSignal = (rel, e) => !!(rel && e.key && rel[e.key] && (rel[e.key].verdict === 'bad' || rel[e.key].verdict === 'flat'));

// 族群強弱與強勢股篩選（純計算）
// 題材族群為手動整理，成分股可在這裡增修；產業族群直接用官方產業分類。

export const THEMES = [
  { name: 'AI 伺服器', ids: ['2317', '2382', '3231', '6669', '2356', '2376', '2377', '3706', '2357', '8210', '3013', '2059'] },
  { name: 'ASIC / IP 設計服務', ids: ['3661', '3443', '3035', '3529', '6643', '6533'] },
  { name: '晶圓代工', ids: ['2330', '2303', '5347', '6770'] },
  { name: '封測 / 先進封裝', ids: ['3711', '2449', '6239', '3374', '6147', '8150', '6257', '3264'] },
  { name: '散熱', ids: ['3017', '3324', '3653', '2421', '6230', '3338', '8996', '6125'] },
  { name: '矽光子 / CPO', ids: ['3081', '3363', '3163', '4979', '6442', '3450', '4908', '3234', '2455'] },
  { name: 'PCB / CCL', ids: ['2383', '2368', '6274', '6213', '4958', '3037', '3044', '8046', '3189', '2313', '6269', '5469'] },
  { name: '記憶體', ids: ['2408', '2344', '2337', '8299', '3260', '4967', '3006', '8271', '2451'] },
  { name: '被動元件', ids: ['2327', '2492', '3026', '2472', '3152', '6173', '2478', '6449'] },
  { name: '手機零組件', ids: ['6732', '3227', '3008', '3406', '3545', '3673', '2474', '3376'] },
  { name: '耳機聲學', ids: ['6743', '2439', '6679'] },
  { name: '重電', ids: ['1519', '1503', '1513', '1514', '2371', '1504', '1609', '1605', '1608'] },
  { name: '機器人', ids: ['2049', '1590', '1597', '2359', '6188', '4583', '2365', '8374', '4562'] },
  { name: '航運', ids: ['2603', '2609', '2615', '2618', '2610', '2606', '2637', '5608', '2605'] },
  { name: '金融', ids: ['2881', '2882', '2891', '2885', '2886', '2884', '2892', '2880', '2883', '2887', '2890', '5880'] },
  { name: '營建', ids: ['2548', '5534', '2542', '2348', '2545', '2520', '2534', '1808', '2501', '5522', '2547', '9945'] },
];

export const SKIP_INDUSTRY = /電子工業|ETF|ETN|指數|受益|存託|權證|大盤|所有證券|創新板|其他$/;

// 產業族群：每檔取第一個具體產業分類，成分 5 檔以上才列入
export function industryGroups(info, ids) {
  const g = new Map();
  for (const id of ids) {
    const cat = (info[id]?.industries || []).find((c) => !SKIP_INDUSTRY.test(c));
    if (!cat) continue;
    if (!g.has(cat)) g.set(cat, []);
    g.get(cat).push(id);
  }
  return [...g.entries()].filter(([, v]) => v.length >= 5).map(([name, v]) => ({ name, ids: v }));
}

// 由每日報酬（已排除除權息）往回推出還原收盤序列，最新一天等於實際收盤
export function adjSeries(market, id, end = market.dates.length - 1) {
  const P = market.prices;
  const last = P[end]?.[id];
  if (!last) return null;
  const out = new Array(end + 1).fill(null);
  let c = last[0];
  out[end] = c;
  for (let i = end; i > 0; i--) {
    const r = P[i][id]?.[2] ?? 0;
    c = c / (1 + r);
    out[i - 1] = c;
  }
  return out;
}

// 給關聯脈絡用的收盤序列 [[date, close], ...]
export function marketSeries(market, id) {
  const adj = adjSeries(market, id);
  return adj ? market.dates.map((d, i) => [d, adj[i]]).filter((x) => x[1] > 0) : null;
}

// 個股指標，end 為以哪一天為基準（預設最後一天），可往前推算上週
export function metrics(market, id, end = market.dates.length - 1) {
  const P = market.prices;
  const c = P[end]?.[id];
  if (!c) return null;
  const adj = adjSeries(market, id, end);
  const ret = (n) => (end - n >= 0 && adj[end - n] ? (adj[end] / adj[end - n] - 1) * 100 : null);
  let ma = null;
  let vr = null;
  if (end >= 20) {
    let s = 0;
    for (let i = end - 19; i <= end; i++) s += adj[i];
    ma = s / 20;
    let v = 0;
    let cnt = 0;
    for (let i = end - 20; i < end; i++) if (P[i]?.[id]) { v += P[i][id][1]; cnt++; }
    vr = cnt && v ? c[1] / (v / cnt) : null;
  }
  // 漲跌（元）：今日用交易所漲跌；5 日、20 日用還原價換算回目前價位
  const amt = (n) => (end - n >= 0 && adj[end - n] ? c[0] - (c[0] * adj[end - n]) / adj[end] : null);
  const d1 = Number.isFinite(c[2]) ? c[0] - c[0] / (1 + c[2]) : null;
  return { id, close: c[0], vol: c[1], r1: ret(1), r5: ret(5), r20: ret(20), d1, d5: amt(5), d20: amt(20), ma20: ma, aboveMA: ma != null ? c[0] > ma : null, vr };
}

// 外資連買天數（正數連買、負數連賣）
export function foreignStreak(market, id) {
  const v = market.inst.map((d) => d[id]).filter((x) => x != null);
  if (!v.length || v[v.length - 1] === 0) return 0;
  const dir = Math.sign(v[v.length - 1]);
  let n = 0;
  for (let i = v.length - 1; i >= 0 && Math.sign(v[i]) === dir; i--) n++;
  return n * dir;
}

// 同業：同一題材族群加上同一官方產業的所有股票，算漲跌、量比、外資與相關係數
export function peers(market, info, id) {
  const last = market.prices[market.prices.length - 1] || {};
  const ids = Object.keys(last);
  const sources = [];
  const set = new Set();
  const themed = new Set();
  for (const t of THEMES) if (t.ids.includes(id)) { sources.push(t.name); t.ids.forEach((x) => { set.add(x); themed.add(x); }); }
  for (const g of industryGroups(info, ids)) if (g.ids.includes(id)) { sources.push(g.name); g.ids.forEach((x) => set.add(x)); }
  set.add(id);
  // 每日報酬（已排除除權息），當天沒交易記為 null
  const ret = (pid) => {
    const out = [];
    for (let i = 1; i < market.prices.length; i++) {
      const b = market.prices[i][pid];
      out.push(b && market.prices[i - 1][pid] ? b[2] ?? null : null);
    }
    return out;
  };
  const base = ret(id);
  const corrWith = (r) => {
    const pairs = [];
    for (let i = 0; i < base.length; i++) if (base[i] != null && r[i] != null) pairs.push([base[i], r[i]]);
    if (pairs.length < 20) return null;
    const n = pairs.length;
    const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
    let c = 0, vx = 0, vy = 0;
    for (const [x, y] of pairs) { c += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; }
    return vx && vy ? c / Math.sqrt(vx * vy) : null;
  };
  const rows = [...set].map((pid) => {
    const m = metrics(market, pid);
    if (!m) return null;
    return { ...m, name: info[pid]?.name || pid, fs: foreignStreak(market, pid), corr: pid === id ? 1 : corrWith(ret(pid)), self: pid === id, themed: themed.has(pid) };
  }).filter(Boolean);
  return { sources, rows, days: base.filter((x) => x != null).length };
}

const avg = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

export function sectorTable(market, groups, info, end) {
  return groups
    .map((g) => {
      const members = g.ids.map((id) => {
        const m = metrics(market, id, end);
        return m && { ...m, name: info[id]?.name || id, fs: end == null || end === market.dates.length - 1 ? foreignStreak(market, id) : 0 };
      }).filter(Boolean);
      if (members.length < 2) return null;
      const pick = (k) => avg(members.map((m) => m[k]).filter((x) => x != null));
      return { name: g.name, members, r1: pick('r1'), r5: pick('r5'), r20: pick('r20'), up: members.filter((m) => m.r1 > 0).length };
    })
    .filter(Boolean);
}

export function rankBy(sectors, key) {
  return sectors.filter((s) => s[key] != null).slice().sort((a, b) => b[key] - a[key]);
}

// 強勢股篩選：前 3 強族群（5 日）中，站上 20 日線、量比 1.5 倍以上、外資連 2 日以上買超
export const SCREEN = { topN: 3, vr: 1.5, fs: 2 };
export function screen(sectors) {
  const top = rankBy(sectors, 'r5').slice(0, SCREEN.topN);
  const picks = [];
  const near = [];
  for (const s of top) {
    for (const m of s.members) {
      const checks = [
        { ok: m.aboveMA === true, t: '站上 20 日線' },
        { ok: m.vr != null && m.vr >= SCREEN.vr, t: '量比 ' + (m.vr == null ? '–' : m.vr.toFixed(1)) + ' 倍' },
        { ok: m.fs >= SCREEN.fs, t: m.fs > 0 ? '外資連 ' + m.fs + ' 買' : m.fs < 0 ? '外資連 ' + -m.fs + ' 賣' : '外資無連買' },
      ];
      const passed = checks.filter((c) => c.ok).length;
      const row = { ...m, sector: s.name, checks };
      if (passed === 3 && m.r5 > 0) picks.push(row);
      else if (passed === 2 && m.r5 > 0) near.push(row);
    }
  }
  picks.sort((a, b) => b.r5 - a.r5);
  near.sort((a, b) => b.r5 - a.r5);
  return { top: top.map((s) => s.name), picks, near };
}

// 集保股權分散表（每週一次，通常週五晚間公布最新一週）。
// 公開資料只提供最新一週，所以每週存一份，累積出趨勢。
// 持股分級：1-8 未滿 50 張，9-11 為 50 到 400 張，12-14 為 400 到 1000 張，15 為 1000 張以上，17 為合計。
const URL_TDCC = 'https://opendata.tdcc.com.tw/getOD.ashx?id=1-5';
const KEEP_WEEKS = 26;
const DAY = 86400000;

function parse(csv) {
  const out = {};
  let date = null;
  const lines = csv.split(/\r?\n/);
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < 6) continue;
    const id = c[1].trim();
    if (!/^[1-9]\d{3}$/.test(id)) continue;
    date = date || c[0];
    const lv = Number(c[2]);
    const pct = Number(c[5]);
    const e = out[id] || (out[id] = { big: 0, b400: 0, small: 0, people: 0 });
    if (lv === 15) e.big = pct;
    if (lv >= 12 && lv <= 15) e.b400 += pct;
    if (lv >= 1 && lv <= 8) e.small += pct;
    if (lv === 17) e.people = Number(c[3]);
  }
  for (const e of Object.values(out)) {
    e.b400 = Math.round(e.b400 * 100) / 100;
    e.small = Math.round(e.small * 100) / 100;
  }
  const iso = date ? `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}` : null;
  return { date: iso, data: out };
}

// 回傳 { weeks: [date...], data: { date: { id: {...} } } }
export async function loadShareholding({ force = false } = {}) {
  const { tdcc } = await chrome.storage.local.get('tdcc');
  const store = tdcc || { fetchedAt: 0, data: {} };
  if (force || Date.now() - store.fetchedAt > DAY) {
    try {
      const r = await fetch(URL_TDCC, { cache: 'no-store' });
      if (r.ok) {
        const { date, data } = parse(await r.text());
        if (date) store.data[date] = data;
        const keep = Object.keys(store.data).sort().slice(-KEEP_WEEKS);
        for (const d of Object.keys(store.data)) if (!keep.includes(d)) delete store.data[d];
        store.fetchedAt = Date.now();
        await chrome.storage.local.set({ tdcc: store });
      }
    } catch (e) {
      if (!tdcc) throw new Error('集保資料暫時連不上');
    }
  }
  return { weeks: Object.keys(store.data).sort(), data: store.data };
}

export function holdingSeries(sh, id) {
  return sh.weeks.map((w) => ({ date: w, ...(sh.data[w][id] || {}) })).filter((x) => x.people);
}

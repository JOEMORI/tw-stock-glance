// 加權指數與櫃買指數：直接向證交所（MI_5MINS_HIST）、櫃買中心（indexInfo/inx）查本月與上月每日開高低收。
// 收盤後約 14:30 就有當天資料，不必等 FinMind（常到晚上才更新，也會被查詢上限擋住）。
const TTL = 10 * 60 * 1000;
const num = (s) => Number(String(s ?? '').replace(/,/g, ''));
const rocIso = (s) => { const [y, m, d] = String(s).split('/'); return `${Number(y) + 1911}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`; };

async function getJSON(url) {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

function months(n) {
  const out = [];
  const d = new Date(Date.now() + 8 * 3600000);
  d.setUTCDate(1);
  for (let i = 0; i < n; i++) { out.push([d.getUTCFullYear(), d.getUTCMonth() + 1]); d.setUTCMonth(d.getUTCMonth() - 1); }
  return out.reverse();
}

async function fetchMonth(id, y, m) {
  if (id === 'TAIEX') {
    const j = await getJSON(`https://www.twse.com.tw/rwd/zh/TAIEX/MI_5MINS_HIST?date=${y}${String(m).padStart(2, '0')}01&response=json`);
    return j.stat === 'OK' ? (j.data || []).map((r) => [rocIso(r[0]), num(r[1]), num(r[2]), num(r[3]), num(r[4])]) : [];
  }
  const j = await getJSON(`https://www.tpex.org.tw/www/zh-tw/indexInfo/inx?date=${y}%2F${String(m).padStart(2, '0')}%2F01&response=json`);
  return (j.tables?.[0]?.data || []).map((r) => [r[0].replaceAll('/', '-'), num(r[1]), num(r[2]), num(r[3]), num(r[4])]);
}

// 回傳 [[date, open, high, low, close]]（近兩個月）；失敗時回傳上次的快取或 null
export async function loadIndex(id, { force = false } = {}) {
  const key = 'idx:' + id;
  const { [key]: c } = await chrome.storage.local.get(key);
  if (!force && c && Date.now() - c.at < TTL) return c.rows;
  try {
    let rows = [];
    for (const [y, m] of months(2)) rows = rows.concat(await fetchMonth(id, y, m));
    rows = rows.filter((r) => r[4] > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    if (rows.length < 2) throw new Error('no data');
    await chrome.storage.local.set({ [key]: { at: Date.now(), rows } });
    return rows;
  } catch (e) {
    return c ? c.rows : null;
  }
}

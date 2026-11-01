// 外資持股（全體外資及陸資持有股數）：證交所 MI_QFIIS、櫃買中心 qfii，每天一次全市場，存最近一天。
// 投信與自營商的持股交易所不公布，只有每日買賣超。
const num = (v) => Number(String(v ?? '').replace(/[,%]/g, '')) || 0;
const KEY = 'qfii';

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchDay(date) {
  const out = {};
  let ok = 0;
  try {
  const tw = await getJSON(`https://www.twse.com.tw/rwd/zh/fund/MI_QFIIS?date=${date.replaceAll('-', '')}&selectType=ALLBUT0999&response=json`);
  if (tw.stat === 'OK') for (const r of tw.data || []) out[r[0]] = [Math.round(num(r[5]) / 1000), num(r[7]), Math.round(num(r[3]) / 1000)];
  if (tw.stat === 'OK') ok++;
  } catch (e) { /* 證交所暫時限流，下次再補 */ }
  await new Promise((res) => setTimeout(res, 1500));
  const [y, m, d] = date.split('-');
  try {
    const otc = await getJSON(`https://www.tpex.org.tw/www/zh-tw/insti/qfii?date=${encodeURIComponent(`${y}/${m}/${d}`)}&response=json`);
    const t = otc.tables && otc.tables[0];
    if (t && t.date === `${Number(y) - 1911}/${m}/${d}`) { for (const r of t.data || []) out[r[1]] = [Math.round(num(r[5]) / 1000), num(r[7]), Math.round(num(r[3]) / 1000)]; ok++; }
  } catch (e) { /* 同上 */ }
  return Object.keys(out).length > 100 ? { map: out, partial: ok < 2 } : null;
}

// date：要對應的交易日（通常是自選股最新資料日）。回傳 { date, map: { id: [外資持股張, 持股比率%, 發行張數] } }
export async function loadForeignHolding(date) {
  const { [KEY]: c } = await chrome.storage.local.get(KEY);
  if (c && (c.date > date || (c.date === date && !c.partial))) return c;
  try {
    const got = await fetchDay(date);
    if (!got) return c || null;
    const map = c && c.date === date ? { ...c.map, ...got.map } : got.map;
    const v = { date, map, partial: got.partial, prev: c && c.date < date ? c.map : c?.prev || null, prevDate: c && c.date < date ? c.date : c?.prevDate || null };
    await chrome.storage.local.set({ [KEY]: v });
    return v;
  } catch (e) {
    return c || null;
  }
}

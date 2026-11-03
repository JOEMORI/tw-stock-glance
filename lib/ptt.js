// PTT 股板討論（只在插件裡用，用你自己的網路連線；GitHub 雲端會被 PTT 擋）。
// 用 PTT 站內標題搜尋：每個題材查前兩個中文關鍵字與前兩檔成分股名稱，合併近 10 天的文章。快取 3 小時。
const BOARD = 'https://www.ptt.cc/bbs/Stock';
const TTL = 3 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pttSearchUrl = (q) => `${BOARD}/search?q=${encodeURIComponent(q)}`;

function parse(html) {
  const body = html.split('<div class="r-list-sep"></div>')[0];
  const out = [];
  for (const b of body.split('<div class="r-ent">').slice(1)) {
    const a = b.match(/<a href="(\/bbs\/Stock\/M\.[^"]+)">([^<]+)<\/a>/);
    const date = ((b.match(/class="date">\s*([^<]+)</) || [])[1] || '').trim();
    const push = ((b.match(/class="nrec">(?:<span[^>]*>)?([^<]*)/) || [])[1] || '').trim();
    if (a && date) out.push({ url: 'https://www.ptt.cc' + a[1], title: a[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"'), md: date, push });
  }
  return out;
}
// 「11/03」換成日期。搜尋結果會混到去年的文章，算出來比今天晚就是去年。
function toDate(md) {
  const now = new Date(Date.now() + 8 * 3600000);
  const today = now.toISOString().slice(0, 10);
  const [m, d] = md.split('/').map(Number);
  const f = (y) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  const y = now.getUTCFullYear();
  return f(y) > today ? f(y - 1) : f(y);
}
const daysAgo = (n) => new Date(Date.now() + 8 * 3600000 - n * 86400000).toISOString().slice(0, 10);

// defs：THEME_DEFS；names：{代號: 名稱}。回傳 { 題材: { n3, base, hot, posts:[{url,title,date,push}], q } }
export async function pttThemes(defs, names = {}, { force = false } = {}) {
  const { pttCache: c } = await chrome.storage.local.get('pttCache');
  if (!force && c && Date.now() - c.at < TTL) return c.data;
  const data = {};
  let ok = 0;
  const from = daysAgo(10), d3 = daysAgo(3);
  for (const t of defs) {
    const qs = [...t.zh.slice(0, 2), ...t.ids.slice(0, 2).map((id) => (names[id] || '').replace(/-KY$|\*$/, '')).filter((x) => x.length >= 2)];
    const seen = new Map();
    for (const q of qs) {
      try {
        const r = await fetch(pttSearchUrl(q), { cache: 'no-store' });
        if (r.ok) ok++;
        if (r.ok) for (const p of parse(await r.text())) { const date = toDate(p.md); if (date >= from && !seen.has(p.url)) seen.set(p.url, { ...p, date, q }); }
      } catch (e) { /* 略過 */ }
      await sleep(250);
    }
    const posts = [...seen.values()].sort((a, b) => (a.date < b.date ? 1 : -1));
    const n3 = posts.filter((p) => p.date > d3).length;
    const base = posts.filter((p) => p.date <= d3).length / 7;
    data[t.name] = { n3, base: Math.round(base * 100) / 100, hot: n3 >= 3 && n3 / 3 >= Math.max(0.5, base * 2), posts: posts.slice(0, 12), q: t.zh[0] };
  }
  if (!ok) throw new Error('PTT 連不上');
  await chrome.storage.local.set({ pttCache: { at: Date.now(), data } });
  return data;
}

// 每個交易日收盤後由 GitHub Actions 執行：抓全市場、不需個人資料的資料，輸出成靜態 JSON 給手機版讀取。
// 手機瀏覽器不能直接抓證交所開放資料、櫃買中心、集保（沒有開放跨網域），所以在這裡先抓好。
// 用法：node scripts/build-data.mjs <輸出資料夾> <快取檔>
import fs from 'node:fs';
import path from 'node:path';
import { installChrome } from './chrome-shim.mjs';

const OUT = process.argv[2] || '_site/data';
const CACHE = process.argv[3] || '.cache/store.json';
installChrome(CACHE);

const { ensureMarket, ensureDetail } = await import('../lib/market.js');
const { collectAnnouncements } = await import('../lib/announce.js');
const { collectConferences } = await import('../lib/conferences.js');
const { collectExRights } = await import('../lib/exright.js');
const { loadForeignHolding } = await import('../lib/qfii.js');
const { loadIndex } = await import('../lib/indexes.js');
const { initHolidays } = await import('../lib/holidays.js');
const { loadShareholding } = await import('../lib/tdcc.js');
const { buildIntel, fetchInsider } = await import('../lib/intel.js');
const { THEMES, sectorTable, rankBy, metrics } = await import('../lib/sectors.js');

fs.mkdirSync(path.join(OUT, 'anns'), { recursive: true });
const write = (name, obj) => fs.writeFileSync(path.join(OUT, name), JSON.stringify(obj));
const step = async (name, fn) => { const t = Date.now(); try { const r = await fn(); console.log(`✓ ${name} ${((Date.now() - t) / 1000).toFixed(1)}s`); return r; } catch (e) { console.log(`✗ ${name}: ${e.message}`); return null; } };

const holidays = await step('休市日', () => initHolidays());
const market = await step('全市場行情', () => ensureMarket({ onProgress: (t) => process.stdout.write('  ' + t + '\r') }));
const latest = market?.dates?.at(-1);
const detail = latest ? await step('最新一天明細', () => ensureDetail(latest)) : null;
const qfii = latest ? await step('外資持股', () => loadForeignHolding(latest)) : null;
const taiex = await step('加權指數', () => loadIndex('TAIEX', { force: true }));
const tpex = await step('櫃買指數', () => loadIndex('TPEx', { force: true }));
const anns = await step('公司公告', () => collectAnnouncements({ force: true }));
const insider = await step('內部人轉讓', () => fetchInsider());
const confs = await step('法說會', () => collectConferences({ force: true }));
const exr = await step('除權息預告', () => collectExRights({ force: true }));
const sh = await step('集保大戶', () => loadShareholding());

// 每檔近 20 日走勢（側欄迷你走勢、族群、漲跌拆解用）：只輸出收盤與報酬，縮小檔案
const closes = {};
if (market?.dates?.length) {
  const n = market.dates.length;
  const ids = Object.keys(market.prices[n - 1] || {});
  for (const id of ids) {
    const m = metrics(market, id);
    if (m) closes[id] = [m.close, round(m.r1), round(m.r5), round(m.r20), m.vr == null ? null : round(m.vr)];
  }
}
function round(v) { return v == null ? null : Math.round(v * 100) / 100; }
const themes = market?.dates?.length ? rankBy(sectorTable(market, THEMES, {}), 'r5').map((s) => ({ name: s.name, r1: round(s.r1), r5: round(s.r5), r20: round(s.r20), ids: s.members.map((m) => m.id) })) : [];
let up = 0, dn = 0, flat = 0;
for (const v of Object.values(market?.prices?.at(-1) || {})) { if (v[2] > 0) up++; else if (v[2] < 0) dn++; else flat++; }

write('latest.json', {
  builtAt: new Date().toISOString(), date: latest, holidays: holidays || {},
  index: { TAIEX: taiex || [], TPEx: tpex || [] },
  breadth: { up, dn, flat },
  detail: detail ? { date: detail.date, p: detail.p, i: detail.i, idx: detail.idx } : null,
  closes, themes,
  shares: Object.fromEntries(Object.entries(qfii?.map || {}).map(([id, v]) => [id, v[2]])),
  qfii: qfii ? { date: qfii.date, map: qfii.map } : null,
});

// 情報雷達：近 20 個公告日，不含個人關聯（手機自己依自選股標）
const shares = Object.fromEntries(Object.entries(qfii?.map || {}).map(([id, v]) => [id, v[2]]));
const names = {};
for (const [id, l] of Object.entries(anns || {})) names[id] = names[id] || id;
for (const x of insider || []) names[x.id] = x.name || names[x.id];
const intel = buildIntel({ anns: anns || {}, insider: insider || [], market, shares, names, keywords: [], links: {} });
write('intel.json', { builtAt: new Date().toISOString(), items: intel.map(({ b, ...x }) => ({ ...x, b: (b || '').slice(0, 1500) })) });

// 公告：每檔一個檔案，手機只抓自選股的
for (const f of fs.readdirSync(path.join(OUT, 'anns'))) fs.unlinkSync(path.join(OUT, 'anns', f));
for (const [id, l] of Object.entries(anns || {})) write(`anns/${id}.json`, l.map(({ at, ...x }) => x));
write('calendar.json', { confs: confs || {}, exr: exr || {} });
if (sh) write('tdcc.json', sh);
// 題材雷達（新聞、PTT、營收、籌碼、美股、異動、新族群）
const { themeRadar } = await import('./theme-radar.mjs');
const { getStockInfo } = await import('../lib/api.js');
// 快取遺失時（例如 GitHub 清掉），從上次發布的網站把歷史紀錄拿回來
if (!(await chrome.storage.local.get('tr:log'))['tr:log']) {
  try {
    const r = await fetch('https://joemori.github.io/tw-stock-glance/data/themes-log.json');
    if (r.ok) { const j = await r.json(); await chrome.storage.local.set({ 'tr:log': j.log || {}, 'tr:movers': j.movers || {} }); console.log('已從網站還原題材紀錄'); }
  } catch (e) { /* 第一次執行 */ }
}
if (market?.dates?.length) {
  const info = await step('股票名稱', () => getStockInfo());
  const names = Object.fromEntries(Object.entries(info || {}).map(([id, v]) => [id, v.name]));
  const tr = await step('題材雷達', () => themeRadar({ market, sh, names }));
  if (tr) {
    const used = new Set([...tr.themes.flatMap((t) => t.ids), ...tr.movers.map((x) => x.id), ...tr.clusters.flatMap((c) => c.ids)]);
    tr.names = Object.fromEntries([...used].map((id) => [id, names[id] || id]));
    write('themes.json', tr);
    const st = await chrome.storage.local.get(['tr:log', 'tr:movers']);
    write('themes-log.json', { log: st['tr:log'] || {}, movers: st['tr:movers'] || {} });
  }
}
console.log(`輸出完成：${latest}，${Object.keys(closes).length} 檔，情報 ${intel.length} 則`);

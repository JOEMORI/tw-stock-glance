// 公司重大訊息：證交所、櫃買中心每天公布的開放資料（與法說會同一份來源）。
// 開放資料只有最近一兩天，所以每次收集都累積存在本機，保留 45 天。
const SOURCES = [
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L', id: '公司代號' },
  { url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O', id: 'SecuritiesCompanyCode' },
];
const INTERVAL = 2 * 3600 * 1000;
const KEEP_DAYS = 45;

const roc = (s) => {
  const m = String(s || '').trim().match(/^(\d{2,3})(\d{2})(\d{2})$/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
};
const hm = (s) => { const t = String(s || '').trim().padStart(6, '0'); return `${t.slice(0, 2)}:${t.slice(2, 4)}`; };
const clean = (s) => String(s || '').replace(/\r?\n/g, '').replace(/\s+/g, ' ').trim();

// 回傳 { id: [{ d, t, s, b }] }，新到舊
export async function collectAnnouncements({ force = false } = {}) {
  const { anns = {}, annsAt = 0 } = await chrome.storage.local.get(['anns', 'annsAt']);
  if (!force && Date.now() - annsAt < INTERVAL) return anns;
  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url, { cache: 'no-store' });
      if (!r.ok) continue;
      for (const row of await r.json()) {
        const id = String(row[src.id] || '').trim();
        if (!/^\d{4}$/.test(id)) continue;
        const subjKey = Object.keys(row).find((k) => k.trim() === '主旨');
        const s = clean(row[subjKey]);
        const d = roc(row['發言日期']);
        if (!s || !d) continue;
        const list = anns[id] || (anns[id] = []);
        if (list.some((x) => x.d === d && x.s === s)) continue;
        // 情報雷達要解析金額的公告（處分、買回、私募、合約等）保留全文，其他只留前 600 字
        const full = /處分|出售|買回|庫藏|私募|增資|減資|公司債|合約|訂單|得標|承攬|更正|重編/.test(s);
        list.push({ d, t: hm(row['發言時間']), s: s.slice(0, 160), b: String(row['說明'] || '').trim().slice(0, full ? 3000 : 600), at: Date.now() });
      }
    } catch (e) {
      /* 單一來源失敗略過，下次再收 */
    }
  }
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const id of Object.keys(anns)) {
    anns[id] = anns[id].filter((x) => x.d >= cutoff).sort((x, y) => (x.d + x.t < y.d + y.t ? 1 : -1));
    if (!anns[id].length) delete anns[id];
  }
  await chrome.storage.local.set({ anns, annsAt: Date.now() });
  return anns;
}

// 自選股中，上次通知之後新收到的公告
export async function newAnnouncements(ids) {
  const anns = await collectAnnouncements({ force: true });
  const { annsNotified = 0 } = await chrome.storage.local.get('annsNotified');
  const out = [];
  for (const id of ids) for (const a of anns[id] || []) if (a.at > annsNotified) out.push({ id, ...a });
  await chrome.storage.local.set({ annsNotified: Date.now() });
  return annsNotified ? out : []; // 第一次啟用時不把舊公告當新的
}

// 除權息預告表：證交所（上市）與櫃買中心（上櫃）開放資料，公告後到除權息日之間都查得到。
// 比 FinMind 的股利資料更早出現新公告。可在 service worker 與頁面中使用。
const SOURCES = [
  { url: 'https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL', date: 'Date', id: 'Code', type: 'Exdividend', cash: 'CashDividend' },
  { url: 'https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost', date: 'ExRrightsExDividendDate', id: 'SecuritiesCompanyCode', type: 'ExRrightsExDividend', cash: 'CashDividend' },
];
const TTL = 12 * 3600 * 1000;
const roc = (s) => { const m = String(s || '').match(/^(\d{2,3})(\d{2})(\d{2})$/); return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null; };

export async function collectExRights({ force = false } = {}) {
  const { exr } = await chrome.storage.local.get('exr');
  if (!force && exr && Date.now() - exr.at < TTL) return exr.map;
  const map = {};
  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url, { cache: 'no-store' });
      if (!r.ok) continue;
      for (const row of await r.json()) {
        const id = String(row[src.id] || '').trim();
        const date = roc(row[src.date]);
        if (!/^\d{4}$/.test(id) || !date) continue;
        const t = String(row[src.type] || '');
        const cash = Number(row[src.cash]) || 0;
        (map[id] = map[id] || []).push({ date, type: /權息/.test(t) ? '除權息' : /權/.test(t) ? '除權' : '除息', cash });
      }
    } catch (e) {
      /* 單一來源失敗略過 */
    }
  }
  await chrome.storage.local.set({ exr: { at: Date.now(), map } });
  return map;
}

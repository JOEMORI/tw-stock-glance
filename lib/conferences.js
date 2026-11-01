// 台股法說會：證交所與櫃買中心每天公布的「重大訊息」開放資料中，挑出法人說明會公告。
// 開放資料只提供最近一兩天的公告，所以每天收集一次存在本機；公司通常在法說會前一到兩週公告。
// 可在 service worker 與頁面中使用（只用 fetch 與 JSON）。
const SOURCES = [
  { url: 'https://openapi.twse.com.tw/v1/opendata/t187ap04_L', id: '公司代號', subj: '主旨 ' },
  { url: 'https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap04_O', id: 'SecuritiesCompanyCode', subj: '主旨' },
];
const INTERVAL = 6 * 3600 * 1000;
const KEEP_DAYS = 60;

function rocToIso(s) {
  const m = String(s || '').match(/(\d{2,3})\/?(\d{2})\/?(\d{2})/);
  return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
}

function parse(row, src) {
  const subj = (row[src.subj] || row['主旨'] || '').trim();
  const body = row['說明'] || '';
  if (!/法人說明會|法說會/.test(subj + body.slice(0, 80))) return null;
  const dm = body.match(/法人說明會之日期[：:]\s*(\d{2,3}\/\d{2}\/\d{2})/);
  const date = rocToIso(dm ? dm[1] : row['事實發生日']);
  if (!date) return null;
  const tm = body.match(/時間[：:]\s*(\d{1,2})\s*時\s*(\d{1,2})?\s*分?/);
  const pm = body.match(/地點[：:]\s*([^\r\n]+)/);
  return {
    id: String(row[src.id] || '').trim(),
    date,
    time: tm ? `${tm[1].padStart(2, '0')}:${(tm[2] || '00').padStart(2, '0')}` : '',
    note: subj.replace(/^本公司/, '').slice(0, 50),
    place: pm ? pm[1].trim().slice(0, 40) : '',
  };
}

export async function collectConferences({ force = false } = {}) {
  const { confs = {}, confsAt = 0 } = await chrome.storage.local.get(['confs', 'confsAt']);
  if (!force && Date.now() - confsAt < INTERVAL) return confs;
  for (const src of SOURCES) {
    try {
      const r = await fetch(src.url, { cache: 'no-store' });
      if (!r.ok) continue;
      for (const row of await r.json()) {
        const c = parse(row, src);
        if (!c || !/^\d{4}$/.test(c.id)) continue;
        const list = confs[c.id] || (confs[c.id] = []);
        if (!list.some((x) => x.date === c.date)) list.push({ date: c.date, time: c.time, note: c.note, place: c.place });
      }
    } catch (e) {
      /* 單一來源失敗略過，下次再收 */
    }
  }
  const cutoff = new Date(Date.now() - KEEP_DAYS * 86400000).toISOString().slice(0, 10);
  for (const id of Object.keys(confs)) {
    confs[id] = confs[id].filter((x) => x.date >= cutoff);
    if (!confs[id].length) delete confs[id];
  }
  await chrome.storage.local.set({ confs, confsAt: Date.now() });
  return confs;
}

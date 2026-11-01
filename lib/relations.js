// 關聯脈絡：每檔股票的客戶、同業、競爭對手、美股指標與匯率。
// kind：tw 台股（含 TAIEX 加權指數）、us 美股、fx 匯率（USD = 美元兌台幣）
// 內建關聯依公司法說會與新聞整理（2026/10），可在速覽頁增刪。

const USD = { kind: 'fx', id: 'USD', name: '美元／台幣', q: '新台幣 匯率', rel: '匯率', why: '外銷營收以美元計，美元走強（台幣貶）有利換算營收；但台幣急貶也常伴隨外資賣超' };
const TAIEX = { kind: 'tw', id: 'TAIEX', name: '加權指數', q: '台股 加權指數', rel: '大盤', why: '大盤資金動能' };

export const BUILTIN = {
  '6743': [
    { kind: 'us', id: 'TBCH', name: 'Turtle Beach', q: 'Turtle Beach', kw: ['Turtle Beach'], rel: '客戶', why: '遊戲搖桿客戶，收購美國搖桿大廠 PDP 後由安普新承接訂單' },
    { kind: 'us', id: 'SONY', name: 'Sony', q: 'Sony 索尼', kw: ['Sony', '索尼', 'Audeze'], ctx: '耳機|Audeze|INZONE|電競|財報|營收|獲利|股價', rel: '客戶母公司', why: '旗下耳機品牌 Audeze 是安普新的客戶' },
    { kind: 'us', id: 'LOGI', name: 'Logitech', q: '羅技 Logitech', kw: ['Logitech', '羅技'], ctx: '財報|營收|獲利|股價|耳機|展望|關稅', events: [{ date: '2026-10-27', t: '第二季財報（FY2027）', note: '美股盤後公布，台股隔天反應', src: 'Logitech 官方公告' }], rel: '產業指標', why: '電競周邊龍頭，反映遊戲耳機終端需求' },
    { kind: 'tw', id: '2439', name: '美律', q: '美律 耳機', kw: ['美律'], rel: '台股同業', why: '耳機代工同業' },
    USD,
  ],
  '2348': [
    { kind: 'tw', id: '2548', name: '華固', q: '華固 建設', kw: ['華固'], rel: '營建同業', why: '同為不動產開發，反映房市氣氛' },
    { kind: 'tw', id: '2542', name: '興富發', q: '興富發', kw: ['興富發'], rel: '營建同業', why: '同為不動產開發，反映房市氣氛' },
    { kind: 'tw', id: '5534', name: '長虹', q: '長虹建設', kw: ['長虹建設', '長虹(5534)', '長虹 5534'], rel: '營建同業', why: '同為不動產開發，反映房市氣氛' },
    TAIEX,
  ],
  '6732': [
    { kind: 'tw', id: '3227', name: '原相', q: '原相 感測', kw: ['原相'], rel: '台股同業', why: '光學感測 IC 同業' },
    { kind: 'tw', id: '3008', name: '大立光', q: '大立光', kw: ['大立光'], rel: '手機供應鏈', why: '手機鏡頭龍頭，反映手機出貨景氣' },
    { kind: 'us', id: 'SOXX', name: '美股半導體 ETF', q: '費城半導體指數', rel: '產業指標', why: '美股半導體整體情緒' },
    USD,
  ],
  '3661': [
    { kind: 'us', id: 'AMZN', name: 'Amazon', q: 'AWS 亞馬遜 AI 晶片', kw: ['亞馬遜', 'Amazon', 'AWS', 'Trainium'], events: [{ date: '2026-10-29', t: '第三季財報', note: '美股盤後公布，台股隔天反應', src: 'Amazon 官方公告' }], rel: '主要客戶', why: 'AWS 自研 AI 晶片 Trainium 的後段設計由世芯負責，AWS 資本支出牽動訂單' },
    { kind: 'tw', id: '2330', name: '台積電', q: '台積電 CoWoS', kw: ['台積電', 'TSMC'], rel: '製造夥伴', why: '先進製程與 CoWoS 封裝產能影響出貨時程' },
    { kind: 'tw', id: '3443', name: '創意', q: '創意 ASIC', kw: ['創意電子', '創意(3443)', '創意 3443', 'GUC'], rel: '台股同業', why: 'ASIC 設計服務同族群，資金常同進同出' },
    { kind: 'us', id: 'MRVL', name: 'Marvell', q: 'Marvell 邁威爾', kw: ['Marvell', '邁威爾'], rel: '競爭對手', why: '同樣爭取雲端業者客製化 AI 晶片訂單' },
    { kind: 'us', id: 'AVGO', name: 'Broadcom', q: 'Broadcom 博通', kw: ['Broadcom', '博通'], rel: 'ASIC 龍頭', why: '財報常被視為 ASIC 族群風向球' },
    { kind: 'us', id: 'SOXX', name: '美股半導體 ETF', q: '費城半導體指數', rel: '產業指標', why: '美股半導體整體情緒' },
    USD,
  ],
};

export const entityKey = (e) => e.kind + ':' + e.id;

export async function getRelations(stockId) {
  const { relCustom = {}, relHidden = {} } = await chrome.storage.sync.get(['relCustom', 'relHidden']);
  const hidden = new Set(relHidden[stockId] || []);
  const base = (BUILTIN[stockId] || [TAIEX]).filter((e) => !hidden.has(entityKey(e))).map((e) => ({ ...e, builtin: true }));
  const custom = (relCustom[stockId] || []).map((e) => ({ ...e, builtin: false }));
  const seen = new Set();
  return [...base, ...custom].filter((e) => !seen.has(entityKey(e)) && seen.add(entityKey(e)));
}

export async function getHidden(stockId) {
  const { relHidden = {} } = await chrome.storage.sync.get('relHidden');
  return new Set(relHidden[stockId] || []);
}

export function hasBuiltin(stockId) {
  return !!BUILTIN[stockId];
}

export async function addRelation(stockId, e) {
  const { relCustom = {}, relHidden = {} } = await chrome.storage.sync.get(['relCustom', 'relHidden']);
  relCustom[stockId] = [...(relCustom[stockId] || []).filter((x) => entityKey(x) !== entityKey(e)), e];
  if (relHidden[stockId]) relHidden[stockId] = relHidden[stockId].filter((k) => k !== entityKey(e));
  await chrome.storage.sync.set({ relCustom, relHidden });
}

export async function removeRelation(stockId, key) {
  const { relCustom = {}, relHidden = {} } = await chrome.storage.sync.get(['relCustom', 'relHidden']);
  relCustom[stockId] = (relCustom[stockId] || []).filter((x) => entityKey(x) !== key);
  // 內建與自動產生的關聯都記為隱藏，之後不再出現
  relHidden[stockId] = [...new Set([...(relHidden[stockId] || []), key])];
  await chrome.storage.sync.set({ relCustom, relHidden });
}

// ---------- 計算 ----------
function returns(series) {
  const out = [];
  for (let i = 1; i < series.length; i++) out.push({ date: series[i][0], r: series[i][1] / series[i - 1][1] - 1 });
  return out;
}

function corr(pairs) {
  const n = pairs.length;
  if (n < 20) return null;
  let sx = 0, sy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; }
  const mx = sx / n, my = sy / n;
  let cov = 0, vx = 0, vy = 0;
  for (const [x, y] of pairs) { cov += (x - mx) * (y - my); vx += (x - mx) ** 2; vy += (y - my) ** 2; }
  return vx && vy ? cov / Math.sqrt(vx * vy) : null;
}

// stockSeries / entitySeries：[[date, close], ...] 依日期排序
// 美股對齊「台股日期之前最近一個美股交易日」，也就是隔夜行情對隔天台股的影響。
export function relationMetrics(stockSeries, entitySeries, kind, window = 60) {
  if (!entitySeries || entitySeries.length < 6) return null;
  const sr = returns(stockSeries);
  const er = returns(entitySeries);
  const pairs = [];
  let j = -1;
  for (const s of sr) {
    if (kind === 'us') {
      while (j + 1 < er.length && er[j + 1].date < s.date) j++;
      if (j >= 0) pairs.push({ date: s.date, x: s.r, y: er[j].r });
    } else {
      while (j + 1 < er.length && er[j + 1].date <= s.date) j++;
      if (j >= 0 && er[j].date === s.date) pairs.push({ date: s.date, x: s.r, y: er[j].r });
    }
  }
  const last = (arr, end, n) => arr.slice(Math.max(0, end - n), end).map((p) => [p.x, p.y]);
  const n = entitySeries.length;
  const lastE = entitySeries[n - 1];
  const prevE = entitySeries[n - 2];
  const e5 = entitySeries[Math.max(0, n - 6)];
  return {
    date: lastE[0],
    value: lastE[1],
    r1: (lastE[1] / prevE[1] - 1) * 100,
    r5: (lastE[1] / e5[1] - 1) * 100,
    corr: corr(last(pairs, pairs.length, window)),
    corrPrev: corr(last(pairs, pairs.length - 5, window)),
  };
}

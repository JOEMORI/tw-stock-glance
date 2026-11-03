// 「今天可以注意」：主動掃公開的小道消息來源，找出最近開始被討論、但股價還沒大動的個股。
// 來源只有公開頁面：PTT 股板最新文章標題、Google 新聞裡「傳出、打入、獨家、接單、概念股」這類標題。
// 不登入、不抓內文，也不讀 Dcard、臉書、Line 等有保護或私人的來源。結果快取 2 小時，每天名單會記下來驗證。
const BOARD = 'https://www.ptt.cc/bbs/Stock';
const TTL = 2 * 3600 * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tst = (ms = Date.now()) => new Date(ms + 8 * 3600000).toISOString().slice(0, 10);
const daysAgo = (n) => tst(Date.now() - n * 86400000);

// 小道消息型的新聞查詢（Google 新聞，近 3 天）
const RUMOR_Q = ['傳 打入 供應鏈', '傳出 接單', '業界傳出', '供應鏈 透露', '市場傳聞 台廠', '獨家 台廠', '概念股 受惠', '法人 看好 新題材', '訂單 滿載 擴產', '轉單 受惠', '打進 美系 大廠', '通過 認證 出貨', '營收 創新高 年增'];
const FORUM = /股市爆料同學會|PTT|Mobile01|Dcard|論壇/i;
// 兩個字的股名常常也是一般用語，這些只在標題同時出現代號時才算
const AMBIG = new Set(['全新', '統一', '中華', '大同', '台灣', '第一', '合作', '先進', '創新', '動力', '開發', '精華', '冠軍', '光明', '大眾', '上海', '亞洲', '聯合', '新光', '全國', '萬國', '大成', '台積', '大學', '國際', '中信', '永豐', '富邦', '元大', '台新', '凱基', '國泰', '玉山', '華南', '兆豐', '日勝', '世界', '致新', '信邦', '光寶', '達麗', '健策', '晶技', '朋程', '旭隼', '亞德', '神達', '飛宏', '正達', '佳世達', '振樺']);

// ---------- 來源 ----------
function toDate(md) {
  const today = tst();
  const [m, d] = md.split('/').map(Number);
  const y = Number(today.slice(0, 4));
  const f = (yy) => `${yy}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return f(y) > today ? f(y - 1) : f(y);
}
// PTT 股板最新文章（列表頁往回翻，直到超過 3 天或 12 頁）
async function pttLatest(maxPages = 20) {
  const out = [];
  const stop = daysAgo(5);
  let url = `${BOARD}/index.html`;
  for (let i = 0; i < maxPages && url; i++) {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) break;
    const html = await r.text();
    const body = html.split('<div class="r-list-sep"></div>')[0]; // 置底文不算
    let oldest = '9999';
    for (const b of body.split('<div class="r-ent">').slice(1)) {
      const a = b.match(/<a href="(\/bbs\/Stock\/M\.[^"]+)">([^<]+)<\/a>/);
      const md = ((b.match(/class="date">\s*([^<]+)</) || [])[1] || '').trim();
      const push = ((b.match(/class="nrec">(?:<span[^>]*>)?([^<]*)/) || [])[1] || '').trim();
      if (!a || !md) continue;
      const date = toDate(md);
      const title = a[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      const tag = (title.match(/^(?:Re:\s*)?\[([^\]]+)\]/) || [])[1] || '';
      out.push({ src: 'ptt', title, url: 'https://www.ptt.cc' + a[1], date, push, tag, re: /^Re:/.test(title) });
      if (date < oldest) oldest = date;
    }
    if (oldest < stop) break;
    const prev = html.match(/href="(\/bbs\/Stock\/index\d+\.html)">&lsaquo;/);
    url = prev ? 'https://www.ptt.cc' + prev[1] : null;
    await sleep(300);
  }
  return out.filter((p) => p.date >= stop);
}
async function rss(q) {
  const r = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(q + ' when:3d')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`, { cache: 'no-store' });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const doc = new DOMParser().parseFromString(await r.text(), 'text/xml');
  return [...doc.querySelectorAll('item')].map((it) => {
    const source = it.querySelector('source')?.textContent || '';
    let title = it.querySelector('title')?.textContent || '';
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
    const pub = new Date(it.querySelector('pubDate')?.textContent || 0);
    return { src: 'news', title, url: it.querySelector('link')?.textContent || '', source, date: isNaN(pub) ? '' : tst(pub.getTime()), q };
  }).filter((x) => x.title && !FORUM.test(x.source + x.title));
}
async function rumorNews() {
  const seen = new Set();
  const out = [];
  for (const q of RUMOR_Q) {
    try {
      for (const x of await rss(q)) {
        const k = x.title.replace(/[\s「」『』“”！？!?,，。:：|｜\-]/g, '').slice(0, 16);
        if (!seen.has(k)) { seen.add(k); out.push(x); }
      }
    } catch (e) { /* 略過 */ }
    await sleep(300);
  }
  return out;
}

// ---------- 從標題找個股 ----------
function nameIndex(info) {
  const list = [];
  for (const [id, v] of Object.entries(info)) {
    if (!/^[1-9]\d{3}$/.test(id) || !v?.name) continue;
    const n = v.name.replace(/-KY$|-創$|\*$/, '');
    if (n.length >= 2) list.push([n, id]);
  }
  return list.sort((a, b) => b[0].length - a[0].length);
}
// 例行的排行、盤勢、籌碼統計文（PTT 每天自動發的那種）不是消息，整篇略過
const ROUTINE = /排行|買賣超|週轉率|盤後|盤中|閒聊|集保|融資|融券|當沖|台指|期貨|大盤|ETF|處置|注意股|公告/;
function findIds(title, idx, info, tag) {
  if (ROUTINE.test(title)) return [];
  const ids = new Set();
  // 代號：要同時寫出股名，或是 [標的] 文，避免把「1103」這種日期當成代號
  for (const m of title.matchAll(/(?<!\d)([1-9]\d{3})(?!\d)/g)) {
    const nm = (info[m[1]]?.name || '').replace(/-KY$|-創$|\*$/, '');
    if (nm && (title.includes(nm) || tag === '標的')) ids.add(m[1]);
  }
  let t = title;
  for (const [n, id] of idx) {
    if (!t.includes(n)) continue;
    if (n.length === 2 && AMBIG.has(n) && !ids.has(id)) continue;
    ids.add(id);
    t = t.split(n).join('　'); // 已比對到的字拿掉，避免「聯發科」又比對到「聯發」
  }
  return [...ids];
}

// ---------- 主程式 ----------
// info：全部股票名稱；market：readMarket() 的全市場行情；themes：題材雷達資料（可為 null）
export async function whisperWatch({ info, market, themes, force = false }) {
  const { whisperCache: c } = await chrome.storage.local.get('whisperCache');
  let posts = c && !force && Date.now() - c.at < TTL ? c.posts : null;
  if (!posts) {
    const [ptt, news] = await Promise.all([pttLatest().catch(() => []), rumorNews().catch(() => [])]);
    if (!ptt.length && !news.length) throw new Error('PTT 與 Google 新聞都連不上');
    posts = [...ptt, ...news];
    await chrome.storage.local.set({ whisperCache: { at: Date.now(), posts } });
  }
  const idx = nameIndex(info);
  const ment = {}; // id -> { ptt, pick, news, items[], co{} }
  for (const p of posts) {
    p.ids = findIds(p.title, idx, info, p.tag);
    if (p.ids.length > 6) continue; // 一次列一堆股票的盤勢文不算
    for (const id of p.ids) {
      const m = (ment[id] = ment[id] || { ptt: 0, pick: 0, news: 0, push: 0, items: [], co: {}, yoy: null });
      const y = p.title.match(/(?:\bY|年增)\s*[:：]?\s*(-?[\d.]+)\s*%/);
      if (y && /營收/.test(p.title) && p.ids.length === 1) m.yoy = Number(y[1]);
      if (p.src === 'ptt') {
        if (/標的|情報/.test(p.tag) && !p.re) m.pick++; else m.ptt++;
        const n = p.push === '爆' ? 100 : /^X/.test(p.push) ? 0 : Number(p.push) || 0;
        m.push += n;
      } else m.news++;
      m.items.push(p);
      for (const o of p.ids) if (o !== id) m.co[o] = (m.co[o] || 0) + 1;
    }
  }
  // 每日提及紀錄：看是不是最近才開始被討論
  const today = tst();
  const { whisperLog: log0 = {} } = await chrome.storage.local.get('whisperLog');
  const log = Object.fromEntries(Object.entries(log0).filter(([d]) => d >= daysAgo(40)));
  log[today] = { ...(log[today] || {}), m: Object.fromEntries(Object.entries(ment).map(([id, m]) => [id, m.ptt + m.pick + m.news])) };
  const past = Object.keys(log).filter((d) => d < daysAgo(3) && d >= daysAgo(17));
  const pastN = (id) => past.reduce((s, d) => s + (log[d].m?.[id] || 0), 0);

  // 行情：20 日漲跌、今日量比、外資近 5 日買超天數
  const P = market?.prices || [];
  const n = P.length;
  const px = (id) => {
    const last = P[n - 1]?.[id];
    if (!last) return null;
    const old = P[Math.max(0, n - 21)]?.[id];
    const vols = P.slice(Math.max(0, n - 21), n - 1).map((p) => p[id]?.[1]).filter((v) => v > 0);
    const av = vols.length ? vols.reduce((s, v) => s + v, 0) / vols.length : 0;
    return { close: last[0], r1: last[2] * 100, r20: old ? (last[0] / old[0] - 1) * 100 : null, vr: av ? last[1] / av : null, vol: last[1] };
  };
  const fBuy = (id) => (market?.inst || []).filter((d) => (d[id] || 0) > 0).length;
  const fDays = (market?.inst || []).length;
  const stageOf = (id) => (themes?.themes || []).filter((t) => t.ids.includes(id));

  // 大型權值股天天有人討論，不算小道消息：成交值前 60 名的分數打三折
  const tv = Object.entries(P[n - 1] || {}).map(([id, x]) => [id, (x[0] || 0) * (x[1] || 0)]).sort((a, b) => b[1] - a[1]);
  const big = new Set(tv.slice(0, 60).map(([id]) => id));
  const cands = [];
  for (const [id, m] of Object.entries(ment)) {
    const p = px(id);
    if (!p || p.vol < 200) continue; // 成交太少（不到 200 張）的不列
    const th = stageOf(id);
    const hot = th.find((t) => t.stage === '醞釀' || t.stage === '發動');
    const prior = pastN(id);
    const fresh = past.length >= 3 ? prior === 0 : null; // 有 3 天以上紀錄才判斷「最近才出現」
    const fb = fBuy(id);
    let score = m.pick * 2 + m.ptt + m.news * 1.5 + Math.min(m.push, 100) / 50 + (m.yoy >= 30 ? 2 : 0);
    if (fresh) score += 2;
    if (fb >= 3) score += 1;
    if (hot) score += 1;
    if (p.r20 != null && p.r20 > 30) score -= 2; // 已經大漲的往後排
    if (big.has(id)) score *= 0.3;
    if (m.pick + m.ptt + m.news < 2 && !(m.yoy >= 30)) continue;
    cands.push({ id, name: info[id]?.name || id, score, big: big.has(id), m, p, fb, fDays, fresh, prior, themes: th.map((t) => ({ name: t.name, stage: t.stage })), co: Object.entries(m.co).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([o]) => o) });
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands.slice(0, 8);
  // 名單存檔：之後算「過去名單 5 日後」的表現
  log[today].pick = top.map((c) => [c.id, c.p.close]);
  await chrome.storage.local.set({ whisperLog: log });
  return { at: c && !force && Date.now() - c.at < TTL ? c.at : Date.now(), top, nPosts: posts.length, nPtt: posts.filter((p) => p.src === 'ptt').length, nNews: posts.filter((p) => p.src === 'news').length, logDays: Object.keys(log).length, valid: validate(log, market) };
}

// 過去名單在 5 個交易日後的漲跌（用全市場收盤），和同期全部股票平均比較
function validate(log, market) {
  const dates = market?.dates || [];
  const P = market?.prices || [];
  const rets = [], base = [];
  for (const [d, v] of Object.entries(log)) {
    if (!v.pick?.length) continue;
    const i = dates.findIndex((x) => x >= d);
    if (i < 0 || i + 5 >= dates.length) continue;
    for (const [id, c0] of v.pick) { const c5 = P[i + 5]?.[id]?.[0]; if (c0 && c5) rets.push((c5 / c0 - 1) * 100); }
    const all = Object.entries(P[i] || {}).map(([id, x]) => { const c5 = P[i + 5]?.[id]?.[0]; return x[0] && c5 ? (c5 / x[0] - 1) * 100 : null; }).filter((x) => x != null);
    if (all.length) base.push(all.reduce((s, x) => s + x, 0) / all.length);
  }
  if (rets.length < 10) return null;
  const avg = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  return { n: rets.length, avg: avg(rets), up: rets.filter((x) => x > 0).length / rets.length, base: base.length ? avg(base) : null };
}

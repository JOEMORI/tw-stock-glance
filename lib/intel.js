// 情報雷達：從全市場公司公告（重大訊息）與內部人持股轉讓申報，篩出值得注意的消息。
// 每則情報：分類、金額解析、每股影響、一次性或持續性、與自選股的關係、股價是否已先反應、預計認列的財報季。
import { adjSeries } from './sectors.js';

export const CATS = {
  sell: { name: '處分資產', nature: '一次性', color: '#7B4FA0' },
  buyback: { name: '庫藏股', nature: '籌碼面', color: '#1F5FBF' },
  capital: { name: '增資減資', nature: '股本變動', color: '#C9772B' },
  order: { name: '接單合約', nature: '持續性', color: '#2F7D4F' },
  insider: { name: '內部人轉讓', nature: '籌碼面', color: '#8A4B2F' },
  clarify: { name: '澄清報導', nature: '消息面', color: '#5F5C55' },
  fix: { name: '更正財報', nature: '一次性', color: '#A8432F' },
  kw: { name: '關鍵字', nature: '', color: '#1A1A1A' },
};
// 例行公告不列入
const ROUTINE = /法人說明會|法說會|股東常會|股東臨時會|除權息|基準日|董事會(召開|決議日期)|公告本公司.*(月份|月)營收|發放現金股利|代子公司.*(逆回購|國債)|一天期|短期票券|定存|貨幣市場基金/;

const num = (s) => Number(String(s).replace(/,/g, ''));
const UNIT = { 元: 1, 仟元: 1e3, 千元: 1e3, 萬元: 1e4, 億元: 1e8 };
function money(txt) {
  const m = String(txt).match(/(新台幣|新臺幣|人民幣|美元|美金|日圓|歐元)?\s*(-?[\d,]+(?:\.\d+)?)\s*(億元|萬元|仟元|千元|元)/);
  if (!m) return null;
  const foreign = m[1] && !/新台幣|新臺幣/.test(m[1]);
  return { v: num(m[2]) * UNIT[m[3]], foreign: foreign ? m[1] : null };
}
// 公告是「1.…2.…」編號格式，取某一段的內容
function section(body, re) {
  const lines = String(body).split(/\r?\n/);
  let on = false;
  const out = [];
  for (const l of lines) {
    if (/^\s*\d{1,2}\s*[.．、]/.test(l)) { if (on) break; if (re.test(l)) { on = true; out.push(l.replace(/^\s*\d{1,2}\s*[.．、]/, '')); continue; } }
    else if (on) out.push(l);
  }
  return out.join(' ');
}
const sharesIn = (txt) => { const m = String(txt).match(/([\d,]+(?:\.\d+)?)\s*(仟股|千股|張|股)/); return m ? num(m[1]) * (m[2] === '股' ? 1 : 1000) : null; };

export function classify(a, keywords = []) {
  const s = String(a.s || '').replace(/\s+/g, '');
  const b = a.b || '';
  const kw = keywords.filter((k) => k && (s.includes(k) || b.includes(k)));
  let cat = null;
  if (/更正|重編|補正/.test(s) && /財報|財務報告|財務報表/.test(s) && !/日期|召開|董事會/.test(s)) cat = 'fix';
  else if (/澄清|媒體報導|報載/.test(s)) cat = 'clarify';
  else if (/買回.*股份|庫藏股/.test(s) && !/轉讓|註銷|執行完畢|未執行完畢|執行情形/.test(s)) cat = 'buyback';
  else if (/私募|現金增資|減資|轉換公司債/.test(s) && !/期間|完成|申報生效|變更登記|代收|存儲專戶|催繳|參與|發行條件|補充說明|取得|價格訂定|基準日|限制員工權利|員工認股|庫藏股|生效/.test(s) && !/^代/.test(s)) cat = 'capital';
  else if (/處分|出售/.test(s) && !ROUTINE.test(s) && !/使用權資產|債權|租約|授信/.test(s)) cat = 'sell';
  else if (/簽訂|合約|訂單|得標|承攬|意向書/.test(s) && !/取得.*(使用權|有價證券)|授信|借款|租賃|租約|裝修|保險|聯貸/.test(s)) cat = 'order';
  if (!cat && kw.length) cat = 'kw';
  if (!cat || (ROUTINE.test(s) && cat !== 'kw')) return null;
  return { cat, kw };
}

// 依分類解析金額與每股影響。issued：發行張數（千股）
export function parse(item, cat, issued) {
  const b = item.b || '';
  const out = {};
  const shares = issued ? issued * 1000 : null;
  if (cat === 'sell') {
    const g = section(b, /處分利益|處份利益|處分損益|利益（或損失）|利益\(或損失\)/);
    const m = money(g);
    if (m) {
      const g2 = g.replace(/（[^）]*）|\([^)]*\)/g, '').replace(/^[^:：]*[:：]/, '');
      const loss = /損失|虧損/.test(g2) || m.v < 0;
      out.profit = loss ? -Math.abs(m.v) : m.v;
      out.foreign = m.foreign;
      if (shares && !m.foreign) out.perShare = out.profit / shares;
    }
    const t = money(section(b, /交易總金額|交易數量/));
    if (t) out.total = t.v;
    const dt = section(b, /交易日期|事實發生日/).match(/(\d{2,3})\/(\d{1,2})\/(\d{1,2})(?!.*\d{2,3}\/\d{1,2}\/\d{1,2})/);
    if (dt) out.factDate = `${Number(dt[1]) + 1911}-${dt[2].padStart(2, '0')}-${dt[3].padStart(2, '0')}`;
  } else if (cat === 'buyback') {
    const n = sharesIn(section(b, /買回股份總金額|預定買回之數量|買回股數|預定買回股數|買回之數量/));
    if (n) { out.buyShares = n; if (shares) out.pctShares = (n / shares) * 100; }
    const pr = section(b, /買回區間價格|買回價格/).match(/([\d.]+)\s*元.*?([\d.]+)\s*元/);
    if (pr) out.range = `${pr[1]}–${pr[2]} 元`;
  } else if (cat === 'capital') {
    out.dir = /減資/.test(item.s) ? (/現金減資/.test(item.s + b) ? 'cashCut' : 'cut') : 'dilute';
    out.private = /私募/.test(item.s);
    if (out.dir === 'dilute') {
      const n = sharesIn(section(b, /發行股數|私募.*(股數|額度)|發行數額|增資股數|發行新股/));
      if (n) { out.newShares = n; if (shares) out.pctShares = (n / shares) * 100; }
    } else {
      const r = b.match(/減資比率[^\d]{0,12}([\d.]+)\s*%/);
      if (r) out.pctShares = Number(r[1]);
      const back = b.match(/每(?:股|仟股)[^\d]{0,10}(?:退還|返還)[^\d]{0,10}([\d.]+)\s*元/);
      if (back) out.refund = back[0].replace(/\s+/g, '');
    }
  } else if (cat === 'order') {
    const m = money(section(b, /合約總金額|交易總金額|契約金額|合約金額|金額/));
    if (m) { out.total = m.v; out.foreign = m.foreign; }
  }
  return out;
}

// 處分利益認列在哪一季財報：事實發生日所在季度的法定公布期限
export function reportOf(date) {
  if (!date) return null;
  const [y, m] = date.split('-').map(Number);
  const q = Math.ceil(m / 3);
  const dl = q === 1 ? `${y}-05-15` : q === 2 ? `${y}-08-14` : q === 3 ? `${y}-11-14` : `${y + 1}-03-31`;
  return { q, y, label: `${y} 第${['一', '二', '三', '四'][q - 1]}季`, deadline: dl };
}

// 股價反應：公告在 13:30 前看當天，之後看下一個交易日。回傳公告前 5 日、反應日、量比、至今
export function reaction(market, id, d, t) {
  if (!market || !market.dates.length) return null;
  const dates = market.dates;
  const after = t && t >= '13:30';
  let r = dates.findIndex((x) => (after ? x > d : x >= d));
  const adj = adjSeries(market, id);
  if (!adj) return null;
  const end = dates.length - 1;
  const base = r < 0 ? end : r - 1; // 反應日前一天
  if (base < 0) return null;
  const pre5 = base >= 5 && adj[base - 5] ? (adj[base] / adj[base - 5] - 1) * 100 : null;
  const out = { pre5, pending: r < 0 };
  if (r >= 0) {
    out.day = (adj[r] / adj[base] - 1) * 100;
    let v = 0, n = 0;
    for (let i = Math.max(0, r - 20); i < r; i++) if (market.prices[i][id]) { v += market.prices[i][id][1]; n++; }
    out.vr = n && v ? market.prices[r][id]?.[1] / (v / n) : null;
    out.since = (adj[end] / adj[base] - 1) * 100;
    out.days = end - r;
    if (r + 5 <= end) out.r5 = (adj[r + 5] / adj[base] - 1) * 100;
    if (r + 20 <= end) out.r20 = (adj[r + 20] / adj[base] - 1) * 100;
  }
  out.leaked = pre5 != null && pre5 >= 5; // 公告前 5 日已漲 5% 以上
  return out;
}

// 內部人持股轉讓事前申報（上市、上櫃各一份，每天公布）
export async function fetchInsider() {
  const { insider: c } = await chrome.storage.local.get('insider');
  if (c && Date.now() - c.at < 2 * 3600 * 1000) return c.rows;
  const rows = [];
  const src = [
    ['https://openapi.twse.com.tw/v1/opendata/t187ap12_L', '公司代號', '公司名稱'],
    ['https://www.tpex.org.tw/openapi/v1/mopsfin_t187ap12_O', 'SecuritiesCompanyCode', 'CompanyName'],
  ];
  for (const [url, ik, nk] of src) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      if (!r.ok) continue;
      for (const x of await r.json()) {
        const g = (k) => x[Object.keys(x).find((kk) => kk.trim() === k || kk.includes(k))];
        const id = String(x[ik] || g('公司代號') || '').trim();
        if (!/^\d{4}$/.test(id)) continue;
        const dd = String(x.Date || x['出表日期'] || g('申報日期') || '').trim();
        const m = dd.match(/^(\d{2,3})(\d{2})(\d{2})$/);
        rows.push({
          id, name: String(x[nk] || '').trim(),
          d: m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : '',
          who: String(g('申請人身分') || '').trim(), person: String(g('姓名') || '').trim(),
          shares: num(g('預定轉讓總股數-自有持股') || g('轉讓股數') || 0),
          hold: num(g('目前持有股數-自有持股') || 0),
          how: String(g('預定轉讓方式及股數-轉讓方式') || '').trim(), period: String(g('有效轉讓期間') || '').trim(),
        });
      }
    } catch (e) { /* 略過 */ }
  }
  if (rows.length || !c) await chrome.storage.local.set({ insider: { at: Date.now(), rows: rows.length ? rows : c?.rows || [] } });
  return rows.length ? rows : c?.rows || [];
}

// 主流程：整理出所有情報，依重要性排序
// opts: { anns, insider, market, shares: {id: 發行張數}, names: {id: 名稱}, keywords, links: {id: [說明]}, days }
export function buildIntel({ anns, insider = [], market, shares = {}, names = {}, keywords = [], links = {}, since }) {
  const out = [];
  for (const [id, list] of Object.entries(anns || {})) {
    for (const a of list) {
      if (since && a.d < since) continue;
      const c = classify(a, keywords);
      if (!c) continue;
      const p = parse(a, c.cat, shares[id]);
      const it = { id, name: names[id] || id, d: a.d, t: a.t, s: a.s, b: a.b, cat: c.cat, kw: c.kw, ...p, links: links[id] || [] };
      it.react = reaction(market, id, a.d, a.t);
      if (c.cat === 'sell' && p.factDate && p.profit) it.report = reportOf(p.factDate);
      it.score = score(it);
      it.important = it.score >= 2 || it.kw.length > 0 || it.links.length > 0;
      out.push(it);
    }
  }
  for (const x of insider) {
    if (since && x.d && x.d < since) continue;
    const iss = shares[x.id];
    const pct = iss ? (x.shares / (iss * 1000)) * 100 : null;
    const it = { id: x.id, name: x.name || names[x.id] || x.id, d: x.d, t: '', cat: 'insider', kw: [], links: links[x.id] || [],
      s: `${x.who} ${x.person} 申報轉讓 ${Math.round(x.shares / 1000).toLocaleString('en-US')} 張`, b: `轉讓方式：${x.how}\n目前持有：${Math.round(x.hold / 1000).toLocaleString('en-US')} 張\n有效期間：${x.period}`,
      pctShares: pct, pctOwn: x.hold ? (x.shares / x.hold) * 100 : null, transfer: x.shares };
    it.react = reaction(market, x.id, x.d, '');
    it.score = score(it);
    it.important = it.score >= 2 || it.links.length > 0;
    out.push(it);
  }
  return out.sort((a, b) => b.d.localeCompare(a.d) || b.score - a.score);
}

// 重要性分數：依每股影響、佔股本比例、類別
export function score(it) {
  let s = 0;
  if (it.cat === 'sell') s = it.perShare != null ? Math.min(6, Math.abs(it.perShare) / 0.25) : it.profit && Math.abs(it.profit) >= 1e8 ? 2 : 0.5;
  else if (it.cat === 'buyback') s = it.pctShares != null ? Math.min(6, it.pctShares * 2) : 1.5;
  else if (it.cat === 'capital') s = it.pctShares != null ? Math.min(6, it.pctShares / 2) : it.private ? 2 : 1.5;
  else if (it.cat === 'order') s = it.total ? Math.min(5, it.total / 5e8) : 1;
  else if (it.cat === 'insider') s = it.pctShares != null ? Math.min(6, it.pctShares * 4) : 0.5;
  else if (it.cat === 'clarify') s = 2;
  else if (it.cat === 'fix') s = 2.5;
  else if (it.cat === 'kw') s = 2;
  if (it.links?.length) s += 1;
  if (it.react?.leaked) s += 0.5;
  return Math.round(s * 10) / 10;
}

// 一句話說明每股影響
export function impactText(it) {
  const f = (v) => (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(2) + ' 億' : Math.round(v / 1e4).toLocaleString('en-US') + ' 萬');
  if (it.cat === 'sell') {
    if (it.perShare != null) return `每股${it.perShare >= 0 ? '+' : '−'}${Math.abs(it.perShare).toFixed(2)} 元`;
    if (it.profit != null) return `${it.profit >= 0 ? '利益' : '損失'} ${it.foreign ? it.foreign + ' ' : ''}${f(Math.abs(it.profit))}`;
    return '';
  }
  if (it.cat === 'buyback') return it.pctShares != null ? `股本 ${it.pctShares.toFixed(1)}%` : '';
  if (it.cat === 'capital') return it.pctShares != null ? `${it.dir === 'dilute' ? '稀釋' : '減少'} ${it.pctShares.toFixed(1)}%` : '';
  if (it.cat === 'order') return it.total ? `${it.foreign ? it.foreign + ' ' : ''}${f(it.total)}` : '';
  if (it.cat === 'insider') return it.pctShares != null ? `股本 ${it.pctShares.toFixed(2)}%` : '';
  return '';
}

// 題材雷達的畫面（插件情報雷達頁與手機版共用）。資料來自 GitHub Actions 每天產生的 data/themes.json。
import { esc, sPct, tone, md, fmtP } from './format.js';
import { THEME_DEFS } from './themes.js';

export const THEMES_URL = 'https://joemori.github.io/tw-stock-glance/data/themes.json';

// 訊號依「通常出現的先後」排列
export const SIGS = [
  ['en', '英文新聞', '國外新聞量升溫，通常最早'],
  ['rev', '營收加速', '成分股月營收年增率加速'],
  ['chip', '籌碼累積', '外資多日小買、大戶增加，但股價還沒大漲'],
  ['us', '美股連動', '美股對照股前一晚大漲'],
  ['zh', '中文新聞', '台灣新聞量升溫'],
  ['ptt', 'PTT 討論', '股板討論量升溫，散戶開始注意'],
  ['px', '放量上漲', '成分股放量上漲，最晚出現'],
];
export const STAGE = {
  醞釀: { c: '#2F7D4F', t: '早期訊號出現、股價還沒大漲' },
  發動: { c: '#C9772B', t: '股價開始放量上漲' },
  過熱: { c: '#C0392B', t: '漲多且散戶討論升溫' },
  平靜: { c: '#8A867D', t: '沒有明顯訊號' },
};
const ORDER = { 醞釀: 0, 發動: 1, 過熱: 2, 平靜: 3 };

export async function loadThemes(fetchJSON) {
  try {
    const d = await fetchJSON(THEMES_URL);
    try { localStorage.setItem('themesCache', JSON.stringify(d)); } catch (e) { /* 略過 */ }
    return d;
  } catch (e) {
    try { return JSON.parse(localStorage.getItem('themesCache')); } catch (e2) { return null; }
  }
}

const nm = (d, info, id) => info?.[id]?.name || d.names?.[id] || id;
const sigVal = (t, k) => {
  if (k === 'en' || k === 'zh') { const n = t.news?.[k]; return n ? (n.sat ? '滿載' : n.x == null ? '–' : `×${n.x.toFixed(1)}`) : '–'; }
  if (k === 'rev') return t.rev?.n ? `${t.rev.acc}/${t.rev.n}` : '–';
  if (k === 'chip') return `${t.chip?.buy3 ?? 0}/${t.chip?.n ?? 0}`;
  if (k === 'us') return t.usm?.r1 == null ? '–' : sPct(t.usm.r1, 1);
  if (k === 'ptt') return `${t.ptt?.n3 ?? 0} 篇`;
  if (k === 'px') return `${t.mv?.today?.length ?? 0} 檔`;
  return '';
};

// 精簡版：醞釀、發動、過熱用卡片，只列亮燈的訊號；平靜收成一張表。PTT 有討論時可展開看文章並連到 PTT。
const SHORT = { en: '英', rev: '營', chip: '籌', us: '美', zh: '中', ptt: 'P', px: '量' };
const qOf = (name) => THEME_DEFS.find((x) => x.name === name)?.zh[0] || name;
const pttLink = (q) => `https://www.ptt.cc/bbs/Stock/search?q=${encodeURIComponent(q)}`;
function dots(t) {
  return `<span class="tr-dots" aria-label="訊號">${SIGS.map(([k, l]) => `<i class="${t.sig[k] ? 'on' : ''}" title="${l}">${SHORT[k]}</i>`).join('')}</span>`;
}
function pttBlock(t, p, q) {
  if (!p) return `<a class="tr-ptt" href="${pttLink(q)}" target="_blank" rel="noopener">PTT 搜尋「${esc(q)}」›</a>`;
  if (!p.posts.length) return `<a class="tr-ptt muted" href="${pttLink(q)}" target="_blank" rel="noopener">PTT 近 10 天沒有相關討論 ›</a>`;
  return `<details class="tr-pttd"><summary>PTT 近 3 天 ${p.n3} 篇${p.hot ? '（升溫）' : ''} · 近 10 天 ${p.posts.length} 篇</summary><ul>${p.posts.map((x) => `<li><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title)}</a> <span class="muted num">${md(x.date)}${x.push ? ' · ' + esc(x.push) : ''}</span></li>`).join('')}</ul><a href="${pttLink(q)}" target="_blank" rel="noopener">在 PTT 搜尋更多 ›</a></details>`;
}
export function stageHTML(d, info, link, ptt = null) {
  const list = d.themes.map((t) => {
    const p = ptt?.[t.name];
    if (!p) return t;
    const sig = { ...t.sig, ptt: p.hot };
    return { ...t, sig, ptt: { n3: p.n3 } };
  }).sort((a, b) => ORDER[a.stage] - ORDER[b.stage] || b.early - a.early);
  const active = list.filter((t) => t.stage !== '平靜');
  const calm = list.filter((t) => t.stage === '平靜');
  const card = (t) => {
    const st = STAGE[t.stage];
    const on = SIGS.filter(([k]) => t.sig[k]);
    const q = qOf(t.name);
    return `<div class="tr-t">
      <div class="tr-h"><b>${esc(t.name)}</b><span class="tr-st" style="background:${st.c}">${t.stage}</span></div>
      <div class="tr-r num">20 日 <span class="${tone(t.r20)}">${sPct(t.r20, 1)}</span><span class="muted"> · 5 日 ${sPct(t.r5, 1)}</span></div>
      <div class="tr-on">${on.map(([k, l]) => `<span>${l} <b>${sigVal(t, k)}</b></span>`).join('')}</div>
      ${pttBlock(t, ptt?.[t.name], q)}
      <details class="tr-mem"><summary>成分股 ${t.ids.length} 檔${t.us?.length ? ` · 美股 ${t.us.join('、')}` : ''}</summary><div>${t.ids.map((id) => link(id, nm(d, info, id))).join('、')}</div></details>
    </div>`;
  };
  return `${active.length ? `<div class="tr-grid">${active.map(card).join('')}</div>` : '<p class="empty">今天沒有醞釀中或發動中的題材</p>'}
    ${calm.length ? `<details class="tr-calm"><summary>平靜 ${calm.length} 個題材</summary><table class="tbl num"><tbody>${calm.map((t) => `<tr><td class="l">${esc(t.name)}</td><td>${dots(t)}</td><td class="${tone(t.r20)}">20 日 ${sPct(t.r20, 1)}</td><td class="l"><a href="${pttLink(qOf(t.name))}" target="_blank" rel="noopener" class="muted small">PTT ›</a></td></tr>`).join('')}</tbody></table><p class="muted small">方格亮綠代表該訊號亮燈：${SIGS.map(([k, l]) => `${SHORT[k]} ${l}`).join('、')}</p></details>` : ''}`;
}

export function moversHTML(d, info, link, themeOf, industryOf) {
  if (!d.movers.length) return '<p class="empty">今天沒有放量（3 倍以上）且上漲 5% 以上的股票</p>';
  const g = {};
  for (const m of d.movers) {
    const key = themeOf(m.id) || industryOf(m.id) || '其他';
    (g[key] = g[key] || []).push(m);
  }
  const groups = Object.entries(g).sort((a, b) => b[1].length - a[1].length);
  const streak = Object.fromEntries(d.themes.map((t) => [t.name, t.mv?.streak || 0]));
  return `<p class="muted small">${md(d.date)} 放量 3 倍以上且上漲 5% 以上共 ${d.movers.length} 檔，依題材（沒有題材就用產業）歸群。同一族群多檔同時出現、或連續幾天都有，比單一檔大漲更值得注意。</p>
    ${groups.map(([k, l]) => `<div class="tr-g"><div class="tr-h"><b>${esc(k)}</b><span class="muted small">${l.length} 檔${streak[k] >= 2 ? `，連續 ${streak[k]} 天有成分股上榜` : ''}</span></div>
      <div class="tr-mv">${l.map((m) => `<span>${link(m.id, nm(d, info, m.id))} <span class="num up">${sPct(m.r1, 1)}</span> <span class="muted small num">量 ${m.vr.toFixed(1)} 倍</span></span>`).join('')}</div></div>`).join('')}`;
}

export function clustersHTML(d, info, link) {
  if (!d.clusters.length) return '<p class="empty">近 20 日沒有找到走勢高度同步、又不屬於現有題材的股票群</p>';
  return `<p class="muted small">近 20 日漲幅前 150 檔中，每日漲跌相關 0.6 以上、又不屬於現有題材的股票群。關鍵字是這些股票新聞標題裡共同出現的詞，可能是新題材的線索，也可能只是巧合，請點進個股確認。</p>
    ${d.clusters.map((c) => `<div class="tr-g"><div class="tr-h"><b>${c.words?.length ? esc(c.words.slice(0, 3).join('、')) : '（找不到共同關鍵字）'}</b><span class="muted small num">${c.ids.length} 檔 · 20 日平均 ${sPct(c.r20, 1)}</span></div>
      <div class="tr-mv">${c.ids.map((id) => `<span>${link(id, nm(d, info, id))}</span>`).join('')}</div></div>`).join('')}`;
}

export function validHTML(d) {
  const v = d.validation?.res || {};
  const base = v.all || {};
  const row = (k, label) => {
    const x = v[k];
    if (!x || !x.n) return `<tr><td class="l">${label}</td><td>0</td><td colspan="4" class="muted">尚未出現</td></tr>`;
    const diff = x.f5 != null && base.f5 != null ? x.f5 - base.f5 : null;
    return `<tr><td class="l">${label}</td><td>${x.n}</td><td class="${tone(x.f5)}">${x.f5 == null ? '累積中' : sPct(x.f5, 2)}<small class="muted"> /${x.n5}</small></td><td>${x.up5 == null ? '–' : Math.round(x.up5 * 100) + '%'}</td><td class="${tone(x.f20)}">${x.f20 == null ? '累積中' : sPct(x.f20, 2)}<small class="muted"> /${x.n20}</small></td><td class="${tone(diff)}">${diff == null ? '–' : sPct(diff, 2)}</td></tr>`;
  };
  const r = d.retro || {};
  return `<p class="muted small">每天把每個題材的訊號存檔，之後看題材成分股平均在 5、20 個交易日後的漲跌。從 ${md(d.validation?.from || '')} 開始記錄，共 ${d.validation?.days || 0} 個交易日；至少要 2 到 3 個月、每列 5 日後有 30 次以上，比較才有意義。</p>
    <div class="tbl-wrap"><table class="tbl num"><thead><tr><th class="l">訊號</th><th>出現（題材×天）</th><th>5 日後平均</th><th>5 日後上漲比例</th><th>20 日後平均</th><th>5 日比全部平均</th></tr></thead><tbody>
      ${SIGS.map(([k, l]) => row(k, l)).join('')}${['醞釀', '發動', '過熱'].map((s) => row('stage:' + s, '階段：' + s)).join('')}${row('all', '全部題材（對照）')}
    </tbody></table></div>
    <h3 style="margin-top:14px">回測：營收加速（不必等累積）</h3>
    ${r.n ? `<p class="small">用成分股近兩年月營收與股價：某月題材有 4 成以上成分股「營收年增超過 15% 且比 3 個月前高 10 個百分點」，看營收公布後 60 個交易日的漲跌。</p>
      <div class="tbl-wrap"><table class="tbl num"><thead><tr><th class="l"></th><th>題材×月</th><th>60 日後平均</th><th>上漲比例</th></tr></thead><tbody>
      <tr><td class="l">營收加速</td><td>${r.hot.n}</td><td class="${tone(r.hot.f60)}">${sPct(r.hot.f60, 1)}</td><td>${r.hot.up == null ? '–' : Math.round(r.hot.up * 100) + '%'}</td></tr>
      <tr><td class="l">其他月份</td><td>${r.cold.n}</td><td class="${tone(r.cold.f60)}">${sPct(r.cold.f60, 1)}</td><td>${r.cold.up == null ? '–' : Math.round(r.cold.up * 100) + '%'}</td></tr></tbody></table></div>
      ${r.cases?.length ? `<p class="muted small">表現最好的幾次：${r.cases.map((c) => `${esc(c.theme)} ${c.month}（${sPct(c.f60, 0)}）`).join('、')}</p>` : ''}`
    : '<p class="empty">成分股歷史資料還在補齊（每次更新補一部分），約 2 到 3 天後出現。</p>'}`;
}

export function howHTML() {
  return `<ol class="small" style="line-height:1.8;padding-left:20px">
    <li><b>先看「醞釀」</b>：早期訊號（英文新聞、營收、籌碼、美股）已出現，但題材近 20 日漲幅不到 10%。這是可以提早研究的名單，不是買進訊號。</li>
    <li><b>「發動」</b>：成分股開始放量上漲，訊號被股價確認；這時進場已不是最早，但趨勢比較明確。</li>
    <li><b>「過熱」</b>：近 20 日漲 20% 以上且 PTT 討論升溫，追高風險大。</li>
    <li><b>訊號說明</b>：${SIGS.map(([, l, t]) => `${l}（${t}）`).join('；')}。數字：新聞為近 3 天日均是前幾週的幾倍；營收、籌碼為符合的成分股數／總數；「滿載」代表新聞太多、無法比較。</li>
    <li><b>用「訊號驗證」決定要信哪個</b>：累積幾個月後，看哪個訊號出現後題材真的比較會漲。不準的訊號就別理它。</li>
    <li>資料來源：Google 新聞（中英文）、PTT 股板標題、證交所與櫃買中心月營收、FinMind、集保。每個交易日 17:05、21:45 更新。題材與成分股在 lib/themes.js，可以增刪。</li>
  </ol>`;
}

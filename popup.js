import { getWatchlist, getSettings } from './lib/storage.js';
import { getCachedStock } from './lib/api.js';
import { analyze, priceDigits } from './lib/indicators.js';
import { readDetail } from './lib/market.js';
import { patchData } from './lib/patch.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const open = (hash = '') => chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') + hash });

document.getElementById('open').addEventListener('click', () => open());
document.getElementById('radar').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('radar.html') }));
document.getElementById('weekly').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('weekly.html') }));

async function init() {
  const { convention } = await getSettings();
  document.documentElement.dataset.convention = convention;
  const ids = await getWatchlist();
  const detail = await readDetail().catch(() => null);
  const { stockinfo } = await chrome.storage.local.get('stockinfo');
  let latest = '';
  let missing = 0;
  const rows = [];
  for (const id of ids) {
    const data = await getCachedStock(id);
    const a = data ? analyze(patchData(data, detail, id)) : null;
    const name = stockinfo?.map?.[id]?.name || id;
    if (!a || a.empty) {
      missing++;
      rows.push(`<li><button type="button" data-id="${esc(id)}"><span>${esc(name)}</span><span class="muted small">尚未載入</span></button></li>`);
      continue;
    }
    if (a.last.time > latest) latest = a.last.time;
    const dg = priceDigits(a.last.close);
    const cls = a.chg > 0 ? 'up' : a.chg < 0 ? 'down' : '';
    const sign = a.pct > 0 ? '▲ +' : a.pct < 0 ? '▼ −' : '';
    rows.push(`<li><button type="button" data-id="${esc(id)}"><span><span>${esc(name)}</span><br><span class="muted small num">${esc(id)} · ${a.events.length ? a.events.length + ' 個新訊號' : '無新訊號'}</span></span><span class="r num"><span>${a.last.close.toLocaleString('en-US', { minimumFractionDigits: dg, maximumFractionDigits: dg })}</span><span class="small ${cls}">${sign}${Math.abs(a.pct).toFixed(2)}%</span></span></button></li>`);
  }
  document.getElementById('list').innerHTML = rows.join('');
  document.getElementById('asof').textContent = latest ? latest.slice(5).replace('-', '/') : '';
  document.getElementById('note').textContent = missing ? '有股票尚未載入，開啟完整頁面就會更新。' : '點股票開啟完整頁面。';
  document.getElementById('list').addEventListener('click', (e) => {
    const b = e.target.closest('[data-id]');
    if (b) open('#' + b.dataset.id);
  });
  chrome.action.setBadgeText({ text: '' });
}

init();

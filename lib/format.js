// 畫面共用的格式工具
import { priceDigits } from './indicators.js';

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const fmtP = (p, dg) => (p == null || Number.isNaN(p) ? '–' : p.toLocaleString('en-US', { minimumFractionDigits: dg ?? priceDigits(p), maximumFractionDigits: dg ?? priceDigits(p) }));
export const fmtInt = (n) => (n == null || Number.isNaN(n) ? '–' : Math.round(n).toLocaleString('en-US'));
export const sInt = (n) => (n == null ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('en-US'));
export const sPct = (n, dg = 2) => (n == null || Number.isNaN(n) ? '–' : (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(dg) + '%');
export const tone = (n) => (n > 0 ? 'up' : n < 0 ? 'down' : '');
export const arrow = (n) => (n > 0 ? '▲ ' : n < 0 ? '▼ ' : '');
export const md = (date) => (date ? date.slice(5, 10).replace('-', '/') : '');
export const ymd = (date) => (date ? date.slice(0, 10).replaceAll('-', '/') : '');
export const fmtCorr = (c) => (c == null || Number.isNaN(c) ? '–' : c.toFixed(2));

export function palette() {
  const cs = getComputedStyle(document.documentElement);
  const v = (k) => cs.getPropertyValue(k).trim();
  return { up: v('--up'), down: v('--down'), ma: [v('--ma1'), v('--ma2'), v('--ma3')] };
}

// 分段按鈕
export function segHTML(items, current) {
  return items.map((it) => `<button type="button" data-v="${esc(it.v)}" aria-pressed="${it.v === current}">${esc(it.l)}</button>`).join('');
}

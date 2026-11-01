// 字體大小：標準／大／特大，整頁等比例放大（含版面與圖表），設定跨電腦同步
export const SCALES = [
  { v: 1, l: '標準' },
  { v: 1.2, l: '大' },
  { v: 1.4, l: '特大' },
];
let cur = 1;
export const uiScale = () => cur;
function apply(v) {
  document.body.style.zoom = String(v);
  document.documentElement.dataset.scale = String(v);
  document.documentElement.style.setProperty('--scale', String(v));
  cur = v;
  window.dispatchEvent(new Event('scalechange'));
  for (const b of document.querySelectorAll('[data-scale]')) b.setAttribute('aria-pressed', String(Number(b.dataset.scale) === v));
  window.dispatchEvent(new Event('resize'));
}
export async function initScale() {
  let v = 1;
  try { v = Number((await chrome.storage.sync.get('fontScale')).fontScale) || 1; } catch (e) { /* 預設 */ }
  apply(v);
  const box = document.getElementById('scaleSeg');
  if (box) {
    box.innerHTML = SCALES.map((s, i) => `<button type="button" data-scale="${s.v}" aria-pressed="${s.v === v}" style="font-size:${14 + i * 3}px" aria-label="字體${s.l}">A</button>`).join('');
    box.addEventListener('click', (e) => {
      const b = e.target.closest('[data-scale]');
      if (!b) return;
      const nv = Number(b.dataset.scale);
      apply(nv);
      chrome.storage.sync.set({ fontScale: nv });
    });
  }
  // 其他頁面（或另一個分頁）改了，這裡跟著變
  chrome.storage.onChanged.addListener((ch, area) => { if (area === 'sync' && ch.fontScale) apply(Number(ch.fontScale.newValue) || 1); });
}

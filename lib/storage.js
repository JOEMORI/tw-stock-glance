// 自選股與設定存在 chrome.storage.sync（跨電腦同步），token 與行情快取存在 local。
export const DEFAULT_WATCH = ['2330', '2454', '3661'];

const DEFAULT_SETTINGS = { convention: 'tw', notify: true };

export async function getWatchlist() {
  const { watchlist } = await chrome.storage.sync.get('watchlist');
  return Array.isArray(watchlist) ? watchlist : DEFAULT_WATCH.slice();
}

export async function setWatchlist(list) {
  await chrome.storage.sync.set({ watchlist: list });
}

export async function getSettings() {
  const { settings } = await chrome.storage.sync.get('settings');
  const { token } = await chrome.storage.local.get('token');
  return { ...DEFAULT_SETTINGS, ...(settings || {}), token: token || '' };
}

export async function setSettings(patch) {
  const { token, ...rest } = patch;
  if (token !== undefined) await chrome.storage.local.set({ token: token.trim() });
  if (Object.keys(rest).length) {
    const { settings } = await chrome.storage.sync.get('settings');
    await chrome.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, ...(settings || {}), ...rest } });
  }
}

// 只列出本機快取的鍵名，不讀內容（全市場行情很大，整包讀出來要好幾秒）
export async function localKeys() {
  if (chrome.storage.local.getKeys) return chrome.storage.local.getKeys();
  return Object.keys(await chrome.storage.local.get(null));
}

// 觀察清單：不是持股、但想追蹤的公司（跨電腦同步）
export async function getObserve() {
  const { observe } = await chrome.storage.sync.get('observe');
  return Array.isArray(observe) ? observe : [];
}
export async function setObserve(list) {
  await chrome.storage.sync.set({ observe: [...new Set(list)] });
}
// 情報雷達關鍵字
export async function getKeywords() {
  const { intelKw } = await chrome.storage.sync.get('intelKw');
  return Array.isArray(intelKw) ? intelKw : [];
}
export async function setKeywords(list) {
  await chrome.storage.sync.set({ intelKw: [...new Set(list.filter(Boolean))] });
}

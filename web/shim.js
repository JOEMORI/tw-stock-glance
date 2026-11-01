// 手機網頁版：用 localStorage 模擬 chrome.storage，讓插件的資料模組可以直接重用。
const area = (prefix) => ({
  async get(keys) {
    const all = keys == null;
    const ks = all ? Object.keys(localStorage).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)) : typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
    const out = {};
    for (const k of ks) { const v = localStorage.getItem(prefix + k); if (v != null) try { out[k] = JSON.parse(v); } catch (e) { /* 略過 */ } }
    return out;
  },
  async set(obj) {
    for (const [k, v] of Object.entries(obj)) {
      try { localStorage.setItem(prefix + k, JSON.stringify(v)); }
      catch (e) {
        // 空間不足：清掉非自選股的個股快取後再試一次
        for (const kk of Object.keys(localStorage)) if (kk.startsWith('L:stock:') || kk.startsWith('L:entL:') || kk.startsWith('L:gn:')) localStorage.removeItem(kk);
        try { localStorage.setItem(prefix + k, JSON.stringify(v)); } catch (e2) { /* 放棄 */ }
      }
    }
  },
  async remove(keys) { for (const k of [].concat(keys)) localStorage.removeItem(prefix + k); },
  async getKeys() { return Object.keys(localStorage).filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)); },
});
globalThis.chrome = globalThis.chrome || {};
globalThis.chrome.storage = { local: area('L:'), sync: area('S:'), onChanged: { addListener() {} } };

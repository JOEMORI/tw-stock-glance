// 在 Node（GitHub Actions）裡模擬 chrome.storage，讓插件的資料模組可以直接重用。資料存在一個 JSON 檔。
import fs from 'node:fs';
import path from 'node:path';

export function installChrome(file) {
  let data = {};
  try { data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { data = {}; }
  const save = () => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data)); };
  const area = {
    async get(keys) {
      if (keys == null) return { ...data };
      const ks = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(obj) { Object.assign(data, structuredClone(obj)); save(); },
    async remove(keys) { for (const k of [].concat(keys)) delete data[k]; save(); },
    async getKeys() { return Object.keys(data); },
  };
  globalThis.chrome = { storage: { local: area, sync: area, onChanged: { addListener() {} } } };
  return { save };
}

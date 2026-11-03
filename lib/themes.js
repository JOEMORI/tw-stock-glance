// 題材雷達的題材字典：中文關鍵字（台灣新聞、PTT）、英文關鍵字（國外新聞）、台股成分股、美股對照。
// 台股成分股沿用族群強弱的 THEMES，另外加上幾個新題材。可自行增刪，代號會在整理資料時檢查是否存在。
import { THEMES } from './sectors.js';

const BASE = Object.fromEntries(THEMES.map((t) => [t.name, t.ids]));

export const THEME_DEFS = [
  { name: '低軌衛星', zh: ['低軌衛星', '衛星通訊', '星鏈'], en: ['Starlink', 'Kuiper satellite', 'low earth orbit satellite', 'satellite broadband'], ids: ['2313', '3491', '6285', '2314', '3138', '6271', '3105', '2312'], us: ['ASTS', 'IRDM', 'RKLB', 'VSAT'] },
  { name: 'AI 伺服器', zh: ['AI 伺服器', 'GB300', 'GB200', '輝達伺服器'], en: ['AI server', 'Nvidia GB300', 'Blackwell server'], ids: BASE['AI 伺服器'], us: ['NVDA', 'SMCI', 'DELL'] },
  { name: 'ASIC / IP 設計服務', zh: ['ASIC', '客製化晶片', '自研晶片'], en: ['custom ASIC', 'AI accelerator chip', 'Trainium', 'TPU'], ids: BASE['ASIC / IP 設計服務'], us: ['AVGO', 'MRVL'] },
  { name: '晶圓代工', zh: ['晶圓代工', '先進製程', '2奈米'], en: ['TSMC', 'foundry 2nm'], ids: BASE['晶圓代工'], us: ['TSM', 'INTC'] },
  { name: '封測 / 先進封裝', zh: ['CoWoS', '先進封裝', 'SoIC', '面板級封裝'], en: ['CoWoS', 'advanced packaging', 'chiplet packaging'], ids: BASE['封測 / 先進封裝'], us: ['AMKR', 'AMAT'] },
  { name: '散熱', zh: ['液冷', '散熱', '水冷'], en: ['liquid cooling data center', 'immersion cooling'], ids: BASE['散熱'], us: ['VRT'] },
  { name: '矽光子 / CPO', zh: ['矽光子', 'CPO', '共同封裝光學', '光通訊'], en: ['silicon photonics', 'co-packaged optics', 'optical transceiver'], ids: BASE['矽光子 / CPO'], us: ['COHR', 'LITE', 'FN'] },
  { name: 'PCB / CCL', zh: ['ABF 載板', 'PCB', '銅箔基板', 'CCL'], en: ['ABF substrate', 'printed circuit board AI'], ids: BASE['PCB / CCL'], us: ['TTMI'] },
  { name: '記憶體', zh: ['記憶體', 'DRAM', 'HBM', 'NAND'], en: ['DRAM prices', 'HBM memory', 'NAND prices'], ids: BASE['記憶體'], us: ['MU', 'WDC'] },
  { name: '重電', zh: ['重電', '電網', '變壓器', '台電強韌電網'], en: ['power grid transformer', 'grid equipment demand'], ids: BASE['重電'], us: ['GEV', 'ETN', 'VRT'] },
  { name: '機器人', zh: ['人形機器人', '機器人', '減速機'], en: ['humanoid robot', 'Optimus robot', 'robotics actuator'], ids: BASE['機器人'], us: ['TSLA', 'ISRG'] },
  { name: '無人機 / 國防', zh: ['無人機', '非紅供應鏈', '軍工股'], en: ['drone maker', 'defense drone', 'military drones Taiwan'], ids: ['2634', '8033', '2645', '4572', '5222'], us: ['AVAV', 'KTOS', 'RCAT'] },
  { name: '減重新藥', zh: ['減重藥', 'GLP-1', '瘦瘦針'], en: ['GLP-1 obesity drug', 'weight loss drug'], ids: ['1795', '6446', '4743', '6472', '4147'], us: ['LLY', 'NVO'] },
  { name: '航運', zh: ['航運', '運價', '貨櫃'], en: ['container shipping rates', 'freight rates'], ids: BASE['航運'], us: ['ZIM', 'MATX'] },
];

// 從新聞或 PTT 標題判斷提到哪些題材
export function matchThemes(text) {
  const t = String(text || '');
  return THEME_DEFS.filter((d) => d.zh.some((k) => t.includes(k)) || d.en.some((k) => t.toLowerCase().includes(k.toLowerCase()))).map((d) => d.name);
}

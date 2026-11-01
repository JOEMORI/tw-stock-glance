// FinMind 還沒有最新一天時，用交易所的最新交易日明細（market.js ensureDetail）補上。
// 不寫回快取：FinMind 之後更新到同一天，就自然以 FinMind 為準。
export function patchData(data, d, id) {
  if (!d || !data?.price?.length) return data;
  const p = d.p?.[id];
  if (!p || d.date <= data.price.at(-1)[0]) return data;
  const out = { ...data, price: [...data.price, [d.date, ...p]], patched: d.date };
  const i = d.i?.[id];
  if (i && !(data.inst || []).some((r) => r.date === d.date)) {
    out.inst = [...(data.inst || []),
      { date: d.date, name: 'Foreign_Investor', buy: i[0], sell: 0 },
      { date: d.date, name: 'Investment_Trust', buy: i[1], sell: 0 },
      { date: d.date, name: 'Dealer_self', buy: i[2], sell: 0 }];
  }
  return out;
}

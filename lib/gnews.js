// Google 新聞 RSS（繁中台灣版）。只在頁面中使用（需要 DOMParser）。快取 3 小時。
const TTL = 3 * 3600 * 1000;
const FORUM = /股市爆料同學會|PTT|Mobile01|Dcard|論壇/i;

export async function googleNews(query, { days = 4, limit = 6 } = {}) {
  const key = 'gn:' + query;
  const { [key]: cached } = await chrome.storage.local.get(key);
  let items = cached && Date.now() - cached.at < TTL ? cached.items : null;
  if (!items) {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query + ' when:' + days + 'd')}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const doc = new DOMParser().parseFromString(await r.text(), 'text/xml');
      items = [...doc.querySelectorAll('item')].map((it) => {
        const source = it.querySelector('source')?.textContent || '';
        let title = it.querySelector('title')?.textContent || '';
        if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3));
        const pub = new Date(it.querySelector('pubDate')?.textContent || 0);
        return { title, link: it.querySelector('link')?.textContent || '', source, date: isNaN(pub) ? '' : pub.toISOString() };
      }).filter((x) => x.title && /^https:\/\//.test(x.link) && !FORUM.test(x.source + x.title));
      await chrome.storage.local.set({ [key]: { at: Date.now(), items } });
    } catch (e) {
      items = cached?.items || [];
    }
  }
  return items.slice().sort((a, b) => (a.date < b.date ? 1 : -1)).slice(0, limit);
}

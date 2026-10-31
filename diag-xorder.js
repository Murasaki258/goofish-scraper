// Validate the x-order gallery rule on single items before a full run.
// Usage: node diag-xorder.js <itemId> [itemId ...]
import { chromium } from 'playwright';
import fs from 'node:fs';

const ids = process.argv.slice(2);
if (!ids.length) {
  console.error('Usage: node diag-xorder.js <itemId> [itemId ...]');
  process.exit(1);
}
const chromiumPath = process.env.CHROMIUM_PATH
  || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
const browser = await chromium.launch({
  headless: false,
  ...(chromiumPath ? { executablePath: chromiumPath } : {}),
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled', '--window-size=1280,900'],
});
const context = await browser.newContext({
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36',
  locale: 'zh-CN',
  timezoneId: 'Asia/Shanghai',
});
await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  window.chrome = { runtime: {} };
});
const page = await context.newPage();
for (const itemId of ids) {
  await page.goto(`https://www.goofish.com/item?id=${itemId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(15000);
  const res = await page.evaluate(() => {
    const large = [...document.querySelectorAll('img')].map(img => {
      const r = img.getBoundingClientRect();
      return { src: img.currentSrc || img.src || '', w: r.width, h: r.height, x: r.x, y: r.y };
    }).filter(i => i.w >= 300 && i.h >= 400 && i.x >= 0).sort((a, b) => a.x - b.x);
    const bases = large.map(i => i.src.split('.jpg')[0] + '.jpg');
    const seen = new Set(); const g = [];
    for (const b of bases) { if (seen.has(b)) break; seen.add(b); g.push(b); }
    return { largeCount: large.length, large: large.map(i => ({ x: Math.round(i.x), y: Math.round(i.y), src: i.src.slice(0, 120) })), gallery: g, galleryCount: g.length };
  });
  console.log(`\n=== ${itemId} large=${res.largeCount} gallery=${res.galleryCount} ===`);
  console.log(res.large.map(i => `${i.x},${i.y} ${i.src}`).join('\n'));
  console.log('GALLERY:');
  console.log(res.gallery.join('\n'));
}
await browser.close();
console.log('Diag xorder done');

// Collect a seller shop's item list from the public shop page.
// Usage: node collect-shop.js <userId> [outDir]
// Output: <outDir>/shop-items.json  ([{ itemId, url }])
//         <outDir>/shop-info.json   (title, whether the on-sale tab was clicked, count)
//
// How it works, and why (all learned the hard way on 2026-10-31):
// - Close the login modal via JS first: clicking through the overlay fails
//   in Playwright, and the modal blocks the tab click.
// - JS-click the "在售" (on-sale) tab when it exists, so the list is
//   on-sale only. Some shops have NO on-sale/sold tabs at all (only "宝贝 N"):
//   then the tab click returns false and the collected list is simply all
//   items visible on the shop page; filter by status later in download-items.js.
// - Paginate with window.scrollTo, NOT mouse.wheel: mouse.wheel did not move
//   this page, while window.scrollTo grows the list by ~20 items per round.
//   Stop when the count is stable for 2 consecutive rounds.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const userId = process.argv[2];
if (!userId) {
  console.error('Usage: node collect-shop.js <userId> [outDir]');
  process.exit(1);
}
const outRoot = path.resolve(process.argv[3] || 'out-shop');
fs.mkdirSync(outRoot, { recursive: true });

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

await page.goto(`https://www.goofish.com/personal?userId=${userId}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(8000);
const clicked = await page.evaluate(() => {
  for (const el of document.querySelectorAll('div')) {
    if (el.textContent && el.textContent.includes('短信登录') && el.textContent.includes('手机扫码安全登录')) { el.remove(); }
  }
  const tabs = [...document.querySelectorAll('div')].filter(el => el.textContent && (el.textContent.trim().startsWith('在售') || el.textContent.trim() === '在售'));
  for (const t of tabs) { t.click(); return true; }
  return false;
});
console.log('Clicked on-sale tab via JS:', clicked);
await page.waitForTimeout(5000);

let last = -1, stable = 0, items = [];
for (let round = 1; round <= 20; round++) {
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await page.waitForTimeout(3000);
  items = await page.evaluate(() => {
    const seen = new Map();
    for (const a of document.querySelectorAll('a[href*="/item?id="]')) {
      const m = a.href.match(/id=(\d+)/);
      if (!m) continue;
      if (!seen.has(m[1])) seen.set(m[1], a.href.startsWith('http') ? a.href : 'https://www.goofish.com' + a.href);
    }
    return [...seen.entries()].map(([itemId, url]) => ({ itemId, url }));
  });
  console.log(`Shop scroll round ${round}: ${items.length} unique items`);
  if (items.length === last) { stable++; if (stable >= 2) break; } else { stable = 0; last = items.length; }
}
const info = await page.evaluate(() => ({ title: document.title, bodyText: (document.body ? document.body.innerText : '').slice(0, 2000) }));
console.log('Shop title:', info.title);
console.log('Shop items collected:', items.length);
fs.writeFileSync(path.join(outRoot, 'shop-items.json'), JSON.stringify(items, null, 2));
fs.writeFileSync(path.join(outRoot, 'shop-info.json'), JSON.stringify({ userId, title: info.title, onSaleTabClicked: clicked, itemCount: items.length, bodyText: info.bodyText }, null, 2));
await browser.close();
console.log('Collect shop done');

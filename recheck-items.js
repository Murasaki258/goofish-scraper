// Re-derive description + status for an already-downloaded output dir,
// without re-downloading images. Use this when a shop's detail pages use
// a different layout from the one download-items.js was written for
// (e.g. a shop with no "运费由卖家承担" anchor, or sold items that only
// say "卖掉了" and were left as "unknown").
// Usage: node recheck-items.js <shop-items.json> [outDir]
// Updates <outDir>/items/<itemId>/meta.json and <outDir>/index.json in place.
// The description/status rules are the same as in download-items.js.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const shopItemsPath = process.argv[2];
if (!shopItemsPath) {
  console.error('Usage: node recheck-items.js <shop-items.json> [outDir]');
  process.exit(1);
}
const outRoot = path.resolve(process.argv[3] || 'out');
const shopItems = JSON.parse(fs.readFileSync(path.resolve(shopItemsPath), 'utf-8'));

function parse(text) {
  const recIdx = text.indexOf('为你推荐');
  const head = recIdx >= 0 ? text.slice(0, recIdx) : text;
  const status = (head.includes('卖掉了') || /已售出|已下架|宝贝不存在|已卖出/.test(head)) ? 'sold'
    : (/聊一聊|立即购买/.test(head) ? 'on_sale' : 'unknown');
  let desc = '';
  const dm = text.match(/运费由卖家承担\s*([\s\S]*?)\s*聊一聊/);
  if (dm) desc = dm[1].trim();
  if (!desc) {
    const bi = head.indexOf('浏览\n');
    if (bi >= 0) {
      let seg = head.slice(bi + 3);
      for (const cut of ['\n卖掉了', '\n聊一聊', '\n立即购买']) {
        const ci = seg.indexOf(cut);
        if (ci >= 0) seg = seg.slice(0, ci);
      }
      seg = seg.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s*：/g, '$1$2$3$4：');
      seg = seg.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s*：/g, '$1$2：');
      desc = seg.replace(/\s+/g, ' ').trim();
    }
  }
  return { status, desc };
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
let index = JSON.parse(fs.readFileSync(path.join(outRoot, 'index.json'), 'utf-8'));
for (const [idx, target] of shopItems.entries()) {
  console.log(`\n[${idx + 1}/${shopItems.length}] ${target.itemId}`);
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(12000);
    const text = await page.evaluate(() => document.body ? document.body.innerText : '');
    const r = parse(text);
    console.log(`  status=${r.status} descLen=${r.desc.length} desc=${r.desc.slice(0, 80)}`);
    const metaPath = path.join(outRoot, 'items', target.itemId, 'meta.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    meta.description = r.desc;
    meta.status = r.status;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
    const row = index.find(x => x.itemId === target.itemId);
    if (row) row.status = r.status;
    fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index, null, 2));
  } catch (e) { console.log('  ERROR', String(e.message).slice(0, 200)); }
}
await browser.close();
console.log('\nDone. Status counts:', JSON.stringify(index.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {})));

// Download every item in a shop-items.json list: title, price, description
// and ALL gallery images, in gallery order.
// Usage: node download-items.js <shop-items.json> [outDir]
// Output: <outDir>/index.json, <outDir>/items/<itemId>/{meta.json, 01.jpg, 02.jpg, ...}
// Resumable: items already complete in <outDir>/index.json (downloaded == imageCount) are skipped.
//
// Gallery rule (the key finding, validated 2026-10-31 on 3 items and then
// on a full 89-item shop: 573 images, 0 zero-image items):
// - The detail gallery is a horizontal carousel. Only the current slide plus
//   clones are in the DOM, so a plain DOM img dump can NEVER give the full
//   gallery, and scrolling before collection breaks the carousel state.
// - Do NOT scroll before collection. Take the large main-carousel images
//   (width >= 300, height >= 400, x >= 0), sort by x coordinate, and dedupe
//   until the first repeat: the leading clone sits at x < 0, the true gallery
//   starts at x >= 0 and repeats after the last image.
// - Image bases: strip the size suffix after ".jpg" to get the original file.
//   Older items use "-0-fleamarket.jpg", newer ones "-0-xy_item.jpg".
// - Wait 15s after domcontentloaded before collecting; longer waits did NOT
//   fix undercounts in earlier versions, the x-order rule is what fixed them.
// - Description, two page layouts (a second shop on 2026-10-31 had NO
//   "运费由卖家承担" anchor at all, so the old rule returned empty for all
//   67 items):
//   1. First layout: text between "运费由卖家承担" and "聊一聊".
//   2. New layout: text after "浏览\n", before "为你推荐", cut at
//      "卖掉了"/"聊一聊"/"立即购买"; spaced single-char field names are
//      joined ("功 能 状 态 ：" -> "功能状态：") and whitespace collapsed.
//   Try layout 1 first, then layout 2. If both are empty, verify.py will
//   list the item -- do not silently ship it without a description.
// - Status, also fixed for the second shop (old rule left 19/67 "unknown"):
//   sold if "卖掉了" appears before "为你推荐", or if the page says
//   已售出/已下架/宝贝不存在/已卖出; else on_sale if "聊一聊" or "立即购买"
//   is present; else unknown. "unknown" must NOT be treated as on_sale:
//   spot-checks showed unknown items were in fact sold. Final delivery
//   should filter on status == "on_sale" only. Use recheck-items.js to
//   re-derive description + status for an already-downloaded output dir
//   without re-downloading images.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const shopItemsPath = process.argv[2];
if (!shopItemsPath) {
  console.error('Usage: node download-items.js <shop-items.json> [outDir]');
  process.exit(1);
}
const outRoot = path.resolve(process.argv[3] || 'out');
fs.mkdirSync(outRoot, { recursive: true });
const shopItems = JSON.parse(fs.readFileSync(path.resolve(shopItemsPath), 'utf-8'));
let index = [];
try { index = JSON.parse(fs.readFileSync(path.join(outRoot, 'index.json'), 'utf-8')); } catch {}
const done = new Set(index.filter(x => x.downloaded === x.imageCount).map(x => x.itemId));
console.log('Items:', shopItems.length, 'already complete, skipping:', done.size);

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

for (const [idx, target] of shopItems.entries()) {
  if (done.has(target.itemId)) { console.log(`[${idx + 1}/${shopItems.length}] ${target.itemId} SKIP (already complete)`); continue; }
  const itemDir = path.join(outRoot, 'items', target.itemId);
  fs.mkdirSync(itemDir, { recursive: true });
  console.log(`\n[${idx + 1}/${shopItems.length}] ${target.itemId}`);
  try {
    await page.goto(target.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(15000);
    const detail = await page.evaluate(() => {
      const title = document.title.replace(/_闲鱼$/, '');
      const text = document.body ? document.body.innerText : '';
      const priceMatch = text.match(/¥\s*([\d,\.]+)/);
      const large = [...document.querySelectorAll('img')].map(img => {
        const r = img.getBoundingClientRect();
        return { src: img.currentSrc || img.src || '', w: r.width, h: r.height, x: r.x };
      }).filter(i => i.w >= 300 && i.h >= 400 && i.x >= 0).sort((a, b) => a.x - b.x);
      const bases = large.map(i => {
        const s = i.src;
        const m = s.match(/^(.*-0-(?:fleamarket|xy_item)\.jpg)/);
        return m ? m[1] : s.split('.jpg')[0] + '.jpg';
      });
      const seen = new Set(); const g = [];
      for (const b of bases) { if (seen.has(b)) break; seen.add(b); g.push(b); }
      // Status + description share the "before 为你推荐" head: recommendations
      // below it can contain sold/chat words from other items.
      const recIdx = text.indexOf('为你推荐');
      const head = recIdx >= 0 ? text.slice(0, recIdx) : text;
      const status = (head.includes('卖掉了') || /已售出|已下架|宝贝不存在|已卖出/.test(head)) ? 'sold'
        : (/聊一聊|立即购买/.test(head) ? 'on_sale' : 'unknown');
      let description = '';
      const dm = text.match(/运费由卖家承担\s*([\s\S]*?)\s*聊一聊/);
      if (dm) description = dm[1].trim();
      if (!description) {
        const bi = head.indexOf('浏览\n');
        if (bi >= 0) {
          let seg = head.slice(bi + 3);
          for (const cut of ['\n卖掉了', '\n聊一聊', '\n立即购买']) {
            const ci = seg.indexOf(cut);
            if (ci >= 0) seg = seg.slice(0, ci);
          }
          seg = seg.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s*：/g, '$1$2$3$4：');
          seg = seg.replace(/([\u4e00-\u9fff])\s+([\u4e00-\u9fff])\s*：/g, '$1$2：');
          description = seg.replace(/\s+/g, ' ').trim();
        }
      }
      return { title, price: priceMatch ? priceMatch[1] : '', description, gallery: g, largeCount: large.length, status };
    });
    const description = detail.description;
    console.log(`  title=${detail.title} price=${detail.price} large=${detail.largeCount} gallery=${detail.gallery.length} status=${detail.status} descLen=${description.length}`);
    fs.writeFileSync(path.join(itemDir, 'meta.json'), JSON.stringify({ itemId: target.itemId, url: target.url, title: detail.title, price: detail.price, description, status: detail.status, imageUrls: detail.gallery, imageCount: detail.gallery.length }, null, 2));
    let downloaded = 0;
    for (const [i, imgUrl] of detail.gallery.entries()) {
      try {
        const res = await context.request.get(imgUrl, { timeout: 30000 });
        if (!res.ok()) continue;
        fs.writeFileSync(path.join(itemDir, `${String(i + 1).padStart(2, '0')}.jpg`), await res.body());
        downloaded++;
      } catch {}
    }
    console.log(`  downloaded ${downloaded}/${detail.gallery.length}`);
    index = index.filter(x => x.itemId !== target.itemId);
    index.push({ itemId: target.itemId, url: target.url, title: detail.title, price: detail.price, status: detail.status, imageCount: detail.gallery.length, downloaded, folder: `items/${target.itemId}` });
  } catch (e) {
    console.log('  ITEM ERROR', String(e.message).slice(0, 300));
    index = index.filter(x => x.itemId !== target.itemId);
    index.push({ itemId: target.itemId, url: target.url, title: '', price: '', status: 'error', imageCount: 0, downloaded: 0, folder: `items/${target.itemId}`, error: String(e.message).slice(0, 300) });
  }
  fs.writeFileSync(path.join(outRoot, 'index.json'), JSON.stringify(index, null, 2));
}
await browser.close();
console.log(`\nDone. Items: ${index.length}, total images downloaded: ${index.reduce((s, x) => s + x.downloaded, 0)}`);
console.log('Status counts:', JSON.stringify(index.reduce((a, x) => { a[x.status] = (a[x.status] || 0) + 1; return a; }, {})));

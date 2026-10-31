# 闲鱼（Goofish）店铺爬虫

爬自己店铺的在售商品：标题、价格、描述、全部画廊图片，按商品分文件夹，图片按画廊顺序编号。只用公开店铺页和详情页，不登录、不存任何账号密码或 cookie。

验证过的成绩（2026-10-31）：一个 89 件在售的店铺，**573 张图，0 件空图**，每件下载数都等于图数。

## 输出格式

```
out/
  index.json                  # 一行一件的清单
  items/<商品ID>/
    meta.json                 # itemId、url、title、price、description、status、imageUrls、imageCount
    01.jpg, 02.jpg, ...       # 顺序与 meta.json 里的 imageUrls 一致
```

`meta.json` 里的 `itemId` 本身就是链接：`https://www.goofish.com/item?id=<itemId>`。

## 环境要求

- Node 20+，`npm install`（依赖只有 `playwright`）
- **必须有图形界面下的 Chromium**：脚本用 `headless: false` 启动。
  - 有系统 Chromium 时：`CHROMIUM_PATH=/usr/bin/chromium`，或直接放默认路径 `/usr/bin/chromium`（脚本会自动用它）
  - 没有系统 Chromium 时：`npx playwright install chromium`，再不设 `CHROMIUM_PATH`，让 Playwright 用自己下载的 Chromium
  - 无图形界面的服务器：用 `xvfb-run -a node ...` 包起来跑
- 网络必须直连 Goofish。**不要**走会拦截 Chromium 的出口代理：曾实测本机 Playwright Chromium 走代理时所有网站都报隧道失败，而 curl 同一地址返回 200 —— 那是代理不兼容，不是店铺封禁，换直连机器就能解决。

## 用法

```bash
npm install

# 1. 采店铺清单（userId 是店铺页链接里的数字）
xvfb-run -a node collect-shop.js <userId> out-shop

# 2. 逐件下载（可断点续跑：index.json 里 downloaded == imageCount 的件会自动跳过）
xvfb-run -a node download-items.js out-shop/shop-items.json out

# 3. 核对
python3 verify.py out

# 4. 已下载完才发现描述/状态不对时，不用重下图片，只重取这两项
xvfb-run -a node recheck-items.js out-shop/shop-items.json out
python3 verify.py out
```

全量跑很慢：89 件约 20 多分钟（每件详情页等 15 秒 + 逐图下载），不要中途改脚本重跑，续跑靠 `index.json`。

## 关键坑（都是实测踩过的，换环境时别再摸索一遍）

1. **无头模式会被识别**：headless 下店铺页标题会变成“我的闲鱼”、0 个商品链接，详情页提示非法访问。必须 headed + 隐藏 automation 特征（脚本里已做：`--disable-blink-features=AutomationControlled` + `navigator.webdriver` 置空）。
2. **登录弹窗要 JS 关**：弹窗遮挡时 Playwright 点不穿，先用 JS 删掉含“短信登录 / 手机扫码安全登录”的弹窗，再 JS 点“在售”标签。
3. **店铺翻页用 `window.scrollTo`，不用 `mouse.wheel`**：后者在这个页面上根本滚不动；前者每轮约 +20 件，连续 2 轮数量不变即停。
4. **画廊不能靠 DOM 图片清单**：详情页画廊是横向轮播，DOM 里只有当前图 + 克隆图，源码里也没有完整 `picList`。正确做法见 `download-items.js`：**采集前不要滚动**，取大图（宽 ≥300、高 ≥400、x ≥0）按 x 坐标排序，遇到第一个重复底图即停；开头的克隆图在 x < 0，会被 x ≥ 0 过滤掉。
5. **图片原图**：去掉 `.jpg` 后的尺寸后缀即原图。老商品是 `-0-fleamarket.jpg`，新商品是 `-0-xy_item.jpg`，两种都要认。
6. **等再久也修不好少图**：早期版本（v5/v6）只拿到 1–3 张时，加到 20 秒 + 滚动轮询也没用，问题在画廊规则不在等待时间。不要往这个方向再试。
7. **没有“在售”标签的店铺**：有的店铺页根本没有在售 / 已售切换，只有“宝贝 N”。这时 `collect-shop.js` 会提示 `Clicked on-sale tab via JS: false`，采到的是全部商品；下载时每件详情页会记 `status`，最后按 `status == on_sale` 筛选，不要直接把全部当在售。
8. **描述有两种页面结构**：第一家店是取“运费由卖家承担”和“聊一聊”之间的文本；第二家店根本没有这个锚点，按旧方法 67 件描述全空。现版脚本先试第一种，再试第二种：取“浏览”之后、“为你推荐”之前，截到“卖掉了 / 聊一聊 / 立即购买”为止，并把拆开的结构化字段拼回去（“功 能 状 态”→“功能状态”）。个别商品页没有这个锚点时描述会为空，`verify.py` 会列出空描述的件。
9. **状态不能只认“立即购买”，unknown 更不能当在售**：第二家店按旧规则是 48 件在售 + 19 件 unknown，抽查 unknown 发现详情页上都写着“卖掉了”。现版规则是：在“为你推荐”之前出现“卖掉了”或已售出 / 已下架 / 宝贝不存在 / 已卖出，判 `sold`；否则有“聊一聊”或“立即购买”判 `on_sale`；否则 `unknown`。最终交付只取 `on_sale`，unknown 要逐件核对，不能默认在售。
10. **已下载的店发现描述/状态错了不用重跑下载**：用 `recheck-items.js`，只重访详情页改每件 meta 里的描述和状态、更新 index，图片不重新下载。

## 文件说明

- `collect-shop.js`：店铺清单采集
- `download-items.js`：逐件下载（最终版，含两种描述结构和新的状态规则）
- `recheck-items.js`：已下载目录的描述 + 状态重取，不重下图片
- `diag-xorder.js`：单件验证 x 坐标画廊法，`node diag-xorder.js <商品ID>`，全量跑之前先用它确认规则在新环境还成立
- `verify.py`：核对 index / meta / 磁盘文件数，列出空描述、空图和状态分布（`unknown` 单独看，不要当在售）

## 不包含的东西

- 不含任何已下载的商品图片和商品数据（`.gitignore` 已排除 `out*/` 和 `*.jpg`）
- 不含任何账号、密码、cookie、token、SSH 配置 —— 换环境时只改 `CHROMIUM_PATH` 和 `userId` 两个参数

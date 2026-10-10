# EPUB → Markdown（Frontmatter 构造器）

把单本 EPUB 转成一份可直接入库的 Markdown：目录锚点、正文清洗、封面与插图上传图床，
并按照目标主题的字段规范**构造 frontmatter**。

上传 EPUB 后还能顺着书里的线索去公开书目库自动检索「作者 / 日文原名 / 日文版发售日 /
ISBN / 出版社 / 书目来源 URL」，以候选卡片列出，点「采用」才写回表单。

纯静态前端，无构建步骤，可直接部署到 Cloudflare Pages 或 Vercel（图片上传走一层同源转发，
见「图床」一节，由平台自带的 Function 承担，不需要你写服务端）。

## 目录结构

```
epub-to-md/
├── index.html          # 界面
├── styles.css          # 样式
├── app.js              # 界面装配（表单、缓存、下载）
├── src/
│   ├── converter.js    # EPUB 解析 / 正文渲染 / 产物组装
│   ├── frontmatter.js  # ★ Frontmatter 构造与自检（本项目核心）
│   ├── lookup.js       # 书目信息自动检索（NDL / openBD / 维基）
│   ├── xml.js          # XML/DOM 小工具（converter 与 lookup 共用）
│   └── images.js       # 图床上传 + 稳定时间派生
├── functions/upload.js # Cloudflare Pages Function：同源上传代理
├── api/upload.js       # Vercel Function：同源上传代理（vercel.json 把 /upload 重写到它）
├── dev.mjs             # 本地开发服务器：静态文件 + 同源上传代理
├── vendor/fflate.js    # ZIP/DEFLATE 解压库（本地 vendor，无 CDN、无外链）
├── vercel.json         # Vercel 配置
└── _headers            # Cloudflare Pages 响应头配置
```

## Frontmatter 构造要求

构造逻辑集中在 [src/frontmatter.js](src/frontmatter.js)，两套方案：

| 方案 | 适用 | 输出字段（固定顺序） |
| --- | --- | --- |
| `shirone`（默认） | Shirone(Astro) 主题 `posts` 集合 | `title` → `description` → `image` → `tags` → `category` → `published` → `pinned` |
| `generic` | Hexo（通用兼容） | `title` → `author` → `publisher` → `cover` → `tags` → `categories` → `date` |

共同遵守的规则：

1. 必填字段（`title`、`published`）缺失即报错，绝不静默补空。
2. 字符串一律双引号包裹，避免冒号、井号、日期被 YAML 误解析。
3. `tags` 固定以「轻小说」开头，随后是系列名、日文原名，再并入自定义标签，去重去空。
4. 封面必须是 HTTPS 直链（图床）。
5. `published` / `date` 输出为 YAML 时间戳，可被主题的 `z.date()` 解析。
6. Shirone 方案**不输出** Hexo 遗留字段（`author` / `publisher` / `cover` / `categories` / `date`），
   作者信息写入正文 `**作者：** …`。
7. `description` **始终输出**：EPUB 没有 `dc:description`、你也没填时写 `description: ""`，
   不省略字段、也不从正文里替你摘一段当简介。

时间派生：`published = 发售日 + 1 天`，时分秒 = `SHA-256(EPUB字节 + 发售日 + 日文原名)` 前 4 字节 `% 86400`，
因此同一本书任何时间重跑都得到同一个时间戳（无需服务端存储）。

## 书目信息自动检索

上传 EPUB 后由 [src/lookup.js](src/lookup.js) 带着线索去查「作者 / 日文原名 / 日文版发售日 / ISBN /
书目来源 URL / 出版社」，结果以**候选卡片**列出，点「采用」才写入表单。仍然无需服务端。

数据源（均为实测支持跨域的公开接口，`Access-Control-Allow-Origin: *`）：

| 源 | 接口 | 用途 |
| --- | --- | --- |
| NDL Search（国立国会図書館） | `ndlsearch.ndl.go.jp/api/opensearch` | 主力：书名/ISBN → 日文原名、著者、出版社、刊行年月、ISBN、**权威书目页 URL** |
| openBD | `api.openbd.jp/v1/get?isbn=` | ISBN → 出版社、出版年月（用于补「只到年」的日期） |
| Wikipedia | `zh.wikipedia.org/w/api.php` | 中文译名 → 日文原名（`opensearch` + `langlinks(ja)`） |
| Wikidata | `wikidata.org/w/api.php` | 日文原名的兜底来源 |

检索顺序（按请求数最少逐级降级）：

```
EPUB 本地线索（dc:title / dc:creator / dc:identifier / 版权页「原著名」）
  → ① NDL ?isbn=      → ② openBD ?isbn=
  → ③ 求日文原名（zh.wikipedia → langlinks(ja)，兜底 Wikidata）
  → ④ NDL ?title=<日文原名>&cnt=10 → 多卷候选
```

规矩：

1. **不猜**。每条候选都标出来源与可核对的原始链接；字段是「采用」写的，不是程序断言的。
2. 采用时**只填空字段，绝不覆盖**你已手填的内容。
3. 出版日期常只到「年月」。此时会按 `YYYY-MM-01` 填入，并在候选卡片与转换后的自检报告里
   明确标注「日部分需人工核对」，不假装知道「日」。
4. NDL 有**并发限流**（会返回 `429 同時アクセス数の上限に達した`）：请求带 10s 超时与指数退避重试，
   失败会被明确记为「该源不可用」，**不会被当成「查无此书」**。
5. 日亚（Amazon.co.jp）没有公开 API 且禁止抓取，因此**只生成外链**（Amazon.co.jp / Google / 维基）
   供人工核对，本工具不做抓取。

## 本地运行

项目无依赖、无构建：

```bash
npm run dev          # node dev.mjs → http://localhost:5173
```

浏览器打开 <http://localhost:5173>。

**必须用 `dev.mjs`**，不要用 `npx serve .` / `python -m http.server` 这类纯静态服务器，
也不要双击 `file://` 打开：图床的 `/upload` 不返回 CORS 头，浏览器跨域直连会在「上传封面」这一步
报 `Failed to fetch`。`dev.mjs` 额外提供同源 `/upload` 转发，与部署后的 `functions/upload.js` 等价。

## 部署

### Cloudflare Pages

1. 新建 Pages 项目，连接本仓库；构建命令留空，**输出目录填 `/`（仓库根目录）**。
2. 或使用 CLI 直接上传：
   ```bash
   npx wrangler pages deploy . --project-name epub-to-md
   ```
3. 根目录的 `_headers` 会自动生效（缓存与安全响应头）。
4. 仓库根的 `functions/` 会被自动识别为 Pages Functions（即同源上传代理 `/upload`），无需额外配置。

### Vercel

1. 导入本仓库，Framework Preset 选 **Other**，Build Command 留空，Output Directory 填 `.`。
2. 或使用 CLI：
   ```bash
   npx vercel --prod
   ```
3. `vercel.json` 已配置安全响应头，并把 `/upload` 重写到 `api/upload`（同源上传代理）。

两边都把 `Cache-Control` 设为 `no-cache`：文件名没有内容哈希，宁可每次 304 复验，也不要让浏览器
继续跑部署前的旧 bundle（曾因此出现「代码已修好、页面仍报旧错」）。部署完刷新即生效，必要时硬刷新。

## 图床

默认图床为 `https://tc.iiiiii.cc.cd`（CloudFlare-ImgBed 部署），上传接口 `POST /upload`，
返回 `{ src: "/file/..." }`；写入 Markdown 的图片直链都是该图床的绝对地址，不受代理影响。

该部署的 `POST /upload` **不返回任何 CORS 响应头**（实测 `OPTIONS` 直接 405）。浏览器跨域直连时
文件其实已经存进图床，但读取响应会被 CORS 拦成 `Failed to fetch`，拿不到直链。因此上传统一走
**同源 `/upload` 代理**，由平台自带 Function 转发（本地则是 `dev.mjs`）：

| 环境 | 代理 |
| --- | --- |
| Cloudflare Pages | `functions/upload.js`（自动识别） |
| Vercel | `api/upload.js` + `vercel.json` 的 `/upload` 重写 |
| 本地 | `dev.mjs`（`npm run dev`） |

- **只想用纯静态托管**（GitHub Pages 等）：给图床响应加上 `Access-Control-Allow-Origin` 即可
  （`*` 就够，上传不带凭据）；此时 [src/images.js](src/images.js) 会自动退回直连，
  `functions/`、`api/`、`dev.mjs` 均可删除。
- 图床**有速率上限与偶发 5xx**，实测速率为：
  - 限流：其 Telegram 后端约每分钟只收 ~20 张，超了返回 `500 {"error":"Too Many Requests: retry after 23"}`。
    一本书 20+ 张图连传必撞，所以上传**主动限速**约 3.5s 一张（≈17 张/分钟），先避开限流。
  - 抖动：约 4% 的上传会返回 `500 {"error":"Failed to get file ID"}`。

  两者都按「最多 4 次尝试」重试：撞限流时**读它给的 `retry after` 秒数再等**（单次最长 90s），
  其余情况按 0.8s / 2s / 4s 退避；等待期间界面会提示「图床限流，等待 Ns…」。仍然失败时报错会把
  图床返回的原文一并带出来，不再只说 `HTTP 500`。
- **换图床**：改 [src/images.js](src/images.js) 的 `DEFAULT_IMAGE_HOST`，同时改
  [functions/upload.js](functions/upload.js) 与 [api/upload.js](api/upload.js) 里的转发目标。

## 已知限制

- EPUB 上限 20 MB；`dc:creator` 为空会直接报错，要求手填作者。
- 目录项少于 2 条会报错，避免把结构异常的 EPUB 转出一份废稿。
- 图片按内容哈希缓存（localStorage），同一张图在不同书之间只上传一次。
- 受图床限速，上传是「排队式」的：一本书 20+ 张图大约要等 1 分钟以上，期间界面会滚动提示等待。

## 免责

本工具只做技术转换、格式自检与书目检索。检索结果只是**候选**，来自第三方公开接口，
可能有旧版、不同卷次或异体表记；书名、系列、日文原名、发售日、ISBN 必须以候选卡片给出的
书目页为准人工核对——程序不会替你断言真伪，也从不替你「猜」。
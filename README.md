# EPUB → Markdown（Frontmatter 构造器）

把单本 EPUB 转成一份可直接入库的 Markdown：目录锚点、正文清洗、封面与插图上传图床，
并按照目标主题的字段规范**构造 frontmatter**。纯前端实现，无服务端、无构建步骤，
可直接部署到 Cloudflare Pages 或 Vercel。

## 目录结构

```
epub-to-md/
├── index.html          # 界面
├── styles.css          # 样式
├── app.js              # 界面装配（表单、缓存、下载）
├── src/
│   ├── converter.js    # EPUB 解析 / 正文渲染 / 产物组装
│   ├── frontmatter.js  # ★ Frontmatter 构造与自检（本项目核心）
│   └── images.js       # 图床上传 + 稳定时间派生
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

时间派生：`published = 发售日 + 1 天`，时分秒 = `SHA-256(EPUB字节 + 发售日 + 日文原名)` 前 4 字节 `% 86400`，
因此同一本书任何时间重跑都得到同一个时间戳（无需服务端存储）。

## 本地运行

项目无依赖、无构建，任选一种静态服务器：

```bash
npm run dev          # npx serve . -l 5173
# 或
python -m http.server 5173
```

浏览器打开 <http://localhost:5173>。注意：图床上传是跨域请求，需通过 http(s) 访问页面，
不要直接双击 `file://` 打开。

## 部署

### Cloudflare Pages

1. 新建 Pages 项目，连接本仓库；构建命令留空，**输出目录填 `/`（仓库根目录）**。
2. 或使用 CLI 直接上传：
   ```bash
   npx wrangler pages deploy . --project-name epub-to-md
   ```
3. 根目录的 `_headers` 会自动生效（缓存与安全响应头）。

### Vercel

1. 导入本仓库，Framework Preset 选 **Other**，Build Command 留空，Output Directory 填 `.`。
2. 或使用 CLI：
   ```bash
   npx vercel --prod
   ```
3. `vercel.json` 已配置静态缓存与安全响应头。

## 图床

默认图床为 `https://tc.iiiiii.cc.cd`（CloudFlare-ImgBed 部署），上传接口 `POST /upload`，
返回 `{ src: "/file/..." }`。如需改用其它图床，修改 [src/images.js](src/images.js) 中的
`DEFAULT_IMAGE_HOST` 与 `uploadImage` 的返回解析即可。

## 免责

本工具只做技术转换与格式自检。书名、系列、日文原名、发售日、ISBN 等书目信息必须人工核对来源，
程序不会替你断言真伪。
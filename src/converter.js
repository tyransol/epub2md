/**
 * EPUB → Markdown 核心转换（纯前端，无服务器）
 *
 * 解析/渲染逻辑沿用已验证的参考实现；产物组装改为调用 frontmatter 模块，
 * 因此输出的是 Shirone 主题可用的 frontmatter（image / category / published），
 * 而不是 Hexo 遗留的 cover / categories / date。
 *
 * 规则要点：一书一文件 · 目录锚点 · 删除制作/传播信息 · 封面与插图走图床 ·
 * published = 已核实发售日的次一自然日 + 派生时分秒。
 */

import { unzipSync, strFromU8 } from '../vendor/fflate.js';
import { uploadImage, deriveStamp, DEFAULT_IMAGE_HOST } from './images.js';
import { buildFrontmatter, checkFrontmatter, seriesName } from './frontmatter.js';
import { clean, text, xmlParse, all, find } from './xml.js';

export const MAX_EPUB_BYTES = 20_000_000;

/** 不渲染的成品页：封面页、书名页、提示页、目录页。 */
const SKIP_PAGE = /(?:^|\/)(?:cover|title|message|contents[^/]*)\.xhtml$/i;
/** 不列为目录条目的名字。 */
const SKIP_TOC_NAME = /^(封面|制作信息|目录|contents)$/i;

/**
 * 制作/校对/传播信息（要求删除）。保守做法：整行匹配，命中即删，
 * 并把删掉的内容写进报告，绝不静默处理。
 */
const CREDIT_LINE = new RegExp([
  '轻之国度', 'lightnovel', 'LK不负担', '仅供个人学习', '禁作商业', '禁用于商业',
  '24小时内删除', '请尊重翻译', '原帖[:：]', 'tieba\\.baidu\\.com', '掌上书苑', 'yidm', 'epubBuilder',
  '制作信息', '制作组', '※.*制作',
  '(扫图|图源|修图|录入|校对|翻译|排版|发布)[:：]',
].join('|'), 'i');
const SEPARATOR_LINE = /^\s*[=\-*_]{5,}\s*$/;

/** 按行删除制作/传播信息，紧跟其后的分隔线一并删除。 */
function stripCredits(lines) {
  const removed = [];
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!CREDIT_LINE.test(lines[i])) { out.push(lines[i]); continue; }
    removed.push(lines[i].trim());
    if (i + 1 < lines.length && SEPARATOR_LINE.test(lines[i + 1])) { removed.push(lines[i + 1].trim()); i++; }
    out.push(''); // 留空行，保持段落结构
  }
  return { lines: out, removed };
}

function resolvePath(base, rel) {
  const parts = base.split('/');
  parts.pop();
  for (const p of decodeURIComponent(rel).split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.' && p) parts.push(p);
  }
  return parts.join('/');
}

const sanitizeFilename = (s) => String(s).replace(/[\\/\x00-\x1f"]/g, '_').slice(0, 100);

async function renderInline(el, ctx, origin) {
  if (el.nodeType === 3) return el.nodeValue.replace(/\u00a0/g, ' ');
  if (el.nodeType !== 1) return '';
  const name = (el.localName || '').toLowerCase();
  if (name === 'br') return '\n';
  if (name === 'img') {
    const src = clean(el.getAttribute('src'));
    if (!src) return '';
    const item = resolvePath(origin, src);
    if (/\/zhu\.png$/i.test(item)) return '[注]';
    if (!ctx.files[item]) throw new Error(`缺少图片 ${item}（EPUB 内不存在该资源）`);
    return `![${clean(el.getAttribute('alt')) || '插图'}](${await uploadImage(ctx.files[item], item, ctx.cache, ctx.imageHost, ctx.fetchImpl, ctx.onWait)})`;
  }
  let v = '';
  for (const child of el.childNodes) v += await renderInline(child, ctx, origin);
  if (['b', 'strong'].includes(name)) return '**' + v + '**';
  if (['em', 'i'].includes(name)) return '*' + v + '*';
  if (name === 'a' && /duokan-footnote/.test(el.getAttribute('class') || '')) return '[注]';
  return v;
}

async function renderBlocks(body, ctx, origin) {
  const candidates = [...all(body, 'p'), ...all(body, 'img'), ...all(body, 'h1'), ...all(body, 'h2'), ...all(body, 'h3')];
  const out = [];
  for (const el of candidates) {
    const name = (el.localName || '').toLowerCase();
    if (name === 'img' && el.closest && el.closest('p,li,h1,h2,h3')) continue;
    if (name === 'p' && el.closest && el.closest('li')) continue;
    let value = clean(await renderInline(el, ctx, origin));
    if (!value) continue;
    if (/^h[1-3]$/.test(name)) value = '#'.repeat(Number(name[1]) + 1) + ' ' + value;
    out.push({ el, value });
  }
  out.sort((a, b) => (a.el.compareDocumentPosition(b.el) & 4 ? -1 : 1));
  return out.map((x) => x.value);
}

function detectCover(opf, meta, items, byId) {
  let cover = items.find((x) => (x.getAttribute('properties') || '').includes('cover-image'));
  if (!cover) {
    const legacy = all(meta, 'meta').find((x) => x.getAttribute('name') === 'cover');
    if (legacy) cover = byId.get(legacy.getAttribute('content'));
  }
  if (!cover) cover = items.find((x) => /cover\.(png|jpe?g|webp)$/i.test(x.getAttribute('href') || ''));
  return cover || null;
}

function buildToc(opf, items, readText, fileOf) {
  const ncx = items.find((x) => x.getAttribute('media-type') === 'application/x-dtbncx+xml');
  let toc = [];
  if (ncx) {
    const doc = xmlParse(readText(fileOf(ncx)));
    toc = all(doc, 'navPoint').map((x) => ({
      name: text(find(find(x, 'navLabel'), 'text')),
      href: resolvePath(fileOf(ncx), (find(x, 'content')?.getAttribute('src') || '').split('#')[0]),
    }));
  } else {
    const nav = items.find((x) => (x.getAttribute('properties') || '').split(' ').includes('nav'));
    if (nav) {
      const navPath = fileOf(nav);
      const doc = xmlParse(readText(navPath));
      toc = all(doc, 'a').map((x) => ({
        name: text(x),
        href: resolvePath(navPath, (x.getAttribute('href') || '').split('#')[0]),
      }));
    }
  }
  return toc.filter((x) => x.name && x.href && !SKIP_TOC_NAME.test(x.name) && !SKIP_PAGE.test(x.href));
}

/** 从 OPF 的 dc:description 提取简介，去掉可能混入的 HTML 标签。 */
function extractDescription(meta) {
  const raw = text(find(meta, 'description'));
  return clean(raw.replace(/<[^>]+>/g, ' '));
}

/**
 * 主入口：转换单个 EPUB。
 * @param {File|Blob} file   EPUB 文件
 * @param {object} fields    { title, series, japaneseTitle, author, publisher, releaseDate,
 *                             description, tags[], pinned, coverUrlOverride, profile,
 *                             timePrecision: 'datetime'|'date' }
 * @param {object} opts      { cache: Map, imageHost, fetchImpl, onProgress(text) }
 * @returns {Promise<object>} 转换产物与自检报告
 */
export async function convertEpub(file, fields, opts = {}) {
  const { cache = new Map(), imageHost = DEFAULT_IMAGE_HOST, fetchImpl = fetch, onProgress = () => {} } = opts;
  const profile = fields.profile || 'shirone';
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length > MAX_EPUB_BYTES) throw new Error(`EPUB 超过 ${MAX_EPUB_BYTES / 1_000_000} MB`);

  onProgress('解压 EPUB…');
  const zip = unzipSync(bytes);
  const readText = (p) => { if (!zip[p]) throw new Error('EPUB 内缺少 ' + p); return strFromU8(zip[p]); };
  const files = zip;

  const container = xmlParse(readText('META-INF/container.xml'));
  const opfPath = find(container, 'rootfile')?.getAttribute('full-path');
  if (!opfPath) throw new Error('未找到 OPF（container.xml 里的 rootfile）');
  const opf = xmlParse(readText(opfPath));
  if (opf.getElementsByTagName('parsererror').length) throw new Error('OPF 格式错误');

  const meta = find(opf, 'metadata');
  const title = clean(fields.title) || text(find(meta, 'title'));
  const author = clean(fields.author) || text(find(meta, 'creator'));
  if (!title) throw new Error('EPUB 的 OPF 里没有书名，请填写「书名」字段');
  if (!author) throw new Error('EPUB 的 dc:creator 为空，请填写「作者」字段（不要留空）');

  const description = clean(fields.description) || extractDescription(meta);

  const items = all(find(opf, 'manifest'), 'item');
  const byId = new Map(items.map((x) => [x.getAttribute('id'), x]));
  const spine = all(find(opf, 'spine'), 'itemref').map((x) => byId.get(x.getAttribute('idref'))).filter(Boolean);
  const root = opfPath.substring(0, opfPath.lastIndexOf('/') + 1);
  const fileOf = (item) => resolvePath(root + 'dummy', item.getAttribute('href'));

  let toc = buildToc(opf, items, readText, fileOf);
  const droppedToc = toc.filter((x) => !zip[x.href]).map((x) => x.name);
  toc = toc.filter((x) => !!zip[x.href]);
  if (toc.length < 2) throw new Error(`目录项过少（${toc.length}），请人工检查 EPUB 结构`);
  const anchors = new Map(toc.map((x, i) => [x.href, 'section-' + (i + 1)]));
  const onWait = (ms, detail) =>
    onProgress(`图床限流，等待 ${Math.round(ms / 1000)}s 后重试${detail ? '（' + detail + '）' : ''}…`);
  const ctx = { files, cache, imageHost, fetchImpl, onWait };

  onProgress('上传封面…');
  let coverUrl;
  if (fields.coverUrlOverride) {
    if (!/^https:\/\//.test(fields.coverUrlOverride)) throw new Error('手动封面必须是 HTTPS 图床 URL');
    coverUrl = fields.coverUrlOverride;
  } else {
    const cover = detectCover(opf, meta, items, byId);
    if (!cover) throw new Error('EPUB 内未找到封面图片；请在“手动封面 URL”里填入图床地址');
    const coverPath = fileOf(cover);
    if (!zip[coverPath]) throw new Error('封面条目在 EPUB 内不存在：' + coverPath);
    coverUrl = await uploadImage(zip[coverPath], coverPath, cache, imageHost, fetchImpl, onWait);
  }

  const stampInfo = await deriveStamp(bytes, fields.releaseDate, fields.japaneseTitle);
  const published = (fields.timePrecision === 'date') ? stampInfo.dateOnly : stampInfo.stamp;
  const series = clean(fields.series) || seriesName(title);

  const frontmatter = buildFrontmatter({
    title,
    series,
    japaneseTitle: fields.japaneseTitle,
    description,
    author,
    publisher: fields.publisher,
    coverUrl,
    published,
    tags: fields.tags || [],
    pinned: !!fields.pinned,
  }, { profile });

  const body = ['', '# ' + title, ''];
  if (author) body.push('**作者：** ' + author, '');
  body.push('## 目录', '', ...toc.map((x) => `- [${x.name}](#${anchors.get(x.href)})`), '');

  const seen = new Set();
  const found = new Set();
  for (const item of spine) {
    const p = fileOf(item);
    if (seen.has(p) || !zip[p]) continue;
    seen.add(p);
    if (SKIP_PAGE.test(p)) continue;
    const doc = xmlParse(readText(p));
    const b = find(doc, 'body');
    if (!b) continue;
    if (anchors.has(p)) {
      found.add(p);
      body.push('', `<a id="${anchors.get(p)}"></a>`, '', '## ' + toc.find((x) => x.href === p).name, '');
    } else if (/\/chapter0\.xhtml$/i.test(p)) {
      body.push('', '## 序章', '');
    } else if (/\/ch0\.xhtml$/i.test(p)) {
      body.push('', '### 上集回顾', '');
    }
    onProgress(`渲染正文 ${p}`);
    const rendered = await renderBlocks(b, ctx, p);
    // 章节首行常与目录同名，目录已列出，避免重复（只跳过开头那一行）。
    // 正文标题会被降一级（h1→##、h2→###），因此按「标题文字」比对，而不是比对固定前缀。
    let parts = rendered;
    if (anchors.has(p)) {
      const tocName = toc.find((x) => x.href === p)?.name;
      const first = parts[0];
      if (tocName && first && /^#{1,6}\s/.test(first) && first.replace(/^#{1,6}\s+/, '') === tocName) {
        parts = parts.slice(1);
      }
    }
    for (const part of parts) body.push(part, '');
  }
  const missingAnchor = [...anchors.keys()].filter((x) => !found.has(x));
  if (missingAnchor.length) throw new Error('目录链接无法对应正文：' + missingAnchor.join(', '));

  const { lines: keptLines, removed: removedCredits } = stripCredits(body);
  const content = frontmatter + '\n' + keptLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const imageCount = (content.match(/!\[[^\]]*\]\(/g) || []).length;

  const report = checkFrontmatter(content, { profile });
  const links = [...content.matchAll(/^- \[[^\]]+\]\(#(section-\d+)\)$/gm)].map((m) => m[1]);
  const anchorIds = [...content.matchAll(/<a id="(section-\d+)"><\/a>/g)].map((m) => m[1]);
  const missing = links.filter((x) => !anchorIds.includes(x));
  const orphan = anchorIds.filter((x) => !links.includes(x));
  if (missing.length) report.problems.push(`目录有 ${missing.length} 条缺锚点：${missing.join(', ')}`);
  if (orphan.length) report.problems.push(`有 ${orphan.length} 个孤儿锚点：${orphan.join(', ')}`);
  if (!links.length) report.problems.push('没有解析到任何目录条目');
  const offsite = [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]).filter((u) => !u.startsWith(imageHost + '/file/'));
  if (offsite.length) report.problems.push(`${offsite.length} 张图片不在图床：${offsite.slice(0, 3).join(', ')}`);
  const prod = content.match(new RegExp(CREDIT_LINE.source, 'gi'));
  if (prod) report.problems.push(`制作/传播信息未被清干净：${[...new Set(prod)].join(', ')}`);
  report.ok = report.problems.length === 0;

  if (removedCredits.length) report.notes.push(`已删除 ${removedCredits.length} 行制作/传播信息：${removedCredits.join(' ／ ')}`);
  if (droppedToc.length) report.notes.push(`跳过 ${droppedToc.length} 条无法定位文件的目录项：${droppedToc.join('、')}`);
  report.notes.push(`目录 ${links.length} 条 / 锚点 ${anchorIds.length} 个 / 插图 ${imageCount} 张`);
  report.notes.push('⚠️ 书名、系列、日文原名、发售日必须人工核对来源，程序不会替你断言真伪。');

  return {
    filename: sanitizeFilename(title) + '.md',
    title, author, series, published,
    content, coverUrl, imageCount, report,
  };
}
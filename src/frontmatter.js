/**
 * Frontmatter 构造模块
 *
 * 目标：按「构造要求」把书名、系列、封面、发售日等元数据组装成 YAML frontmatter，
 * 而不是简单地把一堆字段拼在一起。两套方案：
 *
 *   shirone  —— 本项目默认。对齐 Shirone(Astro) 主题 src/content.config.ts 的 posts 集合：
 *               title / description / image / tags / category / published / pinned
 *               注意：Shirone 用 image（不是 cover）、category（单值，不是 categories）、
 *               published（不是 date），且不使用 author / publisher / ai 等 Hexo 遗留字段。
 *
 *   generic  —— 通用 / Hexo 兼容方案，字段为 title / author / publisher / cover /
 *               tags / categories / date，便于迁移到其它站点。
 *
 * 构造要求（两套方案共同遵守）：
 *   1. 必填字段缺失即报错，绝不静默补空。
 *   2. 所有字符串一律双引号包裹（JSON 字符串是合法 YAML 双引号标量），避免冒号、
 *      井号、日期等被 YAML 误解析。
 *   3. tags 去重、去空，且固定以「轻小说」开头。
 *   4. image / cover 必须是 HTTPS 图床直链。
 *   5. published / date 输出为 YAML 时间戳，可被主题的 z.date() 解析。
 *   6. 输出字段顺序固定，便于 diff 与人工核对。
 */

/** 可选的 frontmatter 方案。 */
export const PROFILES = {
  shirone: {
    label: 'Shirone（Astro 主题）',
    fields: ['title', 'description', 'image', 'tags', 'category', 'published', 'pinned'],
  },
  generic: {
    label: 'Hexo（通用兼容）',
    fields: ['title', 'author', 'publisher', 'cover', 'tags', 'categories', 'date'],
  },
};

/** YAML 双引号标量：JSON.stringify 的输出恰好是合法的 YAML 双引号字符串。 */
const q = (s) => JSON.stringify(String(s ?? ''));

const trim = (s) => String(s ?? '').replace(/\u00a0/g, ' ').trim();

/**
 * 从书名里剥离卷次 / 版本标记，得到系列名（Shirone 的 category）。
 * 例：「义妹生活 第一卷（台）」→「义妹生活」，「埃罗芒阿老师 外传 another days」→「埃罗芒阿老师」。
 * 只剥离**结尾**的标记，避免误伤书名正文。
 */
export function seriesName(title) {
  let t = trim(title);
  const patterns = [
    /\s*第\s*[〇零一二三四五六七八九十百千0-9]+\s*[卷册集部篇]\s*$/u,
    /\s*[（(]\s*台\s*[)）]\s*$/u,
    /\s*[（(]\s*日\s*[)）]\s*$/u,
    /\s*[上下]\s*$/u,
    /\s*短篇\s*$/u,
    /\s*外传.*$/u,
    /\s*[Vv]ol(?:ume)?\.?\s*\d+\s*$/u,
    /\s*\d+\s*$/u,
  ];
  let changed = true;
  while (changed) {
    changed = false;
    for (const re of patterns) {
      const next = t.replace(re, '');
      if (next !== t && next.trim()) { t = next.trim(); changed = true; }
    }
  }
  return t || trim(title);
}

/** 构造 tags：固定「轻小说」打头，随后是系列名、日文原名、以及用户自定义标签，去重去空。 */
export function buildTags({ series, japaneseTitle, extra = [] } = {}) {
  const seen = new Set();
  const out = [];
  for (const raw of ['轻小说', series, japaneseTitle, ...extra]) {
    const v = trim(raw);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/**
 * 按方案构造 frontmatter 文本（含首尾 `---` 围栏）。
 *
 * @param {object} meta 元数据，见下方字段说明
 * @param {object} [opts]
 * @param {'shirone'|'generic'} [opts.profile='shirone']
 * @returns {string} 形如 `---\n...\n---`
 *
 * meta:
 *   title         书名（含卷）。
 *   series        系列名（Shirone category）。缺省时由 title 推导。
 *   japaneseTitle 日文原名，用于 tags。
 *   description   简介（Shirone description）。为空时输出空串，字段不省略（不做正文回退提取）。
 *   author        作者（generic 方案使用；Shirone 不使用）。
 *   publisher     出版社（generic 方案使用；Shirone 不使用）。
 *   coverUrl      封面直链（Shirone image / generic cover）。
 *   published     发布时间戳，`YYYY-MM-DD` 或 `YYYY-MM-DD HH:MM:SS`。
 *   tags          自定义补充标签数组。
 *   pinned        是否置顶（Shirone）。
 */
export function buildFrontmatter(meta = {}, opts = {}) {
  const profile = opts.profile || 'shirone';
  if (!PROFILES[profile]) throw new Error('未知的 frontmatter 方案：' + profile);

  const title = trim(meta.title);
  if (!title) throw new Error('frontmatter 缺少 title（书名）');

  const published = trim(meta.published);
  if (!published) throw new Error('frontmatter 缺少 published（发布日期）');
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(published)) {
    throw new Error('published 必须是 YYYY-MM-DD 或 YYYY-MM-DD HH:MM:SS，实际为：' + published);
  }

  const coverUrl = trim(meta.coverUrl);
  const series = trim(meta.series) || seriesName(title);
  const tags = buildTags({ series, japaneseTitle: meta.japaneseTitle, extra: meta.tags });

  const lines = ['---'];

  if (profile === 'shirone') {
    lines.push('title: ' + q(title));
    // description 始终输出：EPUB 没有 dc:description、用户也没填时写空串，而不是省略字段，
    // 这样字段序列与主题要求一致，自检也不会把它报成「缺少字段」。
    lines.push('description: ' + q(trim(meta.description)));
    if (coverUrl) {
      if (!/^https:\/\//.test(coverUrl)) throw new Error('image 必须是 HTTPS 直链：' + coverUrl);
      lines.push('image: ' + q(coverUrl));
    }
    lines.push('tags:');
    for (const t of tags) lines.push('  - ' + q(t));
    if (series) lines.push('category: ' + q(series));
    lines.push('published: ' + published);
    lines.push('pinned: ' + (meta.pinned ? 'true' : 'false'));
  } else {
    lines.push('title: ' + q(title));
    if (trim(meta.author)) lines.push('author: ' + q(trim(meta.author)));
    if (trim(meta.publisher)) lines.push('publisher: ' + q(trim(meta.publisher)));
    if (coverUrl) lines.push('cover: ' + q(coverUrl));
    lines.push('tags:');
    for (const t of tags) lines.push('  - ' + q(t));
    lines.push('categories:');
    lines.push('  - ACGN');
    lines.push('  - 轻小说');
    lines.push('date: ' + published);
  }

  lines.push('---');
  return lines.join('\n');
}

/**
 * 技术自检：对照「构造要求」逐条核对已生成的 frontmatter 文本。
 * 只做机器可验证的部分；书目真伪仍需人工核对来源。
 *
 * @param {string} content           完整 Markdown（含 frontmatter）
 * @param {object} [opts]
 * @param {'shirone'|'generic'} [opts.profile='shirone']
 * @returns {{ok:boolean, problems:string[], notes:string[]}}
 */
export function checkFrontmatter(content, opts = {}) {
  const profile = opts.profile || 'shirone';
  const problems = [];
  const notes = [];

  if (!content.startsWith('---\n')) {
    return { ok: false, problems: ['文件开头不是 frontmatter（缺少 `---`）'], notes };
  }
  const end = content.indexOf('\n---', 4);
  if (end < 0) return { ok: false, problems: ['frontmatter 没有闭合的 `---`'], notes };
  const head = content.slice(4, end);
  const field = (k) => {
    const m = head.match(new RegExp(`^${k}:\\s*(.*)$`, 'm'));
    return m ? m[1].replace(/^"|"$/g, '') : undefined;
  };

  for (const k of PROFILES[profile].fields) {
    if (!new RegExp(`^${k}:`, 'm').test(head)) problems.push(`frontmatter 缺少字段 ${k}`);
  }

  const dateKey = profile === 'shirone' ? 'published' : 'date';
  const date = field(dateKey);
  if (date && !/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2})?$/.test(date)) {
    problems.push(`${dateKey} 格式异常：${date}`);
  }

  const cover = field(profile === 'shirone' ? 'image' : 'cover');
  if (cover && !/^https:\/\//.test(cover)) problems.push('封面不是 HTTPS 直链');

  const tagLines = head.split('\n').filter((l) => /^\s+- /.test(l));
  if (profile === 'shirone' && tagLines.length < 3) problems.push(`tags 少于 3 条（实际 ${tagLines.length}），请补全系列名与日文原名`);

  if (profile === 'shirone' && /^(author|publisher|cover|categories|date):/m.test(head)) {
    problems.push('Shirone 方案不应包含 Hexo 遗留字段（author/publisher/cover/categories/date）');
  }

  notes.push(`frontmatter 方案：${PROFILES[profile].label}／字段 ${PROFILES[profile].fields.length} 个／tags ${tagLines.length} 条`);
  return { ok: problems.length === 0, problems, notes };
}
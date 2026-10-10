/**
 * 书目信息自动检索（纯前端，无服务端）
 *
 * 只用实测支持跨域（Access-Control-Allow-Origin: *）的公开接口：
 *   NDL Search  https://ndlsearch.ndl.go.jp/api/opensearch  国立国会図書館，最权威
 *   openBD      https://api.openbd.jp/v1/get?isbn=          日販系书目，ISBN → 出版社/年月
 *   Wikipedia   zh opensearch + langlinks(ja)               中文译名 → 日文原名
 *   Wikidata    wbsearchentities / wbgetentities            原名兜底
 *
 * 日亚（Amazon.co.jp）没有公开 API 且禁止抓取，因此**只生成外链**供人工核对，不做抓取。
 *
 * 规矩：不猜。每条候选都带来源与原始凭证（书目页 URL / 接口 URL），
 * 日期若只到「年月」会标注 precision，由人决定是否采用。
 */

import { unzipSync, strFromU8 } from '../vendor/fflate.js';
import { xmlParse, all, find, clean, text } from './xml.js';

export const SOURCES = {
  ndl: { label: 'NDL Search（国立国会図書館）', home: 'https://ndlsearch.ndl.go.jp' },
  openbd: { label: 'openBD', home: 'https://openbd.jp' },
  wikipedia: { label: 'Wikipedia', home: 'https://zh.wikipedia.org' },
  wikidata: { label: 'Wikidata', home: 'https://www.wikidata.org' },
};

const norm = (s) => String(s ?? '').replace(/\u00a0/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 是否含日文假名（用来判断「这已经是日文原名了」）。 */
export const isJapanese = (s) => /[\u3041-\u309f\u30a0-\u30ff]/.test(s || '');

/** 从任意写法（含 urn:isbn: / 带连字符）里取 13 位 ISBN；取不到返回空串。 */
export function isbn13(raw) {
  const d = String(raw ?? '').replace(/[^0-9Xx]/g, '').toUpperCase();
  return /^97[89]\d{10}$/.test(d) ? d : '';
}

/**
 * 归一化出版日期。
 * NDL 用 `2025.2`，openBD 用 `202409`；只到月/年的情况必须如实标注 precision，
 * 不能假装知道「日」。
 * @returns {{date:string, precision:'day'|'month'|'year'}|null}
 */
export function parseIssued(raw) {
  const s = norm(raw);
  const pad = (n) => String(n).padStart(2, '0');
  let m;
  if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) return { date: `${m[1]}-${m[2]}-${m[3]}`, precision: 'day' };
  if ((m = /^(\d{4})(\d{2})$/.exec(s))) return { date: `${m[1]}-${m[2]}-01`, precision: 'month' };
  if ((m = /^(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})$/.exec(s))) return { date: `${m[1]}-${pad(m[2])}-${pad(m[3])}`, precision: 'day' };
  if ((m = /^(\d{4})[.\-/](\d{1,2})$/.exec(s))) return { date: `${m[1]}-${pad(m[2])}-01`, precision: 'month' };
  if ((m = /^(\d{4})$/.exec(s))) return { date: `${m[1]}-01-01`, precision: 'year' };
  return null;
}

/** 用 URL 解析相对路径（避免再写一套与 converter 重复的路径拼接）。 */
function resolveHref(base, rel) {
  const u = new URL(String(rel || '').split('#')[0], 'https://epub.invalid/' + base);
  return decodeURIComponent(u.pathname).slice(1);
}

// ---------------------------------------------------------------- EPUB 线索

/** 版权页里常见的「原著名 / 原書名」行。 */
const ORIGINAL_TITLE_RE = /原\s*(?:書|书|著|作)\s*名?\s*[:：]?\s*(.{2,80})/;

function scanOriginalTitle(zip, spinePaths) {
  for (const p of spinePaths.slice(0, 5)) {
    if (!zip[p]) continue;
    const plain = strFromU8(zip[p]).replace(/<[^>]+>/g, '\n');
    for (const line of plain.split('\n')) {
      const m = ORIGINAL_TITLE_RE.exec(line.replace(/\u00a0/g, ' ').trim());
      if (m) return norm(m[1]).replace(/[<>&].*$/, '').trim();
    }
  }
  return '';
}

/**
 * 从 EPUB 里读线索（不发任何网络请求）。
 * 兼容非标准 meta：真实台版样本用过 <meta name="轻小说"> 与 <meta name="dc:creator-aut">。
 * @param {Uint8Array} bytes
 */
export function extractEpubClues(bytes) {
  const zip = unzipSync(bytes);
  const read = (p) => (zip[p] ? strFromU8(zip[p]) : '');
  const container = xmlParse(read('META-INF/container.xml'));
  const opfPath = find(container, 'rootfile')?.getAttribute('full-path') || '';
  if (!opfPath || !zip[opfPath]) throw new Error('EPUB 结构异常：读不到 OPF');

  const opf = xmlParse(read(opfPath));
  const meta = find(opf, 'metadata');
  const metas = all(meta, 'meta');
  const named = (n) => metas.filter((m) => m.getAttribute('name') === n)
    .map((m) => clean(m.getAttribute('content'))).filter(Boolean);
  const identifiers = all(meta, 'identifier').map((x) => norm(x.textContent));

  const items = all(find(opf, 'manifest'), 'item');
  const byId = new Map(items.map((x) => [x.getAttribute('id'), x]));
  const spine = all(find(opf, 'spine'), 'itemref')
    .map((x) => byId.get(x.getAttribute('idref')))
    .filter(Boolean)
    .map((it) => resolveHref(opfPath, it.getAttribute('href')));

  return {
    title: text(find(meta, 'title')),
    author: text(find(meta, 'creator')) || named('dc:creator-aut')[0] || named('creator')[0] || '',
    publisher: text(find(meta, 'publisher')),
    language: text(find(meta, 'language')),
    date: text(find(meta, 'date')),
    description: text(find(meta, 'description')),
    isbn: identifiers.map(isbn13).find(Boolean) || '',
    identifiers,
    originalTitle: scanOriginalTitle(zip, spine),
  };
}

// ---------------------------------------------------------------- 请求层

/**
 * 带超时与指数退避的 GET。429/5xx 重试，其它 4xx 直接失败（不重试）。
 * @returns {Promise<string>} 响应文本
 */
async function fetchWithRetry(url, ctx) {
  const { fetchImpl, timeoutMs, retries } = ctx;
  let last;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt) ctx.onLog(`… 第 ${attempt} 次重试（上次：${last && last.message}）`);
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const res = await fetchImpl(url, ctrl ? { signal: ctrl.signal } : {});
      if (timer) clearTimeout(timer);
      if (res.ok) return await res.text();
      const err = new Error('HTTP ' + res.status);
      if (res.status !== 429 && res.status < 500) { err.fatal = true; throw err; }
      last = err;
    } catch (e) {
      if (timer) clearTimeout(timer);
      if (e && e.fatal) throw e;
      last = e;
    }
    if (attempt < retries) await sleep(600 * 2 ** attempt);
  }
  throw last || new Error('请求失败');
}

/** 发一次请求并把过程记进 steps（失败也不抛，交给上层决定降级）。 */
async function fetchStep(url, label, ctx, steps) {
  const step = { label, url, ok: false, error: '', count: 0 };
  steps.push(step);
  ctx.onLog(`→ ${label}`);
  try {
    const body = await fetchWithRetry(url, ctx);
    step.ok = true;
    ctx.onLog(`✓ ${label}：${body.length} 字节`);
    return { body, step };
  } catch (e) {
    step.error = (e && e.message) || String(e);
    ctx.onLog(`✗ ${label} 失败：${step.error}（不算空结果）`);
    return { body: null, step };
  }
}

// ---------------------------------------------------------------- 各源解析

/** 解析 NDL 的 OpenSearch RSS。 */
export function parseNdlRss(xml) {
  const doc = xmlParse(xml);
  return all(doc, 'item').map((item) => {
    const t = (n) => text(find(item, n));
    const isbnRaw = all(item, 'identifier')
      .filter((x) => /ISBN/i.test(x.getAttribute('xsi:type') || x.getAttribute('type') || ''))
      .map((x) => norm(x.textContent))[0] || '';
    const link = find(item, 'link');
    return {
      title: t('title'),
      author: t('creator'),
      publisher: t('publisher'),
      series: norm(t('seriesTitle').split(';')[0]),
      issuedRaw: t('issued') || t('date'),
      isbnRaw,
      isbn: isbn13(isbnRaw),
      url: link ? clean(link.textContent) : t('guid'),
      source: 'ndl',
    };
  });
}

/** 解析 openBD 的 /v1/get 返回（未收录时为 [null]）。 */
export function parseOpenBd(body) {
  let arr;
  try { arr = JSON.parse(body); } catch { return null; }
  const s = Array.isArray(arr) && arr[0] ? arr[0].summary : null;
  if (!s) return null;
  const isbn = isbn13(s.isbn);
  return {
    title: norm(s.title),
    author: norm(s.author),
    publisher: norm(s.publisher),
    series: norm(s.series),
    issuedRaw: norm(s.pubdate),
    isbnRaw: norm(s.isbn),
    isbn,
    url: isbn ? `https://api.openbd.jp/v1/get?isbn=${isbn}` : '',
    source: 'openbd',
  };
}

// ---------------------------------------------------------------- 检索主流程

const squash = (s) => (s || '').toLowerCase().replace(/[\s,，、・.,／/]/g, '');
const authorHit = (a, b) => {
  const x = squash(a); const y = squash(b);
  return !!x && !!y && (x.includes(y) || y.includes(x));
};

/** 补上归一化日期、相关度与采用提示。 */
function enrich(c, query) {
  const issued = parseIssued(c.issuedRaw);
  const hit = authorHit(query.author, c.author);
  return {
    ...c,
    date: issued ? issued.date : '',
    datePrecision: issued ? issued.precision : '',
    authorMatch: hit,
    score: (hit ? 4 : 0) + (c.isbn ? 2 : 0) + (issued && issued.precision === 'day' ? 1 : 0),
  };
}

async function collectNdlByTitle(title, found, steps, ctx) {
  const url = `https://ndlsearch.ndl.go.jp/api/opensearch?title=${encodeURIComponent(title)}&cnt=10`;
  const { body, step } = await fetchStep(url, `NDL Search（书名：${title}）`, ctx, steps);
  if (!body) return;
  const items = parseNdlRss(body);
  step.count = items.length;
  found.push(...items);
  ctx.onLog(items.length ? `· 得到 ${items.length} 条候选` : '· 无结果，请用外链人工核对');
}

/** 中文译名 → 日文原名：zh.wikipedia opensearch → langlinks(ja)，兜底 Wikidata。 */
async function guessJapaneseTitle(title, steps, ctx) {
  const os = await fetchStep(
    `https://zh.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(title)}&limit=5&format=json&origin=*`,
    'zh.wikipedia 搜索', ctx, steps);
  if (os.body) {
    let page = '';
    try { page = (JSON.parse(os.body)[1] || [])[0] || ''; } catch { page = ''; }
    os.step.count = page ? 1 : 0;
    if (page) {
      const ll = await fetchStep(
        `https://zh.wikipedia.org/w/api.php?action=query&prop=langlinks&lllang=ja&titles=${encodeURIComponent(page)}&format=json&origin=*`,
        'zh.wikipedia → 日文跨语言链接', ctx, steps);
      if (ll.body) {
        const pages = (JSON.parse(ll.body).query || {}).pages || {};
        const ja = Object.values(pages)[0]?.langlinks?.[0]?.['*'];
        ll.step.count = ja ? 1 : 0;
        if (ja) return { title: clean(ja), via: `维基「${page}」→ 日文「${clean(ja)}」` };
      }
    }
  }
  const wd = await fetchStep(
    `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(title)}&language=zh&uselang=zh&limit=5&format=json&origin=*`,
    'Wikidata 搜索', ctx, steps);
  if (wd.body) {
    let id = '';
    try { id = (JSON.parse(wd.body).search || [])[0]?.id || ''; } catch { id = ''; }
    wd.step.count = id ? 1 : 0;
    if (id) {
      const ent = await fetchStep(
        `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${id}&props=labels&languages=ja&format=json&origin=*`,
        'Wikidata 日文标签', ctx, steps);
      if (ent.body) {
        const ja = (JSON.parse(ent.body).entities || {})[id]?.labels?.ja?.value;
        ent.step.count = ja ? 1 : 0;
        if (ja) return { title: clean(ja), via: `Wikidata ${id} → 日文「${clean(ja)}」` };
      }
    }
  }
  return { title: '', via: '' };
}

/**
 * 检索书目。按请求数最少逐级降级，单源失败不影响其它源（失败会记进 steps，不当空结果）。
 *
 * @param {object} query { title, author, isbn, japaneseTitle }
 * @param {object} [opts]  { fetchImpl, onLog, timeoutMs, retries, maxCandidates }
 * @returns {Promise<{query, japaneseTitle, japaneseTitleVia, candidates, steps}>}
 */
export async function lookupBook(query = {}, opts = {}) {
  const ctx = {
    fetchImpl: opts.fetchImpl || fetch,
    onLog: opts.onLog || (() => {}),
    timeoutMs: opts.timeoutMs || 10000,
    retries: opts.retries ?? 2,
  };
  const steps = [];
  const found = [];
  const q = {
    title: norm(query.title),
    author: norm(query.author),
    isbn: isbn13(query.isbn),
    japaneseTitle: norm(query.japaneseTitle),
  };
  if (!q.title && !q.isbn && !q.japaneseTitle) throw new Error('至少要填「书名」或「ISBN」才能检索');

  // ① EPUB 里带的 ISBN（若是日版 ISBN，这一跳就够）
  if (q.isbn) {
    const { body, step } = await fetchStep(
      `https://ndlsearch.ndl.go.jp/api/opensearch?isbn=${q.isbn}&cnt=10`,
      `NDL Search（ISBN：${q.isbn}）`, ctx, steps);
    if (body) {
      const items = parseNdlRss(body);
      step.count = items.length;
      found.push(...items);
      ctx.onLog(items.length ? `· ISBN 命中 ${items.length} 条` : '· NDL 未收录该 ISBN（台版 ISBN 常见）');
    }
    const ob = await fetchStep(`https://api.openbd.jp/v1/get?isbn=${q.isbn}`, `openBD（ISBN：${q.isbn}）`, ctx, steps);
    if (ob.body) {
      const c = parseOpenBd(ob.body);
      ob.step.count = c ? 1 : 0;
      if (c) { found.push(c); ctx.onLog(`· openBD 命中：${c.title}`); }
      else ctx.onLog('· openBD 未收录该 ISBN');
    }
  }

  // ② 求日文原名
  let ja = q.japaneseTitle || (isJapanese(q.title) ? q.title : '');
  let via = ja ? (q.japaneseTitle ? '表单已填' : '书名本身是日文') : '';
  if (!ja && q.title) {
    const g = await guessJapaneseTitle(q.title, steps, ctx);
    if (g.title) { ja = g.title; via = g.via; ctx.onLog(`· 推得日文原名：${ja}（${via}）`); }
    else ctx.onLog('· 没推得日文原名，改用书名直查 NDL');
  }

  // ③ 按日文原名（或书名）出多卷候选
  await collectNdlByTitle(ja || q.title, found, steps, ctx);

  const seen = new Set();
  const merged = [];
  for (const c of found) {
    if (!c.title) continue;
    const key = c.isbn || `${c.title}|${c.issuedRaw}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(enrich(c, q));
  }
  merged.sort((a, b) => b.score - a.score);

  return {
    query: q,
    japaneseTitle: ja,
    japaneseTitleVia: via,
    candidates: merged.slice(0, opts.maxCandidates ?? 12),
    steps,
  };
}

/**
 * 采用前用 openBD 补一次精确出版年月（仅在候选日期只到「年」时才有意义）。
 * 失败就原样返回，不阻断采用。
 */
export async function refineByIsbn(candidate, opts = {}) {
  const isbn = isbn13(candidate && candidate.isbn);
  if (!isbn) return candidate;
  const ctx = {
    fetchImpl: opts.fetchImpl || fetch,
    onLog: opts.onLog || (() => {}),
    timeoutMs: opts.timeoutMs || 10000,
    retries: opts.retries ?? 1,
  };
  try {
    const body = await fetchWithRetry(`https://api.openbd.jp/v1/get?isbn=${isbn}`, ctx);
    const c = parseOpenBd(body);
    const issued = c && parseIssued(c.issuedRaw);
    if (!issued || issued.precision === 'year') return candidate;
    ctx.onLog(`· openBD 补充出版年月：${c.issuedRaw} → ${issued.date}（${issued.precision}）`);
    return { ...candidate, issuedRaw: c.issuedRaw, date: issued.date, datePrecision: issued.precision, refinedBy: 'openbd' };
  } catch (e) {
    ctx.onLog(`· openBD 补充失败（不影响采用）：${(e && e.message) || e}`);
    return candidate;
  }
}

/** 人工核对用的外链（日亚没有可用 API，只能这样给）。 */
export function externalLinks({ title, japaneseTitle, isbn } = {}) {
  const isbnKey = isbn13(isbn);
  const ja = norm(japaneseTitle);
  const key = encodeURIComponent(isbnKey || ja || norm(title));
  return [
    { label: 'Amazon.co.jp', url: `https://www.amazon.co.jp/s?k=${key}` },
    { label: 'Google', url: `https://www.google.com/search?q=${key}` },
    { label: '日文维基', url: `https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(ja || norm(title))}` },
    { label: '中文维基', url: `https://zh.wikipedia.org/w/index.php?search=${encodeURIComponent(norm(title))}` },
  ];
}
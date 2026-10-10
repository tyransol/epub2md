/**
 * 界面装配：读取表单 → 调用转换核心 → 下载 Markdown 并展示自检报告。
 * 转换逻辑全部在 src/ 下的模块里，本文件只管界面与本地持久化。
 */
import { convertEpub, MAX_EPUB_BYTES } from './src/converter.js';
import { PROFILES, seriesName } from './src/frontmatter.js';
import { lookupBook, extractEpubClues, externalLinks, refineByIsbn, SOURCES } from './src/lookup.js';

const $ = (id) => document.getElementById(id);

const TEXT_FIELDS = [
  'profile', 'title', 'series', 'author', 'japaneseTitle', 'releaseDate',
  'timePrecision', 'description', 'tags', 'coverUrlOverride', 'publisher', 'sourceUrl', 'isbn',
];
const FIELDS = [...TEXT_FIELDS, 'pinned'];
const STORE_KEY = 'epubmd.fields';
const CACHE_KEY = 'epubmd.imgcache';
const CACHE_MAX = 800;

const logEl = $('log');
const resEl = $('result');
const lkLogEl = $('lkLog');
const lkResEl = $('lkResult');

// ---- 字段记忆 ----
const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
for (const k of FIELDS) {
  if (saved[k] === undefined) continue;
  if (k === 'pinned') $(k).checked = !!saved[k];
  else $(k).value = saved[k];
}
if (!$('profile').value) $('profile').value = 'shirone';
if (!$('timePrecision').value) $('timePrecision').value = 'datetime';

function persist() {
  const data = Object.fromEntries(FIELDS.map((f) => [f, f === 'pinned' ? $(f).checked : $(f).value]));
  localStorage.setItem(STORE_KEY, JSON.stringify(data));
}
for (const k of FIELDS) {
  const el = $(k);
  el.addEventListener(k === 'pinned' ? 'change' : 'input', persist);
}
$('forget').onclick = () => {
  localStorage.removeItem(STORE_KEY);
  for (const k of FIELDS) { if (k === 'pinned') $(k).checked = false; else $(k).value = ''; }
  $('profile').value = 'shirone';
  $('timePrecision').value = 'datetime';
  syncProfileNote();
  log('已忘记本机保存的字段。');
};

// ---- 系列名自动推导（仅在用户没手动改过时）----
let seriesTouched = false;
$('series').addEventListener('input', () => { seriesTouched = $('series').value.trim() !== ''; });
$('title').addEventListener('input', () => {
  if (seriesTouched) return;
  if ($('title').value.trim()) $('series').value = seriesName($('title').value);
});

// ---- Frontmatter 方案说明 ----
function syncProfileNote() {
  const p = $('profile').value;
  $('profileFields').textContent = '将构造字段：' + PROFILES[p].fields.join(' → ');
}
$('profile').addEventListener('change', syncProfileNote);
syncProfileNote();

// ---- 图片缓存（内容哈希 → 图床 URL）----
function loadCache() {
  try { return new Map(Object.entries(JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'))); }
  catch { return new Map(); }
}
let imgCache = loadCache();
function saveCache() {
  const entries = [...imgCache.entries()].slice(-CACHE_MAX);
  imgCache = new Map(entries);
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(Object.fromEntries(entries))); } catch {}
  showCache();
}
function showCache() { $('cacheInfo').textContent = `图片缓存 ${imgCache.size} 条`; }
showCache();
$('clearCache').onclick = () => {
  imgCache = new Map();
  saveCache();
  log('已清空图片缓存（图床上的图不会删除，只是下次会重新上传）。');
};

function log(t) { logEl.textContent += t + '\n'; logEl.scrollTop = logEl.scrollHeight; }
function fail(t) { resEl.innerHTML = `<div class="bad">✗ ${t}</div>`; }

const val = (id) => $(id).value.trim();

function readFields() {
  const f = {
    profile: $('profile').value,
    title: val('title'),
    series: val('series'),
    author: val('author'),
    japaneseTitle: val('japaneseTitle'),
    releaseDate: val('releaseDate'),
    timePrecision: $('timePrecision').value,
    description: val('description'),
    tags: val('tags') ? val('tags').split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : [],
    pinned: $('pinned').checked,
    coverUrlOverride: val('coverUrlOverride'),
    publisher: val('publisher'),
    sourceUrl: val('sourceUrl'),
    isbn: val('isbn'),
  };
  if (!f.japaneseTitle) throw new Error('请填写「日文原名」（查不到就先去查证，不要猜）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.releaseDate)) throw new Error('发售日格式应为 YYYY-MM-DD');
  if (f.sourceUrl && !/^https?:\/\//.test(f.sourceUrl)) throw new Error('书目来源 URL 应以 http(s):// 开头');
  if (f.coverUrlOverride && !/^https:\/\//.test(f.coverUrlOverride)) throw new Error('手动封面必须是 HTTPS URL');
  return f;
}

// ---- 书目信息检索 ----
// 规矩：只采用、不猜。候选一律标出来源；只填空字段，绝不覆盖已手填内容。
const esc = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
/** 采用时产生的「需人工确认」项，转换后随自检报告一起显示。 */
let adoptNotes = [];

const lkLog = (t) => { lkLogEl.textContent += t + '\n'; lkLogEl.scrollTop = lkLogEl.scrollHeight; };

/** 只填空值，不覆盖用户已填内容。 */
function fillIfEmpty(id, v) {
  const el = $(id);
  if (!v || el.value.trim()) return false;
  el.value = v;
  return true;
}

/** 从选中的 EPUB 里读线索（纯本地，不发请求）。 */
async function readClues() {
  const file = $('epub').files[0];
  if (!file) { lkLog('请先在顶部选择 EPUB 文件。'); return; }
  try {
    const c = extractEpubClues(new Uint8Array(await file.arrayBuffer()));
    lkLog(`读线索：${file.name}`);
    lkLog(`· 书名「${c.title || '—'}」作者「${c.author || '—'}」出版社「${c.publisher || '—'}」ISBN「${c.isbn || '无'}」`);
    if (c.originalTitle) lkLog(`· 版权页「原著名」：${c.originalTitle}`);
    const titleClue = c.originalTitle || c.title;
    const filled = [];
    if (fillIfEmpty('lkTitle', titleClue)) filled.push(c.originalTitle ? '书名（版权页原著名）' : '书名');
    if (fillIfEmpty('lkAuthor', c.author)) filled.push('作者');
    if (fillIfEmpty('lkIsbn', c.isbn)) filled.push('ISBN');
    lkLog(filled.length ? `· 已填入检索框：${filled.join('、')}` : '· 检索框已有内容，未覆盖');
  } catch (e) {
    lkLog('✗ 读取线索失败：' + ((e && e.message) || e));
  }
}

function linksHtml(q) {
  const links = externalLinks({ title: q.title, japaneseTitle: q.japaneseTitle, isbn: q.isbn });
  return '<div class="hint">人工核对外链：' +
    links.map((l) => `<a class="link-btn" href="${esc(l.url)}" target="_blank" rel="noreferrer">${esc(l.label)}</a>`).join('') +
    '</div>';
}

function precisionText(c) {
  if (c.datePrecision === 'day') return '精确到日';
  if (c.datePrecision === 'month') return '只到「年月」，日按 01 填入，需确认';
  if (c.datePrecision === 'year') return '只到「年」，需确认';
  return '该来源未给出版日期';
}

function renderCandidates(res) {
  if (!res.candidates.length) {
    lkResEl.innerHTML = '<div class="bad">没有候选。请用外链人工核对，或直接手填（查不到就空着，不要猜）。</div>' +
      linksHtml({ title: res.query.title, japaneseTitle: res.japaneseTitle, isbn: res.query.isbn });
    return;
  }
  const parts = [];
  if (res.japaneseTitle) {
    parts.push(`<div class="hint">推得日文原名：<b>${esc(res.japaneseTitle)}</b>（${esc(res.japaneseTitleVia || '')}）</div>`);
  }
  parts.push('<div class="cand-list">');
  res.candidates.forEach((c, i) => {
    parts.push(
      `<div class="cand">
        <div class="cand-head">
          <b>${esc(c.title)}</b>
          ${c.authorMatch ? '<span class="pill acc">作者匹配</span>' : ''}
          <span class="pill">${esc((SOURCES[c.source] || {}).label || c.source)}</span>
        </div>
        <div class="cand-body">著者：${esc(c.author || '—')}　出版社：${esc(c.publisher || '—')}<br>
          出版：${esc(c.issuedRaw || '—')} → ${esc(c.date || '—')}（${precisionText(c)}）<br>
          ISBN：${esc(c.isbnRaw || '—')}</div>
        <div class="row">
          <button class="mini adopt" data-i="${i}">采用</button>
          ${c.url ? `<a class="link-btn" href="${esc(c.url)}" target="_blank" rel="noreferrer">查书目页</a>` : ''}
        </div>
      </div>`);
  });
  parts.push('</div>');
  parts.push(linksHtml({ title: res.query.title, japaneseTitle: res.japaneseTitle, isbn: res.query.isbn }));
  lkResEl.innerHTML = parts.join('');
  lkResEl.querySelectorAll('button.adopt').forEach((b) => {
    b.onclick = () => adopt(res.candidates[Number(b.dataset.i)], res, b);
  });
}

/** 采用一条候选：写入表单空字段，并留下「需人工确认」提示。 */
async function adopt(cand, res, btn) {
  btn.disabled = true;
  let c = cand;
  if (c.datePrecision === 'year' && c.isbn) {
    lkLog('… 日期只到「年」，向 openBD 补一次出版年月');
    c = await refineByIsbn(c, { onLog: lkLog });
  }
  const ja = res.japaneseTitle || seriesName(c.title);
  const filled = [];
  if (fillIfEmpty('japaneseTitle', ja)) filled.push('日文原名');
  if (fillIfEmpty('releaseDate', c.date)) filled.push('发售日');
  if (fillIfEmpty('isbn', c.isbnRaw || c.isbn)) filled.push('ISBN');
  if (fillIfEmpty('sourceUrl', c.url)) filled.push('书目来源 URL');
  if (fillIfEmpty('publisher', c.publisher)) filled.push('出版社');
  if (fillIfEmpty('author', c.author)) filled.push('作者');
  persist();

  const warn = c.datePrecision && c.datePrecision !== 'day'
    ? `「${c.title}」的出版日期原文是 ${c.issuedRaw}（${c.datePrecision === 'month' ? '仅到月' : '仅到年'}），已按 ${c.date} 填入，日部分必须人工核对来源后修正`
    : '';
  if (warn && !adoptNotes.includes(warn)) adoptNotes.push(warn);

  lkLog(`✓ 采用「${c.title}」→ 已填：${filled.length ? filled.join('、') : '无（字段已有内容，未覆盖）'}`);
  if (warn) lkLog('⚠ ' + warn);
  lkResEl.querySelectorAll('.cand').forEach((el) => el.classList.remove('picked'));
  if (btn.closest('.cand')) btn.closest('.cand').classList.add('picked');
  btn.disabled = false;
  btn.textContent = '已采用';
}

async function doLookup() {
  const query = {
    title: val('lkTitle') || val('title'),
    author: val('lkAuthor') || val('author'),
    isbn: val('lkIsbn') || val('isbn'),
    japaneseTitle: val('japaneseTitle'),
  };
  lkLogEl.textContent = '';
  lkResEl.innerHTML = '';
  $('lkGo').disabled = true;
  $('lkInfo').textContent = '检索中…';
  lkLog(`检索：书名「${query.title || '—'}」作者「${query.author || '—'}」ISBN「${query.isbn || '—'}」`);
  try {
    const res = await lookupBook(query, { onLog: lkLog });
    renderCandidates(res);
    $('lkInfo').textContent = `候选 ${res.candidates.length} 条 / 请求 ${res.steps.length} 次`;
  } catch (e) {
    const msg = (e && e.message) || String(e);
    lkLog('✗ ' + msg);
    $('lkInfo').textContent = '检索失败';
    lkResEl.innerHTML = `<div class="bad">✗ ${esc(msg)}</div>`;
  } finally {
    $('lkGo').disabled = false;
  }
}

$('lkFromEpub').onclick = readClues;
$('lkGo').onclick = doLookup;
$('epub').addEventListener('change', () => {
  adoptNotes = [];      // 换书即换上下文
  readClues();          // 上传即读本地线索（不发请求）
});

$('go').onclick = async () => {
  logEl.textContent = '';
  resEl.innerHTML = '';

  let fields;
  try { fields = readFields(); } catch (e) { return fail(e.message); }

  const file = $('epub').files[0];
  if (!file) return fail('请先选择 EPUB 文件（一次只转一本，避免字段与书错配）');
  if (file.size > MAX_EPUB_BYTES) return fail(`EPUB 超过 ${MAX_EPUB_BYTES / 1e6} MB（${(file.size / 1e6).toFixed(1)} MB）`);

  $('go').disabled = true;
  const t0 = Date.now();
  try {
    log(`读取 ${file.name}（${(file.size / 1e6).toFixed(1)} MB）`);
    const out = await convertEpub(file, fields, { cache: imgCache, onProgress: log });
    saveCache();

    const blob = new Blob([out.content], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = out.filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);

    log(`完成：${out.filename}　${(blob.size / 1024).toFixed(0)} KB　插图 ${out.imageCount} 张　用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    const r = out.report;
    const fm = out.content.slice(0, out.content.indexOf('\n---', 4) + 4);
    resEl.innerHTML =
      `<div class="${r.ok ? 'ok' : 'bad'}">${r.ok ? '✓ 技术自检通过' : '✗ 技术自检发现问题'}</div>` +
      (r.problems.length ? `<ul class="bad">${r.problems.map((p) => `<li>${p}</li>`).join('')}</ul>` : '') +
      `<ul>${r.notes.map((n) => `<li>${n}</li>`).join('')}</ul>` +
      (adoptNotes.length
        ? `<div class="bad">⚠ 采用的书目信息需人工确认：</div><ul class="bad">${adoptNotes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>`
        : '') +
      `<div class="hint">生成的 frontmatter：</div><pre class="preview">${fm.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>` +
      `<div class="hint">文件已下载到本地。交付前请人工核对：书名、系列、日文原名、发售日是否与来源一致。</div>`;
  } catch (e) {
    log('失败：' + (e && e.message ? e.message : e));
    fail((e && e.message) || String(e));
  } finally {
    $('go').disabled = false;
  }
};
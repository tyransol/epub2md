/**
 * 界面装配：读取表单 → 调用转换核心 → 下载 Markdown 并展示自检报告。
 * 转换逻辑全部在 src/ 下的模块里，本文件只管界面与本地持久化。
 */
import { convertEpub, MAX_EPUB_BYTES } from './src/converter.js';
import { PROFILES, seriesName } from './src/frontmatter.js';

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
      `<div class="hint">生成的 frontmatter：</div><pre class="preview">${fm.replace(/[<>&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>` +
      `<div class="hint">文件已下载到本地。交付前请人工核对：书名、系列、日文原名、发售日是否与来源一致。</div>`;
  } catch (e) {
    log('失败：' + (e && e.message ? e.message : e));
    fail((e && e.message) || String(e));
  } finally {
    $('go').disabled = false;
  }
};
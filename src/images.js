/**
 * 图床上传模块（纯浏览器，无服务端）
 *
 * 与旧版一致：图片按内容哈希缓存，同一张图在不同书 / 不同次导出之间只上传一次。
 * 图床地址与上传接口路径由调用方注入，默认指向工作区在用的 CloudFlare-ImgBed 部署。
 */

export const DEFAULT_IMAGE_HOST = 'https://tc.iiiiii.cc.cd';

/**
 * 上传入口路径。始终打同源 `/upload`，由同源代理转发到图床：
 * Cloudflare Pages → functions/upload.js，Vercel → api/upload.js（vercel.json 重写），
 * 本地 → dev.mjs（npm run dev）。
 *
 * 起因（实测）：图床的 POST /upload 返回 200 但不带任何 Access-Control-Allow-Origin，
 * OPTIONS 直接 405。浏览器跨域直连时文件其实已存进图床，却在读取响应时被 CORS 拦成
 * TypeError: Failed to fetch，拿不到 src。同源转发不存在跨域，问题消失。
 */
export const UPLOAD_PATH = '/upload';

const hex = (buf) =>
  Array.from(new Uint8Array(buf)).map((x) => x.toString(16).padStart(2, '0')).join('');

/** 内容哈希：用于图片去重缓存与时间派生。 */
export async function sha256(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const buf = view.byteOffset === 0 && view.byteLength === view.buffer.byteLength
    ? view.buffer
    : view.slice().buffer;
  return hex(await crypto.subtle.digest('SHA-256', buf));
}

export const mimeOf = (f) =>
  /\.png$/i.test(f) ? 'image/png'
  : /\.webp$/i.test(f) ? 'image/webp'
  : /\.gif$/i.test(f) ? 'image/gif'
  : /\.svg$/i.test(f) ? 'image/svg+xml'
  : 'image/jpeg';

const makeBody = (bytes, name) => {
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: mimeOf(name) }), name.split('/').pop());
  return body;
};

/**
 * 图床限流（实测）：其 Telegram 后端约每分钟只收 ~20 张，超了返回
 *   500 {"error":"Too Many Requests: retry after 23"}
 * 一本书 20+ 张图连传必撞，所以先**主动限速**（约 17 张/分钟），
 * 撞上了则按它给的 retry after 秒数等待，而不是死等固定 0.4s。
 */
const UPLOAD_INTERVAL_MS = 3500;
const ATTEMPTS = 4;
const MAX_WAIT_MS = 90_000;
const RETRY_AFTER_RE = /retry after (\d+)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let lastUploadAt = 0;
async function pace() {
  const wait = lastUploadAt + UPLOAD_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastUploadAt = Date.now();
}

const isTransient = (res) => !!res && (res.status === 429 || res.status >= 500);

/** 等待时长：优先听图床的 retry after，没有提示才退回默认退避。 */
const waitFor = (detail, attempt) =>
  Math.min(RETRY_AFTER_RE.test(detail) ? Number(RETRY_AFTER_RE.exec(detail)[1]) * 1000 + 500
    : [800, 2000, 4000][attempt] ?? 4000, MAX_WAIT_MS);

/**
 * 带退避的 POST。bodyFactory 每次都新建 FormData（请求体不可复用）。
 * @returns {Promise<{res: object, detail: string}>} detail 为最后一次失败响应体（已被读掉）
 */
async function postWithRetry(fetchImpl, url, bodyFactory, onWait = () => {}) {
  let res = null;
  let detail = '';
  let lastError = null;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      res = await fetchImpl(url, { method: 'POST', body: bodyFactory() });
      if (!isTransient(res)) return { res, detail: '' };
      detail = (await res.text()).trim().slice(0, 160);
    } catch (e) {
      lastError = e;
      res = null;
      detail = '';
    }
    if (attempt === ATTEMPTS - 1) break;
    const wait = waitFor(detail, attempt);
    onWait(wait, detail);
    await sleep(wait);
  }
  if (res) return { res, detail };
  throw lastError;
}

/**
 * 上传一张图片到图床。cache 是 Map(hash → url)，由调用方传入并持久化。
 *
 * 顺序：① 同源 /upload 代理 → ② 代理不存在时退回图床直连（仅当图床自带 CORS 头才可能成功）。
 * @param {function} [onWait] (ms, detail) 撞上限流准备等待时回调，供 UI 提示进度
 * @returns {Promise<string>} 图床直链
 */
export async function uploadImage(
  bytes, name, cache, imageHost = DEFAULT_IMAGE_HOST, fetchImpl = fetch, onWait = () => {}) {
  const hash = await sha256(bytes);
  if (cache && cache.has(hash)) return cache.get(hash);
  await pace();                       // 主动限速，避免连传触发图床限流
  const body = () => makeBody(bytes, name);

  let out = null;
  try { out = await postWithRetry(fetchImpl, UPLOAD_PATH, body, onWait); } catch { out = null; }  // 纯静态托管：连不上代理
  if (!out || out.res.status === 404 || out.res.status === 405) {                                 // 代理缺失 → 试直连
    try { out = await postWithRetry(fetchImpl, imageHost + UPLOAD_PATH, body, onWait); } catch { out = null; }
  }
  if (!out) {
    throw new Error(
      `图床上传失败：同源代理 ${UPLOAD_PATH} 不可用，图床 ${imageHost} 也未返回 CORS 头，`
      + '浏览器跨域读不到上传结果（文件可能已存入图床，但拿不到直链）。'
      + '部署到 Cloudflare Pages / Vercel 时会自动带上代理；本地请用 npm run dev。');
  }
  const { res, detail } = out;
  if (!res.ok) {
    throw new Error(
      `图床上传失败：HTTP ${res.status}（已重试 ${ATTEMPTS} 次）：${detail || '图床未返回说明'}`);
  }

  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch {
    throw new Error('图床返回的不是 JSON（可能命中了静态托管的兜底页）：' + text.trim().slice(0, 80));
  }
  const src = (Array.isArray(json) ? json[0] : json)?.src;
  if (typeof src !== 'string' || !/^\/file\/[\w.%/-]+$/.test(src)) {
    throw new Error('图床返回的 src 无效：' + JSON.stringify(json).slice(0, 120));
  }
  const url = imageHost + src;
  if (cache) cache.set(hash, url);
  return url;
}

/**
 * 时间派生：发售日 +1 天，时分秒 = SHA-256(EPUB字节 + 发售日 + 日文原名) 前 4 字节 % 86400。
 * 目的：同一本书任何时候重跑都得到同一个时分秒，无需任何服务端存储（旧版靠 Cloudflare KV）。
 */
export async function deriveStamp(epubBytes, releaseDate, japaneseTitle) {
  const d = new Date(releaseDate + 'T00:00:00Z');
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== releaseDate) {
    throw new Error('发售日无效：' + releaseDate);
  }
  const extra = new TextEncoder().encode(`${releaseDate}\u0000${japaneseTitle}`);
  const joined = new Uint8Array(epubBytes.length + extra.length);
  joined.set(epubBytes, 0);
  joined.set(extra, epubBytes.length);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', joined));
  const secs = ((digest[0] << 24) | (digest[1] << 16) | (digest[2] << 8) | digest[3]) >>> 0;
  const seconds = secs % 86400;
  d.setUTCDate(d.getUTCDate() + 1);
  const hhmmss = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
    .map((n) => String(n).padStart(2, '0')).join(':');
  const nextDay = d.toISOString().slice(0, 10);
  return { stamp: nextDay + ' ' + hhmmss, dateOnly: nextDay, seconds, nextDay };
}
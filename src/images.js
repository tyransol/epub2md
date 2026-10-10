/**
 * 图床上传模块（纯浏览器，无服务端）
 *
 * 与旧版一致：图片按内容哈希缓存，同一张图在不同书 / 不同次导出之间只上传一次。
 * 图床地址与上传接口路径由调用方注入，默认指向工作区在用的 CloudFlare-ImgBed 部署。
 */

export const DEFAULT_IMAGE_HOST = 'https://tc.iiiiii.cc.cd';

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

/**
 * 上传一张图片到图床。cache 是 Map(hash → url)，由调用方传入并持久化。
 * @returns {Promise<string>} 图床直链
 */
export async function uploadImage(bytes, name, cache, imageHost = DEFAULT_IMAGE_HOST, fetchImpl = fetch) {
  const hash = await sha256(bytes);
  if (cache && cache.has(hash)) return cache.get(hash);
  const body = new FormData();
  body.append('file', new Blob([bytes], { type: mimeOf(name) }), name.split('/').pop());
  const res = await fetchImpl(imageHost + '/upload', { method: 'POST', body });
  if (!res.ok) throw new Error('图床上传失败：HTTP ' + res.status);
  const json = await res.json();
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
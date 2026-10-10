/**
 * 本地开发服务器：静态文件 + 同源上传代理（等价于部署后的 functions/upload.js）。
 *
 *   npm run dev   →  http://localhost:5173
 *
 * 用它的原因：图床的 POST /upload 不返回 CORS 头，浏览器跨域直连会在读取响应时报
 * "Failed to fetch"（见 src/images.js 的注释）。这里把 /upload 转成同源请求再转发出去。
 * 纯静态服务器（npx serve / python -m http.server）没有这个转发，封面会失败。
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const ROOT = resolve('.');
const PORT = Number(process.env.PORT || 5173);
const IMAGE_HOST = process.env.IMAGE_HOST || 'https://tc.iiiiii.cc.cd';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const readBody = (req) => new Promise((ok, no) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => ok(Buffer.concat(chunks)));
  req.on('error', no);
});

async function proxyUpload(req, res) {
  try {
    const upstream = await fetch(IMAGE_HOST + '/upload', {
      method: 'POST',
      headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
      body: await readBody(req),
    });
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(await upstream.text());
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: '代理转发失败：' + e.message }));
  }
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  const file = join(ROOT, normalize(rel));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 ' + pathname);
  }
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://localhost');
  if (pathname === '/upload') {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('405 Method Not Allowed');
      return;
    }
    await proxyUpload(req, res);
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('405 Method Not Allowed');
    return;
  }
  await serveStatic(pathname, res);
}).listen(PORT, () => {
  console.log(`epub-to-md dev → http://localhost:${PORT}（图床代理 ${IMAGE_HOST}/upload）`);
});
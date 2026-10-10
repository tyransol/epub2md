/**
 * Vercel Serverless Function：同源上传代理 → https://tc.iiiiii.cc.cd/upload
 * 与 Cloudflare Pages 的 functions/upload.js 等价（原因见该文件注释）。
 * vercel.json 已把 /upload 重写到本路径，因此前端始终只打同源 /upload。
 */

export const config = { api: { bodyParser: false } };

const IMAGE_HOST = 'https://tc.iiiiii.cc.cd';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method Not Allowed' });
    return;
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);

  const upstream = await fetch(IMAGE_HOST + '/upload', {
    method: 'POST',
    headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
    body: Buffer.concat(chunks),
  });

  res.status(upstream.status);
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.send(await upstream.text());
}
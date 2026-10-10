/**
 * Cloudflare Pages Function：同源上传代理 → https://tc.iiiiii.cc.cd/upload
 *
 * 为什么需要：图床的 POST /upload 返回 200，但响应里没有任何 Access-Control-Allow-Origin
 * （OPTIONS 直接 405）。浏览器跨域直连时文件其实已存进图床，却在读取响应时被 CORS 拦成
 * TypeError: Failed to fetch，拿不到图床直链。改成打同源 /upload 由本函数转发即可绕开。
 *
 * 放在仓库根 functions/ 下，Cloudflare Pages 自动识别，无需构建步骤（输出目录 `/` 下同样适用）。
 */

const IMAGE_HOST = 'https://tc.iiiiii.cc.cd';

export async function onRequestPost({ request }) {
  const upstream = await fetch(IMAGE_HOST + '/upload', {
    method: 'POST',
    headers: { 'content-type': request.headers.get('content-type') || 'application/octet-stream' },
    body: await request.arrayBuffer(),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}
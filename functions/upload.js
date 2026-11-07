/**
 * Cloudflare Pages Function：同源上传代理 → https://img.ixxxi.cc.cd/upload
 *
 * 为什么需要：图床的 POST /upload 不返回 CORS 头（OPTIONS 直接 405）。浏览器跨域直连时
 * 文件其实已存进图床，却在读取响应时被 CORS 拦成 TypeError: Failed to fetch，拿不到直链。
 * 改成打同源 /upload 由本函数转发即可绕开。
 *
 * 鉴权：API Token 只放服务端环境变量 IMGBED_TOKEN（CF Pages → Settings → Environment
 * variables），绝不写进仓库。客户端只打同源 /upload，接触不到 token。
 *
 * 放在仓库根 functions/ 下，Cloudflare Pages 自动识别，无需构建步骤（输出目录 `/` 下同样适用）。
 */

const IMAGE_HOST = 'https://img.ixxxi.cc.cd';

export async function onRequestPost({ request, env }) {
  const token = env.IMGBED_TOKEN;
  if (!token) {
    return new Response(JSON.stringify({ error: '未配置 IMGBED_TOKEN 环境变量' }), {
      status: 500,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  const upstream = await fetch(IMAGE_HOST + '/upload', {
    method: 'POST',
    headers: {
      'content-type': request.headers.get('content-type') || 'application/octet-stream',
      authorization: `Bearer ${token}`,
    },
    body: await request.arrayBuffer(),
  });
  return new Response(upstream.body, {
    status: upstream.status,
    headers: { 'content-type': upstream.headers.get('content-type') || 'application/json' },
  });
}

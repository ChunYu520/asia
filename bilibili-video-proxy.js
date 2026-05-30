/**
 * B站视频代理 Worker（v2）
 * 在原有 bilibili-proxy.js 基础上增加 /video 视频流代理
 *
 * 新增接口：
 *   GET /video?url=<base64url编码的CDN直链> → 代理转发视频流（带 Referer）
 *
 * 架构：
 *   本地服务器（bili_limit_proxy.js）→ 解析 BV 拿 CDN 直链
 *   → 302 跳转到 bilibili.yuki-can.asia/video?url=xxx
 *   → CF Worker 带 Referer 去请求 B站CDN → 流式转发给客户端
 *
 * 部署方式：替换 bilibili.yuki-can.asia 的 Worker 代码
 */

// ── 视频代理核心 ─────────────────────────────────────────

/**
 * 解码 base64url 编码的 CDN 直链，代理请求 B站 CDN 视频流
 * 自动添加 Referer 头绕过防盗链
 */
async function handleVideo(request) {
  const url = new URL(request.url);
  const encodedUrl = url.searchParams.get('url') || '';

  if (!encodedUrl) {
    return jsonResponse({ error: '缺少参数 url' }, 400);
  }

  let videoUrl;
  try {
    // 支持 base64url 和普通 base64
    let base64 = encodedUrl.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) base64 += '=';
    videoUrl = atob(base64);
  } catch (e) {
    return jsonResponse({ error: 'invalid_url_encoding' }, 400);
  }

  // 安全校验：只允许 B站 CDN 域名
  if (!videoUrl.startsWith('https://') && !videoUrl.startsWith('http://')) {
    return jsonResponse({ error: 'only_https_allowed' }, 403);
  }

  const parsedOrigin = new URL(videoUrl).hostname;
  const allowedHosts = [
    'upos-sz-estgoss.bilivideo.com',
    'upos-sz-mirrorkodovi.bilivideo.com',
    'upos-sz-mirrorhw.bilivideo.com',
    'upos-hz-mirrorkodovi.bilivideo.com',
    'upos-sz-estgoss.bilivideo.com',
    'cn-hbxy-cmcc-bcache-01.bilivideo.com',
    'cn-bj29-cu-bcache-01.bilivideo.com',
    'upos-sz.bilivideo.com',
  ];

  // 允许所有 bilivideo.com 子域名
  if (!parsedOrigin.endsWith('.bilivideo.com')) {
    return jsonResponse({ error: `domain_not_allowed: ${parsedOrigin}` }, 403);
  }

  // 代理请求 B站 CDN，带上 Referer
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Origin': 'https://www.bilibili.com',
  };

  try {
    const response = await fetch(videoUrl, {
      headers,
      redirect: 'follow',
    });

    // 透传 CDN 响应，但覆盖 CORS 头
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    // 删除可能导致问题的头
    newHeaders.delete('set-cookie');

    return new Response(response.body, {
      status: response.status,
      headers: newHeaders,
    });
  } catch (e) {
    return jsonResponse({ error: `video_proxy_failed: ${e.message}` }, 502);
  }
}

// ── 工具函数 ────────────────────────────────────────────

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── 主入口 ──────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS 预检
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, OPTIONS',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // ── /health ──
    if (path === '/health' || path === '/healthz') {
      return jsonResponse({
        status: 'healthy',
        service: 'bilibili-proxy-worker',
        version: '2.0.0',
        features: ['video_proxy'],
        timestamp: new Date().toISOString(),
      });
    }

    // ── /video ── 视频流代理（核心新增）
    if (path === '/video') {
      return handleVideo(request);
    }

    // ── 兼容：原有的 /bili /resolve 等路由 ──
    // 如果需要完整功能，可以合并原有 bilibili-proxy.js 的逻辑
    // 目前只做视频代理，解析走本地服务器

    return new Response('Not Found\n\nAvailable:\n  /video?url=<base64url>\n  /health', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

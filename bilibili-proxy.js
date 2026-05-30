/**
 * B站视频直链解析 Worker（v2）
 * 部署在 Cloudflare Workers
 *
 * 接口：
 *   GET /bili?id=BVxxx           → 302 跳转到视频直链
 *   GET /bili?id=BVxxx&p=2       → 指定分P
 *   GET /bili?id=b23.tv短链       → 自动解析短链后跳转
 *   GET /video?url=<base64url>   → 代理视频流（带 Referer，解决 CDN 403）
 *   GET /resolve?id=xxx          → 只返回 {bv, part}，不跳转
 *   GET /health                  → 健康检查
 *   GET /stats                   → 统计信息（内存，重启后重置）
 *
 * 环境变量（可选）：
 *   BILI_SESSDATA   - B站登录态 SESSDATA（可选，提高画质上限）
 *   BILI_BILI_JCT   - B站登录态 bili_jct（可选）
 */

// ── 解析源定义 ──────────────────────────────────────────

const PROVIDERS = {
  // B站官方 API（CF IP 一般不被拦，优先用这个）
  official: {
    name: 'bilibili_official',
    type: 'official',
    weight: 100,
    async parse(bv, part, env) {
      // Step 1: 拿 cid
      const infoUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${bv}`;
      const infoResp = await fetch(infoUrl, {
        headers: buildBilibiliHeaders(env),
      });
      const infoData = await infoResp.json();

      if (infoData.code !== 0) {
        return { error: `获取视频信息失败: ${infoData.message}` };
      }

      const video = infoData.data;
      let cid = video.cid;
      if (part > 1 && video.pages && video.pages[part - 1]) {
        cid = video.pages[part - 1].cid;
      }

      // Step 2: 拿播放地址（qn=80: 1080p）
      const playUrl =
        `https://api.bilibili.com/x/player/playurl` +
        `?bvid=${bv}&cid=${cid}&qn=80&fnval=0&fnver=0&fourk=0`;
      const playResp = await fetch(playUrl, {
        headers: buildBilibiliHeaders(env),
      });
      const playData = await playResp.json();

      if (playData.code !== 0) {
        return { error: `获取播放地址失败: ${playData.message}` };
      }

      const durl = playData.data?.durl || [];
      if (durl.length > 0 && durl[0].url) {
        return { url: durl[0].url };
      }

      return { error: '官方API未返回有效的视频地址' };
    },
  },
};

// ── 工具函数 ────────────────────────────────────────────

function buildBilibiliHeaders(env) {
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    'Referer': 'https://www.bilibili.com/',
    'Accept': 'application/json, text/plain, */*',
  };
  if (env.BILI_SESSDATA) {
    headers['Cookie'] = `SESSDATA=${env.BILI_SESSDATA}`;
    if (env.BILI_BILI_JCT) {
      headers['Cookie'] += `; bili_jct=${env.BILI_BILI_JCT}`;
    }
  }
  return headers;
}

/** 从输入中提取 BV 号，支持 b23.tv 短链 */
async function resolveBv(raw, env) {
  let part = null;
  const pMatch = raw.match(/[?&]p=(\d+)/);
  if (pMatch) part = parseInt(pMatch[1]);

  // 直接匹配 BV 号
  const bvMatch = raw.match(/BV[a-zA-Z0-9]{10}/);
  if (bvMatch) return { bv: bvMatch[0], part };

  // 短链 / URL：用 fetch 跟随重定向
  if (/^https?:\/\//i.test(raw)) {
    try {
      const resp = await fetch(raw, {
        redirect: 'follow',
        headers: { 'User-Agent': 'Mozilla/5.0' },
      });
      const finalUrl = resp.url;
      const bvMatch2 = finalUrl.match(/BV[a-zA-Z0-9]{10}/);
      if (bvMatch2) {
        const pMatch2 = finalUrl.match(/[?&]p=(\d+)/);
        if (pMatch2) part = parseInt(pMatch2[1]);
        return { bv: bvMatch2[0], part };
      }
      const text = await resp.text();
      const bvMatch3 = text.match(/BV[a-zA-Z0-9]{10}/);
      if (bvMatch3) return { bv: bvMatch3[0], part };
    } catch (e) {
      return { error: `短链解析失败: ${e.message}` };
    }
  }

  return { error: '无法提取 BV 号，请检查输入' };
}

/** 用 Cache API 缓存解析结果（24h） */
async function getCache(bv, part) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.bilibili-proxy.local/bili/${bv}/p${part}`);
  const cached = await cache.match(cacheKey);
  if (cached) {
    const data = await cached.json();
    return data.url;
  }
  return null;
}

async function setCache(bv, part, url) {
  const cache = caches.default;
  const cacheKey = new Request(`https://cache.bilibili-proxy.local/bili/${bv}/p${part}`);
  const resp = new Response(JSON.stringify({ url }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=86400' },
  });
  await cache.put(cacheKey, resp);
}

// ── 视频代理 ────────────────────────────────────────────

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

  if (!videoUrl.startsWith('https://') && !videoUrl.startsWith('http://')) {
    return jsonResponse({ error: 'only_https_allowed' }, 403);
  }

  // 安全校验：只允许 bilivideo.com 域名
  const parsedOrigin = new URL(videoUrl).hostname;
  if (!parsedOrigin.endsWith('.bilivideo.com')) {
    return jsonResponse({ error: `domain_not_allowed: ${parsedOrigin}` }, 403);
  }

  // 代理请求 B站 CDN，带上 Referer 绕过防盗链
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

    // 修复：B站 CDN 偶尔返回非法状态码（如 0、600+），需要钳制到合法范围
    let status = response.status;
    if (status < 200 || status > 599) {
      status = 502;
    }

    const newHeaders = new Headers(response.headers);
    newHeaders.set('Access-Control-Allow-Origin', '*');
    newHeaders.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    newHeaders.delete('set-cookie');

    return new Response(response.body, {
      status,
      headers: newHeaders,
    });
  } catch (e) {
    return jsonResponse({ error: `video_proxy_failed: ${e.message}` }, 502);
  }
}

// ── 统计（内存，Worker 重启后重置）──────────────────────
const stats = {
  total: 0,
  success: 0,
  failed: 0,
  providers: {},
};

function statSuccess(name) {
  stats.total++;
  stats.success++;
  if (!stats.providers[name]) stats.providers[name] = { success: 0, failed: 0 };
  stats.providers[name].success++;
}
function statFail(name) {
  stats.total++;
  stats.failed++;
  if (!stats.providers[name]) stats.providers[name] = { success: 0, failed: 0 };
  stats.providers[name].failed++;
}

// ── 主入口 ──────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const params = url.searchParams;

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

    // ── /stats ──
    if (path === '/stats') {
      return jsonResponse({
        ...stats,
        providers: Object.entries(stats.providers).map(([k, v]) => ({
          name: k,
          ...v,
        })),
        uptime: 'N/A (Workers 无持久化)',
      });
    }

    // ── /resolve ── 只解析 BV 号，不跳转
    if (path === '/resolve') {
      const raw = params.get('id') || '';
      if (!raw) return jsonResponse({ error: '缺少参数 id' }, 400);
      const result = await resolveBv(raw, env);
      if (result.error) return jsonResponse({ error: result.error }, 400);
      return jsonResponse({ bv: result.bv, part: result.part || 1 });
    }

    // ── /video ── 视频流代理（带 Referer 绕过 CDN 防盗链）
    if (path === '/video') {
      return handleVideo(request);
    }

    // ── /bili ── 主解析接口：302 跳转到直链
    if (path === '/bili') {
      const rawId = params.get('id') || '';
      if (!rawId) {
        return jsonResponse({ error: '缺少参数 id（BV号 / B站链接 / b23.tv短链）' }, 400);
      }

      const part = parseInt(params.get('p') || '1');
      const forceProvider = params.get('provider') || '';

      const resolved = await resolveBv(rawId, env);
      if (resolved.error) {
        return jsonResponse({ error: resolved.error }, 400);
      }
      const bv = resolved.bv;
      const actualPart = resolved.part || part;

      const cachedUrl = await getCache(bv, actualPart);
      if (cachedUrl) {
        return Response.redirect(cachedUrl, 302);
      }

      const errors = [];
      try {
        const result = await PROVIDERS.official.parse(bv, actualPart, env);
        if (result.url) {
          ctx.waitUntil(setCache(bv, actualPart, result.url));
          statSuccess(PROVIDERS.official.name);
          return Response.redirect(result.url, 302);
        }
        errors.push(`${PROVIDERS.official.name}: ${result.error}`);
        statFail(PROVIDERS.official.name);
      } catch (e) {
        errors.push(`${PROVIDERS.official.name}: 异常 - ${e.message}`);
        statFail(PROVIDERS.official.name);
      }

      return jsonResponse({
        error: '官方 API 解析失败',
        errors,
        suggestion: '请稍后重试，或提供 BILI_SESSDATA 环境变量以提高成功率',
        bv,
        part: actualPart,
      }, 503);
    }

    // ── 404 ──
    return new Response('Not Found\n\nAvailable:\n  /bili?id=BVxxx\n  /video?url=<base64url>\n  /resolve?id=xxx\n  /health\n  /stats', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  },
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

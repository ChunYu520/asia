/**
 * B站视频直链解析 Worker
 * 部署在 Cloudflare Workers，利用 CF IP 绕过服务器风控
 *
 * 接口：
 *   GET /bili?id=BVxxx           → 302 跳转到视频直链
 *   GET /bili?id=BVxxx&p=2       → 指定分P
 *   GET /bili?id=b23.tv短链        → 自动解析短链后跳转
 *   GET /resolve?id=xxx            → 只返回 {bv, part}，不跳转（供前端构造URL用）
 *   GET /health                    → 健康检查
 *   GET /stats                     → 统计信息（内存，重启后重置）
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

      // Step 2: 拿播放地址（qn=32: 480p，无登录也可用的画质）
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
        // 从最终 URL 里也提取 p 参数
        const pMatch2 = finalUrl.match(/[?&]p=(\d+)/);
        if (pMatch2) part = parseInt(pMatch2[1]);
        return { bv: bvMatch2[0], part };
      }
      // 从响应体里找
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

    // ── /health ──
    if (path === '/health' || path === '/healthz') {
      return jsonResponse({
        status: 'healthy',
        service: 'bilibili-proxy-worker',
        version: '1.0.0',
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

    // ── /bili ── 主解析接口：302 跳转到直链
    if (path === '/bili') {
      const rawId = params.get('id') || '';
      if (!rawId) {
        return jsonResponse({ error: '缺少参数 id（BV号 / B站链接 / b23.tv短链）' }, 400);
      }

      const part = parseInt(params.get('p') || '1');
      const forceProvider = params.get('provider') || '';

      // 解析 BV 号
      const resolved = await resolveBv(rawId, env);
      if (resolved.error) {
        return jsonResponse({ error: resolved.error }, 400);
      }
      const bv = resolved.bv;
      const actualPart = resolved.part || part;

      // 查缓存
      const cachedUrl = await getCache(bv, actualPart);
      if (cachedUrl) {
        return Response.redirect(cachedUrl, 302);
      }

      // 仅使用官方 API 解析
      const errors = [];
      try {
        const result = await PROVIDERS.official.parse(bv, actualPart, env);
        if (result.url) {
          // 缓存 24h
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
    return new Response('Not Found\n\n可用接口:\n  /bili?id=BVxxx\n  /resolve?id=xxx\n  /health\n  /stats', {
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

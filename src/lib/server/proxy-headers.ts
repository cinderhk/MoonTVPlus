/**
 * 代理接口共享工具函数
 * 用于构建标准化的 CORS 响应头，避免各代理路由中的重复代码。
 */

/**
 * 构建标准的代理流式响应头 (用于 ts 分片、密钥、二进制流等)
 * 包含 CORS、Accept-Ranges 和 Content-Length 等标准头。
 */
export function buildProxyStreamHeaders(
  contentType: string,
  contentLength?: string | null
): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  if (contentLength) {
    headers.set('Content-Length', contentLength);
  }
  return headers;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 瓜子影视的 vd.wmvbo.com 对浏览器 UA 和 Referer 很敏感：
 * 带浏览器 UA 或任意 Referer 会返回 2 段试看；原生 App 播放器用的是 Lavf
 * 且不带 Referer。代理这类地址时必须模拟播放器请求，否则代理模式也会拿到
 * 试看（ts 分片甚至会被 302 成一个 m3u8 文本）。
 */
export function isGuaziMediaHost(input: string | URL): boolean {
  try {
    const host = (typeof input === 'string' ? new URL(input) : input).hostname.toLowerCase();
    return (
      host === 'wmvbo.com' ||
      host.endsWith('.wmvbo.com') ||
      host === 'eny7kg.com' ||
      host.endsWith('.eny7kg.com')
    );
  } catch {
    return false;
  }
}

/** 代理请求上游媒体时使用的请求头。 */
export function buildUpstreamMediaHeaders(
  target: string | URL,
  source?: string
): Record<string, string> {
  const url = typeof target === 'string' ? new URL(target) : target;
  // 只针对瓜子地址 / 瓜子源生效，避免影响其他 directplay 直链源。
  if (isGuaziMediaHost(url) || (source && source.startsWith('guazi'))) {
    return {
      'User-Agent': 'Lavf/57.83.100',
      Accept: '*/*',
    };
  }

  return {
    'User-Agent': BROWSER_UA,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    Referer: `${url.protocol}//${url.host}/`,
  };
}

/**
 * 构建标准的代理 M3U8 播放列表响应头
 */
export function buildProxyM3u8Headers(contentType?: string): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType || 'application/vnd.apple.mpegurl');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
  headers.set('Cache-Control', 'no-cache');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  return headers;
}

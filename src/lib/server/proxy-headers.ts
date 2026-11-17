import { isGuaziMediaHost } from '@/lib/guazi-playback';

export { isGuaziMediaHost } from '@/lib/guazi-playback';

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
  contentLength?: string | null,
  upstream?: Headers
): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType);
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Range, Origin, Accept'
  );
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  headers.set('X-Accel-Buffering', 'no');
  if (contentLength) {
    headers.set('Content-Length', contentLength);
  }
  for (const name of [
    'Content-Range',
    'Accept-Ranges',
    'ETag',
    'Last-Modified',
  ]) {
    const value = upstream?.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * 瓜子 CDN 的播放列表可能按 UA / Referer 返回试看。
 * 服务器取播放列表时沿用原生播放器的 UA，不附带 Referer / Origin；
 * 浏览器直连分片时的请求策略在 guazi-playback 中单独处理。
 */
export function buildUpstreamMediaHeaders(
  target: string | URL,
  source?: string,
  clientHeaders?: Headers
): Record<string, string> {
  const url = typeof target === 'string' ? new URL(target) : target;
  // 只针对瓜子地址 / 瓜子源生效，避免影响其他 directplay 直链源。
  const headers: Record<string, string> =
    isGuaziMediaHost(url) || (source && source.startsWith('guazi'))
      ? {
          'User-Agent': 'Lavf/57.83.100',
          Accept: '*/*',
          'Accept-Encoding': 'identity',
        }
      : {
          'User-Agent': BROWSER_UA,
          Accept: '*/*',
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          'Accept-Encoding': 'identity',
          Referer: `${url.protocol}//${url.host}/`,
        };
  for (const name of ['Range', 'If-Range']) {
    const value = clientHeaders?.get(name);
    if (value) headers[name] = value;
  }
  return headers;
}

/**
 * 构建标准的代理 M3U8 播放列表响应头
 */
export function buildProxyM3u8Headers(contentType?: string): Headers {
  const headers = new Headers();
  headers.set('Content-Type', contentType || 'application/vnd.apple.mpegurl');
  headers.set('Access-Control-Allow-Origin', '*');
  headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Range, Origin, Accept'
  );
  headers.set('Cache-Control', 'no-cache');
  headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
  return headers;
}

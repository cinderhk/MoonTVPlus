import { isGuaziMediaHost, isGuaziScriptKey } from './guazi-playback';

export interface ScriptPlaybackResult {
  url: string;
  type: string;
  headers: Record<string, string>;
  proxyMode: boolean;
  appProxyMode?: boolean;
  /** 仅播放列表经服务器读取，媒体分片仍由浏览器直连。 */
  playlistProxy?: boolean;
}

/** Web and native clients use independently saved proxy settings. */
export function scriptPlaybackResponse(
  result: ScriptPlaybackResult,
  proxyToken = '',
  client: 'web' | 'app' = 'web',
  scriptKey = ''
): ScriptPlaybackResult {
  const proxyMode =
    client === 'app' ? result.appProxyMode === true : result.proxyMode;
  const playback = { ...result, proxyMode };
  if (!proxyMode) {
    if (client === 'app') return playback;
    let target: URL;
    try {
      target = new URL(result.url);
    } catch {
      return playback;
    }
    const mediaType = result.type.toLowerCase();
    const fileMedia =
      ['mp4', 'flv', 'webm', 'mkv', 'avi', 'mov'].includes(mediaType) ||
      /\.(mp4|flv|webm|mkv|avi|mov)$/i.test(target.pathname);
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      fileMedia ||
      !(isGuaziScriptKey(scriptKey) || isGuaziMediaHost(target))
    )
      return playback;
    const params = new URLSearchParams({
      url: target.toString(),
      source: 'guazi',
      adblock: 'false',
      proxySegments: 'false',
    });
    if (proxyToken) params.set('token', proxyToken);
    return {
      ...playback,
      type: 'hls',
      playlistProxy: true,
      url: `/api/proxy-m3u8?${params.toString()}`,
    };
  }
  const target = new URL(result.url);
  if (!['http:', 'https:'].includes(target.protocol)) {
    throw new Error('代理播放仅支持 HTTP 或 HTTPS 地址');
  }
  const params = new URLSearchParams({
    url: target.toString(),
    source: 'directplay',
    proxySegments: 'true',
    adblock: 'false',
  });
  if (proxyToken) params.set('token', proxyToken);
  return { ...playback, url: `/api/proxy-m3u8?${params.toString()}` };
}

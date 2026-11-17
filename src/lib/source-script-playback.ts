export interface ScriptPlaybackResult {
  url: string;
  type: string;
  headers: Record<string, string>;
  proxyMode: boolean;
  appProxyMode?: boolean;
}

/** Web and native clients use independently saved proxy settings. */
export function scriptPlaybackResponse(
  result: ScriptPlaybackResult,
  proxyToken = '',
  client: 'web' | 'app' = 'web'
): ScriptPlaybackResult {
  const proxyMode =
    client === 'app' ? result.appProxyMode === true : result.proxyMode;
  const playback = { ...result, proxyMode };
  if (!proxyMode) return playback;
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

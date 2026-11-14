export interface ScriptPlaybackResult {
  url: string;
  type: string;
  headers: Record<string, string>;
  proxyMode: boolean;
}

/** The saved script setting controls media proxying for every client. */
export function scriptPlaybackResponse(
  result: ScriptPlaybackResult,
  proxyToken = ''
): ScriptPlaybackResult {
  if (!result.proxyMode) return result;
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
  return { ...result, url: `/api/proxy-m3u8?${params.toString()}` };
}

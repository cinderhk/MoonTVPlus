/** 与 lightwhale 的瓜子脚本 key 和媒体域名判定保持一致。 */
export function isGuaziScriptKey(key: string): boolean {
  const value = key.trim().toLowerCase();
  return value.startsWith('gz') || value.startsWith('guazi');
}

export function isGuaziSource(source: string): boolean {
  const value = source.trim().toLowerCase();
  return (
    value.startsWith('script:') &&
    isGuaziScriptKey(value.slice('script:'.length).split(':')[0])
  );
}

export function isGuaziMediaHost(input: string | URL): boolean {
  try {
    const host = (
      typeof input === 'string' ? new URL(input) : input
    ).hostname.toLowerCase();
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

/** FetchLoader 可按请求禁用 Referer，video 元素上的属性不影响 HLS 的 XHR。 */
export function createGuaziMediaRequest(
  url: string,
  init: RequestInit
): Request {
  const headers = new Headers(init.headers);
  // Origin 和 User-Agent 由浏览器决定，不能照搬原生播放器的设置。
  for (const name of ['Referer', 'Origin', 'User-Agent']) headers.delete(name);
  return new Request(url, {
    ...init,
    headers,
    credentials: 'same-origin',
    referrer: '',
    referrerPolicy: 'no-referrer',
  });
}

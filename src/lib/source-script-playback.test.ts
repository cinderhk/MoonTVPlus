import { scriptPlaybackResponse } from './source-script-playback';

const direct = {
  url: 'https://cdn.example/movie.m3u8?sign=test',
  type: 'hls',
  headers: {},
  proxyMode: false,
};

test('disabled proxy returns the original direct media URL', () => {
  expect(scriptPlaybackResponse(direct)).toEqual(direct);
});

test('enabled proxy wraps media and segments only once at the resolver boundary', () => {
  const result = scriptPlaybackResponse(
    { ...direct, proxyMode: true },
    'token'
  );
  const url = new URL(result.url, 'https://site.example');
  expect(url.pathname).toBe('/api/proxy-m3u8');
  expect(url.searchParams.get('url')).toBe(direct.url);
  expect(url.searchParams.get('source')).toBe('directplay');
  expect(url.searchParams.get('proxySegments')).toBe('true');
  expect(url.searchParams.get('token')).toBe('token');
  expect(result.proxyMode).toBe(true);
});

test('enabled proxy also supports file URLs without claiming an HLS type', () => {
  const result = scriptPlaybackResponse({
    ...direct,
    url: 'https://cdn.example/movie.mp4',
    type: 'mp4',
    proxyMode: true,
  });
  expect(result.type).toBe('mp4');
  expect(result.url).toContain('/api/proxy-m3u8?');
});

test('non-HTTP media cannot be wrapped in a server proxy', () => {
  expect(() =>
    scriptPlaybackResponse({
      ...direct,
      url: 'file:///movie.mp4',
      proxyMode: true,
    })
  ).toThrow();
});

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])('web=%s and app=%s are applied independently', (web, app) => {
  const source = { ...direct, proxyMode: web, appProxyMode: app };
  const browser = scriptPlaybackResponse(source);
  const native = scriptPlaybackResponse(source, '', 'app');
  expect(browser.proxyMode).toBe(web);
  expect(native.proxyMode).toBe(app);
  expect(browser.url.startsWith('/api/proxy-m3u8?')).toBe(web);
  expect(native.url.startsWith('/api/proxy-m3u8?')).toBe(app);
  expect(web || browser.url === direct.url).toBe(true);
  expect(app || native.url === direct.url).toBe(true);
});

test('legacy web-only settings do not enable the new App proxy', () => {
  const source = { ...direct, proxyMode: true };
  expect(scriptPlaybackResponse(source).proxyMode).toBe(true);
  expect(scriptPlaybackResponse(source, '', 'app')).toEqual({
    ...source,
    proxyMode: false,
  });
});

test('direct App playback preserves the script request headers', () => {
  const source = {
    ...direct,
    headers: { Referer: 'https://provider.example/' },
    proxyMode: true,
    appProxyMode: false,
  };
  expect(scriptPlaybackResponse(source, '', 'app')).toMatchObject({
    url: direct.url,
    headers: source.headers,
    proxyMode: false,
  });
});

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

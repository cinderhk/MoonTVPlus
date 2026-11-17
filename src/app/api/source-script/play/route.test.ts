/** @jest-environment node */
jest.mock('next/server', () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status || 200,
      json: async () => body,
    }),
    redirect: jest.fn((url: URL) => ({ status: 307, url: url.toString() })),
  },
}));
jest.mock('@/lib/auth', () => ({
  getAuthInfoFromCookie: jest.fn(() => ({ username: 'tester' })),
}));
jest.mock('@/lib/source-script', () => ({
  parseScriptPlayUrlValue: (value: string) => value,
  resolveSavedScriptPlayUrl: jest.fn(),
}));

import { NextRequest, NextResponse } from 'next/server';

import { resolveSavedScriptPlayUrl } from '@/lib/source-script';

import { GET } from './route';

const media = 'https://cdn.example/movie.m3u8';
function request(query = '') {
  return {
    url: `https://site.example/api/source-script/play?key=test&sourceId=main&episodeIndex=0&playUrl=raw${query}`,
  } as NextRequest;
}

beforeEach(() => jest.clearAllMocks());

test.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  'JSON clients honor independent settings web=%s app=%s',
  async (web, app) => {
    (resolveSavedScriptPlayUrl as jest.Mock).mockResolvedValue({
      url: media,
      type: 'hls',
      headers: {},
      proxyMode: web,
      appProxyMode: app,
    });
    for (const client of ['web', 'app']) {
      const response = await GET(request(`&format=json&client=${client}`));
      expect(response.status).toBe(200);
      const playback = await response.json();
      const enabled = client === 'app' ? app : web;
      expect(playback.proxyMode).toBe(enabled);
      expect(playback.url.startsWith('/api/proxy-m3u8?')).toBe(enabled);
      if (!enabled) expect(playback.url).toBe(media);
    }
  }
);

test('requests without a client remain web playback', async () => {
  (resolveSavedScriptPlayUrl as jest.Mock).mockResolvedValue({
    url: media,
    type: 'hls',
    headers: {},
    proxyMode: true,
    appProxyMode: false,
  });
  const response = await GET(request('&format=json'));
  expect((await response.json()).proxyMode).toBe(true);
});

test('App redirects use the App setting even when the browser uses a proxy', async () => {
  (resolveSavedScriptPlayUrl as jest.Mock).mockResolvedValue({
    url: media,
    type: 'hls',
    headers: {},
    proxyMode: true,
    appProxyMode: false,
  });
  expect((await GET(request('&client=app'))).status).toBe(307);
  expect(NextResponse.redirect).toHaveBeenCalledWith(new URL(media), {
    headers: { 'Cache-Control': 'no-store' },
  });
});

test('unknown playback clients are rejected before executing a script', async () => {
  expect((await GET(request('&client=invalid&format=json'))).status).toBe(400);
  expect(resolveSavedScriptPlayUrl).not.toHaveBeenCalled();
});

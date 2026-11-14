import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const route = readFileSync(resolve(root, 'src/app/api/proxy-m3u8/route.ts'), 'utf8');
const source = stripTypeScriptTypes(
  route.slice(route.indexOf('export async function GET')).replace('export async', 'async'),
  { mode: 'strip' },
);

class NextResponse extends Response {
  static json(body, options) {
    return new NextResponse(JSON.stringify(body), {
      ...options,
      headers: { ...options?.headers, 'Content-Type': 'application/json' },
    });
  }
}

const quiet = { log() {}, warn() {}, error() {} };
const site = 'https://video.test';
const upstream = 'https://cdn.test/series/episode/index.m3u8';
const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:8\n#EXTINF:8,\nfirst.ts\n#EXT-X-ENDLIST\n';

function handler(fetch, safe = true) {
  return new Function(
    'NextResponse', 'getConfig', 'validateProxyUrlServerSide', 'fetch', 'console',
    `${source}\nreturn GET;`,
  )(NextResponse, async () => ({}), async () => safe, fetch, quiet);
}

function request({ source = 'directplay', adblock = 'false' } = {}) {
  return new Request(`${site}/api/proxy-m3u8?${new URLSearchParams({
    url: upstream, source, adblock, proxySegments: 'true',
  })}`);
}

for (const contentType of [
  'application/octet-stream',
  'application/octet-stream; charset=utf-8',
  'binary/octet-stream',
]) {
  test(`rewrites a real HLS playlist served as ${contentType}`, async () => {
    const get = handler(async () => new Response(playlist, {
      headers: { 'Content-Type': contentType },
    }));
    const result = await get(request());
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('Content-Type'), 'application/vnd.apple.mpegurl');
    const line = (await result.text()).split('\n').find((line) => line && !line.startsWith('#'));
    const url = new URL(line);
    assert.equal(url.origin, site);
    assert.equal(url.pathname, '/api/proxy/vod/segment');
    assert.equal(url.searchParams.get('url'), 'https://cdn.test/series/episode/first.ts');
    assert.equal(url.searchParams.get('source'), 'directplay');
  });
}

test('accepts octet-stream playlists in ad-filter mode as well', async () => {
  const get = handler(async () => new Response(playlist, {
    headers: { 'Content-Type': 'application/octet-stream' },
  }));
  const result = await get(request({ source: 'script:fixture:guazi', adblock: 'true' }));
  assert.equal(result.status, 200);
  assert((await result.text()).startsWith('#EXTM3U'));
});

test('recognizes a BOM and a header split across network chunks', async () => {
  const stream = new ReadableStream({
    start(controller) {
      for (const part of ['\uFEFF \r\n#EX', 'TM', '3U\n', playlist.slice(8)]) {
        controller.enqueue(new TextEncoder().encode(part));
      }
      controller.close();
    },
  });
  const get = handler(async () => new Response(stream, {
    headers: { 'Content-Type': 'application/octet-stream' },
  }));
  const result = await get(request());
  assert.equal(result.headers.get('Content-Type'), 'application/vnd.apple.mpegurl');
  const text = await result.text();
  assert(text.startsWith('#EXTM3U'));
  assert(text.includes('/api/proxy/vod/segment?'));
});

test('resolves relative segments against the final URL after redirects', async () => {
  const get = handler(async () => {
    const response = new Response(playlist, {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
    Object.defineProperty(response, 'url', { value: 'https://redirect.test/final/index.m3u8' });
    return response;
  });
  const result = await get(request());
  const line = (await result.text()).split('\n').find((line) => line && !line.startsWith('#'));
  assert.equal(new URL(line).searchParams.get('url'), 'https://redirect.test/final/first.ts');
});

test('preserves the bytes of real binary media in directplay mode', async () => {
  const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112, 109, 112, 52, 50]);
  const get = handler(async () => new Response(bytes, {
    headers: { 'Content-Type': 'application/octet-stream' },
  }));
  const result = await get(request());
  assert.equal(result.headers.get('Content-Type'), 'application/octet-stream');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
});

test('returns a still-open binary stream without waiting for its full body', { timeout: 2000 }, async () => {
  let cancelled = false;
  const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]);
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(bytes); },
    cancel() { cancelled = true; },
  });
  const get = handler(async () => new Response(stream, {
    headers: { 'Content-Type': 'application/octet-stream' },
  }));
  const result = await get(request());
  const reader = result.body.getReader();
  assert.deepEqual((await reader.read()).value, bytes);
  await reader.cancel();
  assert(cancelled);
});

test('does not interpret a false M3U8 prefix as a playlist', async () => {
  const get = handler(async () => new Response('#EXTM3U-invalid-binary', {
    headers: { 'Content-Type': 'application/octet-stream' },
  }));
  const result = await get(request({ source: 'script:fixture:guazi' }));
  assert.equal(result.status, 415);
});

test('keeps SSRF validation before any upstream fetch', async () => {
  let calls = 0;
  const get = handler(async () => { calls++; }, false);
  const result = await get(request());
  assert.equal(result.status, 403);
  assert.equal(calls, 0);
});

test('rewrites nested playlists and encryption keys without changing transport', async () => {
  const input = '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n'
    + '#EXT-X-STREAM-INF:BANDWIDTH=800000\nhigh/index.m3u8\n';
  const get = handler(async () => new Response(input, {
    headers: { 'Content-Type': 'application/octet-stream' },
  }));
  const text = await (await get(request())).text();
  const key = new URL(text.match(/URI="([^"]+)"/)[1]);
  assert.equal(key.pathname, '/api/proxy/vod/segment');
  assert.equal(key.searchParams.get('url'), 'https://cdn.test/series/episode/key.bin');
  const nested = new URL(text.split('\n').find((line) => line && !line.startsWith('#')));
  assert.equal(nested.pathname, '/api/proxy-m3u8');
  assert.equal(nested.searchParams.get('proxySegments'), 'true');
  assert.equal(nested.searchParams.get('adblock'), 'false');
});

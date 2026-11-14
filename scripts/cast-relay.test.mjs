import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const ts = require('typescript');
const originalFetch = globalThis.fetch;
const originalPassword = process.env.PASSWORD;
process.env.PASSWORD = 'cast-relay-test-secret';

function loadTs(path, dependencies = {}) {
  const source = readFileSync(resolve(root, path), 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  });
  const module = { exports: {} };
  new Function('exports', 'require', 'module', outputText)(
    module.exports,
    (id) => dependencies[id] || require(id),
    module
  );
  return module.exports;
}

const validations = [];
const relay = loadTs('src/lib/server/cast-relay.ts', {
  './ssrf': {
    validateProxyUrlServerSide: async (address) => {
      validations.push(address);
      const url = new URL(address);
      return !/^(127\.|10\.|192\.168\.|localhost$)/.test(url.hostname);
    },
  },
});
class NextResponse extends Response {
  static json(value, options = {}) {
    return new NextResponse(JSON.stringify(value), {
      ...options,
      headers: { ...options.headers, 'Content-Type': 'application/json' },
    });
  }
}
const { POST } = loadTs('src/app/api/cast/route.ts', {
  'next/server': { NextResponse },
  '@/lib/auth': {
    getAuthInfoFromCookie: (request) =>
      request.headers.get('cookie') === 'auth=valid'
        ? { username: 'viewer' }
        : null,
  },
  '@/lib/server/cast-relay': relay,
});
const { GET, HEAD } = loadTs('src/app/api/cast/stream/[...media]/route.ts', {
  '@/lib/server/cast-relay': relay,
});

const site = 'https://video.example';
const source = 'https://cdn.example/movie/index.m3u8';
const playlist = '#EXTM3U\n#EXTINF:8,\nfirst.ts\n#EXT-X-ENDLIST\n';
const fetches = [];
beforeEach(() => {
  validations.length = fetches.length = 0;
  globalThis.fetch = async (address, options) => {
    fetches.push({ address, options });
    return new Response(playlist, {
      headers: { 'Content-Type': 'application/vnd.apple.mpegurl' },
    });
  };
});
after(() => {
  globalThis.fetch = originalFetch;
  if (originalPassword === undefined) delete process.env.PASSWORD;
  else process.env.PASSWORD = originalPassword;
});

async function create(input = {}, authorized = true) {
  return POST(
    new Request(`${site}/api/cast`, {
      method: 'POST',
      headers: authorized ? { Cookie: 'auth=valid' } : {},
      body: JSON.stringify({ url: source, hls: true, headers: {}, ...input }),
    })
  );
}
async function url(input = {}) {
  const response = await create(input);
  assert.equal(response.status, 200);
  return new URL((await response.json()).path, site);
}
function ticket(address) {
  return relay.openCastTicket(
    new URL(address, site).searchParams.get('ticket')
  );
}

test('ticket creation requires authentication and transfers no media through the phone', async () => {
  assert.equal((await create({}, false)).status, 401);
  const address = await url({
    headers: { Referer: 'https://origin.example/', Cookie: 'cdn=secret' },
  });
  assert.equal(fetches.length, 0);
  assert.equal(address.pathname, '/api/cast/stream/media.m3u8');
  assert(!address.href.includes('secret'));
  assert(!address.href.includes('origin.example'));
  assert.equal(ticket(address).headers.referer, 'https://origin.example/');
  assert.equal(ticket(address).headers.cookie, 'cdn=secret');
});

test('a TV can fetch an encrypted link without the phone login cookie', async () => {
  const result = await GET(new Request(await url()));
  assert.equal(result.status, 200);
  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].options.headers.has('cookie'), false);
  assert((await result.text()).startsWith('#EXTM3U'));
});

test('Guazi preserves the actual player headers while ordinary sources get no injected Referer or Guazi headers', async () => {
  await (
    await GET(
      new Request(await url({ headers: { 'User-Agent': 'Lavf/57.83.100' } }))
    )
  ).text();
  assert.equal(fetches[0].options.headers.get('user-agent'), 'Lavf/57.83.100');
  assert.equal(fetches[0].options.headers.has('referer'), false);
  await (await GET(new Request(await url()))).text();
  assert.equal(fetches[1].options.headers.has('user-agent'), false);
  assert.equal(fetches[1].options.headers.has('referer'), false);
  assert.equal(fetches[1].options.headers.has('origin'), false);
});

test('the complete source header map is retained, including custom authentication parameters', async () => {
  await (
    await GET(
      new Request(
        await url({
          headers: {
            Referer: 'https://source.example/',
            'User-Agent': 'SourcePlayer/1.0',
            Origin: 'https://source.example',
            Cookie: 'cdn=secret',
            Host: 'private',
            'X-Unknown': 'required',
            'Accept-Language': 'zh-CN',
            'X-Signature': 'signed-value',
          },
        })
      )
    )
  ).text();
  const headers = fetches[0].options.headers;
  assert.equal(headers.get('referer'), 'https://source.example/');
  assert.equal(headers.get('user-agent'), 'SourcePlayer/1.0');
  assert.equal(headers.get('origin'), 'https://source.example');
  assert.equal(headers.get('cookie'), 'cdn=secret');
  assert.equal(headers.has('host'), false);
  assert.equal(headers.get('x-unknown'), 'required');
  assert.equal(headers.get('x-signature'), 'signed-value');
  assert.equal(headers.get('accept-language'), 'zh-CN');
});

test('URL queries are preserved exactly, including repeated keys and escaped signatures', async () => {
  const original =
    'https://cdn.example/play?key=a%2Bb%3D&arg=one&arg=two&empty=&refer=https%3A%2F%2Forigin.example%2F';
  const address = await url({ url: original, hls: false });
  await (await GET(new Request(address))).text();
  assert.equal(fetches[0].address, original);
});

test('invalid headers are rejected explicitly rather than silently omitted', async () => {
  assert.equal(
    (await create({ headers: { Referer: 'bad\r\nInjected: yes' } })).status,
    400
  );
  assert.equal(fetches.length, 0);
});

test('nested playlists, alternative audio, segments, keys and init fragments all use server tickets', async () => {
  const text =
    '#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,URI="audio?id=1"\n' +
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n' +
    '#EXT-X-STREAM-INF:BANDWIDTH=800000\nhigh?id=2\n#EXTINF:8,\nfirst.ts\n';
  globalThis.fetch = async () => new Response(text);
  const address = await url({
    headers: {
      Referer: 'https://source.example/',
      Cookie: 'cdn=secret',
      Authorization: 'Bearer source-token',
      'X-Playback-Signature': 'required-signature',
      'X-Custom-Parameter': 'required-value',
    },
  });
  const result = await GET(new Request(address));
  const body = await result.text();
  const links = [...body.matchAll(/URI="([^"]+)"/g)].map((match) => match[1]);
  links.push(
    ...body.split('\n').filter((line) => line && !line.startsWith('#'))
  );
  assert.equal(links.length, 5);
  for (const link of links) {
    const child = new URL(link, address);
    assert.equal(child.origin, site);
    assert(child.pathname.startsWith('/api/cast/stream/'));
    assert.deepEqual(ticket(child).headers, ticket(address).headers);
    assert.equal(ticket(child).expires, ticket(address).expires);
  }
  assert.equal(ticket(new URL(links[0], address)).hls, true);
  assert.equal(
    ticket(new URL(links[1], address)).url,
    'https://cdn.example/movie/key.bin'
  );
  assert.equal(
    ticket(new URL(links[2], address)).url,
    'https://cdn.example/movie/init.mp4'
  );
  assert.equal(ticket(new URL(links[3], address)).hls, true);
  assert.equal(
    ticket(new URL(links[4], address)).url,
    'https://cdn.example/movie/first.ts'
  );
});

test('HLS resources resolve against the final redirected URL', async () => {
  globalThis.fetch = async (address) =>
    address === source
      ? new Response(null, {
          status: 302,
          headers: { Location: 'https://other.example/final/index.m3u8' },
        })
      : new Response(playlist);
  const address = await url();
  const text = await (await GET(new Request(address))).text();
  const child = new URL(
    text.split('\n').find((line) => line && !line.startsWith('#')),
    address
  );
  assert.equal(ticket(child).url, 'https://other.example/final/first.ts');
});

test('cross-origin redirects and HLS resources never receive the source cookie or authorization', async () => {
  const address = await url({
    headers: {
      Cookie: 'private=secret',
      Authorization: 'Bearer secret',
      Referer: 'https://origin.example/',
      'X-Private-Token': 'private-token',
    },
  });
  globalThis.fetch = async (address, options) => {
    fetches.push({ address, options });
    return address === source
      ? new Response(null, {
          status: 302,
          headers: { Location: 'https://other.example/final/index.m3u8' },
        })
      : new Response(playlist);
  };
  await (await GET(new Request(address))).text();
  assert.equal(fetches[0].options.headers.get('cookie'), 'private=secret');
  assert.equal(fetches[1].options.headers.has('cookie'), false);
  assert.equal(fetches[1].options.headers.has('authorization'), false);
  assert.equal(
    fetches[0].options.headers.get('x-private-token'),
    'private-token'
  );
  assert.equal(fetches[1].options.headers.has('x-private-token'), false);
  assert.equal(
    fetches[1].options.headers.get('referer'),
    'https://origin.example/'
  );
});

test('binary video remains streaming and propagates TV seek ranges and HEAD requests', async () => {
  const bytes = Uint8Array.from([0, 0, 0, 24, 102, 116, 121, 112]);
  globalThis.fetch = async (address, options) => {
    fetches.push({ address, options });
    return new Response(options.method === 'HEAD' ? null : bytes, {
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': 'bytes 10-17/100',
        'Content-Length': '8',
        'Accept-Ranges': 'bytes',
      },
    });
  };
  const address = await url({
    url: 'https://cdn.example/movie.mp4',
    hls: false,
  });
  const result = await GET(
    new Request(address, { headers: { Range: 'bytes=10-17' } })
  );
  assert.equal(result.status, 206);
  assert.equal(result.headers.get('content-range'), 'bytes 10-17/100');
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), bytes);
  assert.equal(fetches[0].options.headers.get('range'), 'bytes=10-17');
  const head = await HEAD(new Request(address, { method: 'HEAD' }));
  assert.equal(fetches[1].options.method, 'HEAD');
  assert.equal(head.headers.get('content-length'), '8');
  assert.equal(await head.text(), '');
});

test(
  'cancelling a TV stream cancels the upstream without buffering the whole movie',
  { timeout: 2000 },
  async () => {
    let cancelled = false;
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'video/mp4' } }
      );
    const result = await GET(new Request(await url({ hls: false })));
    const reader = result.body.getReader();
    assert.equal((await reader.read()).value.length, 8);
    await reader.cancel();
    assert.equal(cancelled, true);
  }
);

test('a local phone URL and redirects to private addresses are blocked before fetch', async () => {
  assert.equal(
    (await create({ url: 'http://127.0.0.1:8080/movie.m3u8' })).status,
    403
  );
  assert.equal(fetches.length, 0);
  globalThis.fetch = async (address, options) => {
    fetches.push({ address, options });
    return new Response(null, {
      status: 302,
      headers: { Location: 'http://192.168.1.1/private' },
    });
  };
  assert.equal((await GET(new Request(await url()))).status, 403);
  assert.equal(fetches.length, 1);
});

test('existing server proxies remain usable, including an explicitly addressed LAN server', async () => {
  const link = await relay.createCastLink(
    {
      url: 'http://192.168.1.5/api/proxy-m3u8?url=https%3A%2F%2Fcdn.example%2Fmovie.m3u8',
      hls: true,
    },
    'http://192.168.1.5'
  );
  assert(link.path.startsWith('/api/cast/stream/'));
  await assert.rejects(() =>
    relay.createCastLink(
      { url: 'http://192.168.1.5/admin' },
      'http://192.168.1.5'
    )
  );
});

test('forged and expired tickets cannot contact any upstream', async () => {
  const address = await url();
  const originalToken = address.searchParams.get('ticket');
  address.searchParams.set(
    'ticket',
    `${originalToken.slice(0, 20)}AAAA${originalToken.slice(24)}`
  );
  assert.equal((await GET(new Request(address))).status, 403);
  const originalNow = Date.now;
  Date.now = () => originalNow() + 13 * 60 * 60 * 1000;
  try {
    address.searchParams.set('ticket', originalToken);
    assert.equal((await GET(new Request(address))).status, 403);
  } finally {
    Date.now = originalNow;
  }
  assert.equal(fetches.length, 0);
});

test('the public stream exception never exempts ticket creation from login middleware', () => {
  const middleware = readFileSync(resolve(root, 'src/middleware.ts'), 'utf8');
  const pattern = middleware.match(/'([^'\n]*api\/cast\/stream\/[^'\n]*)'/)[1];
  const matcher = new RegExp(`^${pattern}$`);
  assert.equal(matcher.test('/api/cast'), true);
  assert.equal(matcher.test('/api/cast/stream/media.m3u8'), false);
});

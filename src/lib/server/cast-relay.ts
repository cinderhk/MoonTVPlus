import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from 'crypto';

import { validateProxyUrlServerSide } from './ssrf';

const LIFETIME = 12 * 60 * 60 * 1000;
const MAX_PLAYLIST = 4 * 1024 * 1024;
// Match Android's OriginScopedHeaders: keep every custom/credential header at
// the asset origin, including each HLS fetch and redirect back to that origin.
const PUBLIC_HEADERS = new Set([
  'user-agent',
  'referer',
  'origin',
  'accept',
  'accept-language',
  'accept-encoding',
  'range',
  'if-range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'cache-control',
  'pragma',
  'content-type',
  'content-encoding',
  'content-range',
]);
const TRANSPORT_HEADERS = new Set([
  'host',
  'content-length',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'trailer',
  'upgrade',
  'proxy-connection',
]);
const LOCAL_MEDIA_PATH =
  /^\/api\/(?:proxy-m3u8$|proxy\/|openlist\/proxy(?:\/|$)|netdisk\/[^/]+\/proxy(?:\/|$)|emby\/play(?:\/|$))/;

export class CastRelayError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export interface CastTicket {
  url: string;
  headers: Record<string, string>;
  credentialOrigin: string;
  siteOrigin: string;
  expires: number;
  hls: boolean;
}

function key(): Buffer {
  const secret = process.env.CAST_RELAY_SECRET || process.env.PASSWORD;
  if (!secret) throw new CastRelayError('服务器未配置投屏中转密钥', 503);
  return createHash('sha256').update(`lightwhale-cast-v1:${secret}`).digest();
}

function seal(ticket: CastTicket): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(ticket), 'utf8'),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    'base64url'
  );
}

export function openCastTicket(token: string): CastTicket {
  if (!/^[A-Za-z0-9_-]{40,32768}$/.test(token)) {
    throw new CastRelayError('投屏链接无效或已过期', 403);
  }
  const secret = key();
  try {
    const bytes = Buffer.from(token, 'base64url');
    const decipher = createDecipheriv(
      'aes-256-gcm',
      secret,
      bytes.subarray(0, 12)
    );
    decipher.setAuthTag(bytes.subarray(12, 28));
    const ticket: CastTicket = JSON.parse(
      Buffer.concat([
        decipher.update(bytes.subarray(28)),
        decipher.final(),
      ]).toString('utf8')
    );
    if (!Number.isFinite(ticket.expires) || ticket.expires <= Date.now())
      throw new Error('expired');
    return ticket;
  } catch {
    throw new CastRelayError('投屏链接无效或已过期', 403);
  }
}

function httpUrl(value: string, base?: string): URL {
  try {
    const url = new URL(value, base);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 8192
    ) {
      throw new Error('invalid');
    }
    url.hash = '';
    return url;
  } catch {
    throw new CastRelayError('播放地址无效');
  }
}

async function checkTarget(url: URL, siteOrigin: string): Promise<void> {
  // Reuse this site's existing authenticated media proxies, including a LAN
  // server. Never grant the same exception to arbitrary private-network URLs.
  if (url.origin === siteOrigin && LOCAL_MEDIA_PATH.test(url.pathname)) return;
  if (!(await validateProxyUrlServerSide(url.href))) {
    throw new CastRelayError('该播放地址无法由服务器中转', 403);
  }
  if (url.origin === siteOrigin && url.pathname.startsWith('/api/cast/')) {
    throw new CastRelayError('不能重复中转投屏链接');
  }
}

function relayPath(ticket: CastTicket): string {
  const extension = ticket.hls
    ? 'm3u8'
    : new URL(ticket.url).pathname.match(
        /\.(mp4|mkv|ts|m2ts|m4s|aac|mp3|vtt|srt|webm|mov)$/i
      )?.[1] || 'bin';
  return `/api/cast/stream/media.${extension}?ticket=${seal(ticket)}`;
}

export async function createCastLink(
  input: unknown,
  siteOrigin: string
): Promise<{ path: string; hls: boolean; expires: number }> {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new CastRelayError('投屏参数无效');
  const data = input as Record<string, unknown>;
  if (typeof data.url !== 'string') throw new CastRelayError('缺少播放地址');
  const url = httpUrl(data.url);
  await checkTarget(url, siteOrigin);
  const headers: Record<string, string> = {};
  if (
    data.headers &&
    typeof data.headers === 'object' &&
    !Array.isArray(data.headers)
  ) {
    for (const [name, value] of Object.entries(data.headers)) {
      const lower = name.toLowerCase();
      if (typeof value !== 'string' || /[\r\n\0]/.test(value))
        throw new CastRelayError('播放请求头无效');
      try {
        new Headers({ [name]: value });
      } catch {
        throw new CastRelayError('播放请求头无效');
      }
      headers[lower] = value;
    }
  }
  if (JSON.stringify(headers).length > 8192)
    throw new CastRelayError('播放请求头过长');
  const ticket: CastTicket = {
    url: url.href,
    headers,
    credentialOrigin: url.origin,
    siteOrigin,
    expires: Date.now() + LIFETIME,
    hls: data.hls === true || /\.m3u8?$/i.test(url.pathname),
  };
  return { path: relayPath(ticket), hls: ticket.hls, expires: ticket.expires };
}

function upstreamHeaders(
  ticket: CastTicket,
  target: URL,
  request: Request
): Headers {
  // The client's resolved URL and complete header map are authoritative. Do
  // not invent Referer/Origin/UA values for Guazi or unrelated providers.
  const headers = new Headers();
  const transport = new Set(TRANSPORT_HEADERS);
  for (const name of (ticket.headers.connection || '').toLowerCase().split(','))
    transport.add(name.trim());
  for (const [name, value] of Object.entries(ticket.headers)) {
    // Framing belongs to this new server->upstream connection, not the phone's.
    if (
      !transport.has(name) &&
      (PUBLIC_HEADERS.has(name) || target.origin === ticket.credentialOrigin)
    )
      headers.set(name, value);
  }
  // Preserve an explicit client encoding. Otherwise identity avoids changing
  // byte ranges when fetch would transparently decompress the upstream body.
  if (!headers.has('accept-encoding'))
    headers.set('accept-encoding', 'identity');
  if (!ticket.hls) {
    for (const name of ['range', 'if-range']) {
      const value = request.headers.get(name);
      if (value) headers.set(name, value);
    }
  }
  return headers;
}

async function fetchMedia(
  ticket: CastTicket,
  request: Request,
  signal: AbortSignal
): Promise<{ response: Response; url: URL }> {
  let url = httpUrl(ticket.url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    await checkTarget(url, ticket.siteOrigin);
    const response = await fetch(url.href, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers: upstreamHeaders(ticket, url, request),
      redirect: 'manual',
      cache: 'no-store',
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status))
      return { response, url };
    const location = response.headers.get('location');
    await response.body?.cancel();
    if (!location) throw new CastRelayError('视频源重定向无效', 502);
    url = httpUrl(location, url.href);
  }
  throw new CastRelayError('视频源重定向次数过多', 502);
}

export function rewriteCastPlaylist(
  text: string,
  base: URL,
  ticket: CastTicket
): string {
  let nextPlaylist = false;
  const link = (value: string, hls: boolean) => {
    if (value.startsWith('data:')) return value;
    const url = httpUrl(value, base.href);
    // Relative URLs also work behind a reverse proxy with a path prefix.
    const path = relayPath({
      ...ticket,
      url: url.href,
      hls: hls || /\.m3u8?$/i.test(url.pathname),
    });
    return path.slice(path.lastIndexOf('/') + 1);
  };
  return text
    .trimStart()
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;
      if (trimmed.startsWith('#')) {
        nextPlaylist = trimmed.startsWith('#EXT-X-STREAM-INF:') || nextPlaylist;
        const playlistAttribute =
          /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT|IMAGE-STREAM-INF):/.test(
            trimmed
          );
        return line.replace(
          /([,:\s])URI="([^"]+)"/g,
          (_, prefix: string, uri: string) =>
            `${prefix}URI="${link(uri, playlistAttribute)}"`
        );
      }
      const result = link(trimmed, nextPlaylist);
      nextPlaylist = false;
      return result;
    })
    .join('\n');
}

function responseHeaders(response: Response): Headers {
  const headers = new Headers({
    'Cache-Control': 'private, no-store',
    'Access-Control-Allow-Origin': '*',
  });
  for (const name of [
    'content-type',
    'content-range',
    'accept-ranges',
    'etag',
    'last-modified',
    'contentfeatures.dlna.org',
    'transfermode.dlna.org',
  ]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  const length = response.headers.get('content-length');
  if (length && !response.headers.get('content-encoding'))
    headers.set('content-length', length);
  return headers;
}

export function castRelayFailure(error: unknown): Response {
  const status = error instanceof CastRelayError ? error.status : 502;
  const message =
    error instanceof CastRelayError
      ? error.message
      : '服务器投屏中转失败，请重试';
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
  });
}

export async function streamCastMedia(request: Request): Promise<Response> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  request.signal.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(abort, 25_000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const ticket = openCastTicket(
      new URL(request.url).searchParams.get('ticket') || ''
    );
    const { response, url } = await fetchMedia(
      ticket,
      request,
      controller.signal
    );
    const headers = responseHeaders(response);
    if (!response.ok || request.method === 'HEAD' || !response.body) {
      await response.body?.cancel();
      if (ticket.hls && response.ok) {
        headers.set('content-type', 'application/vnd.apple.mpegurl');
        headers.delete('content-length');
      }
      return new Response(null, { status: response.status, headers });
    }

    reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    const decoder = new TextDecoder();
    let prefix = '';
    while (prefix.length < 1024) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      prefix += decoder.decode(value.subarray(0, 1024 - prefix.length), {
        stream: true,
      });
      if (prefix.trimStart().length >= 8) break;
    }
    if (/^#EXTM3U(?:\s|$)/.test(prefix.trimStart())) {
      let length = 0;
      const text = new TextDecoder();
      const parts: string[] = [];
      const append = (value: Uint8Array) => {
        length += value.byteLength;
        if (length > MAX_PLAYLIST)
          throw new CastRelayError('视频播放列表过大', 502);
        parts.push(text.decode(value, { stream: true }));
      };
      chunks.forEach(append);
      let part = await reader.read();
      while (!part.done) {
        append(part.value);
        part = await reader.read();
      }
      parts.push(text.decode());
      headers.set('content-type', 'application/vnd.apple.mpegurl');
      headers.delete('content-length');
      headers.delete('content-range');
      headers.delete('accept-ranges');
      return new Response(rewriteCastPlaylist(parts.join(''), url, ticket), {
        headers,
      });
    }

    const upstream = reader;
    const body = new ReadableStream<Uint8Array>({
      start(sink) {
        chunks.forEach((chunk) => sink.enqueue(chunk));
      },
      async pull(sink) {
        try {
          const { done, value } = await upstream.read();
          if (done) sink.close();
          else sink.enqueue(value);
        } catch (error) {
          sink.error(error);
        }
      },
      cancel(reason) {
        return upstream.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, headers });
  } catch (error) {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    return castRelayFailure(error);
  } finally {
    // Only bound connection/playlist preparation, never cut a long video stream.
    clearTimeout(timer);
  }
}

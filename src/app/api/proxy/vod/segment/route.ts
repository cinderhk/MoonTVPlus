/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import {
  buildProxyStreamHeaders,
  buildUpstreamMediaHeaders,
} from '@/lib/server/proxy-headers';
import { validateProxyUrlServerSide } from '@/lib/server/ssrf';

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const source = searchParams.get('source');

  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  if (!source) {
    return NextResponse.json({ error: 'Missing source' }, { status: 400 });
  }

  // 定义直链播放模式常量
  const DIRECT_PLAY_SOURCE = 'directplay';

  // 直链播放模式：跳过源站配置检查，直接代理
  if (source !== DIRECT_PLAY_SOURCE) {
    // 检查该视频源是否启用了代理模式
    const config = await getConfig();
    const videoSource = config.SourceConfig?.find((s: any) => s.key === source);

    if (!videoSource) {
      return NextResponse.json({ error: 'Source not found' }, { status: 404 });
    }

    if (!videoSource.proxyMode) {
      return NextResponse.json({ error: 'Proxy mode not enabled for this source' }, { status: 403 });
    }
  }

  try {
    // URLSearchParams already decoded the outer query parameter. Preserve
    // escaped CDN paths and signatures rather than decoding a second time.
    const decodedUrl = url;
    if (!await validateProxyUrlServerSide(decodedUrl)) {
      return NextResponse.json({ error: 'Proxy request to local or invalid network is forbidden' }, { status: 403 });
    }

    const response = await fetch(decodedUrl, {
      cache: 'no-store',
      signal: request.signal,
      headers: buildUpstreamMediaHeaders(decodedUrl, source, request.headers),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => { /* The connection may already be closed. */ });
      return NextResponse.json({ error: 'Failed to fetch segment' }, { status: response.status });
    }
    const headers = buildProxyStreamHeaders(
      response.headers.get('Content-Type') || 'video/mp2t',
      response.headers.get('Content-Length'),
      response.headers
    );
    // Passing the body through preserves backpressure and propagates consumer
    // cancellation upstream. Eager pumping downloads abandoned seeks in full.
    return new Response(response.body, { status: response.status, headers });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch segment' }, { status: 502 });
  }
}

/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextResponse } from "next/server";

import { getConfig } from "@/lib/config";
import { fetchLive, toWebStream } from "@/lib/live-http";
import { buildProxyStreamHeaders } from "@/lib/server/proxy-headers";

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const source = searchParams.get('moontv-source');
  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  const config = await getConfig();
  const liveSource = config.LiveConfig?.find((s: any) => s.key === source);
  if (!liveSource) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }
  const ua = liveSource.ua || 'AptvPlayer/1.4.10';

  try {
    const headers: Record<string, string> = { 'Accept-Encoding': 'identity' };
    for (const name of ['Range', 'If-Range']) {
      const value = request.headers.get(name);
      if (value) headers[name] = value;
    }
    const response = await fetchLive(url, ua, {
      cache: 'no-store',
      signal: request.signal,
      headers,
    });
    const body = toWebStream(response.body);
    if (!response.ok) {
      void body?.cancel().catch(() => { /* The connection may already be closed. */ });
      return NextResponse.json({ error: 'Failed to fetch segment' }, { status: response.status });
    }
    return new Response(body, {
      status: response.status,
      headers: buildProxyStreamHeaders(
        response.headers.get('Content-Type') || 'video/mp2t',
        response.headers.get('Content-Length'),
        response.headers
      ),
    });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch segment' }, { status: 502 });
  }
}

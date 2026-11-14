import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  CastRelayError,
  castRelayFailure,
  createCastLink,
} from '@/lib/server/cast-relay';

export const runtime = 'nodejs';

/** Only the authenticated phone requests a ticket; it never downloads media. */
export async function POST(request: NextRequest) {
  if (!getAuthInfoFromCookie(request)?.username) {
    return NextResponse.json({ error: '请先登录影视服务' }, { status: 401 });
  }
  try {
    const input = await request.text();
    if (input.length > 32768)
      return NextResponse.json({ error: '投屏参数过长' }, { status: 413 });
    const origin = new URL(process.env.SITE_BASE || request.url).origin;
    let payload: unknown;
    try {
      payload = JSON.parse(input);
    } catch {
      throw new CastRelayError('投屏参数无效');
    }
    const result = await createCastLink(payload, origin);
    return NextResponse.json(result, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return castRelayFailure(error);
  }
}

import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  if (!getAuthInfoFromCookie(request)?.username) {
    return NextResponse.json({ error: '请先登录影视服务' }, { status: 401 });
  }
  try {
    const config = await getConfig();
    return NextResponse.json(
      { hiddenSourceKeys: config.TvHiddenSourceKeys || [] },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch {
    return NextResponse.json({ error: '无法读取 TV 源显示设置' }, { status: 500 });
  }
}

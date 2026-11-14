import { streamCastMedia } from '@/lib/server/cast-relay';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The sealed, expiring ticket authorizes GET/HEAD without a TV login cookie.
export const GET = streamCastMedia;
export const HEAD = streamCastMedia;

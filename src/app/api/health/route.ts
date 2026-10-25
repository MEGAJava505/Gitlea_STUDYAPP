import { NextResponse } from 'next/server';

/**
 * GET /api/health
 *
 * Liveness endpoint. Returns HTTP 200 with `{"status":"ok"}` and never includes
 * secrets or database contents. It does not depend on Gitea or the database so
 * it remains a valid liveness probe even when only the app is up. The reverse
 * proxy exposes it publicly at /health (see docker/proxy/Caddyfile).
 */
export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'ok' }, { status: 200 });
}

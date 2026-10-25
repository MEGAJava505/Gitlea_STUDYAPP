import {
  errors,
  toErrorBody,
  UserId,
} from '../../../../shared/contracts';
import {
  createAuthContext,
  getServices,
  readSessionCookie,
} from '../../../../server/auth-context';
import { serializeCookie } from '../../../../domain/auth/session';

/**
 * Session endpoints.
 *
 * POST /api/v1/session is the post-OAuth hook: it accepts an already-resolved
 * user id (Phase 2 replaces this with the OAuth code exchange) and mints a
 * server-side session whose token is stored only as a hash.
 */
export async function POST(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => null)) as { userId?: string } | null;
    if (!body?.userId) throw errors.invalidInput('userId is required');

    const { identities, sessions } = getServices();
    const userId = body.userId as UserId;
    const user = await identities.getUser(userId);
    if (!user) throw errors.notFound('user');

    const principal = {
      userId: user.id,
      login: user.login,
      displayName: user.displayName,
      roles: await identities.listRoles(user.id),
    };
    const { cookie } = await sessions.create(principal, 30 * 24 * 60 * 60 * 1000);

    const res = Response.json({ ok: true, principal }, { status: 200 });
    res.headers.set('Set-Cookie', serializeCookie(cookie));
    return res;
  } catch (err) {
    const { status, body } = toErrorBody(err);
    return Response.json(body, { status });
  }
}

export async function GET(req: Request): Promise<Response> {
  try {
    const { sessions, identities } = getServices();
    const principal = await createAuthContext({ sessions, identities }).principal(req);
    if (!principal) throw errors.unauthenticated();
    return Response.json({ principal }, { status: 200 });
  } catch (err) {
    const { status, body } = toErrorBody(err);
    return Response.json(body, { status });
  }
}

export async function DELETE(req: Request): Promise<Response> {
  try {
    const { sessions } = getServices();
    const token = readSessionCookie(req);
    if (token) await sessions.revoke(token);

    const res = Response.json({ ok: true }, { status: 200 });
    res.headers.set('Set-Cookie', clearSessionCookie());
    return res;
  } catch (err) {
    const { status, body } = toErrorBody(err);
    return Response.json(body, { status });
  }
}

function clearSessionCookie(): string {
  return 'session=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax';
}

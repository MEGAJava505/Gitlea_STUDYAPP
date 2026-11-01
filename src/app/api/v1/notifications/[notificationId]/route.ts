import { DomainError, errors, toErrorBody } from '../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../server/auth-context';

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ notificationId: string }> },
): Promise<Response> {
  try {
    const { sessions, identities, notifications } = getServices();
    const principal = await createAuthContext({ sessions, identities }).principal(req);
    if (!principal) throw errors.unauthenticated();
    if (!notifications) throw new DomainError('UNAVAILABLE', 'Notifications are not configured', 503);
    const body: unknown = await req.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || !('read' in body) || body.read !== true) {
      throw errors.invalidInput('read must be true');
    }
    const { notificationId } = await ctx.params;
    if (!(await notifications.markRead(principal.userId, notificationId))) throw errors.notFound('notification');
    return Response.json({ ok: true });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

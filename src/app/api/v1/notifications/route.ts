import { DomainError, errors, toErrorBody } from '../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../server/auth-context';

export async function GET(req: Request): Promise<Response> {
  try {
    const { sessions, identities, notifications } = getServices();
    const principal = await createAuthContext({ sessions, identities }).principal(req);
    if (!principal) throw errors.unauthenticated();
    if (!notifications) throw new DomainError('UNAVAILABLE', 'Notifications are not configured', 503);
    const unreadOnly = new URL(req.url).searchParams.get('unreadOnly') === 'true';
    return Response.json({ notifications: await notifications.list(principal.userId, unreadOnly) });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

import { DomainError, errors, NOTIFICATION_CHANNELS, toErrorBody } from '../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../server/auth-context';

export async function GET(req: Request): Promise<Response> {
  try {
    const { sessions, identities, notifications } = getServices();
    const principal = await createAuthContext({ sessions, identities }).principal(req);
    if (!principal) throw errors.unauthenticated();
    if (!notifications) throw new DomainError('UNAVAILABLE', 'Notifications are not configured', 503);
    return Response.json({ preferences: await notifications.getPreferences(principal.userId) });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const { sessions, identities, notifications } = getServices();
    const principal = await createAuthContext({ sessions, identities }).principal(req);
    if (!principal) throw errors.unauthenticated();
    if (!notifications) throw new DomainError('UNAVAILABLE', 'Notifications are not configured', 503);
    const body: unknown = await req.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || !('channel' in body) || typeof body.channel !== 'string' || !NOTIFICATION_CHANNELS.includes(body.channel as typeof NOTIFICATION_CHANNELS[number])
      || !('enabled' in body) || typeof body.enabled !== 'boolean') {
      throw errors.invalidInput('channel and enabled are required');
    }
    await notifications.setPreference(principal.userId, body.channel as typeof NOTIFICATION_CHANNELS[number], body.enabled);
    return Response.json({ channel: body.channel, enabled: body.enabled });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

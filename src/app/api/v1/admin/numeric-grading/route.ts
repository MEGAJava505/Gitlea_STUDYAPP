import { DomainError, errors, toErrorBody } from '../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../server/auth-context';

async function requireGrading(req: Request) {
  const { sessions, identities, grading } = getServices();
  const principal = await createAuthContext({ sessions, identities }).principal(req);
  if (!principal) throw errors.unauthenticated();
  if (!principal.roles.includes('admin') && !principal.roles.includes('owner')) {
    throw errors.forbidden('Missing role "admin"');
  }
  if (!grading) throw new DomainError('UNAVAILABLE', 'Grading service is not configured', 503);
  return grading;
}

export async function GET(req: Request): Promise<Response> {
  try {
    const grading = await requireGrading(req);
    return Response.json({ enabled: await grading.isEnabled() });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

export async function PATCH(req: Request): Promise<Response> {
  try {
    const grading = await requireGrading(req);
    const body: unknown = await req.json().catch(() => null);
    if (body === null || typeof body !== 'object' || Array.isArray(body)
      || !('enabled' in body) || typeof body.enabled !== 'boolean') {
      throw errors.invalidInput('enabled must be a boolean');
    }
    await grading.setEnabled(body.enabled);
    return Response.json({ enabled: body.enabled });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

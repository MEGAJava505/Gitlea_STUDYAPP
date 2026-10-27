import { DomainError, errors, toErrorBody, type SessionPrincipal } from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';
import type { MaterialView } from '../../../../../../domain/materials/service';

function materialsService() {
  const service = getServices().materials;
  if (!service) throw new DomainError('UNAVAILABLE', 'Materials service is not configured', 503);
  return service;
}

async function principal(req: Request): Promise<SessionPrincipal> {
  const { sessions, identities } = getServices();
  const actor = await createAuthContext({ sessions, identities }).principal(req);
  if (!actor) throw errors.unauthenticated();
  return actor;
}

export async function POST(req: Request, ctx: { params: Promise<{ lessonId: string }> }): Promise<Response> {
  try {
    await principal(req);
    throw errors.invalidInput('Use the multipart upload endpoint for material bytes');
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ lessonId: string }> }): Promise<Response> {
  try {
    const [{ lessonId }, actor] = await Promise.all([ctx.params, principal(req)]);
    const materials: MaterialView[] = await materialsService().list(actor, lessonId);
    return Response.json({ materials });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

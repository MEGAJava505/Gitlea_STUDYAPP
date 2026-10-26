import { DomainError, errors, toErrorBody, type SessionPrincipal } from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';

interface MaterialsApiService {
  attach(input: {
    actor: SessionPrincipal;
    lessonId: string;
    filename: string;
    contentType: string;
    storedPath: string;
    size: number;
    sha256: string;
  }): Promise<unknown>;
  list(actor: SessionPrincipal, lessonId: string): Promise<unknown[]>;
}

function materialsService(): MaterialsApiService {
  const service = (getServices() as ReturnType<typeof getServices> & { materials?: MaterialsApiService }).materials;
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
    const [{ lessonId }, actor] = await Promise.all([ctx.params, principal(req)]);
    const body = await req.json().catch(() => null) as {
      filename?: unknown;
      contentType?: unknown;
      storedPath?: unknown;
      size?: unknown;
      sha256?: unknown;
    } | null;
    if (!body || typeof body.filename !== 'string' || typeof body.contentType !== 'string' ||
      typeof body.storedPath !== 'string' || typeof body.size !== 'number' || typeof body.sha256 !== 'string') {
      throw errors.invalidInput('filename, contentType, storedPath, size, and sha256 are required');
    }
    const material = await materialsService().attach({
      actor,
      lessonId,
      filename: body.filename,
      contentType: body.contentType,
      storedPath: body.storedPath,
      size: body.size,
      sha256: body.sha256,
    });
    return Response.json({ material }, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ lessonId: string }> }): Promise<Response> {
  try {
    const [{ lessonId }, actor] = await Promise.all([ctx.params, principal(req)]);
    const materials = await materialsService().list(actor, lessonId);
    return Response.json({ materials });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

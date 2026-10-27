import { DomainError, errors, toErrorBody, type SessionPrincipal } from '../../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../../server/auth-context';

async function principal(req: Request): Promise<SessionPrincipal> {
  const { sessions, identities } = getServices();
  const actor = await createAuthContext({ sessions, identities }).principal(req);
  if (!actor) throw errors.unauthenticated();
  return actor;
}

export async function POST(req: Request, ctx: { params: Promise<{ lessonId: string }> }): Promise<Response> {
  try {
    const service = getServices().materials;
    if (!service) throw new DomainError('UNAVAILABLE', 'Materials service is not configured', 503);
    const actor = await principal(req);
    if (!req.headers.get('content-type')?.toLowerCase().startsWith('multipart/form-data')) throw errors.invalidInput('multipart/form-data is required');
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) throw errors.invalidInput('file is required');
    if (file.size > 50 * 1024 * 1024) throw errors.invalidInput('file exceeds the 50 MiB limit');
    const { lessonId } = await ctx.params;
    const material = await service.uploadBlob({ actor, lessonId, filename: file.name, contentType: file.type || 'application/octet-stream', bytes: new Uint8Array(await file.arrayBuffer()) });
    return Response.json({ material }, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

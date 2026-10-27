import { DomainError, errors, toErrorBody, type SessionPrincipal } from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';

async function principal(req: Request): Promise<SessionPrincipal> {
  const { sessions, identities } = getServices();
  const actor = await createAuthContext({ sessions, identities }).principal(req);
  if (!actor) throw errors.unauthenticated();
  return actor;
}

function disposition(filename: string): string {
  const safe = filename.replace(/[\r\n"\\]/g, '_');
  return `attachment; filename="${safe}"`;
}

export async function GET(req: Request, ctx: { params: Promise<{ materialId: string }> }): Promise<Response> {
  try {
    const service = getServices().materials;
    if (!service) throw new DomainError('UNAVAILABLE', 'Materials service is not configured', 503);
    const actor = await principal(req);
    const { materialId } = await ctx.params;
    const material = await service.openDownload({ actor, materialId });
    return new Response(Buffer.from(material.bytes), { status: 200, headers: {
      'Content-Type': material.contentType,
      'Content-Length': String(material.size),
      'Content-Disposition': disposition(material.filename),
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

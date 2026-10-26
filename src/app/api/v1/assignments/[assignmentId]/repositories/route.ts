import { DomainError, errors, toErrorBody, type AssignmentId, type SessionPrincipal } from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';
import type { ProvisioningService } from '../../../../../../domain/git/provisioning';

interface ProvisioningApiService {
  provision(actor: SessionPrincipal, assignmentId: AssignmentId): ReturnType<ProvisioningService['provision']>;
  get(actor: SessionPrincipal, assignmentId: AssignmentId): ReturnType<ProvisioningService['get']>;
}

function provisioningService(): ProvisioningApiService {
  const service = getServices().provisioning;
  if (!service) throw new DomainError('UNAVAILABLE', 'Repository provisioning service is not configured', 503);
  return service;
}

export async function POST(req: Request, ctx: { params: Promise<{ assignmentId: string }> }): Promise<Response> {
  try {
    const [{ assignmentId }, services] = await Promise.all([ctx.params, Promise.resolve(getServices())]);
    const actor = await createAuthContext({ sessions: services.sessions, identities: services.identities }).principal(req);
    if (!actor) throw errors.unauthenticated();
    const result = await provisioningService().provision(actor, assignmentId as AssignmentId);
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ assignmentId: string }> }): Promise<Response> {
  try {
    const [{ assignmentId }, services] = await Promise.all([ctx.params, Promise.resolve(getServices())]);
    const actor = await createAuthContext({ sessions: services.sessions, identities: services.identities }).principal(req);
    if (!actor) throw errors.unauthenticated();
    const result = await provisioningService().get(actor, assignmentId as AssignmentId);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

import { DomainError, errors, toErrorBody, type AssignmentId, type GroupId, type SessionPrincipal } from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';

interface AssignmentApiService {
  publish(input: { actor: SessionPrincipal; assignmentId: string; groupId: GroupId; deadline: number }): Promise<unknown>;
}

function assignmentService(): AssignmentApiService {
  const service = (getServices() as ReturnType<typeof getServices> & { assignmentService?: AssignmentApiService }).assignmentService;
  if (!service) throw new DomainError('UNAVAILABLE', 'Assignment service is not configured', 503);
  return service;
}

export async function POST(req: Request, ctx: { params: Promise<{ assignmentId: string }> }): Promise<Response> {
  try {
    const [{ assignmentId }, { sessions, identities }] = await Promise.all([ctx.params, Promise.resolve(getServices())]);
    const actor = await createAuthContext({ sessions, identities }).principal(req);
    if (!actor) throw errors.unauthenticated();
    const body = await req.json().catch(() => null) as { groupId?: unknown; deadline?: unknown } | null;
    if (!body || typeof body.groupId !== 'string' || typeof body.deadline !== 'number' || !Number.isSafeInteger(body.deadline)) {
      throw errors.invalidInput('groupId and deadline are required');
    }
    const publication = await assignmentService().publish({
      actor,
      assignmentId: assignmentId as AssignmentId,
      groupId: body.groupId as GroupId,
      deadline: body.deadline,
    });
    return Response.json({ publication }, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

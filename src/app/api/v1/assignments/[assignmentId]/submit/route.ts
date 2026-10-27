import { AssignmentId, DomainError, errors, toErrorBody } from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';

interface SubmitBody {
  commitSha?: unknown;
  idempotencyKey?: unknown;
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ assignmentId: string }> },
): Promise<Response> {
  try {
    const { assignmentId } = await ctx.params;
    const { sessions, identities, assignments } = getServices();
    if (!assignments) throw new DomainError('UNAVAILABLE', 'Assignment service is not configured', 503);
    const principal = await createAuthContext({ sessions, identities }).principal(req);
    if (!principal) throw errors.unauthenticated();

    const body = (await req.json().catch(() => null)) as SubmitBody | null;
    if (
      !body || typeof body !== 'object' || Array.isArray(body) ||
      typeof body.commitSha !== 'string' || !body.commitSha.trim() ||
      typeof body.idempotencyKey !== 'string' || !body.idempotencyKey.trim()
    ) {
      throw errors.invalidInput('commitSha and idempotencyKey are required');
    }

    const result = await assignments.submit({
      actor: principal,
      assignmentId: assignmentId as AssignmentId,
      commitSha: body.commitSha,
      idempotencyKey: body.idempotencyKey,
    });

    return Response.json(
      { submission: result.submission, alreadyExisted: result.alreadyExisted },
      { status: result.alreadyExisted ? 200 : 201 },
    );
  } catch (err) {
    const { status, body } = toErrorBody(err);
    return Response.json(body, { status });
  }
}

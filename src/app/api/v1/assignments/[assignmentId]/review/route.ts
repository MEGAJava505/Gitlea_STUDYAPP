import {
  AssignmentId,
  DomainError,
  errors,
  SubmissionId,
  toErrorBody,
} from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';

type ReviewAction = 'request_revision' | 'pass' | 'fail';

interface ReviewBody {
  action?: ReviewAction;
  submissionId?: string;
  feedback?: string;
  grade?: number | null;
  inlineComment?: { path?: string; line?: number };
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

    const body = (await req.json().catch(() => null)) as ReviewBody | null;
    if (!body?.submissionId) throw errors.invalidInput('submissionId is required');
    if (!body?.action) throw errors.invalidInput('action is required');

    const submissionId = body.submissionId as SubmissionId;
    const feedback = body.feedback ?? '';
    const grade = parseGrade(body.grade);
    const base = { actor: principal, assignmentId: assignmentId as AssignmentId, submissionId, feedback };

    let result;
    switch (body.action) {
      case 'request_revision':
        result = await assignments.requestRevision(base);
        break;
      case 'pass':
        result = await assignments.pass({ ...base, decision: 'pass', grade });
        break;
      case 'fail':
        result = await assignments.fail({ ...base, decision: 'fail', grade });
        break;
      default:
        throw errors.invalidInput('action must be one of request_revision, pass, fail');
    }

    return Response.json({ review: result.review, status: result.status }, { status: 200 });
  } catch (err) {
    const { status, body } = toErrorBody(err);
    return Response.json(body, { status });
  }
}

/** Validates an optional numeric grade to the 1–5 scale; null when absent. */
function parseGrade(value: unknown): import('../../../../../../shared/contracts').NumericGrade | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    throw errors.invalidInput('grade must be an integer between 1 and 5');
  }
  return value as import('../../../../../../shared/contracts').NumericGrade;
}

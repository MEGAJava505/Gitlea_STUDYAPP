import {
  AssignmentId,
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
}

export async function POST(
  req: Request,
  ctx: { params: Promise<{ assignmentId: string }> },
): Promise<Response> {
  try {
    const { assignmentId } = await ctx.params;
    const { sessions, identities, assignments } = getServices();
    const principal = await createAuthContext({ sessions, identities }).principal(req);
    if (!principal) throw errors.unauthenticated();

    const body = (await req.json().catch(() => null)) as ReviewBody | null;
    if (!body?.submissionId) throw errors.invalidInput('submissionId is required');
    if (!body?.action) throw errors.invalidInput('action is required');

    const submissionId = body.submissionId as SubmissionId;
    const feedback = body.feedback ?? '';
    const base = { actor: principal, assignmentId: assignmentId as AssignmentId, submissionId, feedback };

    let result;
    switch (body.action) {
      case 'request_revision':
        result = await assignments.requestRevision(base);
        break;
      case 'pass':
        result = await assignments.pass({ ...base, decision: 'pass' });
        break;
      case 'fail':
        result = await assignments.fail({ ...base, decision: 'fail' });
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

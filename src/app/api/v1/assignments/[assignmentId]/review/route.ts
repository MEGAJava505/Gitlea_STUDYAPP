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
  inlineComment?: { path?: string; line?: number; body?: string };
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
    const inlineComment = parseInlineComment(body.inlineComment);
    const base = { actor: principal, assignmentId: assignmentId as AssignmentId, submissionId, feedback, inlineComment };

    let result;
    switch (body.action) {
      case 'request_revision':
        if (body.grade !== undefined) throw errors.invalidInput('grade is not supported for request_revision');
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

/**
 * Validates an optional inline remark: all of path, line, and body must be
 * present and well-formed together; a partial inlineComment is a 400.
 */
function parseInlineComment(
  value: ReviewBody['inlineComment'],
): import('../../../../../../shared/contracts').InlineComment | undefined {
  if (value === undefined) return undefined;
  if (
    value === null || typeof value !== 'object' || typeof value.path !== 'string' || !value.path.trim()
    || typeof value.line !== 'number' || !Number.isInteger(value.line) || value.line < 1
    || typeof value.body !== 'string' || !value.body.trim()
  ) {
    throw errors.invalidInput('inlineComment requires path, line, and body together');
  }
  return { path: value.path, line: value.line, body: value.body };
}

/** Validates an optional numeric grade to the 1–5 scale; null when absent. */
function parseGrade(value: unknown): import('../../../../../../shared/contracts').NumericGrade | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 5) {
    throw errors.invalidInput('grade must be an integer between 1 and 5');
  }
  return value as import('../../../../../../shared/contracts').NumericGrade;
}

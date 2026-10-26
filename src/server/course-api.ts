import { DomainError, errors, toErrorBody } from '../shared/contracts';
import { createAuthContext, getServices } from './auth-context';

export async function requireCourseContext(req: Request) {
  const { courses, sessions, identities } = getServices();
  if (!courses) throw new DomainError('UNAVAILABLE', 'Course service is not configured', 503);
  const actor = await createAuthContext({ sessions, identities }).principal(req);
  if (!actor) throw errors.unauthenticated();
  return { courses, actor };
}

export function courseApiError(err: unknown): Response {
  const { status, body } = toErrorBody(err);
  return Response.json(body, { status });
}

import { DomainError, errors, toErrorBody, type CourseId, type SessionPrincipal } from '../../../../../../shared/contracts';
import { createAuthContext, getServices } from '../../../../../../server/auth-context';

interface AssignmentApiService {
  create(input: { actor: SessionPrincipal; courseId: CourseId; title: string; description?: string; allowResubmission?: boolean }): Promise<unknown>;
  listForCourse(actor: SessionPrincipal, courseId: CourseId): Promise<unknown[]>;
  listForStudent(actor: SessionPrincipal, courseId?: CourseId): Promise<unknown[]>;
}

function assignmentService(): AssignmentApiService {
  const service = (getServices() as ReturnType<typeof getServices> & { assignmentService?: AssignmentApiService }).assignmentService;
  if (!service) throw new DomainError('UNAVAILABLE', 'Assignment service is not configured', 503);
  return service;
}

async function principal(req: Request): Promise<SessionPrincipal> {
  const { sessions, identities } = getServices();
  const actor = await createAuthContext({ sessions, identities }).principal(req);
  if (!actor) throw errors.unauthenticated();
  return actor;
}

export async function POST(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, actor] = await Promise.all([ctx.params, principal(req)]);
    const body = await req.json().catch(() => null) as { title?: unknown; description?: unknown; allowResubmission?: unknown } | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim()) throw errors.invalidInput('title is required');
    if (body.description !== undefined && typeof body.description !== 'string') throw errors.invalidInput('description must be a string');
    if (body.allowResubmission !== undefined && typeof body.allowResubmission !== 'boolean') {
      throw errors.invalidInput('allowResubmission must be a boolean');
    }
    const assignment = await assignmentService().create({
      actor,
      courseId: courseId as CourseId,
      title: body.title,
      description: body.description,
      allowResubmission: body.allowResubmission,
    });
    return Response.json({ assignment }, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

export async function GET(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, actor] = await Promise.all([ctx.params, principal(req)]);
    const service = assignmentService();
    const assignments = actor.roles.includes('student')
      ? await service.listForStudent(actor, courseId as CourseId)
      : await service.listForCourse(actor, courseId as CourseId);
    return Response.json({ assignments });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

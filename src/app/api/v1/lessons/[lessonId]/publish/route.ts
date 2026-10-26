import { errors, toErrorBody, type GroupId } from '../../../../../../shared/contracts';
import { requireCourseContext } from '../../../../../../server/course-api';

export async function POST(req: Request, ctx: { params: Promise<{ lessonId: string }> }): Promise<Response> {
  try {
    const [{ lessonId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    const body = await req.json().catch(() => null) as { groupId?: string } | null;
    if (!body?.groupId) throw errors.invalidInput('groupId is required');
    const publication = await courses.publishLessonToGroup(actor, lessonId, body.groupId as GroupId);
    return Response.json({ publication }, { status: 201 });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

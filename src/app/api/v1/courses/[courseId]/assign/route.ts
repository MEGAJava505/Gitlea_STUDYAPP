import { errors, type CourseId, type GroupId } from '../../../../../../shared/contracts';
import { courseApiError, requireCourseContext } from '../../../../../../server/course-api';

export async function POST(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    const body = await req.json().catch(() => null) as { groupId?: string } | null;
    if (!body?.groupId) throw errors.invalidInput('groupId is required');
    const assignment = await courses.assignCourseToGroup(actor, courseId as CourseId, body.groupId as GroupId);
    return Response.json({ assignment }, { status: 201 });
  } catch (error) {
    return courseApiError(error);
  }
}

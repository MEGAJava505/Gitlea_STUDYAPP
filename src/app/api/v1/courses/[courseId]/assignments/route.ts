import { errors, type CourseId, type GroupId } from '../../../../../../shared/contracts';
import { courseApiError, requireCourseContext } from '../../../../../../server/course-api';

export async function POST(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    const body = await req.json().catch(() => null) as {
      groupId?: string; title?: string; description?: string; allowResubmission?: boolean; deadline?: number | null; published?: boolean;
    } | null;
    if (!body?.groupId || !body.title) throw errors.invalidInput('groupId and title are required');
    if (body.allowResubmission !== undefined && typeof body.allowResubmission !== 'boolean') throw errors.invalidInput('allowResubmission must be a boolean');
    if (body.published !== undefined && typeof body.published !== 'boolean') throw errors.invalidInput('published must be a boolean');
    const assignment = await courses.createExtraAssignment({
      actor, courseId: courseId as CourseId, groupId: body.groupId as GroupId, title: body.title,
      description: body.description, allowResubmission: body.allowResubmission, deadline: body.deadline, published: body.published,
    });
    return Response.json({ assignment }, { status: 201 });
  } catch (error) {
    return courseApiError(error);
  }
}

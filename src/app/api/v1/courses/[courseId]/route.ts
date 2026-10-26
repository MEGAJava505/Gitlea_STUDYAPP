import { errors, type CourseId } from '../../../../../shared/contracts';
import { courseApiError, requireCourseContext } from '../../../../../server/course-api';

export async function PATCH(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    const body = await req.json().catch(() => null) as { title?: string; slug?: string; description?: string } | null;
    if (!body || (!body.title && !body.slug && body.description === undefined)) throw errors.invalidInput('At least one course field is required');
    return Response.json({ course: await courses.updateCourse(actor, courseId as CourseId, body) });
  } catch (error) {
    return courseApiError(error);
  }
}

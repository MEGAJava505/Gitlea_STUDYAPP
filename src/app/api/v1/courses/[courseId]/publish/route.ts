import { toErrorBody, type CourseId } from '../../../../../../shared/contracts';
import { requireCourseContext } from '../../../../../../server/course-api';

export async function POST(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    return Response.json({ course: await courses.publishCourse(actor, courseId as CourseId) });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

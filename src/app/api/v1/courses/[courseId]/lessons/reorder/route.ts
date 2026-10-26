import { errors, toErrorBody, type CourseId } from '../../../../../../../shared/contracts';
import { requireCourseContext } from '../../../../../../../server/course-api';

export async function POST(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    const body = await req.json().catch(() => null) as { lessonIds?: string[] } | null;
    if (!body || !Array.isArray(body.lessonIds)) throw errors.invalidInput('lessonIds is required');
    const lessons = await courses.reorderLessons(actor, courseId as CourseId, body.lessonIds);
    return Response.json({ lessons });
  } catch (error) {
    const { status, body } = toErrorBody(error);
    return Response.json(body, { status });
  }
}

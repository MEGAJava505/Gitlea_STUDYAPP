import { errors, toErrorBody } from '../../../../../shared/contracts';
import { courseApiError, requireCourseContext } from '../../../../../server/course-api';

export async function PATCH(req: Request, ctx: { params: Promise<{ lessonId: string }> }): Promise<Response> {
  try {
    const [{ lessonId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    const body = await req.json().catch(() => null) as { title?: string; contentMetadata?: Record<string, unknown> } | null;
    if (!body || (body.title === undefined && body.contentMetadata === undefined)) throw errors.invalidInput('At least one lesson field is required');
    return Response.json({ lesson: await courses.updateLesson({ actor, lessonId, ...body }) });
  } catch (error) {
    return courseApiError(error);
  }
}

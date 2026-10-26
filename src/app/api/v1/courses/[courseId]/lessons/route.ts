import { errors, type CourseId } from '../../../../../../shared/contracts';
import { courseApiError, requireCourseContext } from '../../../../../../server/course-api';

export async function GET(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    return Response.json({ lessons: await courses.listPublishedLessonsForStudent(actor, courseId as CourseId) });
  } catch (error) {
    return courseApiError(error);
  }
}

export async function POST(req: Request, ctx: { params: Promise<{ courseId: string }> }): Promise<Response> {
  try {
    const [{ courseId }, { courses, actor }] = await Promise.all([ctx.params, requireCourseContext(req)]);
    const body = await req.json().catch(() => null) as { title?: string; contentMetadata?: Record<string, unknown> } | null;
    if (!body?.title) throw errors.invalidInput('title is required');
    const lesson = await courses.createLesson({ actor, courseId: courseId as CourseId, title: body.title, contentMetadata: body.contentMetadata });
    return Response.json({ lesson }, { status: 201 });
  } catch (error) {
    return courseApiError(error);
  }
}

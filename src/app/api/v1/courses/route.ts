import { errors } from '../../../../shared/contracts';
import { courseApiError, requireCourseContext } from '../../../../server/course-api';

export async function GET(req: Request): Promise<Response> {
  try {
    const { courses, actor } = await requireCourseContext(req);
    return Response.json({ courses: await courses.listLibrary(actor) });
  } catch (error) {
    return courseApiError(error);
  }
}

export async function POST(req: Request): Promise<Response> {
  try {
    const { courses, actor } = await requireCourseContext(req);
    const body = await req.json().catch(() => null) as { title?: string; slug?: string; description?: string } | null;
    if (!body || typeof body.title !== 'string' || !body.title.trim() || typeof body.slug !== 'string' || !body.slug.trim() ||
      (body.description !== undefined && typeof body.description !== 'string')) {
      throw errors.invalidInput('title and slug must be nonempty strings; description must be a string');
    }
    const course = await courses.createCourse({ actor, title: body.title, slug: body.slug, description: body.description });
    return Response.json({ course }, { status: 201 });
  } catch (error) {
    return courseApiError(error);
  }
}

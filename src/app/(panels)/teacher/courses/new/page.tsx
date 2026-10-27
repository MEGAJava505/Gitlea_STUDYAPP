import { coursePageContext } from '../context';
import { ApiForm } from '../api-form';
export const dynamic = 'force-dynamic';
export default async function NewCoursePage() {
  await coursePageContext('teacher');
  return <section><h2>Create course</h2><ApiForm endpoint="/api/v1/courses" label="Create course" redirectCourse>
    <p><label>Title <input name="title" required maxLength={255} /></label></p>
    <p><label>Slug <input name="slug" required pattern="[A-Za-z0-9-]+" /></label></p>
    <p><label>Description <textarea name="description" /></label></p>
  </ApiForm></section>;
}

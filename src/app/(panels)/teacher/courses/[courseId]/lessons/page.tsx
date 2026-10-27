import Link from 'next/link';
import { coursePageContext, coursePageError } from '../../context';
import { ApiForm } from '../../api-form';
import { teacherCourseDetails } from '@/server/teacher-courses';
export const dynamic = 'force-dynamic';
export default async function LessonsPage({ params }: { params: Promise<{ courseId: string }> }) {
  const { actor } = await coursePageContext('teacher');
  const { courseId } = await params;
  let data;
  try { data = await teacherCourseDetails(actor, courseId); }
  catch (error) { coursePageError(error); }
  const { course, lessons, assignedGroups, availableGroups, publications } = data;
  return <section><Link href="/teacher/courses">Course Library</Link><h2>{course.title}</h2><p>{course.description}</p>
    <p>{course.publishedAt === null ? 'Draft course' : 'Published course'}</p>
    {course.publishedAt === null && <ApiForm endpoint={'/api/v1/courses/' + courseId + '/publish'} label="Publish course" />}
    <h3>Assign to group</h3>
    <ApiForm endpoint={'/api/v1/courses/' + courseId + '/assign'} label="Assign course">
      <label>Group <select name="groupId" required><option value="">Choose group</option>{availableGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
    </ApiForm>
    <p>Assigned groups: {assignedGroups.map(group => group.name).join(', ') || 'None'}</p>
    <h3>Add lesson</h3><p>Lessons are appended in order and remain hidden until published to a group.</p>
    <ApiForm endpoint={'/api/v1/courses/' + courseId + '/lessons'} label="Add lesson"><label>Lesson title <input name="title" required /></label></ApiForm>
    <ol>{lessons.map(lesson => <li key={lesson.id}><h3>{lesson.title}</h3>
      <Link href={'/teacher/courses/' + courseId + '/lessons/' + lesson.id + '/materials'}>Browse materials</Link>
      <p>Published to: {assignedGroups.filter(group => publications.some(publication => publication.lessonId === lesson.id && publication.groupId === group.id)).map(group => group.name).join(', ') || 'None (hidden from students)'}</p>
      <ApiForm endpoint={'/api/v1/lessons/' + lesson.id + '/publish'} label="Publish lesson to group">
        <label>Assigned group <select name="groupId" required><option value="">Choose assigned group</option>{assignedGroups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}</select></label>
      </ApiForm>
    </li>)}</ol>
  </section>;
}

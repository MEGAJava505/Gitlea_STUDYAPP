import Link from 'next/link';
import { coursePageContext } from './context';
export const dynamic = 'force-dynamic';
export default async function TeacherCoursesPage() {
  const { actor, courses } = await coursePageContext('teacher');
  const library = await courses.listLibrary(actor);
  return <section><h2>Course Library</h2><Link href="/teacher/courses/new">Create course</Link>
    <ul>{library.map(course => <li key={course.id}>{course.title} — {course.publishedAt === null ? 'Draft' : 'Published'}{' '}
      {(course.ownerId === actor.userId || actor.roles.some(role => role === 'admin' || role === 'owner')) && <Link href={'/teacher/courses/' + course.id + '/lessons'}>Manage lessons</Link>}
    </li>)}</ul>{library.length === 0 && <p>No courses yet.</p>}</section>;
}

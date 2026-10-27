import Link from 'next/link';
import { coursePageContext } from '../../teacher/courses/context';
export const dynamic = 'force-dynamic';
export default async function StudentCoursesPage() {
  const { actor, courses } = await coursePageContext('student');
  const library = await courses.listLibrary(actor);
  return <section><h2>My Courses</h2><ul>{library.map(course => <li key={course.id}><Link href={'/student/courses/' + course.id}>{course.title}</Link></li>)}</ul>{library.length === 0 && <p>No assigned courses yet.</p>}</section>;
}

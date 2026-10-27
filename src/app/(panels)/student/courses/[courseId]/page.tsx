import Link from 'next/link';
import { notFound } from 'next/navigation';
import { coursePageContext } from '../../../teacher/courses/context';
import { MaterialList } from '../../../teacher/courses/material-list';
import type { CourseId } from '@/shared/contracts';
export const dynamic = 'force-dynamic';
export default async function StudentCoursePage({ params }: { params: Promise<{ courseId: string }> }) {
  const { actor, courses } = await coursePageContext('student');
  const { courseId } = await params;
  const course = (await courses.listLibrary(actor)).find(item => item.id === courseId);
  if (!course) notFound();
  const lessons = await courses.listPublishedLessonsForStudent(actor, courseId as CourseId);
  return <section><Link href="/student/courses">My Courses</Link><h2>{course.title}</h2><p>{course.description}</p>
    {lessons.length === 0 && <p>No published lessons yet.</p>}
    <ol>{lessons.map(lesson => <li key={lesson.id}><h3>{lesson.title}</h3><MaterialList lessonId={lesson.id} /></li>)}</ol>
  </section>;
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { coursePageContext, coursePageError } from '../../../../context';
import { MaterialList } from '../../../../material-list';
import { teacherCourseDetails } from '@/server/teacher-courses';
export const dynamic = 'force-dynamic';
export default async function MaterialsPage({ params }: { params: Promise<{ courseId: string; lessonId: string }> }) {
  const { actor } = await coursePageContext('teacher');
  const { courseId, lessonId } = await params;
  let data;
  try { data = await teacherCourseDetails(actor, courseId); }
  catch (error) { coursePageError(error); }
  const lesson = data.lessons.find(item => item.id === lessonId);
  if (!lesson) notFound();
  return <section><Link href={'/teacher/courses/' + courseId + '/lessons'}>Back to lessons</Link><h2>{lesson.title}: materials</h2><MaterialList lessonId={lessonId} canUpload /></section>;
}

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { coursePageContext } from '@/app/(panels)/teacher/courses/context';
import { getServices } from '@/server/auth-context';
import { ReviewForm } from './review-form';

export const dynamic = 'force-dynamic';

const formatTashkent = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Tashkent' });

export default async function TeacherAssignmentReviewPage({
  params,
}: {
  params: Promise<{ courseId: string; assignmentId: string }>;
}) {
  const { actor } = await coursePageContext('teacher');
  const { courseId, assignmentId } = await params;
  const { teacherSubmissions, grading } = getServices();
  if (!teacherSubmissions) throw new Error('Teacher submissions service is not configured');

  // Enforces the assigned-teacher rule: a teacher who is not the assignment
  // author sees nothing here (matches the review permission in permissions.ts).
  const meta = await teacherSubmissions.forAssignment(assignmentId, actor.userId);
  if (!meta) notFound();

  const submissions = await teacherSubmissions.listSubmissions(assignmentId, actor.userId);
  const showGrade = grading ? await grading.isEnabled() : false;

  return (
    <section>
      <p><Link href={`/teacher/courses/${courseId}/lessons`}>Course Library</Link></p>
      <h2>{meta.title}</h2>
      <p>Group: <strong>{meta.group.name}</strong></p>

      {submissions.length === 0 ? (
        <p>No submissions yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Student</th><th>Attempt</th><th>Commit</th><th>Submitted</th><th>Status</th>
              <th>Review</th>{showGrade && <th>Grade</th>}<th>Review this</th>
            </tr>
          </thead>
          <tbody>
            {submissions.map((s) => (
              <tr key={s.submissionId}>
                <td>{s.student.displayName}</td>
                <td>{s.attempt}</td>
                <td><code>{s.commitSha.slice(0, 8)}</code></td>
                <td>{formatTashkent(s.submittedAt)}</td>
                <td>{s.status}</td>
                <td>{s.review ? `${s.review.decision}: ${s.review.feedback}` : '—'}</td>
                {showGrade && <td data-grade>{s.review?.grade ?? ''}</td>}
                <td>
                  <ReviewForm
                    assignmentId={assignmentId}
                    submissionId={s.submissionId}
                    showGrade={showGrade}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

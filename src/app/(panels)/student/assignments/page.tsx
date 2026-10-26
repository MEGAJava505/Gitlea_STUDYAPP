import Link from 'next/link';
import { headers } from 'next/headers';
import { createAuthContext, getServices } from '../../../../server/auth-context';
import { requirePageAccess, requireStudentPanel } from '../../../../server/panels';

export const dynamic = 'force-dynamic';

export default async function StudentAssignmentsPage() {
  const cookie = (await headers()).get('cookie');
  const { sessions, identities, studentAssignments } = getServices();
  const principal = await createAuthContext({ sessions, identities }).principal(
    new Request('http://localhost/student/assignments', { headers: cookie ? { cookie } : undefined }),
  );
  const student = requirePageAccess(() => requireStudentPanel(principal));
  const assignments = studentAssignments ? await studentAssignments.list(student.userId) : [];

  return (
    <section>
      <h2>Assignments</h2>
      {assignments.length === 0 ? (
        <p>No published assignments yet.</p>
      ) : (
        <ul>
          {assignments.map((assignment) => (
            <li key={assignment.id}>
              <Link href={`/student/assignments/${assignment.id}`}>{assignment.title}</Link>{' '}
              <span data-status={assignment.status}>{assignment.status}</span>{' '}
              <time dateTime={new Date(assignment.deadline).toISOString()}>
                {new Date(assignment.deadline).toLocaleString('en-GB', { timeZone: 'Asia/Tashkent' })}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

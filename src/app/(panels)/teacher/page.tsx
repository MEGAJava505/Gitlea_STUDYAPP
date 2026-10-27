import Link from 'next/link';
import { headers } from 'next/headers';
import { createAuthContext, getServices } from '../../../server/auth-context';
import { requirePageAccess, requireTeacherPanel } from '../../../server/panels';

export default async function TeacherPanelPage() {
  const requestHeaders = await headers();
  const { sessions, identities } = getServices();
  const principal = await createAuthContext({ sessions, identities }).principal(
    new Request('http://localhost/teacher', {
      headers: requestHeaders.get('cookie') ? { cookie: requestHeaders.get('cookie')! } : undefined,
    }),
  );
  requirePageAccess(() => requireTeacherPanel(principal));

  return (
    <section>
      <h2>Teacher Panel</h2>
      <ul>
        <li>Dashboard</li>
        <li>My Groups</li>
        <li><Link href="/teacher/courses">Course Library</Link></li>
        <li>Lessons</li>
        <li>Assignments</li>
        <li>Submissions / Review</li>
        <li>Student Progress</li>
        <li>Notifications</li>
      </ul>
    </section>
  );
}

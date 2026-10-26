import { headers } from 'next/headers';
import { createAuthContext, getServices } from '../../../server/auth-context';
import { requirePageAccess, requireStudentPanel } from '../../../server/panels';

export default async function StudentPanelPage() {
  const requestHeaders = await headers();
  const { sessions, identities } = getServices();
  const principal = await createAuthContext({ sessions, identities }).principal(
    new Request('http://localhost/student', {
      headers: requestHeaders.get('cookie') ? { cookie: requestHeaders.get('cookie')! } : undefined,
    }),
  );
  requirePageAccess(() => requireStudentPanel(principal));

  return (
    <section>
      <h2>Student Panel</h2>
      <ul>
        <li>Dashboard</li>
        <li>My Courses</li>
        <li>Assignments</li>
        <li>Repositories</li>
        <li>Results</li>
        <li>Notifications</li>
        <li>Settings</li>
      </ul>
    </section>
  );
}

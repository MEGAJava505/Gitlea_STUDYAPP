import { headers } from 'next/headers';
import { createAuthContext, getServices } from '../../../server/auth-context';
import { requireAdminPanel } from '../../../server/panels';

export default async function AdminPanelPage() {
  const requestHeaders = await headers();
  const { sessions, identities } = getServices();
  const principal = await createAuthContext({ sessions, identities }).principal(
    new Request('http://localhost/admin', {
      headers: requestHeaders.get('cookie') ? { cookie: requestHeaders.get('cookie')! } : undefined,
    }),
  );
  requireAdminPanel(principal);

  return (
    <section>
      <h2>Admin Panel</h2>
      <ul>
        <li>Overview</li>
        <li>Users</li>
        <li>Groups</li>
        <li>Import Students</li>
        <li>Courses</li>
        <li>Roles &amp; Permissions</li>
        <li>Grading Settings</li>
        <li>Audit Log</li>
      </ul>
    </section>
  );
}

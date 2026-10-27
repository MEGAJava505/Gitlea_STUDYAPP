import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { createAuthContext, getServices } from '../../../../../server/auth-context';
import { requirePageAccess, requireStudentPanel } from '../../../../../server/panels';
import { cloneUrls } from '../../../../../domain/git/provisioning';
import { ProvisionButton, SubmitForm } from './submit-form';

export const dynamic = 'force-dynamic';

const formatTashkent = (ms: number) =>
  new Date(ms).toLocaleString('en-GB', { dateStyle: 'long', timeStyle: 'short', timeZone: 'Asia/Tashkent' });

export default async function StudentAssignmentDetailPage({ params }: { params: Promise<{ assignmentId: string }> }) {
  const { assignmentId } = await params;
  const cookie = (await headers()).get('cookie');
  const { sessions, identities, studentAssignments } = getServices();
  const principal = await createAuthContext({ sessions, identities }).principal(
    new Request(`http://localhost/student/assignments/${assignmentId}`, { headers: cookie ? { cookie } : undefined }),
  );
  const student = requirePageAccess(() => requireStudentPanel(principal));

  const assignment = await studentAssignments?.get(student.userId, assignmentId);
  if (!assignment) notFound();

  const isOverdue = Date.now() > assignment.deadline;
  const latest = assignment.attempts[0];
  const canSubmit = !isOverdue && assignment.repository !== null && (
    assignment.status === 'in_progress' ||
    (assignment.status === 'revision_required' && assignment.allowResubmission)
  );
  const urls = assignment.repository && cloneUrls(assignment.repository.fullName, {
    cloneBaseUrl: process.env.GITEA_CLONE_BASE_URL ?? process.env.GITEA_BASE_URL ?? '',
    sshCloneBaseUrl: process.env.GITEA_SSH_CLONE_BASE_URL ?? '',
  });

  return (
    <article>
      <h2>{assignment.title}</h2>
      <p>Status: <strong data-status={assignment.status}>{assignment.status}</strong></p>
      <p>
        Deadline: <time dateTime={new Date(assignment.deadline).toISOString()}>{formatTashkent(assignment.deadline)}</time> (Tashkent)
        {isOverdue && ' — closed'}
      </p>
      {assignment.description && <p>{assignment.description}</p>}

      {urls ? (
        <section>
          <h3>Repository</h3>
          <p>HTTPS: <code>{urls.https}</code></p>
          {process.env.GITEA_SSH_CLONE_BASE_URL && <p>SSH: <code>{urls.ssh}</code></p>}
          <h3>Git workflow</h3>
          <ol>
            <li>Clone the repository.</li>
            <li>Work on the <code>work</code> branch: <code>git switch -c work</code>.</li>
            <li>Commit and <code>git push -u origin work</code>.</li>
            <li>Copy the pushed commit: <code>git rev-parse HEAD</code>.</li>
            <li>Submit it below. Pushing alone is not a submission.</li>
          </ol>
        </section>
      ) : (
        <section>
          <p>Your private repository has not been created yet.</p>
          {!isOverdue && <ProvisionButton assignmentId={assignmentId} />}
        </section>
      )}

      {assignment.attempts.length > 0 && (
        <section>
          <h3>Submissions</h3>
          <table>
            <thead><tr><th>Attempt</th><th>Commit</th><th>Submitted</th><th>Status</th></tr></thead>
            <tbody>
              {assignment.attempts.map((attempt) => (
                <tr key={attempt.attempt}>
                  <td>{attempt.attempt}</td>
                  <td><code>{attempt.commitSha}</code></td>
                  <td>{formatTashkent(attempt.submittedAt)}</td>
                  <td>{attempt.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {canSubmit ? (
        <SubmitForm assignmentId={assignmentId} />
      ) : (
        <p>
          {isOverdue && 'Submission is closed: the deadline has passed.'}
          {!isOverdue && !assignment.repository && 'Submission opens once your repository exists.'}
          {!isOverdue && latest?.status === 'submitted' && 'Submitted. Waiting for teacher review.'}
          {!isOverdue && assignment.status === 'revision_required' && !assignment.allowResubmission &&
            'Revision requested, but resubmission is not allowed for this assignment.'}
        </p>
      )}
    </article>
  );
}

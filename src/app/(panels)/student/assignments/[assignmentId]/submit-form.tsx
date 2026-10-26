'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

/** Submits an existing pushed commit SHA. One idempotency key per form instance makes retries safe. */
export function SubmitForm({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [commitSha, setCommitSha] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/assignments/${assignmentId}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commitSha: commitSha.trim(), idempotencyKey }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `Submission failed (${response.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError('Network error. Your work was not confirmed as submitted; please retry.');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={onSubmit}>
      <label htmlFor="commitSha">Commit SHA</label>
      <input
        id="commitSha"
        name="commitSha"
        required
        pattern="[0-9a-f]{40}"
        title="Full 40-character commit SHA (git rev-parse HEAD)"
        value={commitSha}
        onChange={(event) => setCommitSha(event.target.value)}
        aria-describedby="commit-sha-help"
      />
      <small id="commit-sha-help">Run <code>git rev-parse HEAD</code> after pushing and paste the full SHA.</small>
      <button type="submit" disabled={pending}>{pending ? 'Submitting…' : 'Submit work'}</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

/** Creates the student's private repository from the assignment template (idempotent server-side). */
export function ProvisionButton({ assignmentId }: { assignmentId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onClick() {
    setPending(true);
    setError(null);
    try {
      const response = await fetch(`/api/v1/assignments/${assignmentId}/repositories`, { method: 'POST' });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
        setError(body?.error?.message ?? `Repository creation failed (${response.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError('Network error. Please retry.');
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <button type="button" onClick={onClick} disabled={pending}>{pending ? 'Creating…' : 'Create my repository'}</button>
      {error && <p role="alert">{error}</p>}
    </>
  );
}

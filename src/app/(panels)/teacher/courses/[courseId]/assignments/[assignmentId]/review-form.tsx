'use client';
import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';

type ReviewAction = 'request_revision' | 'pass' | 'fail';

/**
 * Inline review controls for a single submission. POSTs the teacher's decision
 * (and optional grade / inline comment) to the review API, then refreshes the
 * page read-model. The grade control is rendered only when numeric grading is
 * enabled; the page passes that flag down so the toggle is enforced in markup.
 */
export function ReviewForm({
  assignmentId,
  submissionId,
  showGrade,
}: {
  assignmentId: string;
  submissionId: string;
  showGrade: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [action, setAction] = useState<ReviewAction>('pass');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setPending(true);
    setMessage('');
    try {
      const feedback = String(data.get('feedback') ?? '');
      const gradeRaw = String(data.get('grade') ?? '').trim();
      const path = String(data.get('path') ?? '').trim();
      const lineRaw = String(data.get('line') ?? '').trim();
      const body = String(data.get('body') ?? '').trim();

      const payload: Record<string, unknown> = { action, submissionId, feedback };
      // Grade is offered only while numeric grading is on, and never with a
      // revision request (the API rejects that combination with a 400).
      if (showGrade && action !== 'request_revision' && gradeRaw !== '') {
        const grade = Number(gradeRaw);
        if (!Number.isInteger(grade) || grade < 1 || grade > 5) {
          throw new Error('grade must be an integer between 1 and 5');
        }
        payload.grade = grade;
      }
      // Inline comment: path, line and body must all be present together.
      if (path !== '' || lineRaw !== '' || body !== '') {
        const line = Number(lineRaw);
        if (path === '' || !Number.isInteger(line) || line < 1 || body === '') {
          throw new Error('inlineComment requires path, line, and body together');
        }
        payload.inlineComment = { path, line, body };
      }

      const response = await fetch(`/api/v1/assignments/${assignmentId}/review`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => null);
      if (!response.ok) throw new Error(result?.error?.message ?? 'Review failed');
      form.reset();
      setAction('pass');
      setMessage('Saved.');
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Review failed');
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <fieldset>
        <legend>Decision</legend>
        {(['request_revision', 'pass', 'fail'] as const).map((value) => (
          <label key={value}>
            <input
              type="radio"
              name="action"
              value={value}
              checked={action === value}
              onChange={() => setAction(value)}
            />{' '}{value.replace('_', ' ')}
          </label>
        ))}
      </fieldset>
      <label>Feedback <textarea name="feedback" rows={2} /></label>
      {showGrade && action !== 'request_revision' && (
        <label>Grade (1–5){' '}
          <select name="grade" defaultValue="">
            <option value="">—</option>
            {[1, 2, 3, 4, 5].map((g) => <option key={g} value={g}>{g}</option>)}
          </select>
        </label>
      )}
      <details>
        <summary>Inline comment</summary>
        <label>Path <input name="path" placeholder="src/main.ts" /></label>
        <label>Line <input name="line" type="number" min={1} placeholder="12" /></label>
        <label>Body <input name="body" placeholder="remark" /></label>
      </details>
      <button type="submit" disabled={pending}>{pending ? 'Saving…' : 'Submit review'}</button>
      <p role="status">{message}</p>
    </form>
  );
}

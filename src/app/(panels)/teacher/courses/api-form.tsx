'use client';
import { useState, type FormEvent, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';

/** Forms use the same authenticated JSON endpoints as other clients. */
export function ApiForm({ endpoint, children, label, redirectCourse = false }: {
  endpoint: string; children?: ReactNode; label: string; redirectCourse?: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    setPending(true); setMessage('');
    try {
      const body = Object.fromEntries(new FormData(form));
      const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error?.message ?? 'Request failed');
      if (redirectCourse) router.push('/teacher/courses/' + result.course.id + '/lessons');
      else { form.reset(); setMessage('Saved.'); router.refresh(); }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Request failed'); }
    finally { setPending(false); }
  }
  return <form onSubmit={submit}>{children}<button disabled={pending} type="submit">{pending ? 'Saving…' : label}</button><p role="status">{message}</p></form>;
}

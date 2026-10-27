import { headers } from 'next/headers';
import { notFound } from 'next/navigation';
import { createAuthContext, getServices } from '@/server/auth-context';
import { requirePageAccess, requireTeacherPanel, requireStudentPanel } from '@/server/panels';
import { DomainError } from '@/shared/contracts';

export function coursePageError(error: unknown): never {
  if (error instanceof DomainError && error.status === 404) notFound();
  requirePageAccess(() => { throw error; });
  throw error;
}

export async function coursePageContext(panel: 'teacher' | 'student') {
  const cookie = (await headers()).get('cookie');
  const services = getServices();
  const principal = await createAuthContext(services).principal(new Request('http://localhost/' + panel, { headers: cookie ? { cookie } : undefined }));
  const actor = requirePageAccess(() => panel === 'teacher' ? requireTeacherPanel(principal) : requireStudentPanel(principal));
  if (!services.courses) throw new DomainError('UNAVAILABLE', 'Course service is not configured', 503);
  return { actor, courses: services.courses };
}

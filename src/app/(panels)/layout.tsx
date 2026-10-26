import Link from 'next/link';

export default function PanelsLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <main className="container">
      <h1>Local GitHub Panels</h1>
      <nav aria-label="Panels">
        <Link href="/student">Student</Link>{' '}
        <Link href="/teacher">Teacher</Link>{' '}
        <Link href="/admin">Admin</Link>
      </nav>
      {children}
    </main>
  );
}

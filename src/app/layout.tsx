import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Local GitHub',
  description: 'Local GitHub MVP - foundation placeholder',
};

/**
 * App shell (Task A owns only the shell). Product screens land in later tasks;
 * keep this minimal and free of feature logic.
 */
export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

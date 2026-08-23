import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Colorado Hunt Finder',
  description:
    'Explore Colorado leftover hunting licenses alongside official CPW game management units.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

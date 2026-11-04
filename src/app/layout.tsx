import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = { title: 'City Rider — Take the scenic route', description: 'Explore real cities in your own little car.' };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="ru"><body>{children}</body></html>; }

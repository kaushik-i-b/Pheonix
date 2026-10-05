import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { IBM_Plex_Mono, Instrument_Sans } from 'next/font/google';
import { Footer } from '../components/footer';
import { Header } from '../components/header';
import { SourceBanner } from '../components/source-banner';
import { resolveWorkspace } from '../data/repo-root';
import './globals.css';

const instrumentSans = Instrument_Sans({
  variable: '--font-instrument-sans',
  subsets: ['latin'],
  display: 'swap',
});

const ibmPlexMono = IBM_Plex_Mono({
  variable: '--font-ibm-plex-mono',
  subsets: ['latin'],
  weight: ['400', '500'],
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'PHOENIX run inspector',
  description: 'Evidence and citations for PHOENIX modernization runs.',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  const ws = resolveWorkspace();
  return (
    <html lang="en" className={`${instrumentSans.variable} ${ibmPlexMono.variable}`}>
      <body className="bg-deck text-deck-text font-sans antialiased">
        <div className="flex min-h-screen flex-col">
          <Header />
          <SourceBanner sourceMode={ws.sourceMode} buildTime={ws.buildTime} />
          <main className="flex-1">{children}</main>
          <Footer />
        </div>
      </body>
    </html>
  );
}

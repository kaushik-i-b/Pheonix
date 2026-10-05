'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Header() {
  const pathname = usePathname();
  const onHome = pathname === '/';
  const onEvidence = pathname.startsWith('/recorded') || pathname.startsWith('/runs');
  return (
    <header className="border-b border-deck-line bg-deck">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 sm:px-6">
        <Link href="/" className="font-mono text-sm tracking-[0.35em] text-deck-text">
          PHOENIX
        </Link>
        <nav className="flex items-baseline gap-4 whitespace-nowrap">
          <Link
            href="/"
            className={`font-mono text-[11px] tracking-[0.16em] uppercase ${
              onHome ? 'text-brass' : 'text-mist hover:text-deck-text'
            }`}
          >
            Home
          </Link>
          <Link
            href="/recorded/"
            className={`font-mono text-[11px] tracking-[0.16em] uppercase ${
              onEvidence ? 'text-brass' : 'text-mist hover:text-deck-text'
            }`}
          >
            Evidence
          </Link>
        </nav>
      </div>
    </header>
  );
}

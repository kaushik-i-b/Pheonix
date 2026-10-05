'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

export function Header() {
  const pathname = usePathname();
  const onRuns = pathname === '/' || pathname.startsWith('/runs');
  return (
    <header className="border-b border-deck-line bg-deck">
      <div className="mx-auto flex max-w-6xl items-baseline gap-3 px-6 py-3">
        <Link href="/" className="font-mono text-sm tracking-[0.35em] text-deck-text">
          PHOENIX
        </Link>
        <span className="font-mono text-[11px] tracking-[0.2em] text-mist uppercase">
          run inspector
        </span>
        <nav className="ml-auto">
          <Link
            href="/"
            className={`font-mono text-[11px] tracking-[0.2em] uppercase ${
              onRuns ? 'text-brass' : 'text-mist hover:text-deck-text'
            }`}
          >
            Runs
          </Link>
        </nav>
      </div>
    </header>
  );
}

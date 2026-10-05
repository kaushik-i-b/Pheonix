'use client';

import { usePathname } from 'next/navigation';

export function Footer() {
  const pathname = usePathname();
  if (pathname === '/') return null;
  return (
    <footer className="border-t border-deck-line bg-deck">
      <p className="mx-auto max-w-6xl px-4 py-4 text-xs leading-relaxed text-mist sm:px-6">
        These pages read recorded results. They do not start a new run.
      </p>
    </footer>
  );
}

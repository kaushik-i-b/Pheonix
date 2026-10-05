'use client';

import { usePathname } from 'next/navigation';

export function SourceBanner({
  sourceMode,
  buildTime,
}: {
  sourceMode: 'working-tree' | 'snapshot';
  buildTime: string | null;
}) {
  const pathname = usePathname();
  if (pathname === '/') return null;
  const snapshot = sourceMode === 'snapshot';
  return (
    <p className="border-b border-deck-line bg-deck-raised px-4 py-2 text-center text-xs leading-relaxed text-mist sm:px-6">
      {snapshot
        ? `The service source on this site was saved when it was built${buildTime ? ` (${buildTime})` : ''}.`
        : 'Quotes on these pages are checked against the service source on this machine.'}
    </p>
  );
}

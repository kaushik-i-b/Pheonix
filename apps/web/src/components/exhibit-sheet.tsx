import type { ReactNode } from 'react';

export function ExhibitSheet({
  header,
  slot,
  children,
}: {
  header?: ReactNode;
  slot?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-[3px] bg-paper text-ink shadow-[0_1px_0_rgba(0,0,0,0.4)]">
      {(header !== undefined || slot !== undefined) && (
        <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-ink/10 px-4 py-2 font-mono text-[11px] tracking-[0.08em] text-ink-soft">
          <span className="min-w-0 truncate">{header}</span>
          {slot !== undefined && <span className="shrink-0">{slot}</span>}
        </header>
      )}
      {children}
    </section>
  );
}

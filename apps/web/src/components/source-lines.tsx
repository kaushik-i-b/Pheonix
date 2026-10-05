import type { ReactNode } from 'react';

export function SourceLines({
  lines,
  startLine,
  endLine,
  context = 4,
}: {
  lines: string[];
  startLine: number;
  endLine: number;
  context?: number;
}) {
  const first = Math.max(1, startLine - context);
  const last = Math.min(lines.length, endLine + context);
  const rows: ReactNode[] = [];

  if (first > 1) {
    rows.push(
      <div key="above" className="flex gap-3 border-l-2 border-transparent px-3 text-ink-soft/70">
        <span className="w-10 shrink-0 text-right select-none">⋯</span>
        <span className="italic">{first - 1} lines above</span>
      </div>,
    );
  }

  for (let n = first; n <= last; n += 1) {
    const inRange = n >= startLine && n <= endLine;
    rows.push(
      <div
        key={n}
        className={`flex gap-3 border-l-2 px-3 ${
          inRange ? 'border-brass bg-brass/10' : 'border-transparent'
        }`}
      >
        <span className="w-10 shrink-0 text-right select-none text-ink-soft/70">{n}</span>
        <span className="whitespace-pre-wrap break-words">{lines[n - 1]}</span>
      </div>,
    );
  }

  if (last < lines.length) {
    rows.push(
      <div key="below" className="flex gap-3 border-l-2 border-transparent px-3 text-ink-soft/70">
        <span className="w-10 shrink-0 text-right select-none">⋯</span>
        <span className="italic">{lines.length - last} lines below</span>
      </div>,
    );
  }

  return <div className="py-2 font-mono text-[12px] leading-[1.7]">{rows}</div>;
}

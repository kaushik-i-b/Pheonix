import type { Workspace } from '../data/repo-root';

export function Footer({ ws }: { ws: Workspace }) {
  const snapshot = ws.sourceMode === 'snapshot';
  return (
    <footer className="border-t border-deck-line bg-deck">
      <div className="mx-auto max-w-6xl space-y-1 px-6 py-4 font-mono text-[11px] leading-relaxed text-mist">
        <p>
          Read-only inspector — it never writes to a run, launches a stage, or alters the record.
        </p>
        <p>
          {snapshot
            ? 'Evidence bytes are a snapshot captured at deploy build time. Pipeline records are reproduced just as the run left them.'
            : 'Evidence bytes are read from the current working tree. Pipeline records are reproduced just as the run left them.'}
        </p>
      </div>
    </footer>
  );
}

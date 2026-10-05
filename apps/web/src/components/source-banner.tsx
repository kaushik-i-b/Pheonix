import type { Workspace } from '../data/repo-root';
import { StampChip } from './stamp-chip';

export function SourceBanner({ ws }: { ws: Workspace }) {
  const snapshot = ws.sourceMode === 'snapshot';
  return (
    <div className="border-b border-deck-line bg-deck-raised">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1 px-6 py-2 font-mono text-[11px] tracking-[0.04em] text-mist">
        <StampChip tone={snapshot ? 'neutral' : 'brass'} surface="deck">
          {snapshot ? 'snapshot' : 'working tree'}
        </StampChip>
        <span>
          {snapshot
            ? `Hosted snapshot — evidence was captured at deploy build time ${
                ws.buildTime ?? 'build time not recorded'
              }; bytes are frozen.`
            : 'Evidence is re-checked against the current working tree as of this page load.'}
        </span>
      </div>
    </div>
  );
}

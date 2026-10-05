import { readLegacySource } from '../data/legacy-source';
import { recheckEvidence } from '../data/recheck';
import type { Workspace } from '../data/repo-root';
import { sanitizeForDisplay } from '../data/sanitize';
import type { Evidence } from '../data/specification';
import { displayCitation, formatAt } from '../lib/format';
import { SourcePanel } from './source-panel';

const labelClass = 'font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase';

export function EvidenceCard({ evidence, ws }: { evidence: Evidence; ws: Workspace }) {
  const source = readLegacySource(ws, evidence.path);
  const recheck = recheckEvidence(ws, evidence, evidence.quote);
  const symbol = evidence.symbol === null ? null : sanitizeForDisplay(evidence.symbol, ws, 120);
  const note = evidence.note === null ? null : sanitizeForDisplay(evidence.note, ws, 600);
  const citation = `${sanitizeForDisplay(displayCitation(evidence.path), ws, 300)} : ${evidence.startLine}–${evidence.endLine}`;
  return (
    <article className="px-4 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="font-mono text-[12px] break-all text-ink">{citation}</span>
        {symbol !== null && <span className="font-mono text-[12px] text-ink-soft">· {symbol}</span>}
      </div>
      <p className="mt-1 font-mono text-[11px] text-ink-soft">
        {sanitizeForDisplay(evidence.kind, ws, 80)} · collected{' '}
        {evidence.collectedAt === null
          ? 'collection time not recorded'
          : formatAt(evidence.collectedAt)}{' '}
        · by{' '}
        {evidence.collectedBy === null
          ? 'collector not recorded'
          : sanitizeForDisplay(evidence.collectedBy, ws, 120)}
      </p>
      <div className="mt-2">
        <span className={labelClass}>recorded quote</span>
        <pre className="mt-1.5 border-l-2 border-ink/25 py-0.5 pl-3 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap break-words text-ink">
          {evidence.quote}
        </pre>
      </div>
      {note !== null && (
        <div className="mt-2">
          <span className={labelClass}>recorded note</span>
          <p className="mt-1 text-[12px] leading-relaxed text-ink-soft">{note}</p>
        </div>
      )}
      <div className="mt-3 border-t border-ink/10 bg-ink/[0.04] p-3">
        <SourcePanel
          path={evidence.path}
          startLine={evidence.startLine}
          endLine={evidence.endLine}
          source={source}
          recheck={recheck}
          quote={evidence.quote}
          ws={ws}
        />
      </div>
    </article>
  );
}

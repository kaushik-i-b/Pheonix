import type { ReactNode } from 'react';
import type { LegacySource } from '../data/legacy-source';
import { splitLines } from '../data/legacy-source';
import type { RecheckResult } from '../data/recheck';
import type { Workspace } from '../data/repo-root';
import { sanitizeForDisplay } from '../data/sanitize';
import { displayCitation, formatAt } from '../lib/format';
import { ExhibitSheet } from './exhibit-sheet';
import { SourceLines } from './source-lines';
import { StampChip } from './stamp-chip';
import type { StampTone } from './stamp-chip';

const labelClass = 'font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase';

export function SourcePanel({
  path,
  startLine,
  endLine,
  source,
  recheck,
  quote,
  ws,
}: {
  path: string;
  startLine: number;
  endLine: number;
  source: LegacySource;
  recheck: RecheckResult;
  quote: string;
  ws: Workspace;
}) {
  const citation = `${sanitizeForDisplay(displayCitation(path), ws, 300)} : ${startLine}–${endLine}`;
  return (
    <ExhibitSheet
      header={<span>{citation}</span>}
      slot={
        <span className="flex items-center gap-2">
          <span className="uppercase">UI re-check</span>
          <StampChip tone={recheckTone(recheck)}>{recheckLabel(recheck)}</StampChip>
        </span>
      }
    >
      <p className="border-b border-ink/10 px-4 py-2 font-mono text-[10px] leading-relaxed text-ink-soft">
        UI-computed re-check — this is not a pipeline-recorded verification result.
      </p>
      {source.ok ? (
        <RecheckBody
          lines={splitLines(source.content)}
          startLine={startLine}
          endLine={endLine}
          quote={quote}
          recheck={recheck}
          ws={ws}
        />
      ) : (
        <Note>{sourceReason(source.reason)}</Note>
      )}
    </ExhibitSheet>
  );
}

function RecheckBody({
  lines,
  startLine,
  endLine,
  quote,
  recheck,
  ws,
}: {
  lines: string[];
  startLine: number;
  endLine: number;
  quote: string;
  recheck: RecheckResult;
  ws: Workspace;
}) {
  if (recheck.state === 'file-missing') {
    return <Note>{sourceReason('missing')}</Note>;
  }
  if (recheck.state === 'out-of-range') {
    return (
      <>
        <Sentence>{`The file has ${recheck.lineCount} lines; the recorded range is beyond the file.`}</Sentence>
        <div className="border-t border-ink/10">
          <Label>actual tail of the file</Label>
          <SourceLines
            lines={lines}
            startLine={recheck.lineCount + 1}
            endLine={recheck.lineCount + 1}
          />
        </div>
      </>
    );
  }
  if (recheck.state === 'relocated') {
    return (
      <>
        <Sentence>{`The quote was not found at the recorded range; it appears at lines ${recheck.foundStart}–${recheck.foundEnd}.`}</Sentence>
        <div className="border-t border-ink/10 pt-2.5">
          <SourceLines lines={lines} startLine={recheck.foundStart} endLine={recheck.foundEnd} />
        </div>
      </>
    );
  }
  if (recheck.state === 'drifted') {
    return (
      <>
        <Sentence>The bytes at this range differ from the recorded quote.</Sentence>
        <p className="px-4 pt-1 font-mono text-[11px] text-[#a05c12]">
          {recheck.firstDiffLine === null
            ? 'the recorded quote is a prefix of this range — the range continues beyond it'
            : `first difference at line ${recheck.firstDiffLine}`}
        </p>
        <div className="mt-3 border-t border-ink/10">
          <Label>recorded quote</Label>
          <div className="px-4 pt-1.5 pb-3">
            <pre className="border-l-2 border-ink/25 py-0.5 pl-3 font-mono text-[12px] leading-[1.7] whitespace-pre-wrap break-words text-ink-soft">
              {quote}
            </pre>
          </div>
        </div>
        <div className="border-t border-ink/10">
          <Label>actual bytes at the recorded range</Label>
          <SourceLines lines={lines} startLine={startLine} endLine={endLine} />
        </div>
      </>
    );
  }
  return (
    <>
      <Sentence>The bytes at this range equal the recorded quote.</Sentence>
      <p className="px-4 pt-1 font-mono text-[11px] text-ink-soft">
        read against {sourceModeLabel(ws)}
      </p>
      <div className="mt-3 border-t border-ink/10 pt-2.5">
        <SourceLines lines={lines} startLine={startLine} endLine={endLine} />
      </div>
    </>
  );
}

function Sentence({ children }: { children: ReactNode }) {
  return <p className="px-4 pt-3 text-sm leading-relaxed text-ink">{children}</p>;
}

function Label({ children }: { children: ReactNode }) {
  return (
    <div className="px-4 pt-2.5">
      <span className={labelClass}>{children}</span>
    </div>
  );
}

function Note({ children }: { children: ReactNode }) {
  return <p className="px-4 py-4 font-mono text-[12px] text-ink-soft">{children}</p>;
}

function sourceReason(reason: 'missing' | 'io-error'): string {
  return reason === 'missing'
    ? 'No file at this path under examples/legacy-bank/.'
    : 'The file exists but could not be read (I/O error).';
}

function sourceModeLabel(ws: Workspace): string {
  return ws.buildTime !== null
    ? `a snapshot taken at ${formatAt(ws.buildTime)}`
    : 'the working tree';
}

function recheckLabel(recheck: RecheckResult): string {
  switch (recheck.state) {
    case 'matched':
      return 'matched';
    case 'drifted':
      return 'drifted';
    case 'relocated':
      return `relocated · ${recheck.foundStart}–${recheck.foundEnd}`;
    case 'file-missing':
      return 'file missing';
    case 'out-of-range':
      return `out of range · file has ${recheck.lineCount} lines`;
  }
}

function recheckTone(recheck: RecheckResult): StampTone {
  switch (recheck.state) {
    case 'matched':
      return 'matched';
    case 'drifted':
      return 'drifted';
    case 'relocated':
      return 'relocated';
    case 'file-missing':
    case 'out-of-range':
      return 'danger';
  }
}

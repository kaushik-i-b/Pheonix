import Link from 'next/link';
import { ExhibitSheet } from '../components/exhibit-sheet';
import { SourceLines } from '../components/source-lines';
import { StampChip } from '../components/stamp-chip';
import type { StampTone } from '../components/stamp-chip';
import { readLegacySource, splitLines } from '../data/legacy-source';
import { recheckEvidence } from '../data/recheck';
import type { RecheckResult } from '../data/recheck';
import { resolveWorkspace } from '../data/repo-root';
import type { Workspace } from '../data/repo-root';
import { assertFeaturedIntact, featuredRun, scanRuns } from '../data/runs';
import type { RunSummary } from '../data/runs';
import { loadSpecification } from '../data/specification';
import type { Evidence } from '../data/specification';
import { countLabel, displayCitation, formatAt, iterationLabel } from '../lib/format';

interface HeroExhibit {
  ruleId: string;
  ruleTitle: string;
  route: string;
  evidence: Evidence;
  recheck: RecheckResult;
  lines: string[] | null;
}

export default function RunsIndexPage() {
  const ws = resolveWorkspace();
  const runs = scanRuns(ws);
  const featured = featuredRun(runs);
  assertFeaturedIntact(featured);
  const exhibit = featured === null ? null : buildHeroExhibit(ws, featured);

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-14 pb-12">
        <p className="font-mono text-[11px] tracking-[0.3em] text-brass">RUN RECORD / EVIDENCE</p>
        <h1 className="mt-4 max-w-3xl text-3xl leading-[1.15] font-medium tracking-tight md:text-[2.5rem]">
          Every claim this pipeline makes is traceable to the bytes it stands on.
        </h1>
        <p className="mt-5 max-w-2xl text-sm leading-relaxed text-mist">
          PHOENIX modernizes a legacy repository through discovery, specification, characterization,
          modernization, and differential verification. This inspector replays the record of each
          run — and re-checks every citation against the real source bytes.
        </p>
        {exhibit !== null && (
          <div className="mt-10">
            <HeroExhibitSheet exhibit={exhibit} />
          </div>
        )}
        {exhibit === null && featured !== null && (
          <p className="mt-10 font-mono text-[11px] tracking-[0.04em] text-mist">
            The latest run records no rule evidence to exhibit.
          </p>
        )}
      </section>
      <section aria-label="Runs" className="mx-auto max-w-6xl px-6 pb-20">
        <ExhibitSheet
          header={<span className="uppercase">Runs</span>}
          slot={<span className="uppercase">{runs.length} recorded</span>}
        >
          {runs.length === 0 ? (
            <p className="px-4 py-6 text-sm text-ink-soft">
              No runs are recorded in this workspace.
            </p>
          ) : (
            <ol className="divide-y divide-ink/10">
              {runs.map((run) => (
                <RunRow key={run.runId} run={run} featured={run.runId === featured?.runId} />
              ))}
            </ol>
          )}
        </ExhibitSheet>
      </section>
    </>
  );
}

function buildHeroExhibit(ws: Workspace, run: RunSummary): HeroExhibit | null {
  const spec = loadSpecification(ws, run.runId);
  const canonical = spec.artifacts.find(
    (artifact) => artifact.variant === 'canonical' && artifact.slug === 'business-rules',
  );
  if (canonical === undefined) return null;
  const rule = canonical.rules[0];
  const evidence = rule?.sourceEvidence[0];
  if (rule === undefined || evidence === undefined) return null;
  const recheck = recheckEvidence(ws, evidence, evidence.quote);
  const source = readLegacySource(ws, evidence.path);
  return {
    ruleId: rule.ruleId,
    ruleTitle: rule.title,
    route: `/runs/${run.runId}/rules/${canonical.slug}/${encodeURIComponent(rule.ruleId)}/`,
    evidence,
    recheck,
    lines: source.ok ? splitLines(source.content) : null,
  };
}

function HeroExhibitSheet({ exhibit }: { exhibit: HeroExhibit }) {
  const { evidence, recheck, lines } = exhibit;
  return (
    <ExhibitSheet
      header={
        <span>
          {displayCitation(evidence.path)} : {evidence.startLine}–{evidence.endLine}
        </span>
      }
      slot={
        <span className="flex items-center gap-2">
          <span className="uppercase">UI re-check</span>
          <StampChip tone={recheckTone(recheck)}>{recheckLabel(recheck)}</StampChip>
        </span>
      }
    >
      {lines !== null ? (
        <SourceLines lines={lines} startLine={evidence.startLine} endLine={evidence.endLine} />
      ) : (
        <p className="px-4 py-4 font-mono text-[12px] text-ink-soft">
          No file at this recorded path under examples/legacy-bank/.
        </p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-ink/10 px-4 py-3">
        <span className="min-w-0 font-mono text-[12px] text-ink-soft">
          claim <span className="text-ink">{exhibit.ruleId}</span> — {exhibit.ruleTitle}
        </span>
        <Link
          href={exhibit.route}
          className="font-mono text-[11px] tracking-[0.08em] text-ink uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-ink"
        >
          Evidence view →
        </Link>
      </div>
    </ExhibitSheet>
  );
}

function RunRow({ run, featured }: { run: RunSummary; featured: boolean }) {
  const verdict = run.latestVerdict;
  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={`/runs/${run.runId}/`}
              className="font-mono text-[13px] text-ink underline-offset-4 hover:underline"
            >
              {run.runId}
            </Link>
            {featured && <StampChip tone="brass">latest</StampChip>}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {run.stages.length === 0 ? (
              <span className="font-mono text-[11px] text-mist">no stages recorded</span>
            ) : (
              run.stages.map((stage) => (
                <StampChip key={stage} tone="neutral">
                  {stage}
                </StampChip>
              ))
            )}
          </div>
        </div>
        <div className="text-right font-mono text-[11px] leading-relaxed text-ink-soft">
          <div className="flex items-center justify-end gap-2">
            {verdict === null ? (
              <StampChip tone="neutral">no verdict</StampChip>
            ) : (
              <>
                <StampChip
                  tone={verdict.verdict === 'EQUIVALENT' ? 'equivalent' : 'not-equivalent'}
                >
                  {verdict.verdict}
                </StampChip>
                <span>
                  {iterationLabel(verdict.iteration)} ·{' '}
                  {countLabel(verdict.mismatchTotal, 'mismatch', 'mismatches')}
                </span>
              </>
            )}
          </div>
          <div className="mt-1">
            {run.artifactCount >= 0
              ? countLabel(run.artifactCount, 'artifact', 'artifacts')
              : 'artifacts —'}{' '}
            · {countLabel(run.eventCount, 'event', 'events')} ·{' '}
            {countLabel(run.taskCount, 'task', 'tasks')}
          </div>
          <div className="mt-1">{formatAt(run.lastEventAt)}</div>
        </div>
      </div>
      {run.problems.length > 0 && (
        <p className="mt-2 font-mono text-[11px] text-ink-soft">
          problems: {run.problems.join(' · ')}
        </p>
      )}
    </li>
  );
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

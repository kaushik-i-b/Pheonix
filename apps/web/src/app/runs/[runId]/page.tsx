import { notFound } from 'next/navigation';
import { ExhibitSheet } from '../../../components/exhibit-sheet';
import {
  ArtifactInventory,
  CharacterizationPanel,
  ImplementationPanel,
  SpecSummary,
  TaskTable,
  VerificationPanel,
} from '../../../components/panels';
import { StampChip } from '../../../components/stamp-chip';
import { Timeline } from '../../../components/timeline';
import { groupArtifacts, loadArtifactIndex } from '../../../data/artifacts';
import type { ArtifactEntry } from '../../../data/artifacts';
import { loadCharacterization } from '../../../data/characterization';
import { groupTimeline, readRunEvents } from '../../../data/events';
import type { RawEvent } from '../../../data/events';
import { loadImplementation } from '../../../data/implementation';
import { resolveWorkspace } from '../../../data/repo-root';
import type { Workspace } from '../../../data/repo-root';
import { featuredRun, scanRuns } from '../../../data/runs';
import { loadSpecification } from '../../../data/specification';
import { loadTaskOutcomes, taskRows } from '../../../data/tasks';
import { loadVerifications } from '../../../data/verification';
import { countLabel, formatAt, iterationLabel } from '../../../lib/format';

type Section<T> = { ok: true; value: T } | { ok: false; error: string };

export function generateStaticParams(): Array<{ runId: string }> {
  return scanRuns(resolveWorkspace()).map((run) => ({ runId: run.runId }));
}

export default async function RunOverviewPage({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = await params;
  const ws = resolveWorkspace();
  const runs = scanRuns(ws);
  const summary = runs.find((run) => run.runId === runId);
  if (summary === undefined) notFound();
  const featured = featuredRun(runs)?.runId === runId;

  const events = readEventsSection(ws, runId, featured);
  const outcomes = loadTaskOutcomes(ws, runId);
  const artifacts = readSection(() => loadArtifactIndex(ws, runId));
  const artifactEntries: ArtifactEntry[] = artifacts.ok ? artifacts.value : [];
  const artifactTaskIds = countArtifactsByTask(artifactEntries);
  const taskRowsList = events.ok ? taskRows(events.value, outcomes, artifactTaskIds) : [];
  const verification = readSection(() => loadVerifications(ws, runId));
  const specification = readSection(() => loadSpecification(ws, runId));
  const characterization = readSection(() => loadCharacterization(ws, runId));
  const implementation = readSection(() => loadImplementation(ws, runId));

  const verdict = summary.latestVerdict;

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-12 pb-8">
        <p className="font-mono text-[11px] tracking-[0.3em] text-brass">RUN RECORD</p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <h1 className="font-mono text-xl leading-tight break-all md:text-2xl">{summary.runId}</h1>
          {featured && <StampChip tone="brass">latest</StampChip>}
          {verdict !== null && (
            <>
              <StampChip tone={verdict.verdict === 'EQUIVALENT' ? 'equivalent' : 'not-equivalent'}>
                {verdict.verdict}
              </StampChip>
              <span className="font-mono text-[11px] text-mist">
                {iterationLabel(verdict.iteration)} ·{' '}
                {countLabel(verdict.mismatchTotal, 'mismatch', 'mismatches')}
              </span>
            </>
          )}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-mist">
          <span>{countLabel(summary.eventCount, 'event', 'events')}</span>
          <span aria-hidden>·</span>
          <span>
            {summary.artifactCount >= 0
              ? countLabel(summary.artifactCount, 'artifact', 'artifacts')
              : 'artifacts —'}
          </span>
          <span aria-hidden>·</span>
          <span>{countLabel(summary.taskCount, 'task', 'tasks')}</span>
          <span aria-hidden>·</span>
          <span>{countLabel(summary.writerSessions, 'writer session', 'writer sessions')}</span>
        </div>
        <p className="mt-2 font-mono text-[11px] text-mist">
          first event {formatAt(summary.firstEventAt)} · last event {formatAt(summary.lastEventAt)}
        </p>
        {summary.stages.length > 0 && (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {summary.stages.map((stage) => (
              <StampChip key={stage} tone="neutral">
                {stage}
              </StampChip>
            ))}
          </div>
        )}
        {summary.problems.length > 0 && (
          <p className="mt-3 font-mono text-[11px] text-mist">
            problems: {summary.problems.join(' · ')}
          </p>
        )}
      </section>
      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-20">
        <ExhibitSheet
          header={<span className="uppercase">Timeline</span>}
          slot={
            <span className="uppercase">
              {countLabel(summary.eventCount, 'event', 'events')} · append order
            </span>
          }
        >
          {events.ok ? (
            <Timeline groups={groupTimeline(events.value, ws)} />
          ) : (
            <SectionError problem={events.error} />
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span className="uppercase">Verification</span>}
          slot={
            verification.ok ? (
              <span className="uppercase">
                {countLabel(verification.value.iterations.length, 'iteration', 'iterations')}
              </span>
            ) : undefined
          }
        >
          {verification.ok ? (
            <VerificationPanel view={verification.value} />
          ) : (
            <SectionError problem={verification.error} />
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span className="uppercase">Tasks</span>}
          slot={
            events.ok ? (
              <span className="uppercase">{countLabel(taskRowsList.length, 'task', 'tasks')}</span>
            ) : undefined
          }
        >
          {events.ok ? <TaskTable rows={taskRowsList} /> : <SectionError problem={events.error} />}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span className="uppercase">Artifacts</span>}
          slot={
            artifacts.ok ? (
              <span className="uppercase">
                {countLabel(artifactEntries.length, 'entry', 'entries')}
              </span>
            ) : undefined
          }
        >
          {artifacts.ok ? (
            <ArtifactInventory groups={groupArtifacts(artifactEntries)} outcomes={outcomes} />
          ) : (
            <SectionError problem={artifacts.error} />
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span className="uppercase">Specification</span>}
          slot={
            specification.ok ? (
              <span className="uppercase">
                {countLabel(specification.value.artifacts.length, 'artifact', 'artifacts')}
              </span>
            ) : undefined
          }
        >
          {specification.ok ? (
            <SpecSummary
              artifacts={specification.value.artifacts}
              outcomes={outcomes}
              runId={runId}
              problems={specification.value.problems}
            />
          ) : (
            <SectionError problem={specification.error} />
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span className="uppercase">Characterization</span>}
          slot={
            characterization.ok ? (
              <span className="uppercase">
                {countLabel(characterization.value.suites.length, 'suite', 'suites')}
              </span>
            ) : undefined
          }
        >
          {characterization.ok ? (
            <CharacterizationPanel view={characterization.value} />
          ) : (
            <SectionError problem={characterization.error} />
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span className="uppercase">Implementation</span>}
          slot={
            implementation.ok ? (
              <span className="uppercase">
                {countLabel(implementation.value.reports.length, 'report', 'reports')}
              </span>
            ) : undefined
          }
        >
          {implementation.ok ? (
            <ImplementationPanel view={implementation.value} />
          ) : (
            <SectionError problem={implementation.error} />
          )}
        </ExhibitSheet>
      </section>
    </>
  );
}

function readEventsSection(ws: Workspace, runId: string, required: boolean): Section<RawEvent[]> {
  try {
    return { ok: true, value: readRunEvents(ws, runId) };
  } catch (error) {
    if (required) throw error;
    return { ok: false, error: message(error) };
  }
}

function readSection<T>(load: () => T): Section<T> {
  try {
    return { ok: true, value: load() };
  } catch (error) {
    return { ok: false, error: message(error) };
  }
}

function countArtifactsByTask(entries: ArtifactEntry[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of entries) {
    if (entry.taskId === null) continue;
    counts.set(entry.taskId, (counts.get(entry.taskId) ?? 0) + 1);
  }
  return counts;
}

function SectionError({ problem }: { problem: string }) {
  return (
    <p className="px-4 py-6 font-mono text-[12px] text-ink-soft">
      This section could not be read: {problem}
    </p>
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import Link from 'next/link';
import type { ReactNode } from 'react';
import type { ArtifactEntry, ArtifactGroup, Variant } from '../data/artifacts';
import type { CaseView, CharacterizationView } from '../data/characterization';
import type { ChangeFile, ImplementationView } from '../data/implementation';
import type { SpecArtifact } from '../data/specification';
import type { TaskOutcome, TaskRow, TaskStatus } from '../data/tasks';
import type {
  ComparisonView,
  IterationView,
  VerdictCheck,
  VerificationView,
} from '../data/verification';
import { countLabel, formatAt, iterationLabel, shaPrefix, shortTaskId } from '../lib/format';
import { StampChip } from './stamp-chip';
import type { StampTone } from './stamp-chip';

const taskStatusTones: Record<TaskStatus, StampTone> = {
  SUCCEEDED: 'matched',
  PARTIAL: 'drifted',
  FAILED: 'danger',
  UNKNOWN: 'neutral',
};

export function VerdictStamp({
  verdict,
  mismatchTotal,
}: {
  verdict: string | null;
  mismatchTotal: number | null;
}) {
  if (verdict === null) {
    return <StampChip tone="neutral">no verdict</StampChip>;
  }
  return (
    <span className="flex items-center gap-2">
      <StampChip tone={verdictTone(verdict)}>{verdict}</StampChip>
      {mismatchTotal !== null && (
        <span className="font-mono text-[11px] text-ink-soft">
          {countLabel(mismatchTotal, 'mismatch', 'mismatches')}
        </span>
      )}
    </span>
  );
}

export function VerificationPanel({ view }: { view: VerificationView }) {
  if (view.iterations.length === 0) {
    return (
      <>
        <EmptyNote>No verification iterations are recorded in this run.</EmptyNote>
        <ProblemLines problems={view.problems} />
      </>
    );
  }
  return (
    <div>
      <div className="border-b border-ink/10 px-4 py-3">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-2">
          {view.iterations.map((iteration, index) => (
            <li
              key={`${iteration.iteration}-${iteration.variant}-${index}`}
              className="flex items-center gap-2"
            >
              {index > 0 && (
                <span aria-hidden className="font-mono text-[11px] text-ink-soft">
                  →
                </span>
              )}
              <IterationStamp iteration={iteration} />
            </li>
          ))}
        </ol>
      </div>
      <ol className="divide-y divide-ink/10">
        {view.iterations.map((iteration, index) => (
          <li key={`${iteration.iteration}-${iteration.variant}-${index}`}>
            <IterationBlock iteration={iteration} />
          </li>
        ))}
      </ol>
      <ProblemLines problems={view.problems} />
    </div>
  );
}

export function TaskTable({ rows }: { rows: TaskRow[] }) {
  if (rows.length === 0) {
    return <EmptyNote>No agent tasks are recorded in this run.</EmptyNote>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/10 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="px-4 py-2 font-normal">Task</th>
            <th className="px-4 py-2 font-normal">Role</th>
            <th className="px-4 py-2 font-normal">Stage</th>
            <th className="px-4 py-2 font-normal">Status</th>
            <th className="px-4 py-2 font-normal">Started</th>
            <th className="px-4 py-2 font-normal">Finished</th>
            <th className="px-4 py-2 font-normal">Artifacts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.taskId} className="border-b border-ink/5 align-top">
              <td className="px-4 py-2 font-mono text-[11px] break-all text-ink">{row.taskId}</td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">{row.role ?? '—'}</td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">{row.stage ?? '—'}</td>
              <td className="px-4 py-2">
                <StampChip tone={taskStatusTones[row.status]}>{row.status}</StampChip>
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">
                {atCell(row.startedAt)}
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">
                {atCell(row.finishedAt)}
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">{row.artifactCount}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ArtifactInventory({
  groups,
  outcomes,
}: {
  groups: ArtifactGroup[];
  outcomes: Map<string, TaskOutcome>;
}) {
  if (groups.length === 0) {
    return <EmptyNote>No artifacts are recorded in this run.</EmptyNote>;
  }
  return (
    <div>
      {groups.map((group) => (
        <section key={group.kind} className="border-t border-ink/10 first:border-t-0">
          <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-ink/[0.03] px-4 py-2">
            <h3 className="font-mono text-[11px] tracking-[0.08em] text-ink uppercase">
              {group.kind}
            </h3>
            <span className="font-mono text-[10px] text-ink-soft">
              {countLabel(group.entries.length, 'entry', 'entries')}
            </span>
          </header>
          <ol className="divide-y divide-ink/5">
            {group.entries.map((entry) => (
              <ArtifactRow key={entry.id} entry={entry} outcomes={outcomes} />
            ))}
          </ol>
        </section>
      ))}
    </div>
  );
}

export function SpecSummary({
  artifacts,
  outcomes,
  runId,
  problems,
}: {
  artifacts: SpecArtifact[];
  outcomes: Map<string, TaskOutcome>;
  runId: string;
  problems: string[];
}) {
  return (
    <div>
      {artifacts.length === 0 ? (
        <EmptyNote>No specification artifacts are recorded in this run.</EmptyNote>
      ) : (
        <ol className="divide-y divide-ink/10">
          {artifacts.map((artifact) => {
            const outcome = artifact.taskId === null ? undefined : outcomes.get(artifact.taskId);
            return (
              <li key={`${artifact.variant}-${artifact.slug}`} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-mono text-[12px] text-ink">{artifact.slug}</span>
                  <StampChip tone={variantTone(artifact.variant)}>{artifact.variant}</StampChip>
                  {artifact.taskId !== null && (
                    <span className="font-mono text-[10px] text-ink-soft">
                      {shortTaskId(artifact.taskId)}
                    </span>
                  )}
                  {outcome !== undefined && (
                    <StampChip tone={taskStatusTones[outcome.status]}>{outcome.status}</StampChip>
                  )}
                  <Link
                    href={`/runs/${runId}/specification/`}
                    className="ml-auto font-mono text-[11px] tracking-[0.08em] text-ink uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-ink"
                  >
                    Specification →
                  </Link>
                </div>
                <dl className="mt-1.5 flex flex-wrap gap-x-5 gap-y-1">
                  <Metric label="rules" value={artifact.ruleCount} />
                  <Metric label="invariants" value={artifact.invariantCount} />
                  <Metric label="unknowns" value={artifact.unknownCount} />
                </dl>
              </li>
            );
          })}
        </ol>
      )}
      <ProblemLines problems={problems} />
    </div>
  );
}

export function CharacterizationPanel({ view }: { view: CharacterizationView }) {
  return (
    <div>
      {view.suites.length === 0 ? (
        <EmptyNote>No characterization suites are recorded in this run.</EmptyNote>
      ) : (
        view.suites.map((suite) => (
          <section key={suite.slug} className="border-t border-ink/10 first:border-t-0">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-ink/[0.03] px-4 py-2">
              <h3 className="font-mono text-[11px] tracking-[0.08em] text-ink uppercase">
                {suite.slug}
              </h3>
              <StampChip tone={variantTone(suite.variant)}>{suite.variant}</StampChip>
              {suite.taskId !== null && (
                <span className="font-mono text-[10px] text-ink-soft">
                  {shortTaskId(suite.taskId)}
                </span>
              )}
              {suite.statistics !== null && (
                <span className="ml-auto font-mono text-[10px] text-ink-soft">
                  {countLabel(suite.statistics.total, 'case', 'cases')} ·{' '}
                  {suite.statistics.captured} captured · {suite.statistics.assertions} assertions ·{' '}
                  {suite.statistics.recordingLegacyDefects} recording legacy defects
                </span>
              )}
            </header>
            {suite.cases.length === 0 ? (
              <p className="px-4 py-3 text-sm text-ink-soft">This suite records no cases.</p>
            ) : (
              <CaseTable cases={suite.cases} />
            )}
          </section>
        ))
      )}
      <ProblemLines problems={view.problems} />
    </div>
  );
}

export function ImplementationPanel({ view }: { view: ImplementationView }) {
  return (
    <div>
      {view.reports.length === 0 ? (
        <EmptyNote>No change reports are recorded in this run.</EmptyNote>
      ) : (
        view.reports.map((report) => (
          <section key={report.slug} className="border-t border-ink/10 first:border-t-0">
            <header className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-ink/[0.03] px-4 py-2">
              <h3 className="font-mono text-[11px] tracking-[0.08em] text-ink uppercase">
                {report.slug}
              </h3>
              <StampChip tone={variantTone(report.variant)}>{report.variant}</StampChip>
              <span className="font-mono text-[10px] text-ink-soft">
                {iterationLabel(report.iteration)}
              </span>
              {report.taskId !== null && (
                <span className="font-mono text-[10px] text-ink-soft">
                  {shortTaskId(report.taskId)}
                </span>
              )}
              {report.generatedAt !== null && (
                <span className="ml-auto font-mono text-[10px] text-ink-soft">
                  {formatAt(report.generatedAt)}
                  {report.generatedBy !== null ? ` · ${report.generatedBy}` : ''}
                </span>
              )}
            </header>
            <div className="px-4 py-3">
              {report.summary !== null && (
                <p className="text-sm leading-relaxed text-ink">{report.summary}</p>
              )}
              {(report.entryPoint !== null || report.resetPath !== null) && (
                <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
                  {report.entryPoint !== null && (
                    <div className="flex items-baseline gap-2">
                      <dt className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
                        entry point
                      </dt>
                      <dd className="font-mono text-[11px] break-all text-ink">
                        {report.entryPoint}
                      </dd>
                    </div>
                  )}
                  {report.resetPath !== null && (
                    <div className="flex items-baseline gap-2">
                      <dt className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
                        reset path
                      </dt>
                      <dd className="font-mono text-[11px] break-all text-ink">
                        {report.resetPath}
                      </dd>
                    </div>
                  )}
                </dl>
              )}
              {(report.ruleIdsImplemented.length > 0 ||
                report.invariantIdsAddressed.length > 0) && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {report.ruleIdsImplemented.map((id) => (
                    <StampChip key={id} tone="neutral">
                      {id}
                    </StampChip>
                  ))}
                  {report.invariantIdsAddressed.map((id) => (
                    <StampChip key={id} tone="brass">
                      {id}
                    </StampChip>
                  ))}
                </div>
              )}
              {report.files.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">This report records no changed files.</p>
              ) : (
                <FileTable files={report.files} />
              )}
            </div>
          </section>
        ))
      )}
      <ProblemLines problems={view.problems} />
    </div>
  );
}

function IterationStamp({ iteration }: { iteration: IterationView }) {
  const verdict = iteration.verdict;
  return (
    <span className="flex items-center gap-2">
      <span className="font-mono text-[11px] font-medium text-ink">
        {iterationLabel(iteration.iteration)}
      </span>
      <VerdictStamp
        verdict={verdict?.verdict ?? null}
        mismatchTotal={verdict?.mismatchSummary?.total ?? null}
      />
      {verdict !== null && verdict.variant === 'attempt' && (
        <span className="font-mono text-[10px] text-ink-soft">
          (attempt{verdict.taskId === null ? '' : ` ${shortTaskId(verdict.taskId)}`})
        </span>
      )}
    </span>
  );
}

function IterationBlock({ iteration }: { iteration: IterationView }) {
  const verdict = iteration.verdict;
  const report = iteration.report;
  return (
    <div className="px-4 py-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="font-mono text-[12px] tracking-[0.08em] text-ink uppercase">
          {iterationLabel(iteration.iteration)}
        </h3>
        <StampChip tone={variantTone(iteration.variant)}>{iteration.variant}</StampChip>
        {verdict !== null && verdict.computedAt !== null && (
          <span className="font-mono text-[11px] text-ink-soft">
            {formatAt(verdict.computedAt)}
          </span>
        )}
        {verdict !== null && verdict.variant === 'attempt' && verdict.taskId !== null && (
          <span className="font-mono text-[11px] text-ink-soft">
            attempt {shortTaskId(verdict.taskId)}
          </span>
        )}
      </div>
      {verdict === null ? (
        <p className="mt-3 text-sm text-ink-soft">
          A differential report is recorded for this iteration; no verdict is recorded.
        </p>
      ) : (
        <>
          {verdict.mismatchSummary !== null && (
            <p className="mt-2 font-mono text-[11px] text-ink-soft">
              {countLabel(verdict.mismatchSummary.total, 'mismatch', 'mismatches')} ·{' '}
              {verdict.mismatchSummary.unexplained} unexplained ·{' '}
              {verdict.mismatchSummary.unresolved} unresolved
              {verdict.mismatchSummary.highestSeverity !== null
                ? ` · highest severity ${verdict.mismatchSummary.highestSeverity}`
                : ''}
            </p>
          )}
          {verdict.reasons.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm leading-relaxed text-ink-soft">
              {verdict.reasons.map((reason, index) => (
                <li key={index}>{reason}</li>
              ))}
            </ul>
          )}
          {verdict.checks.length > 0 && <ChecksTable checks={verdict.checks} />}
        </>
      )}
      {report !== null && (
        <>
          {report.comparisons.length > 0 ? (
            <ComparisonTable comparisons={report.comparisons} />
          ) : (
            <p className="mt-3 font-mono text-[11px] text-ink-soft">
              The report records no scenario comparisons.
            </p>
          )}
          <StatisticsLine statistics={report.statistics} />
          {report.generatedAt !== null && (
            <p className="mt-2 font-mono text-[10px] text-ink-soft">
              report generated {formatAt(report.generatedAt)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

function ChecksTable({ checks }: { checks: VerdictCheck[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/10 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="py-1.5 pr-4 font-normal">Check</th>
            <th className="py-1.5 pr-4 font-normal">Kind</th>
            <th className="py-1.5 pr-4 font-normal">Status</th>
            <th className="py-1.5 pr-4 font-normal">Observed</th>
            <th className="py-1.5 font-normal">Threshold</th>
          </tr>
        </thead>
        <tbody>
          {checks.map((check, index) => (
            <tr key={index} className="border-b border-ink/5 align-top">
              <td className="py-2 pr-4 font-mono text-[11px] break-all text-ink">
                {check.checkId}
                {check.required === true ? ' *' : ''}
              </td>
              <td className="py-2 pr-4 font-mono text-[11px] text-ink-soft">{check.kind}</td>
              <td className="py-2 pr-4">
                <StampChip tone={checkTone(check.status)}>{check.status}</StampChip>
              </td>
              <td className="py-2 pr-4 font-mono text-[11px] break-all text-ink-soft">
                {check.observed}
              </td>
              <td className="py-2 font-mono text-[11px] break-all text-ink-soft">
                {check.threshold ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ComparisonTable({ comparisons }: { comparisons: ComparisonView[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/10 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="py-1.5 pr-4 font-normal">Scenario</th>
            <th className="py-1.5 pr-4 font-normal">Category</th>
            <th className="py-1.5 pr-4 font-normal">Outcome</th>
            <th className="py-1.5 pr-4 font-normal">Result</th>
            <th className="py-1.5 font-normal">Duration</th>
          </tr>
        </thead>
        <tbody>
          {comparisons.map((comparison, index) => (
            <tr key={index} className="border-b border-ink/5 align-top">
              <td className="py-2 pr-4">
                <div className="text-[12px] text-ink">{comparison.scenarioTitle}</div>
                <div className="font-mono text-[10px] break-all text-ink-soft">
                  {comparison.scenarioId}
                </div>
              </td>
              <td className="py-2 pr-4 font-mono text-[11px] text-ink-soft">
                {comparison.category}
              </td>
              <td className="py-2 pr-4 font-mono text-[11px] text-ink-soft">
                {comparison.outcome}
              </td>
              <td className="py-2 pr-4">
                {comparison.equal === null ? (
                  <StampChip tone="neutral">not recorded</StampChip>
                ) : comparison.equal ? (
                  <StampChip tone="matched">equal</StampChip>
                ) : (
                  <StampChip tone="danger">diverged</StampChip>
                )}
              </td>
              <td className="py-2 font-mono text-[11px] text-ink-soft">
                {comparison.durationMs === null ? '—' : `${comparison.durationMs} ms`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatisticsLine({ statistics }: { statistics: Record<string, unknown> | null }) {
  if (statistics === null) return null;
  const entries = Object.entries(statistics).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
  );
  if (entries.length === 0) return null;
  return (
    <dl className="mt-3 flex flex-wrap gap-x-5 gap-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2">
          <dt className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">{key}</dt>
          <dd className="font-mono text-[11px] text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function CaseTable({ cases }: { cases: CaseView[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/5 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="px-4 py-1.5 font-normal">Case</th>
            <th className="px-4 py-1.5 font-normal">Category</th>
            <th className="px-4 py-1.5 font-normal">Status</th>
            <th className="px-4 py-1.5 font-normal">Legacy defect</th>
          </tr>
        </thead>
        <tbody>
          {cases.map((item) => (
            <tr key={item.caseId} className="border-b border-ink/5 align-top">
              <td className="px-4 py-2">
                <div className="text-[12px] text-ink">{item.title}</div>
                <div className="font-mono text-[10px] break-all text-ink-soft">{item.caseId}</div>
                {item.unexplainedVolatility.length > 0 && (
                  <div className="mt-1 font-mono text-[10px] text-ink-soft">
                    unexplained volatility: {item.unexplainedVolatility.join(', ')}
                  </div>
                )}
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">{item.category}</td>
              <td className="px-4 py-2">
                <StampChip tone={caseStatusTone(item.status)}>{item.status}</StampChip>
                {(item.targetRuleIds.length > 0 || item.targetInvariantIds.length > 0) && (
                  <div className="mt-1 font-mono text-[10px] text-ink-soft">
                    targets {[...item.targetRuleIds, ...item.targetInvariantIds].join(', ')}
                  </div>
                )}
              </td>
              <td className="px-4 py-2">
                {item.recordsLegacyDefect === null ? (
                  <span className="font-mono text-[11px] text-ink-soft">—</span>
                ) : (
                  <StampChip tone={item.recordsLegacyDefect ? 'drifted' : 'neutral'}>
                    {item.recordsLegacyDefect ? 'yes' : 'no'}
                  </StampChip>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FileTable({ files }: { files: ChangeFile[] }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[640px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/10 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="py-1.5 pr-4 font-normal">File</th>
            <th className="py-1.5 pr-4 font-normal">Description</th>
            <th className="py-1.5 pr-4 font-normal">Bytes</th>
            <th className="py-1.5 font-normal">sha</th>
          </tr>
        </thead>
        <tbody>
          {files.map((file, index) => (
            <tr key={index} className="border-b border-ink/5 align-top">
              <td className="py-2 pr-4 font-mono text-[11px] break-all text-ink">{file.path}</td>
              <td className="py-2 pr-4 text-[12px] text-ink-soft">{file.description}</td>
              <td className="py-2 pr-4 font-mono text-[11px] text-ink-soft">
                {file.bytes === null ? '—' : String(file.bytes)}
              </td>
              <td className="py-2 font-mono text-[11px] text-ink-soft">{shaPrefix(file.sha256)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactRow({
  entry,
  outcomes,
}: {
  entry: ArtifactEntry;
  outcomes: Map<string, TaskOutcome>;
}) {
  const outcome = entry.taskId === null ? undefined : outcomes.get(entry.taskId);
  return (
    <li className="px-4 py-2.5">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-mono text-[11px] break-all text-ink">{entry.relativePath}</span>
        <StampChip tone={variantTone(entry.variant)}>{entry.variant}</StampChip>
        {entry.role !== null && (
          <span className="font-mono text-[10px] text-ink-soft">{entry.role}</span>
        )}
        {entry.taskId !== null && (
          <span className="font-mono text-[10px] text-ink-soft">{shortTaskId(entry.taskId)}</span>
        )}
        {entry.taskId !== null && (
          <StampChip tone={taskStatusTones[outcome?.status ?? 'UNKNOWN']}>
            {outcome?.status ?? 'UNKNOWN'}
          </StampChip>
        )}
        <span className="ml-auto font-mono text-[10px] text-ink-soft">
          {countLabel(entry.bytes, 'byte', 'bytes')} · sha {shaPrefix(entry.sha256)}
        </span>
      </div>
      {entry.title !== null && <p className="mt-1 text-[12px] text-ink-soft">{entry.title}</p>}
    </li>
  );
}

function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">{label}</dt>
      <dd className="font-mono text-[11px] text-ink">{value}</dd>
    </div>
  );
}

function ProblemLines({ problems }: { problems: string[] }) {
  if (problems.length === 0) return null;
  return (
    <ul className="border-t border-ink/10 px-4 py-2">
      {problems.map((problem, index) => (
        <li key={index} className="font-mono text-[11px] leading-relaxed text-ink-soft">
          problem: {problem}
        </li>
      ))}
    </ul>
  );
}

function EmptyNote({ children }: { children: ReactNode }) {
  return <p className="px-4 py-6 text-sm text-ink-soft">{children}</p>;
}

function verdictTone(verdict: string): StampTone {
  if (verdict === 'EQUIVALENT') return 'equivalent';
  if (verdict === 'NOT_EQUIVALENT') return 'not-equivalent';
  return 'neutral';
}

function checkTone(status: string): StampTone {
  if (status === 'PASS') return 'matched';
  if (status === 'FAIL') return 'danger';
  return 'neutral';
}

function caseStatusTone(status: string): StampTone {
  return status === 'passing-against-legacy' ? 'matched' : 'neutral';
}

function variantTone(variant: Variant): StampTone {
  return variant === 'canonical' ? 'neutral' : 'brass';
}

function atCell(at: string | null): string {
  return at === null ? '—' : formatAt(at);
}

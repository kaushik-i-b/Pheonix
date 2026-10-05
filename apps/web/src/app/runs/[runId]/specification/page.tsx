import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';
import { ExhibitSheet } from '../../../../components/exhibit-sheet';
import { StampChip } from '../../../../components/stamp-chip';
import type { StampTone } from '../../../../components/stamp-chip';
import { resolveWorkspace } from '../../../../data/repo-root';
import type { Workspace } from '../../../../data/repo-root';
import { scanRuns } from '../../../../data/runs';
import { loadSpecification } from '../../../../data/specification';
import type { Invariant, Rule, SpecArtifact, SpecUnknown } from '../../../../data/specification';
import { loadTaskOutcomes } from '../../../../data/tasks';
import type { TaskOutcome } from '../../../../data/tasks';
import { countLabel, shortTaskId } from '../../../../lib/format';

type LoadedSpecification =
  | {
      ok: true;
      artifacts: SpecArtifact[];
      ruleIndex: Map<string, { slug: string; rule: Rule }>;
      problems: string[];
    }
  | { ok: false; error: string };

export function generateStaticParams(): Array<{ runId: string }> {
  return scanRuns(resolveWorkspace()).map((run) => ({ runId: run.runId }));
}

export default async function SpecificationPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  const ws = resolveWorkspace();
  const summary = scanRuns(ws).find((run) => run.runId === runId);
  if (summary === undefined) notFound();

  const loaded = readSpecification(ws, runId);
  const artifacts = loaded.ok ? loaded.artifacts : [];
  const problems = loaded.ok ? loaded.problems : [loaded.error];
  const outcomes = loadTaskOutcomes(ws, runId);

  const ruleCount = artifacts.reduce((total, artifact) => total + artifact.rules.length, 0);
  const invariantCount = artifacts.reduce(
    (total, artifact) => total + artifact.invariants.length,
    0,
  );
  const unknownCount = artifacts.reduce((total, artifact) => total + artifact.unknowns.length, 0);

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-12 pb-8">
        <p className="font-mono text-[11px] tracking-[0.3em] text-brass">
          RUN RECORD / SPECIFICATION
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-mono text-xl leading-tight break-all md:text-2xl">{runId}</h1>
          <Link
            href={`/runs/${runId}/`}
            className="font-mono text-[11px] tracking-[0.08em] text-mist uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:text-deck-text"
          >
            ← Run overview
          </Link>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-mist">
          <span>{countLabel(artifacts.length, 'artifact', 'artifacts')}</span>
          <span aria-hidden>·</span>
          <span>{countLabel(ruleCount, 'rule', 'rules')}</span>
          <span aria-hidden>·</span>
          <span>{countLabel(invariantCount, 'invariant', 'invariants')}</span>
          <span aria-hidden>·</span>
          <span>{countLabel(unknownCount, 'unknown', 'unknowns')}</span>
        </div>
      </section>
      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-20">
        {!loaded.ok ? (
          <ExhibitSheet>
            <p className="px-4 py-6 font-mono text-[12px] text-ink-soft">
              This section could not be read: {loaded.error}
            </p>
          </ExhibitSheet>
        ) : artifacts.length === 0 ? (
          <ExhibitSheet>
            <p className="px-4 py-6 text-sm text-ink-soft">
              No specification artifacts are recorded in this run.
            </p>
          </ExhibitSheet>
        ) : (
          artifacts.map((artifact) => (
            <ArtifactSheet
              key={`${artifact.variant}-${artifact.slug}`}
              artifact={artifact}
              outcomes={outcomes}
              runId={runId}
              ruleIndex={loaded.ruleIndex}
            />
          ))
        )}
        {problems.length > 0 && (
          <ul className="space-y-1">
            {problems.map((problem, index) => (
              <li key={index} className="font-mono text-[11px] leading-relaxed text-mist">
                problem: {problem}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

function ArtifactSheet({
  artifact,
  outcomes,
  runId,
  ruleIndex,
}: {
  artifact: SpecArtifact;
  outcomes: Map<string, TaskOutcome>;
  runId: string;
  ruleIndex: Map<string, { slug: string; rule: Rule }>;
}) {
  const outcome = artifact.taskId === null ? undefined : outcomes.get(artifact.taskId);
  return (
    <ExhibitSheet
      header={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {artifact.variant === 'canonical' ? (
            <>
              <span className="text-ink">{artifact.slug}</span>
              <StampChip tone="neutral">canonical</StampChip>
            </>
          ) : (
            <span className="text-ink">
              attempt — task {shortTaskId(artifact.taskId)} (
              {outcome?.status ?? 'outcome not recorded'})
            </span>
          )}
        </span>
      }
      slot={
        <span className="uppercase">
          {countLabel(artifact.rules.length, 'rule', 'rules')} ·{' '}
          {countLabel(artifact.invariants.length, 'invariant', 'invariants')} ·{' '}
          {countLabel(artifact.unknowns.length, 'unknown', 'unknowns')}
        </span>
      }
    >
      {artifact.statistics !== null && (
        <div className="border-b border-ink/10 px-4 py-2.5">
          <StatisticsLine statistics={artifact.statistics} />
        </div>
      )}
      <div className="divide-y divide-ink/10">
        <SpecSection title="Rules" slot={countLabel(artifact.rules.length, 'rule', 'rules')}>
          {artifact.rules.length === 0 ? (
            <ZeroNote />
          ) : (
            <RulesTable rules={artifact.rules} runId={runId} artifactSlug={artifact.slug} />
          )}
        </SpecSection>
        <SpecSection
          title="Invariants"
          slot={countLabel(artifact.invariants.length, 'invariant', 'invariants')}
        >
          {artifact.invariants.length === 0 ? (
            <ZeroNote />
          ) : (
            <InvariantList invariants={artifact.invariants} runId={runId} ruleIndex={ruleIndex} />
          )}
        </SpecSection>
        <SpecSection
          title="Unknowns"
          slot={countLabel(artifact.unknowns.length, 'unknown', 'unknowns')}
        >
          {artifact.unknowns.length === 0 ? (
            <ZeroNote />
          ) : (
            <UnknownsTable unknowns={artifact.unknowns} runId={runId} ruleIndex={ruleIndex} />
          )}
        </SpecSection>
      </div>
    </ExhibitSheet>
  );
}

function SpecSection({
  title,
  slot,
  children,
}: {
  title: string;
  slot: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 bg-ink/[0.03] px-4 py-2">
        <h3 className="font-mono text-[11px] tracking-[0.08em] text-ink uppercase">{title}</h3>
        <span className="font-mono text-[10px] text-ink-soft">{slot}</span>
      </header>
      {children}
    </section>
  );
}

function RulesTable({
  rules,
  runId,
  artifactSlug,
}: {
  rules: Rule[];
  runId: string;
  artifactSlug: string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[760px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/5 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="px-4 py-1.5 font-normal">Rule</th>
            <th className="px-4 py-1.5 font-normal">Title</th>
            <th className="px-4 py-1.5 font-normal">Kind</th>
            <th className="px-4 py-1.5 font-normal">Epistemic</th>
            <th className="px-4 py-1.5 font-normal">Lifecycle</th>
            <th className="px-4 py-1.5 font-normal">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {rules.map((rule) => (
            <tr key={rule.ruleId} className="border-b border-ink/5 align-top">
              <td className="px-4 py-2">
                <Link
                  href={`/runs/${runId}/rules/${artifactSlug}/${encodeURIComponent(rule.ruleId)}/`}
                  className="font-mono text-[11px] break-all text-ink underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-ink"
                >
                  {rule.ruleId}
                </Link>
              </td>
              <td className="px-4 py-2 text-[12px] text-ink">{rule.title}</td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">{rule.kind ?? '—'}</td>
              <td className="px-4 py-2">
                {rule.epistemicStatus === null ? (
                  <span className="font-mono text-[11px] text-ink-soft">—</span>
                ) : (
                  <StampChip tone={epistemicTone(rule.epistemicStatus)}>
                    {rule.epistemicStatus}
                  </StampChip>
                )}
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">
                {rule.lifecycleStatus ?? '—'}
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">
                {rule.confidence === null ? '—' : String(rule.confidence)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InvariantList({
  invariants,
  runId,
  ruleIndex,
}: {
  invariants: Invariant[];
  runId: string;
  ruleIndex: Map<string, { slug: string; rule: Rule }>;
}) {
  return (
    <ol className="divide-y divide-ink/5">
      {invariants.map((invariant) => (
        <li key={invariant.invariantId} className="px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="font-mono text-[12px] text-ink">{invariant.invariantId}</span>
            {invariant.criticality !== null && (
              <StampChip tone={criticalityTone(invariant.criticality)}>
                {invariant.criticality}
              </StampChip>
            )}
            {invariant.epistemicStatus !== null && (
              <StampChip tone={epistemicTone(invariant.epistemicStatus)}>
                {invariant.epistemicStatus}
              </StampChip>
            )}
          </div>
          <p className="mt-1.5 text-sm leading-relaxed text-ink">{invariant.statement}</p>
          <p className="mt-1.5 font-mono text-[11px] text-ink-soft">
            checking strategy: {invariant.checkingStrategy.kind ?? '—'} ·{' '}
            {automationLabel(invariant.checkingStrategy.automated)}
          </p>
          {invariant.examples.length > 0 && (
            <div className="mt-2">
              <span className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
                examples
              </span>
              <ul className="mt-1 list-disc space-y-1 pl-5">
                {invariant.examples.map((example, index) => (
                  <li key={index} className="text-[12px] leading-relaxed text-ink-soft">
                    <span className="text-ink">{example.description}</span>
                    <span className="block font-mono text-[11px]">
                      expected: {example.expected}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {invariant.derivedFromRuleIds.length > 0 && (
            <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
                derived from
              </span>
              {invariant.derivedFromRuleIds.map((ruleId) => (
                <RuleRef key={ruleId} ruleId={ruleId} runId={runId} ruleIndex={ruleIndex} />
              ))}
            </div>
          )}
        </li>
      ))}
    </ol>
  );
}

function UnknownsTable({
  unknowns,
  runId,
  ruleIndex,
}: {
  unknowns: SpecUnknown[];
  runId: string;
  ruleIndex: Map<string, { slug: string; rule: Rule }>;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/5 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="px-4 py-1.5 font-normal">Unknown</th>
            <th className="px-4 py-1.5 font-normal">Question</th>
            <th className="px-4 py-1.5 font-normal">Why it matters</th>
            <th className="px-4 py-1.5 font-normal">Resolution strategy</th>
            <th className="px-4 py-1.5 font-normal">Related</th>
          </tr>
        </thead>
        <tbody>
          {unknowns.map((unknown) => (
            <tr key={unknown.id} className="border-b border-ink/5 align-top">
              <td className="px-4 py-2 font-mono text-[11px] break-all text-ink">{unknown.id}</td>
              <td className="px-4 py-2 text-[12px] text-ink">{unknown.question}</td>
              <td className="px-4 py-2 text-[12px] text-ink-soft">{unknown.whyItMatters ?? '—'}</td>
              <td className="px-4 py-2 text-[12px] text-ink-soft">
                {unknown.resolutionStrategy ?? '—'}
              </td>
              <td className="px-4 py-2">
                {unknown.relatedRuleIds.length === 0 && unknown.relatedInvariantIds.length === 0 ? (
                  <span className="font-mono text-[11px] text-ink-soft">—</span>
                ) : (
                  <div className="flex flex-col items-start gap-1">
                    {unknown.relatedRuleIds.map((ruleId) => (
                      <RuleRef key={ruleId} ruleId={ruleId} runId={runId} ruleIndex={ruleIndex} />
                    ))}
                    {unknown.relatedInvariantIds.map((invariantId) => (
                      <span
                        key={invariantId}
                        className="font-mono text-[11px] break-all text-ink-soft"
                      >
                        {invariantId}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RuleRef({
  ruleId,
  runId,
  ruleIndex,
}: {
  ruleId: string;
  runId: string;
  ruleIndex: Map<string, { slug: string; rule: Rule }>;
}) {
  const hit = ruleIndex.get(ruleId);
  if (hit === undefined) {
    return <span className="font-mono text-[11px] break-all text-ink-soft">{ruleId}</span>;
  }
  return (
    <Link
      href={`/runs/${runId}/rules/${hit.slug}/${encodeURIComponent(ruleId)}/`}
      className="font-mono text-[11px] break-all text-ink underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-ink"
    >
      {ruleId}
    </Link>
  );
}

function ZeroNote() {
  return (
    <p className="px-4 py-3 text-sm text-ink-soft">0 recorded (this is what the artifact says)</p>
  );
}

function StatisticsLine({ statistics }: { statistics: Record<string, unknown> }) {
  const entries = Object.entries(statistics).filter(
    (entry): entry is [string, string | number | boolean] =>
      typeof entry[1] === 'string' || typeof entry[1] === 'number' || typeof entry[1] === 'boolean',
  );
  if (entries.length === 0) return null;
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-baseline gap-2">
          <dt className="font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">{key}</dt>
          <dd className="font-mono text-[11px] text-ink">{String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function readSpecification(ws: Workspace, runId: string): LoadedSpecification {
  try {
    const view = loadSpecification(ws, runId);
    return {
      ok: true,
      artifacts: view.artifacts,
      ruleIndex: view.ruleIndex,
      problems: view.problems,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function epistemicTone(status: string): StampTone {
  if (status === 'OBSERVED') return 'matched';
  if (status === 'INFERRED') return 'drifted';
  return 'neutral';
}

function criticalityTone(criticality: string): StampTone {
  if (criticality === 'CRITICAL') return 'danger';
  if (criticality === 'MAJOR') return 'drifted';
  return 'neutral';
}

function automationLabel(automated: boolean | null): string {
  if (automated === null) return 'automation not recorded';
  return automated ? 'automated' : 'manual';
}

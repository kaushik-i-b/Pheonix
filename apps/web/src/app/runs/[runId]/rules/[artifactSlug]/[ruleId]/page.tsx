import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EvidenceCard } from '../../../../../../components/evidence-card';
import { ExhibitSheet } from '../../../../../../components/exhibit-sheet';
import { StampChip } from '../../../../../../components/stamp-chip';
import type { StampTone } from '../../../../../../components/stamp-chip';
import { assertUniqueSlugs, loadArtifactIndex } from '../../../../../../data/artifacts';
import { resolveWorkspace } from '../../../../../../data/repo-root';
import type { Workspace } from '../../../../../../data/repo-root';
import { scanRuns } from '../../../../../../data/runs';
import { sanitizeForDisplay } from '../../../../../../data/sanitize';
import { loadSpecification } from '../../../../../../data/specification';
import type { Rule, SpecArtifact } from '../../../../../../data/specification';
import { loadTaskOutcomes } from '../../../../../../data/tasks';
import { countLabel, displayCitation, shortTaskId } from '../../../../../../lib/format';

type LoadedSpecification =
  | {
      ok: true;
      artifacts: SpecArtifact[];
      ruleIndex: Map<string, { slug: string; rule: Rule }>;
      problems: string[];
    }
  | { ok: false; error: string };

const deckLinkClass =
  'font-mono text-[11px] tracking-[0.08em] text-mist uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:text-deck-text';

const labelClass = 'font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase';

interface RuleRouteParams {
  runId: string;
  artifactSlug: string;
  ruleId: string;
}

export function generateStaticParams(): RuleRouteParams[] {
  const ws = resolveWorkspace();
  const params: RuleRouteParams[] = [];
  const seen = new Set<string>();
  for (const run of scanRuns(ws)) {
    assertUniqueSlugs(loadArtifactIndex(ws, run.runId));
    const loaded = readSpecification(ws, run.runId);
    if (!loaded.ok) continue;
    for (const artifact of loaded.artifacts) {
      for (const rule of artifact.rules) {
        const key = `${run.runId}/${artifact.slug}/${rule.ruleId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        params.push({ runId: run.runId, artifactSlug: artifact.slug, ruleId: rule.ruleId });
      }
    }
  }
  return params;
}

export default async function RuleEvidencePage({ params }: { params: Promise<RuleRouteParams> }) {
  const { runId, artifactSlug, ruleId } = await params;
  const ws = resolveWorkspace();
  const summary = scanRuns(ws).find((run) => run.runId === runId);
  if (summary === undefined) notFound();

  const loaded = readSpecification(ws, runId);
  if (!loaded.ok) {
    return <DeckProblem runId={runId} message={sanitizeForDisplay(loaded.error, ws, 600)} />;
  }
  const artifact = loaded.artifacts.find((entry) => entry.slug === artifactSlug);
  if (artifact === undefined) notFound();
  const rule = artifact.rules.find((entry) => entry.ruleId === ruleId);
  if (rule === undefined) notFound();

  const outcomes = loadTaskOutcomes(ws, runId);
  const outcome = artifact.taskId === null ? undefined : outcomes.get(artifact.taskId);

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-12 pb-8">
        <p className="font-mono text-[11px] tracking-[0.3em] text-brass">
          RUN RECORD / RULE EVIDENCE
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-mono text-xl leading-tight break-all md:text-2xl">{rule.ruleId}</h1>
          <Link href={`/runs/${runId}/`} className={deckLinkClass}>
            ← Run overview
          </Link>
          <Link href={`/runs/${runId}/specification/`} className={deckLinkClass}>
            Specification
          </Link>
        </div>
        <p className="mt-4 max-w-3xl text-2xl leading-snug">
          {sanitizeForDisplay(rule.title, ws, 300)}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          {artifact.variant === 'canonical' ? (
            <>
              <StampChip tone="neutral" surface="deck">
                {artifact.slug}
              </StampChip>
              <StampChip tone="neutral" surface="deck">
                canonical
              </StampChip>
            </>
          ) : (
            <span className="font-mono text-[11px] text-mist">
              attempt — task {shortTaskId(artifact.taskId)} (
              {outcome?.status ?? 'outcome not recorded'})
            </span>
          )}
          {rule.kind !== null && (
            <StampChip tone="neutral" surface="deck">
              {rule.kind}
            </StampChip>
          )}
          {rule.epistemicStatus !== null && (
            <StampChip tone={epistemicTone(rule.epistemicStatus)} surface="deck">
              {rule.epistemicStatus}
            </StampChip>
          )}
          {rule.lifecycleStatus !== null && (
            <StampChip tone="neutral" surface="deck">
              {rule.lifecycleStatus}
            </StampChip>
          )}
        </div>
        <p className="mt-3 font-mono text-[11px] text-mist">
          confidence {rule.confidence === null ? 'not recorded' : String(rule.confidence)} ·
          testable: {testableLabel(rule.testable)}
        </p>
      </section>
      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-20">
        <ExhibitSheet header={<span>Claim</span>}>
          <div className="divide-y divide-ink/10">
            <TextRow label="Description" value={rule.description} ws={ws} />
            <TextRow label="Observable behavior" value={rule.observableBehavior} ws={ws} />
            <ListRow label="Affected components" items={rule.affectedComponents} ws={ws} />
            <ListRow label="Assumptions" items={rule.assumptions} ws={ws} />
            <TextRow label="Confidence basis" value={rule.confidenceBasis} ws={ws} />
          </div>
        </ExhibitSheet>
        <ExhibitSheet
          header={<span>Source evidence</span>}
          slot={
            <span className="uppercase">
              {countLabel(rule.sourceEvidence.length, 'citation', 'citations')}
            </span>
          }
        >
          {rule.sourceEvidence.length === 0 ? (
            <div className="px-4 py-3">
              <ZeroNote />
            </div>
          ) : (
            <div className="divide-y divide-ink/10">
              {rule.sourceEvidence.map((evidence, index) => (
                <EvidenceCard
                  key={`${evidence.id ?? 'evidence'}-${index}`}
                  evidence={evidence}
                  ws={ws}
                />
              ))}
            </div>
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span>Edge cases</span>}
          slot={
            <span className="uppercase">{countLabel(rule.edgeCases.length, 'case', 'cases')}</span>
          }
        >
          {rule.edgeCases.length === 0 ? (
            <div className="px-4 py-3">
              <ZeroNote />
            </div>
          ) : (
            <ol className="divide-y divide-ink/10">
              {rule.edgeCases.map((edge, index) => (
                <li key={`${edge.id ?? 'edge'}-${index}`} className="px-4 py-3.5">
                  <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                    {edge.id !== null && (
                      <span className="font-mono text-[11px] text-ink">{edge.id}</span>
                    )}
                    {edge.epistemicStatus !== null && (
                      <StampChip tone={epistemicTone(edge.epistemicStatus)}>
                        {edge.epistemicStatus}
                      </StampChip>
                    )}
                    {edge.confidence !== null && (
                      <span className="font-mono text-[11px] text-ink-soft">
                        confidence {edge.confidence}
                      </span>
                    )}
                  </div>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-ink">
                    {sanitizeForDisplay(edge.description, ws, 900)}
                  </p>
                  <p className="mt-1 text-[13px] leading-relaxed text-ink-soft">
                    expected:{' '}
                    {edge.expectedBehavior === null
                      ? 'not recorded'
                      : sanitizeForDisplay(edge.expectedBehavior, ws, 900)}
                  </p>
                  {edge.evidence.length === 0 ? (
                    <p className="mt-2 font-mono text-[11px] text-ink-soft">
                      no evidence recorded for this edge case
                    </p>
                  ) : (
                    <div className="mt-2 divide-y divide-ink/10 border border-ink/10">
                      {edge.evidence.map((evidence, evidenceIndex) => (
                        <EvidenceCard
                          key={`${evidence.id ?? 'evidence'}-${evidenceIndex}`}
                          evidence={evidence}
                          ws={ws}
                        />
                      ))}
                    </div>
                  )}
                </li>
              ))}
            </ol>
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span>Proposed checks</span>}
          slot={
            <span className="uppercase">
              {countLabel(rule.proposedChecks.length, 'check', 'checks')}
            </span>
          }
        >
          {rule.proposedChecks.length === 0 ? (
            <div className="px-4 py-3">
              <ZeroNote />
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] border-collapse text-left">
                <thead>
                  <tr className="border-b border-ink/5 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
                    <th className="px-4 py-1.5 font-normal">Check</th>
                    <th className="px-4 py-1.5 font-normal">Kind</th>
                    <th className="px-4 py-1.5 font-normal">Description</th>
                    <th className="px-4 py-1.5 font-normal">Targets</th>
                  </tr>
                </thead>
                <tbody>
                  {rule.proposedChecks.map((check) => (
                    <tr key={check.id} className="border-b border-ink/5 align-top">
                      <td className="px-4 py-2 font-mono text-[11px] break-all text-ink">
                        {check.id}
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">
                        {check.kind ?? '—'}
                      </td>
                      <td className="px-4 py-2 text-[12px] leading-relaxed text-ink">
                        {sanitizeForDisplay(check.description, ws, 600)}
                      </td>
                      <td className="px-4 py-2">
                        {check.targetsRuleId === null ? (
                          <span className="font-mono text-[11px] text-ink-soft">—</span>
                        ) : (
                          <RuleRef
                            ruleId={check.targetsRuleId}
                            runId={runId}
                            ruleIndex={loaded.ruleIndex}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span>Contradictions</span>}
          slot={
            <span className="uppercase">
              {countLabel(rule.contradictsRuleIds.length, 'rule', 'rules')}
            </span>
          }
        >
          {rule.contradictsRuleIds.length === 0 ? (
            <div className="px-4 py-3">
              <ZeroNote />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              {rule.contradictsRuleIds.map((contradictedId) => (
                <RuleRef
                  key={contradictedId}
                  ruleId={contradictedId}
                  runId={runId}
                  ruleIndex={loaded.ruleIndex}
                />
              ))}
            </div>
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span>Derived invariants</span>}
          slot={
            <span className="uppercase">
              {countLabel(rule.derivedFromInvariantIds.length, 'invariant', 'invariants')}
            </span>
          }
        >
          {rule.derivedFromInvariantIds.length === 0 ? (
            <div className="px-4 py-3">
              <ZeroNote />
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
              {rule.derivedFromInvariantIds.map((invariantId) => (
                <span key={invariantId} className="font-mono text-[12px] break-all text-ink">
                  {invariantId}
                </span>
              ))}
            </div>
          )}
        </ExhibitSheet>
        <ExhibitSheet
          header={<span>Duplicate implementations</span>}
          slot={
            <span className="uppercase">
              {countLabel(rule.duplicateImplementations.length, 'path', 'paths')}
            </span>
          }
        >
          {rule.duplicateImplementations.length === 0 ? (
            <div className="px-4 py-3">
              <ZeroNote />
            </div>
          ) : (
            <ul className="space-y-1 px-4 py-3">
              {rule.duplicateImplementations.map((duplicate, index) => (
                <li key={index} className="font-mono text-[12px] break-all text-ink">
                  {sanitizeForDisplay(displayCitation(duplicate), ws, 400)}
                </li>
              ))}
            </ul>
          )}
        </ExhibitSheet>
        {loaded.problems.length > 0 && (
          <ul className="space-y-1">
            {loaded.problems.map((problem, index) => (
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

function DeckProblem({ runId, message }: { runId: string; message: string }) {
  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-12 pb-8">
        <p className="font-mono text-[11px] tracking-[0.3em] text-brass">
          RUN RECORD / RULE EVIDENCE
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-mono text-xl leading-tight break-all md:text-2xl">{runId}</h1>
          <Link href={`/runs/${runId}/`} className={deckLinkClass}>
            ← Run overview
          </Link>
        </div>
      </section>
      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-20">
        <ExhibitSheet>
          <p className="px-4 py-6 font-mono text-[12px] text-ink-soft">
            This section could not be read: {message}
          </p>
        </ExhibitSheet>
      </section>
    </>
  );
}

function TextRow({ label, value, ws }: { label: string; value: string | null; ws: Workspace }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[160px_1fr] sm:gap-4">
      <span className={labelClass}>{label}</span>
      {value === null ? (
        <span className="font-mono text-[12px] text-ink-soft">not recorded</span>
      ) : (
        <p className="text-[13px] leading-relaxed text-ink">{sanitizeForDisplay(value, ws, 900)}</p>
      )}
    </div>
  );
}

function ListRow({ label, items, ws }: { label: string; items: string[]; ws: Workspace }) {
  return (
    <div className="grid grid-cols-1 gap-1 px-4 py-3 sm:grid-cols-[160px_1fr] sm:gap-4">
      <span className={labelClass}>{label}</span>
      {items.length === 0 ? (
        <span className="font-mono text-[12px] text-ink-soft">
          0 recorded (this is what the artifact says)
        </span>
      ) : (
        <ul className="space-y-1">
          {items.map((item, index) => (
            <li key={index} className="font-mono text-[12px] break-all text-ink">
              {sanitizeForDisplay(displayCitation(item), ws, 400)}
            </li>
          ))}
        </ul>
      )}
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
  return <p className="text-sm text-ink-soft">0 recorded (this is what the artifact says)</p>;
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

function testableLabel(testable: boolean | null): string {
  if (testable === null) return 'not recorded';
  return testable ? 'yes' : 'no';
}

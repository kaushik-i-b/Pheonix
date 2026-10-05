import Link from 'next/link';
import { notFound } from 'next/navigation';
import { EvidenceCard } from '../../../../../components/evidence-card';
import { ExhibitSheet } from '../../../../../components/exhibit-sheet';
import { StampChip } from '../../../../../components/stamp-chip';
import type { StampTone } from '../../../../../components/stamp-chip';
import { loadFindings } from '../../../../../data/findings';
import { resolveWorkspace } from '../../../../../data/repo-root';
import type { Workspace } from '../../../../../data/repo-root';
import { sanitizeForDisplay } from '../../../../../data/sanitize';
import { scanRuns } from '../../../../../data/runs';
import { loadSpecification } from '../../../../../data/specification';
import type { Rule } from '../../../../../data/specification';
import { countLabel, displayCitation } from '../../../../../lib/format';

const deckLinkClass =
  'font-mono text-[11px] tracking-[0.08em] text-mist uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:text-deck-text';

const deckRefClass =
  'font-mono text-[12px] break-all underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-ink';

const labelClass = 'font-mono text-[10px] tracking-[0.08em] text-mist uppercase';

type LoadedRuleIndex =
  { ok: true; ruleIndex: Map<string, { slug: string; rule: Rule }> } | { ok: false; error: string };

interface FindingRouteParams {
  runId: string;
  findingId: string;
}

export function generateStaticParams(): FindingRouteParams[] {
  const ws = resolveWorkspace();
  const params: FindingRouteParams[] = [];
  const seen = new Set<string>();
  for (const run of scanRuns(ws)) {
    const view = loadFindings(ws, run.runId);
    for (const finding of view.findings) {
      const key = `${run.runId}/${finding.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      params.push({ runId: run.runId, findingId: finding.id });
    }
  }
  return params;
}

export default async function FindingEvidencePage({
  params,
}: {
  params: Promise<FindingRouteParams>;
}) {
  const { runId, findingId } = await params;
  const ws = resolveWorkspace();
  const summary = scanRuns(ws).find((run) => run.runId === runId);
  if (summary === undefined) notFound();

  const view = loadFindings(ws, runId);
  const finding = view.findings.find((entry) => entry.id === findingId);
  if (finding === undefined) notFound();

  const specIndex = readRuleIndex(ws, runId);
  const ruleIndex = specIndex.ok
    ? specIndex.ruleIndex
    : new Map<string, { slug: string; rule: Rule }>();
  const problems = specIndex.ok
    ? view.problems
    : [...view.problems, `specification index could not be read: ${specIndex.error}`];

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-12 pb-8">
        <p className="font-mono text-[11px] tracking-[0.3em] text-brass">
          RUN RECORD / DISCOVERY FINDING
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-mono text-xl leading-tight break-all md:text-2xl">{finding.id}</h1>
          <Link href={`/runs/${runId}/`} className={deckLinkClass}>
            ← Run overview
          </Link>
          <Link href={`/runs/${runId}/findings/`} className={deckLinkClass}>
            Findings
          </Link>
        </div>
        <p className="mt-4 max-w-3xl text-[15px] leading-relaxed">
          {sanitizeForDisplay(finding.summary, ws, 1200)}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <StampChip tone="neutral" surface="deck">
            {finding.kind}
          </StampChip>
          {finding.severity !== null && (
            <StampChip tone={severityTone(finding.severity)} surface="deck">
              {finding.severity}
            </StampChip>
          )}
          {finding.epistemicStatus !== null && (
            <StampChip tone={epistemicTone(finding.epistemicStatus)} surface="deck">
              {finding.epistemicStatus}
            </StampChip>
          )}
        </div>
        <p className="mt-3 font-mono text-[11px] text-mist">
          confidence {finding.confidence === null ? 'not recorded' : String(finding.confidence)} ·{' '}
          {countLabel(finding.evidence.length, 'citation', 'citations')}
        </p>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className={labelClass}>affected components</span>
          {finding.affectedComponents.length === 0 ? (
            <span className="font-mono text-[11px] text-mist">
              0 recorded (this is what the artifact says)
            </span>
          ) : (
            finding.affectedComponents.map((component, index) => (
              <span key={index} className="font-mono text-[12px] break-all">
                {sanitizeForDisplay(displayCitation(component), ws, 300)}
              </span>
            ))
          )}
        </div>
        {finding.relatedRuleIds.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={labelClass}>related rules</span>
            {finding.relatedRuleIds.map((ruleId) => (
              <RuleRef key={ruleId} ruleId={ruleId} runId={runId} ruleIndex={ruleIndex} />
            ))}
          </div>
        )}
        {finding.relatedInvariantIds.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className={labelClass}>related invariants</span>
            {finding.relatedInvariantIds.map((invariantId) => (
              <span key={invariantId} className="font-mono text-[12px] break-all">
                {invariantId}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-20">
        <ExhibitSheet
          header={<span>Source evidence</span>}
          slot={
            <span className="uppercase">
              {countLabel(finding.evidence.length, 'citation', 'citations')}
            </span>
          }
        >
          {finding.evidence.length === 0 ? (
            <div className="px-4 py-3">
              <ZeroNote />
            </div>
          ) : (
            <div className="divide-y divide-ink/10">
              {finding.evidence.map((evidence, index) => (
                <EvidenceCard
                  key={`${evidence.id ?? 'evidence'}-${index}`}
                  evidence={evidence}
                  ws={ws}
                />
              ))}
            </div>
          )}
        </ExhibitSheet>
        {problems.length > 0 && (
          <ul className="space-y-1">
            {problems.map((problem, index) => (
              <li key={index} className="font-mono text-[11px] leading-relaxed text-mist">
                problem: {sanitizeForDisplay(problem, ws, 400)}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
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
    return <span className="font-mono text-[12px] break-all">{ruleId}</span>;
  }
  return (
    <Link
      href={`/runs/${runId}/rules/${hit.slug}/${encodeURIComponent(ruleId)}/`}
      className={deckRefClass}
    >
      {ruleId}
    </Link>
  );
}

function ZeroNote() {
  return <p className="text-sm text-ink-soft">0 recorded (this is what the artifact says)</p>;
}

function readRuleIndex(ws: Workspace, runId: string): LoadedRuleIndex {
  try {
    return { ok: true, ruleIndex: loadSpecification(ws, runId).ruleIndex };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function severityTone(severity: string): StampTone {
  if (severity === 'MAJOR') return 'danger';
  return 'neutral';
}

function epistemicTone(status: string): StampTone {
  if (status === 'OBSERVED') return 'matched';
  if (status === 'INFERRED') return 'drifted';
  return 'neutral';
}

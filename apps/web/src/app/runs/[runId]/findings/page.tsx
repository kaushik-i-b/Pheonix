import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ExhibitSheet } from '../../../../components/exhibit-sheet';
import { StampChip } from '../../../../components/stamp-chip';
import type { StampTone } from '../../../../components/stamp-chip';
import { loadFindings } from '../../../../data/findings';
import type { Finding } from '../../../../data/findings';
import { resolveWorkspace } from '../../../../data/repo-root';
import type { Workspace } from '../../../../data/repo-root';
import { sanitizeForDisplay } from '../../../../data/sanitize';
import { scanRuns } from '../../../../data/runs';
import { loadSpecification } from '../../../../data/specification';
import type { Rule, SpecUnknown } from '../../../../data/specification';
import { countLabel } from '../../../../lib/format';

const deckLinkClass =
  'font-mono text-[11px] tracking-[0.08em] text-mist uppercase underline decoration-brass decoration-2 underline-offset-[3px] hover:text-deck-text';

const recordLinkClass =
  'font-mono text-[12px] break-all text-ink underline decoration-brass decoration-2 underline-offset-[3px] hover:decoration-ink';

type LoadedRuleIndex =
  { ok: true; ruleIndex: Map<string, { slug: string; rule: Rule }> } | { ok: false; error: string };

interface FindingsRouteParams {
  runId: string;
}

export function generateStaticParams(): FindingsRouteParams[] {
  return scanRuns(resolveWorkspace()).map((run) => ({ runId: run.runId }));
}

export default async function FindingsPage({ params }: { params: Promise<FindingsRouteParams> }) {
  const { runId } = await params;
  const ws = resolveWorkspace();
  const summary = scanRuns(ws).find((run) => run.runId === runId);
  if (summary === undefined) notFound();

  const view = loadFindings(ws, runId);
  const specIndex = readRuleIndex(ws, runId);
  const ruleIndex = specIndex.ok
    ? specIndex.ruleIndex
    : new Map<string, { slug: string; rule: Rule }>();
  const problems = specIndex.ok
    ? view.problems
    : [...view.problems, `specification index could not be read: ${specIndex.error}`];

  const present =
    view.findings.length > 0 ||
    view.openQuestions.length > 0 ||
    view.sections.length > 0 ||
    view.summary !== null;

  return (
    <>
      <section className="mx-auto max-w-6xl px-6 pt-12 pb-8">
        <p className="font-mono text-[11px] tracking-[0.3em] text-brass">
          RUN RECORD / DISCOVERY FINDINGS
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2">
          <h1 className="font-mono text-xl leading-tight break-all md:text-2xl">{runId}</h1>
          <Link href={`/runs/${runId}/`} className={deckLinkClass}>
            ← Run overview
          </Link>
          <Link href={`/runs/${runId}/specification/`} className={deckLinkClass}>
            Specification
          </Link>
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[12px] text-mist">
          <span>{countLabel(view.findings.length, 'finding', 'findings')}</span>
          <span aria-hidden>·</span>
          <span>{countLabel(view.openQuestions.length, 'open question', 'open questions')}</span>
          <span aria-hidden>·</span>
          <span>{countLabel(view.sections.length, 'section', 'sections')}</span>
        </div>
      </section>
      <section className="mx-auto max-w-6xl space-y-6 px-6 pb-20">
        {!present ? (
          <ExhibitSheet>
            <p className="px-4 py-6 text-sm text-ink-soft">
              No discovery findings are recorded in this run.
            </p>
          </ExhibitSheet>
        ) : (
          <>
            {view.summary !== null && (
              <ExhibitSheet header={<span>Summary</span>}>
                <p className="px-4 py-3 text-[13px] leading-relaxed text-ink">
                  {sanitizeForDisplay(view.summary, ws, 1200)}
                </p>
              </ExhibitSheet>
            )}
            <ExhibitSheet
              header={<span>Findings</span>}
              slot={
                <span className="uppercase">
                  {countLabel(view.findings.length, 'finding', 'findings')}
                </span>
              }
            >
              {view.findings.length === 0 ? (
                <div className="px-4 py-3">
                  <ZeroNote />
                </div>
              ) : (
                <ol className="divide-y divide-ink/10">
                  {view.findings.map((finding) => (
                    <FindingRow key={finding.id} finding={finding} runId={runId} ws={ws} />
                  ))}
                </ol>
              )}
            </ExhibitSheet>
            <ExhibitSheet
              header={<span>Open questions</span>}
              slot={
                <span className="uppercase">
                  {countLabel(view.openQuestions.length, 'open question', 'open questions')}
                </span>
              }
            >
              {view.openQuestions.length === 0 ? (
                <div className="px-4 py-3">
                  <ZeroNote />
                </div>
              ) : (
                <OpenQuestionsTable
                  questions={view.openQuestions}
                  runId={runId}
                  ruleIndex={ruleIndex}
                  ws={ws}
                />
              )}
            </ExhibitSheet>
            <ExhibitSheet
              header={<span>Sections</span>}
              slot={
                <span className="uppercase">
                  {countLabel(view.sections.length, 'section', 'sections')}
                </span>
              }
            >
              {view.sections.length === 0 ? (
                <div className="px-4 py-3">
                  <ZeroNote />
                </div>
              ) : (
                <ol className="divide-y divide-ink/10">
                  {view.sections.map((section, index) => (
                    <li key={index} className="px-4 py-3.5">
                      <h3 className="text-[13px] font-medium text-ink">
                        {sanitizeForDisplay(section.heading, ws, 200)}
                      </h3>
                      <p className="mt-1.5 text-[13px] leading-relaxed whitespace-pre-wrap text-ink-soft">
                        {sanitizeForDisplay(section.body, ws, 2000)}
                      </p>
                    </li>
                  ))}
                </ol>
              )}
            </ExhibitSheet>
          </>
        )}
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

function FindingRow({ finding, runId, ws }: { finding: Finding; runId: string; ws: Workspace }) {
  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Link
          href={`/runs/${runId}/findings/${encodeURIComponent(finding.id)}/`}
          className={recordLinkClass}
        >
          {finding.id}
        </Link>
        {finding.severity !== null && (
          <StampChip tone={severityTone(finding.severity)}>{finding.severity}</StampChip>
        )}
        {finding.epistemicStatus !== null && (
          <StampChip tone={epistemicTone(finding.epistemicStatus)}>
            {finding.epistemicStatus}
          </StampChip>
        )}
        {finding.confidence !== null && (
          <span className="font-mono text-[11px] text-ink-soft">
            confidence {finding.confidence}
          </span>
        )}
      </div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-ink">
        {sanitizeForDisplay(finding.summary, ws, 900)}
      </p>
      <p className="mt-1.5 font-mono text-[11px] text-ink-soft">
        {finding.kind} · {countLabel(finding.evidence.length, 'citation', 'citations')}
      </p>
    </li>
  );
}

function OpenQuestionsTable({
  questions,
  runId,
  ruleIndex,
  ws,
}: {
  questions: SpecUnknown[];
  runId: string;
  ruleIndex: Map<string, { slug: string; rule: Rule }>;
  ws: Workspace;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[880px] border-collapse text-left">
        <thead>
          <tr className="border-b border-ink/5 font-mono text-[10px] tracking-[0.08em] text-ink-soft uppercase">
            <th className="px-4 py-1.5 font-normal">Open question</th>
            <th className="px-4 py-1.5 font-normal">Question</th>
            <th className="px-4 py-1.5 font-normal">Why it matters</th>
            <th className="px-4 py-1.5 font-normal">Resolution strategy</th>
            <th className="px-4 py-1.5 font-normal">Related</th>
          </tr>
        </thead>
        <tbody>
          {questions.map((question) => (
            <tr key={question.id} className="border-b border-ink/5 align-top">
              <td className="px-4 py-2 font-mono text-[11px] break-all text-ink">{question.id}</td>
              <td className="px-4 py-2 text-[12px] text-ink">
                {sanitizeForDisplay(question.question, ws, 600)}
              </td>
              <td className="px-4 py-2 text-[12px] text-ink-soft">
                {question.whyItMatters === null
                  ? '—'
                  : sanitizeForDisplay(question.whyItMatters, ws, 600)}
              </td>
              <td className="px-4 py-2 font-mono text-[11px] text-ink-soft">
                {question.resolutionStrategy ?? '—'}
              </td>
              <td className="px-4 py-2">
                {question.relatedRuleIds.length === 0 &&
                question.relatedInvariantIds.length === 0 ? (
                  <span className="font-mono text-[11px] text-ink-soft">—</span>
                ) : (
                  <div className="flex flex-col items-start gap-1">
                    {question.relatedRuleIds.map((ruleId) => (
                      <RuleRef key={ruleId} ruleId={ruleId} runId={runId} ruleIndex={ruleIndex} />
                    ))}
                    {question.relatedInvariantIds.map((invariantId) => (
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
      className={recordLinkClass}
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

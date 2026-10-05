'use client';

import { useEffect, useId, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { EvidenceExcerpt, RecordedRun, RuleCard, InvariantCard, ValuePair, VerificationView } from './types';

type Claim = { kind: 'rule'; card: RuleCard } | { kind: 'invariant'; card: InvariantCard };

export function RecordedDashboard({ run }: { run: RecordedRun }) {
  const [claim, setClaim] = useState<Claim | null>(run.rules[0] !== undefined ? { kind: 'rule', card: run.rules[0] } : null);
  const titleId = useId();

  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') setClaim(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="recorded-run bg-[#14110e]">
      <div className="mx-auto flex max-w-6xl flex-col gap-14 px-4 py-10 sm:px-6 md:py-14">
        <Header run={run} titleId={titleId} />
        <Timeline run={run} />
        <Claims run={run} claim={claim} onSelect={setClaim} />
        <Characterization run={run} />
        <Verification run={run} />
        <Artifacts run={run} />
      </div>
    </div>
  );
}

function Header({ run, titleId }: { run: RecordedRun; titleId: string }) {
  return (
    <header>
      <h1 id={titleId} className="max-w-3xl text-3xl leading-tight font-medium tracking-tight text-[#f6f1ea]">
        Evidence
      </h1>
      <p className="mt-3 max-w-2xl text-base leading-relaxed text-[#cbbfb2]">
        The recorded comparison, the rules that were checked, and the files behind them.
      </p>
      <dl className="mt-8 grid gap-3 sm:grid-cols-3">
        <Meta label="Run" value={run.runId} mono />
        <Meta label="Commit" value={run.sliceCommit.slice(0, 7)} mono />
        <Meta label="Result" value={text(run.finalVerdict)} badge={run.finalVerdict} />
      </dl>
    </header>
  );
}

function Timeline({ run }: { run: RecordedRun }) {
  const numeric = run.verification.numericExample;
  const stages = [
    {
      name: 'Discover',
      verdict: run.discover.status,
      detail: `${run.discover.findings.length} finding(s) recorded`,
    },
    {
      name: 'Specify',
      verdict: run.specify.status,
      detail: `${run.rules.length} rules, ${run.invariants.length} invariants`,
    },
    {
      name: 'Characterize',
      verdict: run.characterization.status,
      detail: `${text(run.characterization.caseCount)} cases, ${text(run.characterization.assertionCount)} assertions`,
    },
    {
      name: 'Modernize',
      verdict: run.verification.numeric.verdict,
      detail: 'First differential result',
    },
    {
      name: 'Verify',
      verdict: run.verification.equivalent.verdict,
      detail: 'After the recorded repair',
    },
  ];
  return (
    <section aria-labelledby="timeline-heading">
      <h2 id="timeline-heading" className="text-lg font-medium text-[#f6f1ea]">
        Stage timeline
      </h2>
      <ol className="mt-5 grid gap-3 md:grid-cols-5">
        {stages.map((stage, index) => (
          <li key={stage.name} className="rounded-lg border border-[#3a322c] bg-[#1c1814] p-4">
            <p className="text-[11px] tracking-[0.16em] text-[#a89888] uppercase">0{index + 1}</p>
            <p className="mt-2 text-sm font-medium text-[#f6f1ea]">{stage.name}</p>
            <div className="mt-3">
              <Badge value={stage.verdict} />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[#cbbfb2]">{stage.detail}</p>
          </li>
        ))}
      </ol>
      <div className="mt-4 rounded-lg border border-[#ff7a3c]/40 bg-[#2a1c14] p-4 text-sm leading-relaxed text-[#f6f1ea]">
        <p>
          The first verification of the generated replacement is{' '}
          <Badge value={run.verification.numeric.verdict} /> with {text(run.verification.numeric.mismatchCount)}{' '}
          mismatches. One recorded example is{' '}
          <span className="font-mono text-[13px]">{text(numeric?.path)}</span>: legacy{' '}
          <ValueChip tone="legacy">{formatValue(numeric?.legacy)}</ValueChip> versus modern{' '}
          <ValueChip tone="modern">{formatValue(numeric?.modern)}</ValueChip>
          {numeric?.differenceKind ? ` (${numeric.differenceKind})` : ''}. The later repair verification is{' '}
          <Badge value={run.verification.equivalent.verdict} /> with {text(run.verification.equivalent.mismatchCount)}{' '}
          mismatches.
        </p>
        <p className="mt-2 text-[#cbbfb2]">Correction: {correctionWord(run.verification.equivalent.correction.kind)}.</p>
      </div>
    </section>
  );
}

function Claims({
  run,
  claim,
  onSelect,
}: {
  run: RecordedRun;
  claim: Claim | null;
  onSelect: (claim: Claim | null) => void;
}) {
  const cards: Claim[] = [
    ...run.rules.map((card) => ({ kind: 'rule' as const, card })),
    ...run.invariants.map((card) => ({ kind: 'invariant' as const, card })),
  ];
  return (
    <section aria-labelledby="claims-heading">
      <h2 id="claims-heading" className="text-lg font-medium text-[#f6f1ea]">
        Rules and invariants
      </h2>
      <div className="mt-5 grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
        <ul className="flex flex-col gap-2" aria-label="Claims">
          {cards.length === 0 ? (
            <li className="text-sm text-[#cbbfb2]">Not recorded</li>
          ) : (
            cards.map((item, index) => {
              const selected = claim?.card.id === item.card.id;
              return (
                <li key={item.card.id}>
                  <button
                    type="button"
                    aria-pressed={selected}
                    className={`w-full rounded-lg border px-4 py-3 text-left transition-colors duration-200 ${
                      selected ? 'border-[#ff7a3c] bg-[#2a1c14]' : 'border-[#3a322c] bg-[#1c1814] hover:border-[#6a5344]'
                    }`}
                    onClick={() => onSelect(item)}
                    onKeyDown={(event) => moveClaim(event, index, cards, onSelect)}
                  >
                    <span className="text-[11px] tracking-[0.14em] text-[#ff7a3c] uppercase">
                      {item.kind === 'rule' ? 'Rule' : 'Invariant'}
                    </span>
                    <span className="mt-1 block font-mono text-xs text-[#f6f1ea]">{item.card.id}</span>
                    <span className="mt-1 block text-sm text-[#cbbfb2]">
                      {item.kind === 'rule' ? text(item.card.title) : text(item.card.statement)}
                    </span>
                  </button>
                </li>
              );
            })
          )}
        </ul>
        <EvidenceDrawer claim={claim} feeAt60={run.feeAt60} />
      </div>
      <Unknowns run={run} />
    </section>
  );
}

function moveClaim(
  event: ReactKeyboardEvent<HTMLButtonElement>,
  index: number,
  cards: Claim[],
  onSelect: (claim: Claim) => void,
) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  event.preventDefault();
  const next = event.key === 'ArrowDown' ? Math.min(cards.length - 1, index + 1) : Math.max(0, index - 1);
  const item = cards[next];
  if (item === undefined) return;
  onSelect(item);
  const list = event.currentTarget.closest('ul');
  const button = list?.querySelectorAll('button')[next];
  if (button instanceof HTMLButtonElement) button.focus();
}

function EvidenceDrawer({ claim, feeAt60 }: { claim: Claim | null; feeAt60: RecordedRun['feeAt60'] }) {
  if (claim === null) {
    return (
      <aside className="rounded-lg border border-dashed border-[#3a322c] p-5 text-sm text-[#cbbfb2]">
        Select a rule or invariant. The evidence drawer shows the recorded source path, line range, and excerpt.
      </aside>
    );
  }
  return (
    <aside aria-live="polite" className="rounded-lg border border-[#3a322c] bg-[#1c1814] p-5">
      <p className="font-mono text-xs text-[#ff7a3c]">{claim.card.id}</p>
      {claim.kind === 'rule' ? <RuleBody card={claim.card} feeAt60={feeAt60} /> : <InvariantBody card={claim.card} />}
      <div className="mt-5 flex flex-col gap-4">
        {claim.card.evidence.length === 0 ? (
          <p className="text-sm text-[#cbbfb2]">Not recorded</p>
        ) : (
          claim.card.evidence.map((item, index) => (
            <EvidenceBlock key={`${claim.card.id}-${index}`} evidence={item} />
          ))
        )}
      </div>
    </aside>
  );
}

function RuleBody({ card, feeAt60 }: { card: RuleCard; feeAt60: RecordedRun['feeAt60'] }) {
  const feeRule = card.id === 'BR-TRANSFER-FEE-ONLINE-THRESHOLD-AND-ROUNDING';
  return (
    <>
      <h3 className="mt-2 text-base font-medium text-[#f6f1ea]">{text(card.title)}</h3>
      <p className="mt-3 text-sm leading-relaxed text-[#cbbfb2]">{text(card.description)}</p>
      <h4 className="mt-4 text-xs tracking-[0.14em] text-[#a89888] uppercase">Recorded text</h4>
      <p className="mt-2 text-sm leading-relaxed text-[#f6f1ea]">{text(card.observableBehavior)}</p>
      {feeRule ? <FeeTextCorrection card={card} feeAt60={feeAt60} /> : null}
      {card.edgeCases.length === 0 ? (
        <p className="mt-2 text-sm text-[#cbbfb2]">Not recorded</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2 text-sm text-[#cbbfb2]">
          {card.edgeCases.map((item, index) => (
            <li key={index}>
              {text(item.description)} — {text(item.expectedBehavior)}
            </li>
          ))}
        </ul>
      )}
      <h4 className="mt-4 text-xs tracking-[0.14em] text-[#a89888] uppercase">Assumptions</h4>
      <ListOrMissing items={card.assumptions} />
    </>
  );
}

function FeeTextCorrection({ card, feeAt60 }: { card: RuleCard; feeAt60: RecordedRun['feeAt60'] }) {
  const edge = card.edgeCases.find((item) => (item.expectedBehavior ?? '').includes('online transfer fee for 60.00 is 0.00'));
  return (
    <div className="mt-3 rounded-md border border-[#ff7a3c]/40 bg-[#2a1c14] p-3">
      <p className="text-[11px] tracking-[0.12em] text-[#ffb088] uppercase">Correction to displayed recorded text</p>
      {feeAt60 === null || feeAt60.capturedFee !== 0 ? (
        <p className="mt-2 text-sm text-[#cbbfb2]">Not recorded</p>
      ) : (
        <p className="mt-2 text-sm leading-relaxed text-[#f6f1ea]">
          The recorded sentence says a transfer of 60.00 costs 0.25 on the online path. The captured case {text(feeAt60.caseId)}{' '}
          records {text(feeAt60.stepId)} responseBody.fee = {text(feeAt60.capturedFee)} for amount {text(feeAt60.amount)}. The
          recorded description of this rule says the online path waives the fee below 100.00. The figure 0.25 is the recorded
          minimum fee, not the captured online fee
          {edge === undefined ? '.' : ` (${text(edge.expectedBehavior)}).`}
        </p>
      )}
    </div>
  );
}

function InvariantBody({ card }: { card: InvariantCard }) {
  return (
    <>
      <h3 className="mt-2 text-base font-medium leading-relaxed text-[#f6f1ea]">{text(card.statement)}</h3>
      <p className="mt-2 text-xs text-[#a89888]">
        {text(card.criticality)} · derived from {card.derivedFromRuleIds.length === 0 ? 'Not recorded' : card.derivedFromRuleIds.join(', ')}
      </p>
      <h4 className="mt-4 text-xs tracking-[0.14em] text-[#a89888] uppercase">Exceptions</h4>
      <ListOrMissing items={card.knownExceptions} />
      <h4 className="mt-4 text-xs tracking-[0.14em] text-[#a89888] uppercase">Checking strategy</h4>
      <p className="mt-2 text-sm leading-relaxed text-[#cbbfb2]">{text(card.checkingStrategy)}</p>
    </>
  );
}

function EvidenceBlock({ evidence }: { evidence: EvidenceExcerpt }) {
  const cited =
    evidence.startLine !== null && evidence.endLine !== null ? `${evidence.startLine}–${evidence.endLine}` : null;
  const resolved =
    evidence.quoteLocation === null ? null : `${evidence.quoteLocation.startLine}–${evidence.quoteLocation.endLine}`;
  return (
    <figure className="rounded-md border border-[#3a322c] bg-[#14110e] p-3">
      <figcaption className="font-mono text-[11px] leading-relaxed text-[#ffb088]">
        {text(evidence.path)}
        {evidence.symbol ? ` · ${evidence.symbol}` : ''}
      </figcaption>
      <p className="mt-3 text-[11px] tracking-[0.12em] text-[#a89888] uppercase">Original citation</p>
      <p className="mt-1 font-mono text-xs text-[#f6f1ea]">{cited === null ? 'Not recorded' : cited}</p>
      <pre className="mt-2 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-[#f6f1ea]">
        {text(evidence.excerpt)}
      </pre>
      <p className="mt-3 text-[11px] tracking-[0.12em] text-[#a89888] uppercase">Resolved citation</p>
      {evidence.quoteInExcerpt ? (
        <p className="mt-1 text-xs text-[#cbbfb2]">The recorded quote is inside the original range.</p>
      ) : evidence.quoteLocation === null ? (
        <p className="mt-1 text-xs text-[#cbbfb2]">Not recorded</p>
      ) : (
        <>
          <p className="mt-1 font-mono text-xs text-[#f6f1ea]">{resolved}</p>
          <pre className="mt-2 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-[#f6f1ea]">
            {text(evidence.quoteLocation.excerpt)}
          </pre>
        </>
      )}
      <p className="mt-3 text-[11px] tracking-[0.12em] text-[#a89888] uppercase">Recorded quote</p>
      <pre className="mt-1 overflow-x-auto text-xs leading-relaxed whitespace-pre-wrap text-[#cbbfb2]">{text(evidence.quote)}</pre>
    </figure>
  );
}

function Characterization({ run }: { run: RecordedRun }) {
  const block = run.characterization;
  return (
    <section aria-labelledby="cases-heading">
      <h2 id="cases-heading" className="text-lg font-medium text-[#f6f1ea]">
        Characterization
      </h2>
      <p className="mt-3 text-sm text-[#cbbfb2]">
        {text(block.caseCount)} cases · {text(block.assertionCount)} assertions · status {text(block.status)}
      </p>
      <div className="mt-4 flex flex-col gap-2">
        {block.cases.length === 0 ? (
          <p className="text-sm text-[#cbbfb2]">Not recorded</p>
        ) : (
          block.cases.map((item) => (
            <details key={item.caseId} className="rounded-lg border border-[#3a322c] bg-[#1c1814] open:border-[#6a5344]">
              <summary className="cursor-pointer px-4 py-3 text-sm text-[#f6f1ea]">
                <span className="font-mono text-xs text-[#ff7a3c]">{item.caseId}</span>
                <span className="mt-1 block">{text(item.title)}</span>
                <span className="mt-1 block text-xs text-[#a89888]">
                  {text(item.category)} · {text(item.status)} · {item.assertionCount} assertions
                </span>
              </summary>
              <div className="border-t border-[#3a322c] px-4 py-3">
                <h3 className="text-xs tracking-[0.14em] text-[#a89888] uppercase">Operations</h3>
                <ul className="mt-2 flex flex-col gap-2">
                  {item.operations.length === 0 ? (
                    <li className="text-sm text-[#cbbfb2]">Not recorded</li>
                  ) : (
                    item.operations.map((step, index) => (
                      <li key={`${item.caseId}-${index}`} className="font-mono text-xs leading-relaxed text-[#f6f1ea]">
                        {text(step.method)} {text(step.path)}
                        {step.body === null ? null : (
                          <span className="mt-1 block font-sans text-[#cbbfb2]">{JSON.stringify(step.body)}</span>
                        )}
                      </li>
                    ))
                  )}
                </ul>
                <h3 className="mt-4 text-xs tracking-[0.14em] text-[#a89888] uppercase">Captured expectations</h3>
                <ul className="mt-2 max-h-64 overflow-auto flex flex-col gap-1">
                  {item.expectations.length === 0 ? (
                    <li className="text-sm text-[#cbbfb2]">Not recorded</li>
                  ) : (
                    item.expectations.map((expectation, index) => (
                      <li key={`${item.caseId}-e-${index}`} className="text-xs text-[#cbbfb2]">
                        <span className="text-[#f6f1ea]">{text(expectation.path)}</span> = {formatValue(expectation.expected)}
                      </li>
                    ))
                  )}
                </ul>
              </div>
            </details>
          ))
        )}
      </div>
    </section>
  );
}

function Verification({ run }: { run: RecordedRun }) {
  const views = [run.verification.numeric, run.verification.equivalent, run.verification.defect, run.verification.restored];
  return (
    <section aria-labelledby="verify-heading">
      <h2 id="verify-heading" className="text-lg font-medium text-[#f6f1ea]">
        Verification
      </h2>
      <div className="mt-5 flex flex-col gap-6">
        {views.map((view) => (
          <VerificationPanel key={view.id} view={view} fee={view.id === 'Controlled fee defect' ? run.verification.feeExample : null} confirmed={run.verification.feeConfirmed} />
        ))}
      </div>
    </section>
  );
}

function VerificationPanel({
  view,
  fee,
  confirmed,
}: {
  view: VerificationView;
  fee: ValuePair | null;
  confirmed: boolean;
}) {
  const rows = view.mismatches.length > 0 ? view.mismatches : view.samplePairs;
  return (
    <article className="rounded-lg border border-[#3a322c] bg-[#1c1814] p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-sm font-medium text-[#f6f1ea]">{view.label}</h3>
        <Badge value={view.verdict} />
      </div>
      <p className="mt-2 text-xs text-[#a89888]">
        Task {view.taskId} · {text(view.mismatchCount)} mismatches
        {view.id === 'Initial verification' ? '' : ` · Correction: ${correctionWord(view.correction.kind)}`}
      </p>
      <p className="mt-2 text-sm leading-relaxed text-[#cbbfb2]">{view.correction.detail}</p>
      {view.id === 'Controlled fee defect' && confirmed && fee !== null ? (
        <p className="mt-3 text-sm text-[#f6f1ea]">
          Controlled fee defect, confirmed in the report: legacy <ValueChip tone="legacy">{formatValue(fee.legacy)}</ValueChip>{' '}
          versus modern <ValueChip tone="modern">{formatValue(fee.modern)}</ValueChip> at{' '}
          <span className="font-mono text-xs">{text(fee.path)}</span>.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="mt-4 text-sm text-[#cbbfb2]">Not recorded</p>
      ) : (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[36rem] border-collapse text-left text-xs">
            <caption className="sr-only">Legacy and modern values for {view.label}</caption>
            <thead>
              <tr className="text-[#a89888]">
                <th className="py-2 pr-3 font-medium">Path</th>
                <th className="py-2 pr-3 font-medium">Legacy</th>
                <th className="py-2 font-medium">Modern</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 12).map((row, index) => (
                <tr key={`${view.id}-${index}`} className={row.highlighted ? 'bg-[#3a201c]' : undefined}>
                  <td className="py-2 pr-3 align-top font-mono text-[#f6f1ea]">{text(row.path)}</td>
                  <td className="py-2 pr-3 align-top text-[#f6f1ea]">{formatValue(row.legacy)}</td>
                  <td className="py-2 align-top text-[#f6f1ea]">{formatValue(row.modern)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rows.length > 12 ? (
            <p className="mt-2 text-xs text-[#a89888]">{rows.length - 12} further recorded rows are in the evidence bundle.</p>
          ) : null}
        </div>
      )}
    </article>
  );
}

function Artifacts({ run }: { run: RecordedRun }) {
  return (
    <section aria-labelledby="artifacts-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <h2 id="artifacts-heading" className="text-lg font-medium text-[#f6f1ea]">
          Artifact details
        </h2>
        <a
          href="/recorded-run.json"
          download="recorded-run.json"
          className="rounded-md bg-[#ff7a3c] px-3 py-2 text-sm font-medium text-[#1a100c]"
        >
          Download evidence bundle
        </a>
      </div>
      <div className="mt-4 overflow-x-auto rounded-lg border border-[#3a322c]">
        <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
          <thead className="bg-[#1c1814] text-[#a89888]">
            <tr>
              <th className="px-3 py-2 font-medium">Task</th>
              <th className="px-3 py-2 font-medium">Relative path</th>
              <th className="px-3 py-2 font-medium">Recorded at</th>
            </tr>
          </thead>
          <tbody>
            {run.artifacts.map((item) => (
              <tr key={`${item.taskId}-${item.relativePath}`} className="border-t border-[#3a322c]">
                <td className="px-3 py-2 font-mono text-[#f6f1ea]">{item.taskId}</td>
                <td className="px-3 py-2 font-mono text-[#cbbfb2]">{item.relativePath}</td>
                <td className="px-3 py-2 text-[#cbbfb2]">{text(item.recordedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Unknowns({ run }: { run: RecordedRun }) {
  return (
    <details className="mt-4 rounded-lg border border-[#3a322c] bg-[#1c1814] px-4 py-3">
      <summary className="cursor-pointer text-sm text-[#f6f1ea]">Recorded unknowns</summary>
      {run.unknowns.length === 0 ? (
        <p className="mt-2 text-sm text-[#cbbfb2]">Not recorded</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2 text-sm text-[#cbbfb2]">
          {run.unknowns.map((item) => (
            <li key={item.id ?? item.question}>{text(item.question)}</li>
          ))}
        </ul>
      )}
    </details>
  );
}

function ListOrMissing({ items }: { items: string[] }) {
  if (items.length === 0) return <p className="mt-2 text-sm text-[#cbbfb2]">Not recorded</p>;
  return (
    <ul className="mt-2 flex flex-col gap-2 text-sm leading-relaxed text-[#cbbfb2]">
      {items.map((item, index) => (
        <li key={index}>{item}</li>
      ))}
    </ul>
  );
}

function Meta({ label, value, mono, badge }: { label: string; value: string; mono?: boolean; badge?: string | null }) {
  return (
    <div className="rounded-lg border border-[#3a322c] bg-[#1c1814] px-4 py-3">
      <dt className="text-[11px] tracking-[0.14em] text-[#a89888] uppercase">{label}</dt>
      <dd className={`mt-1 text-sm text-[#f6f1ea] ${mono ? 'font-mono break-all' : ''}`}>
        {badge !== undefined ? <Badge value={badge} /> : value}
      </dd>
    </div>
  );
}

function Badge({ value }: { value: string | null }) {
  const label = text(value);
  const tone =
    value === 'EQUIVALENT' || value === 'SUCCEEDED'
      ? 'bg-[#1d3a2c] text-[#b7ebc9]'
      : value === 'NOT_EQUIVALENT' || value === 'FAILED'
        ? 'bg-[#3a201c] text-[#ffb4a8]'
        : 'bg-[#2a241f] text-[#cbbfb2]';
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium tracking-wide ${tone}`}>{label}</span>;
}

function ValueChip({ tone, children }: { tone: 'legacy' | 'modern'; children: string }) {
  const color = tone === 'legacy' ? 'text-[#f6f1ea]' : 'text-[#ffb088]';
  return <span className={`font-mono text-[13px] ${color}`}>{children}</span>;
}

function correctionWord(kind: string): string {
  if (kind === 'autonomous') return 'Autonomous';
  if (kind === 'not-recorded-as-autonomous') return 'Unconfirmed';
  return 'Not recorded';
}

function text(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return 'Not recorded';
  return String(value);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return 'Not recorded';
  if (typeof value === 'string') return value.length === 0 ? 'Not recorded' : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

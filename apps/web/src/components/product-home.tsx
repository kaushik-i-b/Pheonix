import Link from 'next/link';
import type { RecordedRun } from '../demo/types';

export function ProductHome({ run }: { run: RecordedRun }) {
  const scenarios = run.characterization.caseCount;
  const restored = run.verification.restored;
  const matched =
    scenarios === 10 &&
    restored.mismatchCount === 0 &&
    restored.verdict === 'EQUIVALENT' &&
    restored.scenarios.length === scenarios &&
    restored.scenarios.every((item) => item.equal);
  const fee = run.verification.feeConfirmed ? run.verification.feeExample : null;
  const restoredFee = restored.samplePairs.find((pair) => pair.path === 'xfer-100-young-account.responseBody.fee') ?? null;
  const feesMatch = restoredFee !== null && restoredFee.legacy === restoredFee.modern && restoredFee.highlighted === false;
  const numeric = run.verification.numericExample;

  return (
    <div className="bg-[#14110e] text-[#f6f1ea]">
      <article className="mx-auto max-w-2xl px-4 py-14 sm:px-6 sm:py-20">
        <p className="text-sm font-medium text-[#ff7a3c]">Recorded demo</p>
        <h1 className="mt-3 text-4xl leading-tight font-medium tracking-tight sm:text-5xl">New code. Same banking behaviour.</h1>
        <p className="mt-5 text-lg leading-relaxed text-[#cbbfb2]">
          We rebuilt a Java banking service, ran the same scenarios against both versions, and checked where their results
          differed.
        </p>
        <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
          <a href="#comparison" className="rounded-md bg-[#ff7a3c] px-4 py-2.5 text-sm font-medium text-[#1a100c]">
            See the comparison
          </a>
          <Link href="/recorded/" className="text-sm text-[#f6f1ea] underline decoration-[#ff7a3c] underline-offset-4">
            Explore the evidence
          </Link>
        </div>

        <section id="comparison" className="mt-16 scroll-mt-8">
          <h2 className="text-xl font-medium">What changed?</h2>
          {fee === null || !feesMatch ? (
            <p className="mt-4 text-base leading-relaxed text-[#cbbfb2]">Not recorded</p>
          ) : (
            <>
              <p className="mt-4 text-base leading-relaxed text-[#cbbfb2]">
                A transfer should cost 0.50. We deliberately changed the replacement to charge 1.00. The comparison caught it.
                After restoration, the tested results matched again.
              </p>
              <dl className="mt-6 divide-y divide-[#3a322c] border-y border-[#3a322c]">
                <Row label="Old service" value={money(fee.legacy)} />
                <Row label="Replacement" value={money(fee.modern)} />
                <Row label="After restoration" value={`${money(restoredFee.legacy)} and ${money(restoredFee.modern)}`} />
              </dl>
              <p className="mt-4 text-sm leading-relaxed text-[#cbbfb2]">
                The record does not show that an agent restored the fee. Both checks used the same generated service.
              </p>
            </>
          )}
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-medium">What matched?</h2>
          <p className="mt-4 text-base leading-relaxed text-[#cbbfb2]">
            {matched
              ? 'After the fee was restored, all 10 scenarios matched.'
              : 'Not recorded'}
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-medium">How we checked</h2>
          <dl className="mt-4 divide-y divide-[#3a322c] border-y border-[#3a322c]">
            <Row label="Old service" value={oldService(run)} />
            <Row label="Replacement" value={replacement(run)} />
          </dl>
          <p className="mt-4 text-base leading-relaxed text-[#cbbfb2]">
            {scenarios === 10
              ? 'The same 10 scenarios were run against both versions.'
              : 'Not recorded'}
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-medium">An earlier repair, kept separate</h2>
          <p className="mt-4 text-base leading-relaxed text-[#cbbfb2]">
            {numeric === null || run.verification.equivalent.mismatchCount !== 0
              ? 'Not recorded'
              : `Before the fee test, the first comparison disagreed because one result wrote ${formatPlain(numeric.legacy)} and the other wrote ${formatPlain(numeric.modern)}. A later recorded repair made those values match. That repair is not the fee restoration.`}
          </p>
        </section>

        <section className="mt-12">
          <h2 className="text-xl font-medium">Pocketful</h2>
          <p className="mt-4 text-base leading-relaxed text-[#cbbfb2]">
            Pocketful’s wallet and payments challenge is about keeping money consistent when payments overlap, are retried, or
            are rounded. This page is a recorded comparison of one banking service. It is not a verified Pocketful result.
          </p>
        </section>

        <p className="mt-16 text-sm leading-relaxed text-[#a89888]">
          {matched
            ? 'This demo shows a recorded run across 10 scenarios. It does not start a new job or guarantee that every possible behaviour matches.'
            : 'This demo shows one recorded run. It does not start a new job or guarantee that every possible behaviour matches.'}
        </p>
      </article>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 py-3 sm:flex-row sm:items-baseline sm:justify-between sm:gap-8">
      <dt className="text-sm text-[#cbbfb2]">{label}</dt>
      <dd className="text-base text-[#f6f1ea] sm:text-right">{value}</dd>
    </div>
  );
}

function oldService(run: RecordedRun): string {
  const language = run.services.original.primaryLanguage;
  const spring = run.services.original.frameworks.find((item) => item.name === 'spring-boot');
  if (language === 'Java' && spring?.version) return `Java, Spring Boot ${spring.version}`;
  if (language) return language;
  return 'Not recorded';
}

function replacement(run: RecordedRun): string {
  if (run.services.replacement.stack === 'Node/TypeScript') return 'Node and TypeScript';
  return run.services.replacement.stack ?? 'Not recorded';
}

function money(value: unknown): string {
  return typeof value === 'number' ? value.toFixed(2) : 'Not recorded';
}

function formatPlain(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return 'Not recorded';
}

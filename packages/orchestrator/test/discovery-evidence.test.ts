import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { CitationReadOutcome } from '@phoenix/agent-runtime';

import { anchorReportCitations } from '../src/stages/discovery-evidence.js';
import {
  archaeologistReportSchema,
  type ArchaeologistReport,
} from '../src/stages/discovery-schema.js';
import { REPO_ROOT } from './support.js';

const LEGACY_ROOT = join(REPO_ROOT, 'examples/legacy-bank');
const V3_PATH = 'src/main/resources/db/migration/V3__batch_and_triggers.sql';
const RECON_PATH = 'src/main/java/com/fnb/corebank/svc/ReconSvc.java';

const V3 = readFileSync(join(LEGACY_ROOT, V3_PATH), 'utf8');
const RECON = readFileSync(join(LEGACY_ROOT, RECON_PATH), 'utf8');

// Exact quote shapes from run 14 of DISCOVER: a fused SQL fragment the anchor must localize,
// and a fabricated quote against a file that never contained it.
const LEDGER_QUOTE =
  "BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW WHEN (OLD.status = 'SETTLED' AND chan <> 'CORRECTION_JOB') BEGIN RAISE EXCEPTION 'E188: settled ledger entries are immutable (ledger row %)', OLD.id; END;";
const FEE_QUOTE = [
  'CREATE OR REPLACE FUNCTION calc_transfer_fee(amt NUMERIC) RETURNS NUMERIC AS $$',
  'BEGIN',
  '    IF amt < 50 THEN',
  '        RETURN 0;',
  '    END IF;',
  '    RETURN GREATEST(ROUND(amt * 0.005, 2), 0.25);',
  'END;',
  '$$ LANGUAGE plpgsql IMMUTABLE;',
].join('\n');
const TIME_QUOTE = [
  'if (LocalDate.now().getDayOfWeek() == DayOfWeek.MONDAY) {',
  '    // Run reconciliation',
  '}',
].join('\n');

function sections(): { heading: string; body: string }[] {
  return [
    { heading: 'Overview', body: 'A small core-banking system with database-side behaviour.' },
    { heading: 'Money movement', body: 'Transfers debit, credit and charge fees in one path.' },
    { heading: 'Risks', body: 'Fee logic is duplicated and the two copies disagree on rounding.' },
  ];
}

function report(findings: unknown[]): ArchaeologistReport {
  return archaeologistReportSchema.parse({
    summary:
      'The legacy bank moves money between accounts, charges transfer fees, reconciles balances nightly and enforces ledger immutability in the database.',
    sections: sections(),
    findings,
  });
}

function evidence(path: string, quote: string, startLine?: number): Record<string, unknown> {
  return { path, quote, ...(startLine !== undefined ? { startLine } : {}) };
}

function makeRead(files: Record<string, string>) {
  return async (path: string): Promise<CitationReadOutcome> => {
    const text = files[path];
    return text === undefined ? { problem: `no such file: ${path}`, definitive: true } : { text };
  };
}

describe('anchorReportCitations', () => {
  it('rewrites every citation to real bytes when all of them anchor', async () => {
    const input = report([
      {
        id: 'F-LEDGER-IMMUTABILITY',
        kind: 'business-rule-candidate',
        summary: 'Settled ledger entries are immutable except for correction jobs.',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        evidence: [evidence(V3_PATH, LEDGER_QUOTE, 31)],
      },
      {
        id: 'F-FEE-ROUNDING',
        kind: 'behavior',
        summary: 'Transfer fees round to two decimals with a minimum of 0.25.',
        epistemicStatus: 'OBSERVED',
        confidence: 0.8,
        evidence: [evidence(V3_PATH, FEE_QUOTE, 60)],
      },
    ]);

    const result = await anchorReportCitations({
      value: input,
      read: makeRead({ [V3_PATH]: V3 }),
      attemptsExhausted: false,
    });

    expect(result.value).toBeDefined();
    const findings = result.value?.findings ?? [];
    expect(findings).toHaveLength(2);

    const ledger = findings[0]?.evidence[0];
    expect(ledger?.startLine).toBe(21);
    expect(ledger?.endLine).toBe(23);
    expect(ledger?.quote).toBe(V3.split('\n').slice(20, 23).join('\n'));
    expect(ledger?.note).toContain('host-anchored to real bytes at lines 21-23');
    expect(ledger?.note).toContain('paraphrased or fused');

    const fee = findings[1]?.evidence[0];
    expect(fee?.startLine).toBe(4);
    expect(fee?.endLine).toBe(11);
    expect(fee?.quote).toBe(V3.split('\n').slice(3, 11).join('\n'));
    expect(fee?.note).toContain('host-corrected cited line span to 4-11');

    expect(
      result.notes?.some((note) => note.includes('host-anchored F-LEDGER-IMMUTABILITY/ev-1')),
    ).toBe(true);
    expect(
      result.notes?.some((note) => note.includes('corrected the line span of F-FEE-ROUNDING/ev-1')),
    ).toBe(true);
  });

  it('leaves the report alone while a repair round remains', async () => {
    const input = report([
      {
        id: 'F-TIME-JOB',
        kind: 'behavior',
        summary: 'Reconciliation may run only on Mondays.',
        epistemicStatus: 'INFERRED',
        confidence: 0.4,
        evidence: [evidence(RECON_PATH, TIME_QUOTE, 29)],
      },
    ]);

    const result = await anchorReportCitations({
      value: input,
      read: makeRead({ [RECON_PATH]: RECON }),
      attemptsExhausted: false,
    });

    expect(result.value).toBeUndefined();
  });

  it('drops an unanchorable citation and demotes the emptied finding on the last attempt', async () => {
    const input = report([
      {
        id: 'F-TIME-JOB',
        kind: 'behavior',
        summary: 'Reconciliation may run only on Mondays.',
        epistemicStatus: 'INFERRED',
        confidence: 0.4,
        evidence: [evidence(RECON_PATH, TIME_QUOTE, 29)],
      },
    ]);

    const result = await anchorReportCitations({
      value: input,
      read: makeRead({ [RECON_PATH]: RECON }),
      attemptsExhausted: true,
    });

    expect(result.value).toBeDefined();
    expect(result.value?.findings).toHaveLength(0);
    const questions = result.value?.openQuestions ?? [];
    expect(questions).toHaveLength(1);
    expect(questions[0]?.id).toBe('Q-TIME-JOB');
    expect(questions[0]?.question).toBe('Reconciliation may run only on Mondays.');
    expect(questions[0]?.resolutionStrategy).toBe('runtime-probe');
    expect(result.notes?.some((note) => note.includes('demoted F-TIME-JOB to Q-TIME-JOB'))).toBe(
      true,
    );
    expect(result.notes?.some((note) => note.includes('best similarity'))).toBe(true);
  });

  it('keeps a finding with the citations that did anchor and drops the rest', async () => {
    const input = report([
      {
        id: 'F-MIXED',
        kind: 'behavior',
        summary: 'The ledger trigger blocks updates to settled rows.',
        epistemicStatus: 'OBSERVED',
        confidence: 0.7,
        evidence: [evidence(V3_PATH, LEDGER_QUOTE, 31), evidence(RECON_PATH, TIME_QUOTE, 29)],
      },
    ]);

    const result = await anchorReportCitations({
      value: input,
      read: makeRead({ [V3_PATH]: V3, [RECON_PATH]: RECON }),
      attemptsExhausted: true,
    });

    expect(result.value).toBeDefined();
    const finding = result.value?.findings[0];
    expect(result.value?.findings).toHaveLength(1);
    expect(finding?.evidence).toHaveLength(1);
    expect(finding?.evidence[0]?.quote).toBe(V3.split('\n').slice(20, 23).join('\n'));
    expect(result.notes?.some((note) => note.includes('dropped citation F-MIXED/ev-2'))).toBe(true);
  });

  it('treats an unreadable file as an unanchorable citation', async () => {
    const input = report([
      {
        id: 'F-PHANTOM',
        kind: 'risk',
        summary: 'A phantom service appears to apply overdraft penalties.',
        epistemicStatus: 'INFERRED',
        confidence: 0.3,
        evidence: [evidence('src/main/java/com/example/Phantom.java', 'class Phantom {}')],
      },
    ]);

    const result = await anchorReportCitations({
      value: input,
      read: makeRead({}),
      attemptsExhausted: true,
    });

    expect(result.value).toBeDefined();
    expect(result.value?.findings).toHaveLength(0);
    expect(result.value?.openQuestions[0]?.id).toBe('Q-PHANTOM');
    expect(result.notes?.some((note) => note.includes('the file could not be read'))).toBe(true);
  });
});

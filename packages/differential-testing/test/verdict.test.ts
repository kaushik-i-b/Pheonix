import { describe, expect, it } from 'vitest';
import {
  hashStable,
  verificationCheckSchema,
  type CharacterizationCaseStatus,
  type Mismatch,
} from '@phoenix/shared';
import { compareSuite, computeDifferentialVerdict, type CompareSuiteResult } from '../src/index.js';
import {
  LEGACY_FEE,
  assertion,
  caseItem,
  execution,
  feeCase,
  feeModern,
  outcome,
  suiteOf,
} from './support.js';

const RUN_ID = 'run_test-verdict';

interface CaseSpec {
  caseId: string;
  legacyFee: number;
  modernFee: number;
  status?: CharacterizationCaseStatus;
  sourceInvariantIds?: readonly string[];
}

function compare(specs: readonly CaseSpec[], criticalInvariantIds?: readonly string[]): CompareSuiteResult {
  const built = specs.map((spec) => ({
    spec,
    ...feeCase({
      caseId: spec.caseId,
      legacyFee: spec.legacyFee,
      ...(spec.status !== undefined ? { status: spec.status } : {}),
      ...(spec.sourceInvariantIds !== undefined
        ? { sourceInvariantIds: spec.sourceInvariantIds }
        : {}),
    }),
  }));
  const suite = suiteOf({
    cases: built.map((entry) => entry.item),
    captures: built.map((entry) => entry.baseline),
  });
  return compareSuite({
    suite,
    ...(criticalInvariantIds !== undefined ? { criticalInvariantIds } : {}),
    modernExecutions: built.map((entry) => ({
      caseId: entry.spec.caseId,
      execution: feeModern(entry.spec.modernFee),
    })),
  });
}

function verdictFor(result: CompareSuiteResult, mismatches: readonly Mismatch[] = result.mismatches) {
  return computeDifferentialVerdict({
    runId: RUN_ID,
    comparisons: result.comparisons,
    mismatches,
    legacySelfCheckFailures: result.legacySelfCheckFailures,
  });
}

describe('computeDifferentialVerdict', () => {
  it('is NOT_EQUIVALENT as soon as one scenario diverges', () => {
    const result = compare([
      { caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: LEGACY_FEE },
      { caseId: 'CHR-FEE-002', legacyFee: 1.5, modernFee: 1.5 },
      { caseId: 'CHR-FEE-003', legacyFee: LEGACY_FEE, modernFee: 2 },
    ]);
    const verdict = verdictFor(result);

    expect(verdict.verdict).toBe('NOT_EQUIVALENT');
    expect(verdict.confidence).toBe(1);
    expect(verdict.mismatchSummary.total).toBe(1);
    expect(verdict.mismatchSummary.unresolved).toBe(1);
    expect(verdict.mismatchSummary.highestSeverity).toBe('MAJOR');
    expect(verdict.repairTargets).toEqual(['CHR-FEE-003-M1']);

    const suiteCheck = verdict.checks.find(
      (check) => check.checkId === 'characterization-suite-passes-on-legacy',
    )!;
    expect(suiteCheck.status).toBe('PASS');
    const equivalence = verdict.checks.find((check) => check.checkId === 'differential-equivalence')!;
    expect(equivalence.status).toBe('FAIL');
    expect(verdict.reasons.some((reason) => reason.includes('diverged'))).toBe(true);
  });

  it('is EQUIVALENT only when every scenario was judged and reproduced its baseline', () => {
    const result = compare([
      { caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: LEGACY_FEE },
      { caseId: 'CHR-FEE-002', legacyFee: 1.5, modernFee: 1.5 },
    ]);
    const verdict = verdictFor(result);

    expect(verdict.verdict).toBe('EQUIVALENT');
    expect(verdict.confidence).toBe(1);
    expect(verdict.repairTargets).toEqual([]);
    expect(verdict.mismatchSummary.total).toBe(0);
    expect(verdict.mismatchSummary.highestSeverity).toBe('INFO');
    expect(verdict.reasons.at(-1)).toContain('reproduce their captured legacy behavior');
  });

  it('is INCONCLUSIVE, never EQUIVALENT, when a scenario could not be judged', () => {
    const result = compare([
      { caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: LEGACY_FEE },
      { caseId: 'CHR-FEE-004', legacyFee: LEGACY_FEE, modernFee: LEGACY_FEE, status: 'inconclusive' },
    ]);
    const verdict = verdictFor(result);

    expect(verdict.verdict).toBe('INCONCLUSIVE');
    expect(verdict.confidence).toBe(0.5);
    const equivalence = verdict.checks.find((check) => check.checkId === 'differential-equivalence')!;
    expect(equivalence.status).toBe('UNKNOWN');
    expect(verdict.reasons.some((reason) => reason.includes('inconclusive'))).toBe(true);
  });

  it('routes fixture drift to INCONCLUSIVE with the suite check FAILed, not to NOT_EQUIVALENT', () => {
    const driftedCapture = execution('legacy', [
      outcome('transfer', { httpStatus: 200, responseBody: { fee: 2.05 } }),
    ]);
    const drifted = caseItem({
      caseId: 'CHR-DRIFT-001',
      status: 'passing-against-legacy',
      captureExecutionId: hashStable(driftedCapture),
      assertions: [
        assertion({
          assertionId: 'CHR-DRIFT-001-A1',
          kind: 'json-value',
          path: 'responseBody.fee',
          expected: LEGACY_FEE,
        }),
      ],
    });
    const equal = feeCase({ caseId: 'CHR-FEE-002', legacyFee: LEGACY_FEE });
    const suite = suiteOf({
      cases: [drifted, equal.item],
      captures: [driftedCapture, equal.baseline],
    });
    const result = compareSuite({
      suite,
      modernExecutions: [
        { caseId: 'CHR-DRIFT-001', execution: feeModern(LEGACY_FEE) },
        { caseId: 'CHR-FEE-002', execution: feeModern(LEGACY_FEE) },
      ],
    });
    const verdict = verdictFor(result);

    expect(verdict.verdict).toBe('INCONCLUSIVE');
    const suiteCheck = verdict.checks.find(
      (check) => check.checkId === 'characterization-suite-passes-on-legacy',
    )!;
    expect(suiteCheck.status).toBe('FAIL');
    expect(verdict.reasons.some((reason) => reason.includes('self-check'))).toBe(true);
  });

  it('orders repair targets by severity and excludes mismatches a repair iteration already resolved', () => {
    const result = compare(
      [
        { caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: 2 },
        {
          caseId: 'CHR-FEE-002',
          legacyFee: LEGACY_FEE,
          modernFee: 2,
          sourceInvariantIds: ['INV-FEE-ROUNDING'],
        },
      ],
      ['INV-FEE-ROUNDING'],
    );
    expect(result.mismatches.map((mismatch) => mismatch.severity)).toEqual(['MAJOR', 'CRITICAL']);

    const orderingVerdict = verdictFor(result);
    expect(orderingVerdict.repairTargets).toEqual(['CHR-FEE-002-M1', 'CHR-FEE-001-M1']);

    const critical = result.mismatches.find((mismatch) => mismatch.severity === 'CRITICAL')!;
    const resolved: Mismatch = {
      ...critical,
      resolvedAt: '2026-01-02T00:00:00.000Z',
      resolvedByIteration: 1,
    };
    const afterRepair = verdictFor(result, [result.mismatches[0]!, resolved]);
    expect(afterRepair.repairTargets).toEqual(['CHR-FEE-001-M1']);
    expect(afterRepair.mismatchSummary.unresolved).toBe(1);
    expect(afterRepair.mismatchSummary.total).toBe(2);
  });

  it('turns a failing required external check into NOT_EQUIVALENT', () => {
    const result = compare([{ caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: LEGACY_FEE }]);
    const requiredFail = verificationCheckSchema.parse({
      checkId: 'modern-builds',
      kind: 'modern-implementation-builds',
      description: 'the modern implementation builds',
      status: 'FAIL',
      required: true,
    });
    const verdict = verdictFor(result, []);
    const strict = computeDifferentialVerdict({
      runId: RUN_ID,
      comparisons: result.comparisons,
      mismatches: [],
      legacySelfCheckFailures: [],
      additionalChecks: [requiredFail],
    });

    expect(verdict.verdict).toBe('EQUIVALENT');
    expect(strict.verdict).toBe('NOT_EQUIVALENT');
    expect(strict.reasons.some((reason) => reason.includes('modern-builds'))).toBe(true);
  });

  it('ignores a failing optional external check', () => {
    const result = compare([{ caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: LEGACY_FEE }]);
    const advisoryFail = verificationCheckSchema.parse({
      checkId: 'coverage-advisory',
      kind: 'coverage',
      description: 'coverage is advisory here',
      status: 'FAIL',
      required: false,
    });
    const verdict = computeDifferentialVerdict({
      runId: RUN_ID,
      comparisons: result.comparisons,
      mismatches: [],
      additionalChecks: [advisoryFail],
    });

    expect(verdict.verdict).toBe('EQUIVALENT');
  });

  it('is INCONCLUSIVE with zero confidence when nothing was compared', () => {
    const verdict = computeDifferentialVerdict({ runId: RUN_ID, comparisons: [], mismatches: [] });

    expect(verdict.verdict).toBe('INCONCLUSIVE');
    expect(verdict.confidence).toBe(0);
    expect(verdict.checks.every((check) => check.status === 'UNKNOWN')).toBe(true);
    expect(verdict.reasons.some((reason) => reason.includes('no scenarios were compared'))).toBe(true);
  });

  it('carries the repair iteration and input artifact ids into the verdict', () => {
    const result = compare([{ caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: 2 }]);
    const verdict = computeDifferentialVerdict({
      runId: RUN_ID,
      comparisons: result.comparisons,
      mismatches: result.mismatches,
      repairIteration: 2,
      inputArtifactIds: [],
    });

    expect(verdict.repairIteration).toBe(2);
  });

  it('counts unexplained mismatches and reports their highest severity', () => {
    const result = compare([
      { caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE, modernFee: 2 },
      {
        caseId: 'CHR-FEE-002',
        legacyFee: LEGACY_FEE,
        modernFee: 2,
        sourceInvariantIds: ['INV-FEE-ROUNDING'],
      },
    ], ['INV-FEE-ROUNDING']);
    const verdict = verdictFor(result);

    expect(verdict.mismatchSummary.unexplained).toBe(2);
    expect(verdict.mismatchSummary.bySeverity).toEqual({
      CRITICAL: 1,
      MAJOR: 1,
      MINOR: 0,
      INFO: 0,
    });
    expect(verdict.mismatchSummary.highestSeverity).toBe('CRITICAL');
  });
});

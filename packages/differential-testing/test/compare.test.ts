import { describe, expect, it } from 'vitest';
import { PhoenixError, artifactIdSchema, hashStable } from '@phoenix/shared';
import { compareSuite } from '../src/index.js';
import {
  FEE_CASE_ID,
  FEE_INVARIANT_ID,
  FEE_RULE_ID,
  LEGACY_FEE,
  assertion,
  caseItem,
  execution,
  feeCase,
  feeFixture,
  feeModern,
  outcome,
  suiteOf,
} from './support.js';

/**
 * The comparison tests are written around the scenario the vertical slice exists to catch: legacy
 * charged a fee of 2.01 and a naive modern rewrite charges 2.00. Everything here is a pure function
 * of recorded executions, so no server, clock or model is involved.
 */

describe('compareSuite', () => {
  it('reports equal when the modern execution reproduces the captured legacy values', () => {
    const { suite } = feeFixture();
    const result = compareSuite({
      suite,
      modernExecutions: [{ caseId: FEE_CASE_ID, execution: feeModern(LEGACY_FEE) }],
    });

    expect(result.comparisons).toHaveLength(1);
    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('equal');
    expect(comparison.equal).toBe(true);
    expect(comparison.mismatches).toEqual([]);
    expect(comparison.legacy).toBeDefined();
    expect(comparison.modern).toBeDefined();
    expect(result.mismatches).toEqual([]);
    expect(result.legacySelfCheckFailures).toEqual([]);
    expect(result.unjudgeable).toEqual([]);
  });

  it('flags a fee that differs in the last cent as a precision mismatch', () => {
    const { suite } = feeFixture();
    const result = compareSuite({
      suite,
      modernExecutions: [{ caseId: FEE_CASE_ID, execution: feeModern(2) }],
    });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('divergent');
    expect(comparison.equal).toBe(false);
    expect(comparison.mismatches).toHaveLength(1);

    const mismatch = result.mismatches[0]!;
    expect(mismatch.mismatchId).toBe(`${FEE_CASE_ID}-M1`);
    expect(mismatch.differenceKind).toBe('precision');
    expect(mismatch.severity).toBe('MAJOR');
    expect(mismatch.path).toBe('transfer.responseBody.fee');
    expect(mismatch.legacyValue).toBe(LEGACY_FEE);
    expect(mismatch.modernValue).toBe(2);
    expect(mismatch.scenarioId).toBe('scn_fee-rounding');
    expect(mismatch.relevantRuleIds).toEqual([FEE_RULE_ID]);
    expect(mismatch.relevantInvariantIds).toEqual([FEE_INVARIANT_ID]);
    expect(mismatch.explanationStatus).toBe('unexplained');
    expect(mismatch.observedCount).toBe(1);
    expect(mismatch.evidence.length).toBeGreaterThanOrEqual(1);
    expect(mismatch.evidence[0]!.kind).toBe('runtime-observation');
    expect(mismatch.evidence[0]!.observation).toContain(
      'legacy 2.01 vs modern 2 at transfer.responseBody.fee',
    );
  });

  it('attaches the suite artifact to mismatch evidence when one is supplied', () => {
    const { suite } = feeFixture();
    const suiteArtifactId = artifactIdSchema.parse(`art_${'a'.repeat(64)}`);
    const result = compareSuite({
      suite,
      suiteArtifactId,
      modernExecutions: [{ caseId: FEE_CASE_ID, execution: feeModern(2) }],
    });

    expect(result.mismatches[0]!.evidence[0]!.artifactId).toBe(suiteArtifactId);
  });

  it('treats a wrong HTTP status as critical', () => {
    const baseline = execution('legacy', [outcome('transfer', { httpStatus: 200 })]);
    const item = caseItem({
      caseId: 'CHR-STATUS-001',
      status: 'passing-against-legacy',
      captureExecutionId: hashStable(baseline),
      assertions: [
        assertion({
          assertionId: 'CHR-STATUS-001-A1',
          kind: 'http-status',
          stepId: 'transfer',
          expected: 200,
        }),
      ],
    });
    const suite = suiteOf({ cases: [item], captures: [baseline] });
    const result = compareSuite({
      suite,
      modernExecutions: [
        { caseId: 'CHR-STATUS-001', execution: execution('modern', [outcome('transfer', { httpStatus: 500 })]) },
      ],
    });

    const mismatch = result.mismatches[0]!;
    expect(mismatch.differenceKind).toBe('http-status');
    expect(mismatch.severity).toBe('CRITICAL');
    expect(mismatch.path).toBe('transfer.http-status');
  });

  it('escalates a value mismatch to critical when it touches a configured critical invariant', () => {
    const { suite } = feeFixture();
    const result = compareSuite({
      suite,
      criticalInvariantIds: [FEE_INVARIANT_ID],
      modernExecutions: [{ caseId: FEE_CASE_ID, execution: feeModern(2) }],
    });

    expect(result.mismatches[0]!.severity).toBe('CRITICAL');
  });

  it('records a normalized difference instead of failing on it', () => {
    const baseline = execution('legacy', [
      outcome('transfer', {
        httpStatus: 200,
        responseBody: { transferId: 'TR-1', fee: LEGACY_FEE },
      }),
    ]);
    const item = caseItem({
      caseId: 'CHR-NORM-001',
      status: 'passing-against-legacy',
      captureExecutionId: hashStable(baseline),
      assertions: [
        assertion({
          assertionId: 'CHR-NORM-001-A1',
          kind: 'json-value',
          path: 'responseBody.fee',
          expected: LEGACY_FEE,
        }),
        assertion({
          assertionId: 'CHR-NORM-001-A2',
          kind: 'json-value',
          path: 'responseBody.transferId',
          expected: 'TR-1',
          normalized: true,
          normalization: {
            reason: 'varied-across-repeated-legacy-executions',
            policy: 'ignore-transfer-id',
            observedValues: ['TR-1', 'TR-2'],
          },
        }),
      ],
    });
    const suite = suiteOf({ cases: [item], captures: [baseline] });
    const result = compareSuite({
      suite,
      modernExecutions: [
        {
          caseId: 'CHR-NORM-001',
          execution: execution('modern', [
            outcome('transfer', {
              httpStatus: 200,
              responseBody: { transferId: 'TR-9', fee: LEGACY_FEE },
            }),
          ]),
        },
      ],
    });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('equal');
    expect(comparison.equal).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(comparison.normalizationApplied).toHaveLength(1);
    const applied = comparison.normalizationApplied[0]!;
    expect(applied.ruleId).toBe('ignore-transfer-id');
    expect(applied.strategy).toBe('ignore');
    expect(applied.system).toBe('modern');
    expect(applied.path).toBe('transfer.responseBody.transferId');
    expect(applied.before).toBe('TR-1');
    expect(applied.after).toBe('TR-9');
  });

  it('refuses to compare a case that never passed its own legacy baseline', () => {
    const { item, baseline } = feeCase({ caseId: 'CHR-STATUS-002', legacyFee: LEGACY_FEE, status: 'inconclusive' });
    const suite = suiteOf({ cases: [item], captures: [baseline] });
    const result = compareSuite({
      suite,
      modernExecutions: [{ caseId: 'CHR-STATUS-002', execution: feeModern(LEGACY_FEE) }],
    });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('inconclusive');
    expect(comparison.equal).toBe(false);
    expect(comparison.inconclusiveReason).toContain('only a case that passed');
    expect(result.unjudgeable).toHaveLength(1);
    expect(result.unjudgeable[0]!.caseId).toBe('CHR-STATUS-002');
    expect(result.unjudgeable[0]!.outcome).toBe('inconclusive');
  });

  it('is inconclusive when the recorded baseline is not among the captures', () => {
    const { item, baseline } = feeCase({ caseId: 'CHR-MISS-001', legacyFee: LEGACY_FEE });
    const orphan = caseItem({
      caseId: item.caseId,
      status: 'passing-against-legacy',
      scenario: item.scenario,
      assertions: item.assertions,
      captureExecutionId: 'not-a-captured-execution',
    });
    const suite = suiteOf({ cases: [orphan], captures: [baseline] });
    const result = compareSuite({
      suite,
      modernExecutions: [{ caseId: 'CHR-MISS-001', execution: feeModern(LEGACY_FEE) }],
    });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('inconclusive');
    expect(comparison.inconclusiveReason).toContain('is not present in the suite captures');
    expect(result.unjudgeable).toHaveLength(1);
  });

  it('reports fixture drift instead of judging when the baseline stopped satisfying its assertions', () => {
    const driftedCapture = execution('legacy', [
      outcome('transfer', { httpStatus: 200, responseBody: { fee: 2.05 } }),
    ]);
    const item = caseItem({
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
    const suite = suiteOf({ cases: [item], captures: [driftedCapture] });
    const result = compareSuite({
      suite,
      modernExecutions: [{ caseId: 'CHR-DRIFT-001', execution: feeModern(LEGACY_FEE) }],
    });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('inconclusive');
    expect(comparison.inconclusiveReason).toContain('drifted');
    expect(comparison.legacy).toBeDefined();
    expect(result.legacySelfCheckFailures).toHaveLength(1);
    expect(result.legacySelfCheckFailures[0]).toContain('CHR-DRIFT-001');
    expect(result.legacySelfCheckFailures[0]).toContain('CHR-DRIFT-001-A1');
    expect(result.mismatches).toEqual([]);
    expect(result.unjudgeable).toHaveLength(1);
    expect(result.unjudgeable[0]!.outcome).toBe('inconclusive');
  });

  it('marks the comparison modern-unreachable when the modern system never answered', () => {
    const { suite } = feeFixture();
    const unreachable = execution(
      'modern',
      [outcome('transfer', { status: 'unreachable', error: 'connect ECONNREFUSED 127.0.0.1:8090' })],
      { status: 'unreachable', error: 'connect ECONNREFUSED 127.0.0.1:8090' },
    );
    const result = compareSuite({
      suite,
      modernExecutions: [{ caseId: FEE_CASE_ID, execution: unreachable }],
    });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('modern-unreachable');
    expect(comparison.inconclusiveReason).toContain('ECONNREFUSED');
    expect(comparison.mismatches).toEqual([]);
    expect(result.mismatches).toEqual([]);
    expect(result.unjudgeable).toHaveLength(1);
    expect(result.unjudgeable[0]!.outcome).toBe('modern-unreachable');
  });

  it('is inconclusive when the modern execution errored or timed out', () => {
    const { suite } = feeFixture();
    const failed = execution('modern', [outcome('transfer', { status: 'error', error: 'java.lang.IllegalStateException' })], {
      status: 'error',
      error: 'java.lang.IllegalStateException',
    });
    const result = compareSuite({
      suite,
      modernExecutions: [{ caseId: FEE_CASE_ID, execution: failed }],
    });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('inconclusive');
    expect(comparison.inconclusiveReason).toContain('ended "error"');
    expect(result.unjudgeable).toHaveLength(1);
  });

  it('is inconclusive when no modern execution was recorded', () => {
    const { suite } = feeFixture();
    const result = compareSuite({ suite, modernExecutions: [] });

    const comparison = result.comparisons[0]!;
    expect(comparison.outcome).toBe('inconclusive');
    expect(comparison.inconclusiveReason).toContain('no modern execution was recorded');
    expect(result.unjudgeable).toHaveLength(1);
  });

  it('throws an internal error when a modern execution names a case the suite does not contain', () => {
    const { suite } = feeFixture();
    let caught: unknown;
    try {
      compareSuite({
        suite,
        modernExecutions: [{ caseId: 'CHR-GHOST-001', execution: feeModern(LEGACY_FEE) }],
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PhoenixError);
    expect((caught as PhoenixError).code).toBe('INTERNAL');
    expect((caught as PhoenixError).message).toContain('does not contain');
  });

  it('builds a multi-case suite independently per case', () => {
    const first = feeCase({ caseId: 'CHR-FEE-001', legacyFee: LEGACY_FEE });
    const second = feeCase({ caseId: 'CHR-FEE-002', legacyFee: 1.5 });
    const suite = suiteOf({
      cases: [first.item, second.item],
      captures: [first.baseline, second.baseline],
    });
    const result = compareSuite({
      suite,
      modernExecutions: [
        { caseId: 'CHR-FEE-001', execution: feeModern(LEGACY_FEE) },
        { caseId: 'CHR-FEE-002', execution: feeModern(1.4) },
      ],
    });

    expect(result.comparisons.map((entry) => entry.outcome)).toEqual(['equal', 'divergent']);
    expect(result.mismatches).toHaveLength(1);
    expect(result.mismatches[0]!.scenarioId).toBe('scn_chr-fee-002');
  });

  it('ignores a seed clock instant and still reports a fee that differs', () => {
    const baseline = execution('legacy', [
      outcome('transfer', {
        httpStatus: 200,
        responseBody: { fee: LEGACY_FEE, createdAt: '2026-08-21T07:10:28.81881' },
      }),
    ]);
    const item = caseItem({
      caseId: FEE_CASE_ID,
      status: 'passing-against-legacy',
      captureExecutionId: hashStable(baseline),
      assertions: [
        assertion({
          assertionId: 'clock',
          kind: 'json-value',
          path: 'responseBody.createdAt',
          expected: '2026-08-21T07:10:28.81881',
        }),
        assertion({
          assertionId: 'fee',
          kind: 'json-value',
          path: 'responseBody.fee',
          expected: LEGACY_FEE,
        }),
      ],
    });
    const suite = suiteOf({ cases: [item], captures: [baseline] });
    const sameFee = compareSuite({
      suite,
      modernExecutions: [
        {
          caseId: FEE_CASE_ID,
          execution: execution('modern', [
            outcome('transfer', {
              httpStatus: 200,
              responseBody: { fee: LEGACY_FEE, createdAt: '2026-08-21T07:01:49Z' },
            }),
          ]),
        },
      ],
    });
    expect(sameFee.comparisons[0]!.outcome).toBe('equal');
    expect(sameFee.mismatches).toEqual([]);
    expect(sameFee.comparisons[0]!.normalizationApplied.some((entry) => entry.reason === 'clock-reading')).toBe(true);

    const wrongFee = compareSuite({
      suite,
      modernExecutions: [
        {
          caseId: FEE_CASE_ID,
          execution: execution('modern', [
            outcome('transfer', {
              httpStatus: 200,
              responseBody: { fee: 2, createdAt: '2026-08-21T07:01:49Z' },
            }),
          ]),
        },
      ],
    });
    expect(wrongFee.comparisons[0]!.outcome).toBe('divergent');
    expect(wrongFee.mismatches.map((mismatch) => mismatch.path)).toEqual(['transfer.responseBody.fee']);
  });
});

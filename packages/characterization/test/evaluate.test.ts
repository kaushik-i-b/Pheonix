import { characterizationAssertionSchema, type CharacterizationAssertion } from '@phoenix/shared';
import { describe, expect, it } from 'vitest';
import { evaluateAssertion, evaluateCase, sameValue } from '../src/evaluate.js';
import { execution, outcome } from './support.js';
import type { z } from 'zod';

type AssertionInit = Partial<z.input<typeof characterizationAssertionSchema>>;

const assertionDefaults = {
  assertionId: 'CHR-T-a1',
  description: 'test assertion',
  kind: 'json-value',
  stepId: 'read',
  expected: 1,
  sourceRuleIds: [],
  sourceInvariantIds: [],
} satisfies z.input<typeof characterizationAssertionSchema>;

function assertion(init: AssertionInit): CharacterizationAssertion {
  return characterizationAssertionSchema.parse({ ...assertionDefaults, ...init });
}

describe('evaluateAssertion', () => {
  it('satisfied when the actual value equals the captured one, including key order in objects', () => {
    const result = evaluateAssertion(
      assertion({ kind: 'json-value', stepId: 'read', path: 'responseBody', expected: { a: 1, b: 2 } }),
      execution([outcome('read', { httpStatus: 200, responseBody: { b: 2, a: 1 } })]),
    );
    expect(result.satisfied).toBe(true);
    expect(result.actual).toEqual({ b: 2, a: 1 });
    expect(result.message).toBeUndefined();
  });

  it('records the actual value and a readable message on a mismatch', () => {
    const result = evaluateAssertion(
      assertion({ kind: 'json-value', stepId: 'read', path: 'responseBody.fee', expected: '0.50' }),
      execution([outcome('read', { httpStatus: 200, responseBody: { fee: '0.51' } })]),
    );
    expect(result.satisfied).toBe(false);
    expect(result.actual).toBe('0.51');
    expect(result.message).toContain('"0.51" differs from captured "0.50"');
  });

  it('reads arrays by index and misses honestly past the end', () => {
    const base = execution([
      outcome('read', { httpStatus: 200, responseBody: { entries: [{ amount: 5 }, { amount: 7 }] } }),
    ]);
    expect(
      evaluateAssertion(
        assertion({ kind: 'json-value', stepId: 'read', path: 'responseBody.entries.1.amount', expected: 7 }),
        base,
      ).satisfied,
    ).toBe(true);
    const past = evaluateAssertion(
      assertion({ kind: 'json-value', stepId: 'read', path: 'responseBody.entries.5.amount', expected: 7 }),
      base,
    );
    expect(past.satisfied).toBe(false);
    expect(past.message).toContain('is absent from this execution');
  });

  it('fails an assertion whose step never ran, and names the step', () => {
    const result = evaluateAssertion(
      assertion({ kind: 'http-status', stepId: 'later', expected: 200 }),
      execution([outcome('read', { httpStatus: 200 })]),
    );
    expect(result.satisfied).toBe(false);
    expect(result.message).toContain('step later did not run');
  });

  it('applies a tolerance to numbers only', () => {
    const within = evaluateAssertion(
      assertion({ kind: 'json-value', stepId: 'read', path: 'responseBody.rate', expected: 1.005, tolerance: 0.01 }),
      execution([outcome('read', { httpStatus: 200, responseBody: { rate: 1.012 } })]),
    );
    expect(within.satisfied).toBe(true);

    const beyond = evaluateAssertion(
      assertion({ kind: 'json-value', stepId: 'read', path: 'responseBody.rate', expected: 1.005, tolerance: 0.01 }),
      execution([outcome('read', { httpStatus: 200, responseBody: { rate: 1.2 } })]),
    );
    expect(beyond.satisfied).toBe(false);
    expect(beyond.message).toContain('by more than ±0.01');

    // A tolerance recorded on a string assertion cannot make two different strings equal.
    const textual = evaluateAssertion(
      assertion({ kind: 'text-value', stepId: 'read', path: 'responseHeaders.x-mode', expected: 'strict', tolerance: 1 }),
      execution([outcome('read', { httpStatus: 200, responseHeaders: { 'x-mode': 'loose' } })]),
    );
    expect(textual.satisfied).toBe(false);
  });

  it.each([
    ['http-status', { httpStatus: 404 } as const, 404],
    ['row-count', { rowCount: 3 } as const, 3],
    ['exit-code', { exitCode: 2 } as const, 2],
  ] as const)('evaluates the %s kind off the recorded outcome', (kind, fields, expected) => {
    const result = evaluateAssertion(
      assertion({ kind, stepId: 'read', path: kind === 'http-status' ? 'httpStatus' : kind === 'row-count' ? 'rowCount' : 'exitCode', expected }),
      execution([outcome('read', fields)]),
    );
    expect(result.satisfied).toBe(true);
  });

  it('judges error-present by the step status', () => {
    const failed = evaluateAssertion(
      assertion({ kind: 'error-present', stepId: 'read', path: 'status', expected: 'failed' }),
      execution([outcome('read', { status: 'failed', error: 'boom' })]),
    );
    expect(failed.satisfied).toBe(true);

    const unexpectedlyFine = evaluateAssertion(
      assertion({ kind: 'error-present', stepId: 'read', path: 'status', expected: 'failed' }),
      execution([outcome('read', { httpStatus: 200 })]),
    );
    expect(unexpectedlyFine.satisfied).toBe(false);
  });

  it('refuses to evaluate a kind capture never produces', () => {
    // The schema is the first line of defence and rejects this shape outright; the cast gets past it
    // so the evaluator's own guard — for a kind that slips through some future schema change — is
    // still proven to fire rather than fail open.
    const hostile = { ...assertion({ kind: 'http-status', stepId: 'read', expected: 200 }), kind: 'response-time' } as unknown as CharacterizationAssertion;
    expect(() =>
      evaluateAssertion(hostile, execution([outcome('read', { httpStatus: 200 })])),
    ).toThrow(/not produced by capture/);
  });
});

describe('evaluateCase', () => {
  it('passes only when every assertion host policy does not excuse was satisfied', () => {
    const execution_ = execution([outcome('read', { httpStatus: 200, responseBody: { balance: '10.00' } })]);
    const item = {
      caseId: 'CHR-T',
      assertions: [
        assertion({ assertionId: 'a1', kind: 'http-status', stepId: 'read', path: 'httpStatus', expected: 200 }),
        assertion({ assertionId: 'a2', kind: 'json-value', stepId: 'read', path: 'responseBody.balance', expected: '10.00' }),
      ],
    };
    expect(evaluateCase(item, execution_).passed).toBe(true);
  });

  it('reports a normalized mismatch without counting it as a failure, keeping both values', () => {
    const execution_ = execution([outcome('read', { httpStatus: 200, responseBody: { transferId: 'tx_other' } })]);
    const item = {
      caseId: 'CHR-T',
      assertions: [
        assertion({
          assertionId: 'a1',
          kind: 'http-status',
          stepId: 'read',
          path: 'httpStatus',
          expected: 200,
        }),
        assertion({
          assertionId: 'a2',
          kind: 'json-value',
          stepId: 'read',
          path: 'responseBody.transferId',
          expected: 'tx_first',
          normalized: true,
          normalization: {
            reason: 'varied-across-repeated-legacy-executions',
            policy: '"transferId" ends in an identifier suffix',
            observedValues: ['tx_first', 'tx_second'],
          },
        }),
      ],
    };

    const evaluation = evaluateCase(item, execution_);
    expect(evaluation.passed).toBe(true);
    expect(evaluation.normalizedMismatches).toHaveLength(1);
    expect(evaluation.normalizedMismatches[0]?.assertionId).toBe('a2');
    expect(evaluation.normalizedMismatches[0]?.expected).toBe('tx_first');
    expect(evaluation.normalizedMismatches[0]?.actual).toBe('tx_other');
    expect(evaluation.results).toHaveLength(2);
  });

  it('collects the steps the execution never reached', () => {
    const item = {
      caseId: 'CHR-T',
      assertions: [
        assertion({ assertionId: 'a1', kind: 'http-status', stepId: 'read', path: 'httpStatus', expected: 200 }),
        assertion({ assertionId: 'a2', kind: 'http-status', stepId: 'audit', path: 'httpStatus', expected: 200 }),
      ],
    };
    const evaluation = evaluateCase(item, execution([outcome('read', { httpStatus: 200 })]));
    expect(evaluation.missingStepIds).toEqual(['audit']);
    expect(evaluation.passed).toBe(false);
  });
});

describe('sameValue', () => {
  it.each([
    [1, 1, true],
    ['a', 'b', false],
    [null, null, true],
    [null, undefined, false],
    [{ a: 1 }, { a: 1 }, true],
    [[1, { x: 'y' }], [1, { x: 'y' }], true],
    [1, '1', false],
  ])('sameValue(%j, %j) → %j', (left, right, expected) => {
    expect(sameValue(left, right)).toBe(expected);
  });
});

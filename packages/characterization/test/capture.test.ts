import { describe, expect, it } from 'vitest';
import type { ScenarioExecution, StepOutcome } from '@phoenix/shared';
import { deriveAssertions } from '../src/index.js';
import { execution, outcome } from './support.js';

/**
 * The capture is the contract. Every expected value must be traceable to something legacy actually
 * returned, and the only values excused from comparison are the ones legacy itself failed to
 * reproduce *and* host policy classes as uncomparable. These tests hold both halves of that
 * conjunction, because either half alone would let a real difference through.
 */

function bankRead(body: Record<string, unknown>, overrides: Partial<StepOutcome> = {}): StepOutcome {
  return outcome('read', {
    httpStatus: 200,
    responseBody: body,
    responseHeaders: {
      'content-type': 'application/json',
      'content-length': '1234',
      'x-legacy-mode': 'classic',
      date: 'Wed, 01 Oct 2026 00:00:00 GMT',
    },
    ...overrides,
  });
}

function pair(baseline: StepOutcome[], probe: StepOutcome[]): { baseline: ScenarioExecution; probe: ScenarioExecution } {
  return { baseline: execution(baseline), probe: execution(probe) };
}

describe('deriveAssertions', () => {
  it('freezes the baseline values as the expectations and nothing else', () => {
    const { baseline, probe } = pair(
      [bankRead({ balance: '10.00', fee: '0.50' })],
      [bankRead({ balance: '10.00', fee: '0.50' })],
    );

    const result = deriveAssertions({ caseId: 'CHR-TEST', baseline, probe, targetRuleIds: [], targetInvariantIds: [] });

    const balance = result.assertions.find((a) => a.path === 'responseBody.balance');
    expect(balance?.expected).toBe('10.00');
    expect(balance?.normalized).toBe(false);
    // Status line first, then body leaves in field order.
    expect(balance?.assertionId).toBe('CHR-TEST-a2');
    // Deterministic on both runs: there is nothing to excuse.
    expect(result.normalized).toEqual([]);
    expect(result.unexplainedVolatility).toEqual([]);
  });

  it('excuses a value only when it varied across runs AND policy names it uncomparable', () => {
    const { baseline, probe } = pair(
      [bankRead({ transferId: 'tx_first', createdAt: '2026-01-01T00:00:00Z', balance: '10.00' })],
      [bankRead({ transferId: 'tx_second', createdAt: '2026-01-01T00:00:01Z', balance: '10.00' })],
    );

    const result = deriveAssertions({ caseId: 'CHR-TEST', baseline, probe, targetRuleIds: [], targetInvariantIds: [] });

    const minted = result.assertions.filter((a) => a.normalized);
    expect(minted.map((a) => a.path).sort()).toEqual(['responseBody.createdAt', 'responseBody.transferId']);
    expect(minted[0]?.normalization?.reason).toBe('varied-across-repeated-legacy-executions');
    expect(minted[0]?.normalization?.observedValues).toEqual(['tx_first', 'tx_second']);
    expect(result.normalized.map((entry) => entry.path).sort()).toEqual([
      'responseBody.createdAt',
      'responseBody.transferId',
    ]);
  });

  it('keeps an identifier-named value live when legacy reproduces it exactly', () => {
    const { baseline, probe } = pair([bankRead({ requestId: 'req-1' })], [bankRead({ requestId: 'req-1' })]);

    const result = deriveAssertions({ caseId: 'CHR-TEST', baseline, probe, targetRuleIds: [], targetInvariantIds: [] });

    const request = result.assertions.find((a) => a.path === 'responseBody.requestId');
    // Policy would excuse a varying requestId; it varied nothing, so it stays a real expectation.
    expect(request?.normalized).toBe(false);
    expect(result.normalized).toEqual([]);
  });

  it('refuses to excuse a business value that varies, and says the scenario was not repeatable', () => {
    const { baseline, probe } = pair([bankRead({ fee: '0.50' })], [bankRead({ fee: '2.01' })]);

    const result = deriveAssertions({ caseId: 'CHR-TEST', baseline, probe, targetRuleIds: [], targetInvariantIds: [] });

    const fee = result.assertions.find((a) => a.path === 'responseBody.fee');
    expect(fee?.expected).toBe('0.50');
    expect(fee?.normalized).toBe(false);
    expect(result.unexplainedVolatility).toEqual(['read.responseBody.fee']);
  });

  it('drops transport headers from the suite without probe evidence', () => {
    const { baseline, probe } = pair([bankRead({})], [bankRead({})]);

    const result = deriveAssertions({ caseId: 'CHR-TEST', baseline, probe, targetRuleIds: [], targetInvariantIds: [] });

    const headerPaths = result.assertions.filter((a) => a.path?.startsWith('responseHeaders.')).map((a) => a.path);
    // `date` and `content-length` describe the transport; `content-type` and `x-legacy-mode`
    // are the application's own and stay asserted.
    expect(headerPaths).toEqual(['responseHeaders.content-type', 'responseHeaders.x-legacy-mode']);
  });

  it('asserts the status line, row counts, exit codes and recorded failures as separate expectations', () => {
    const baseline = execution([
      outcome('query', { kind: 'sql', rowCount: 3, rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
      outcome('reject', { kind: 'command', status: 'failed', exitCode: 2, stderr: 'insufficient funds' }),
      outcome('gone', { httpStatus: 404 }),
    ]);
    const probe = execution([
      outcome('query', { kind: 'sql', rowCount: 3, rows: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }),
      outcome('reject', { kind: 'command', status: 'failed', exitCode: 2, stderr: 'insufficient funds' }),
      outcome('gone', { httpStatus: 404 }),
    ]);

    const result = deriveAssertions({ caseId: 'CHR-TEST', baseline, probe, targetRuleIds: [], targetInvariantIds: [] });

    expect(result.assertions.find((a) => a.stepId === 'query' && a.kind === 'row-count')?.expected).toBe(3);
    expect(result.assertions.find((a) => a.stepId === 'reject' && a.kind === 'exit-code')?.expected).toBe(2);
    expect(result.assertions.find((a) => a.stepId === 'reject' && a.kind === 'error-present')?.expected).toBe('failed');
    expect(result.assertions.find((a) => a.stepId === 'gone' && a.kind === 'http-status')?.expected).toBe(404);
  });

  it('treats a step the second run never reached as volatility, not as agreement', () => {
    const { baseline, probe } = pair([bankRead({ balance: '10.00' })], []);

    const result = deriveAssertions({ caseId: 'CHR-TEST', baseline, probe, targetRuleIds: [], targetInvariantIds: [] });

    // A half-executed repeat must not make the unexecuted half look stable.
    expect(result.assertions.length).toBeGreaterThan(0);
    expect(result.assertions.every((a) => a.normalized)).toBe(false);
    expect(result.unexplainedVolatility).toContain('read.responseBody.balance');
  });

  it('counts assertions it had to drop against the per-case cap', () => {
    const body = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`k${index}`, index]));
    const { baseline, probe } = pair([bankRead(body)], [bankRead(body)]);

    const result = deriveAssertions({
      caseId: 'CHR-TEST',
      baseline,
      probe,
      targetRuleIds: [],
      targetInvariantIds: [],
      maxAssertions: 5,
    });

    expect(result.assertions).toHaveLength(5);
    expect(result.truncated).toBe(10);
  });
});

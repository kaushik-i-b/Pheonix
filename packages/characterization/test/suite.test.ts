import { describe, expect, it } from 'vitest';
import type { Scenario } from '@phoenix/shared';
import type { ScenarioTarget } from '../src/executor.js';
import { captureSuite, type ProposedCase } from '../src/suite.js';
import { httpStep, scenario, startServer, UNREACHABLE_BASE_URL } from './support.js';

/**
 * The full capture pipeline against a real HTTP server — the same code path CHARACTERIZE runs
 * against legacy-bank. Every expectation in the produced suite has to be traceable to a value the
 * stub actually returned, which is why the stub echoes deterministic bodies rather than a canned
 * fixture.
 */

const RULES = ['BR-TRANSFER-FEE'];
const INVARIANTS = ['INV-BALANCE-NONNEGATIVE'];

function target(baseUrl: string): ScenarioTarget {
  return { system: 'legacy', label: 'test-legacy', baseUrl };
}

function proposal(caseId: string, scenario_: Scenario): ProposedCase {
  return { caseId, scenario: scenario_ };
}

describe('captureSuite', () => {
  it('freezes what the server actually returned into a self-consistent suite', async () => {
    const server = await startServer(() => ({
      status: 201,
      body: JSON.stringify({ accountId: 'acc_1', balance: '100.00', currency: 'USD' }),
    }));
    try {
      const events: string[] = [];
      const { suite, cases, skipped } = await captureSuite({
        capturedFrom: 'legacy-bank@stub',
        generatedBy: 'characterization-engineer',
        proposals: [
          proposal(
            'CHR-SUITE-1',
            scenario([httpStep('open', '/accounts', { method: 'POST', body: { name: 'ann' } })], {
              targetRuleIds: RULES,
              targetInvariantIds: INVARIANTS,
            }),
          ),
        ],
        knownRuleIds: RULES,
        knownInvariantIds: INVARIANTS,
        target: target(server.baseUrl),
        onProgress: (event) => {
          if (event.phase === 'captured') events.push(`${event.caseId}:${event.status}`);
          else events.push(`${event.caseId}:${event.phase}`);
        },
      });

      expect(skipped).toEqual([]);
      expect(events).toEqual(['CHR-SUITE-1:baseline', 'CHR-SUITE-1:probe', 'CHR-SUITE-1:passing-against-legacy']);

      const item = cases[0];
      expect(item?.item.status).toBe('passing-against-legacy');
      expect(item?.selfCheck.passed).toBe(true);

      // The expectations are the values the stub returned, not values anyone authored.
      const status = item?.item.assertions.find((a) => a.path === 'httpStatus');
      const balance = item?.item.assertions.find((a) => a.path === 'responseBody.balance');
      expect(status?.expected).toBe(201);
      expect(balance?.expected).toBe('100.00');
      expect(item?.item.assertions.every((a) => a.sourceRuleIds.length > 0)).toBe(true);
      expect(item?.item.targetRuleIds).toEqual(RULES);

      // Baseline and probe both recorded — the pair is the volatility evidence.
      expect(suite.captures).toHaveLength(2);
      expect(suite.cases).toHaveLength(1);
      expect(suite.coverage.ruleIdsCovered).toEqual(RULES);
      expect(suite.statistics).toMatchObject({ total: 1, captured: 1 });
      expect((suite.statistics?.assertions ?? 0)).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });

  it('excuses a per-request identifier only after the probe caught it varying', async () => {
    let minted = 0;
    const server = await startServer(() => {
      minted += 1;
      return { body: JSON.stringify({ requestId: `req_${minted}`, balance: '50.00' }) };
    });
    try {
      const { cases } = await captureSuite({
        capturedFrom: 'legacy-bank@stub',
        generatedBy: 'characterization-engineer',
        proposals: [proposal('CHR-SUITE-1', scenario([httpStep('read', '/accounts')]))],
        knownRuleIds: RULES,
        knownInvariantIds: INVARIANTS,
        target: target(server.baseUrl),
      });

      const item = cases[0];
      expect(item?.item.status).toBe('passing-against-legacy');
      const requestId = item?.item.assertions.find((a) => a.path === 'responseBody.requestId');
      expect(requestId?.normalized).toBe(true);
      expect(requestId?.normalization?.reason).toBe('varied-across-repeated-legacy-executions');
      expect(item?.capture.unexplainedVolatility).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it('keeps a varying business value in the comparison and marks the case unrepeatable', async () => {
    let calls = 0;
    const server = await startServer(() => {
      calls += 1;
      return { body: JSON.stringify({ balance: calls === 1 ? '10.00' : '20.00' }) };
    });
    try {
      const { cases } = await captureSuite({
        capturedFrom: 'legacy-bank@stub',
        generatedBy: 'characterization-engineer',
        proposals: [proposal('CHR-SUITE-1', scenario([httpStep('read', '/accounts')]))],
        knownRuleIds: RULES,
        knownInvariantIds: INVARIANTS,
        target: target(server.baseUrl),
      });

      const item = cases[0];
      // Self-check still holds (assertions came from this baseline), but the fixture is marked:
      // legacy did not reproduce itself, so this case is not a trustworthy judge.
      expect(item?.item.status).toBe('passing-against-legacy');
      expect(item?.item.unexplainedVolatility).toEqual(['read.responseBody.balance']);
      const balance = item?.item.assertions.find((a) => a.path === 'responseBody.balance');
      expect(balance?.normalized).toBe(false);
    } finally {
      await server.close();
    }
  });

  it('skips a scenario whose target never answers, and says why', async () => {
    const { suite, cases, skipped } = await captureSuite({
      capturedFrom: 'legacy-bank@stub',
      generatedBy: 'characterization-engineer',
      proposals: [proposal('CHR-SUITE-1', scenario([httpStep('read', '/accounts')]))],
      knownRuleIds: RULES,
      knownInvariantIds: INVARIANTS,
      target: target(UNREACHABLE_BASE_URL),
      executor: { defaultTimeoutMs: 300 },
    });

    expect(cases).toEqual([]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toContain('never answered');
    expect(suite.cases).toHaveLength(0);
  });

  it('characterizes a scenario legacy cannot even serve as an error fixture, not a skip', async () => {
    const server = await startServer(() => ({ body: '{"ok":true}' }));
    try {
      const { cases, skipped } = await captureSuite({
        capturedFrom: 'legacy-bank@stub',
        generatedBy: 'characterization-engineer',
        proposals: [
          proposal('CHR-SUITE-1', scenario([httpStep('ghost', '/x/{{never.captured}}')])),
        ],
        knownRuleIds: RULES,
        knownInvariantIds: INVARIANTS,
        target: target(server.baseUrl),
      });

      // Nothing was skipped: legacy genuinely failed this scenario, and that failure — recorded,
      // not thrown away — is exactly what the fixture must demand of the modern system too.
      expect(skipped).toEqual([]);
      const item = cases[0];
      expect(item?.baseline.status).toBe('failed');
      expect(item?.item.status).toBe('passing-against-legacy');
      const errorPresent = item?.item.assertions.find((a) => a.kind === 'error-present');
      expect(errorPresent?.expected).toBe('error');
    } finally {
      await server.close();
    }
  });

  it('marks a scenario inconclusive when legacy times out mid-capture', async () => {
    const server = await startServer(() => ({ body: '{"ok":true}', delayMs: 400 }));
    try {
      const { cases, skipped } = await captureSuite({
        capturedFrom: 'legacy-bank@stub',
        generatedBy: 'characterization-engineer',
        proposals: [proposal('CHR-SUITE-1', scenario([httpStep('read', '/accounts', { timeoutMs: 60 })]))],
        knownRuleIds: RULES,
        knownInvariantIds: INVARIANTS,
        target: target(server.baseUrl),
      });

      expect(skipped).toEqual([]);
      const item = cases[0];
      expect(item?.baseline.status).toBe('timeout');
      expect(item?.item.status).toBe('inconclusive');
    } finally {
      await server.close();
    }
  });

  it('tells the truth about rule coverage, including what nothing targeted', async () => {
    const server = await startServer(() => ({ body: '{"ok":true}' }));
    try {
      const { suite, skipped } = await captureSuite({
        capturedFrom: 'legacy-bank@stub',
        generatedBy: 'characterization-engineer',
        proposals: [
          proposal(
            'CHR-SUITE-1',
            scenario([httpStep('read', '/ok')], { targetRuleIds: ['BR-TRANSFER-FEE'] }),
          ),
          proposal('CHR-SUITE-2', scenario([httpStep('read', '/ok')])),
        ],
        knownRuleIds: ['BR-TRANSFER-FEE', 'BR-OVERDRAFT'],
        knownInvariantIds: INVARIANTS,
        target: target(server.baseUrl),
      });

      expect(skipped).toEqual([]);
      expect(suite.coverage.ruleIdsCovered).toEqual(['BR-TRANSFER-FEE']);
      expect(suite.coverage.ruleIdsUncovered).toEqual(['BR-OVERDRAFT']);
      expect(suite.coverage.invariantIdsUncovered).toEqual(INVARIANTS);
    } finally {
      await server.close();
    }
  });

  it('resets the target before the baseline and again before the repeat', async () => {
    const server = await startServer(() => ({ body: '{"ok":true}' }));
    let resets = 0;
    try {
      const { skipped } = await captureSuite({
        capturedFrom: 'legacy-bank@stub',
        generatedBy: 'characterization-engineer',
        proposals: [proposal('CHR-RESET-1', scenario([httpStep('read', '/ok')]))],
        knownRuleIds: RULES,
        knownInvariantIds: INVARIANTS,
        target: {
          ...target(server.baseUrl),
          reset: async () => {
            resets += 1;
          },
        },
      });
      expect(skipped).toEqual([]);
      expect(resets).toBe(2);
    } finally {
      await server.close();
    }
  });
});

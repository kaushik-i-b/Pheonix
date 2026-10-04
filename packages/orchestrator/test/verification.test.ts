import { createServer, type Server } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureSuite, type ScenarioTarget } from '@phoenix/characterization';
import { EventSequencer, InMemoryEventSink, runIdSchema, type CharacterizationSuite } from '@phoenix/shared';
import { MockLlmProvider } from '@phoenix/llm/testing';
import {
  createRunRuntime,
  caseIdFor,
  modelScenarioSchema,
  modernizationChangeReportSchema,
  runVerificationStage,
  toScenario,
  type RunRuntime,
} from '../src/index.js';
import {
  cleanupTemporaryDirectories,
  createLegacyFixture,
  fixtureConfig,
  silentLogger,
} from './support.js';

/**
 * The differential verifier against live stubs: one clean pass, one genuine rounding divergence,
 * and the two ways the modern system can fail to even be judged. The fee arithmetic below is an
 * independent BigInt reimplementation of the legacy contract — the tests compute expected values
 * the same way the capture asserts them, never by copying whatever the stub happened to answer.
 */

const fixture = createLegacyFixture();
afterAll(cleanupTemporaryDirectories);

const RULE_ID = 'BR-FEE-HALF-UP';
const INVARIANT_ID = 'INV-FEE-TWO-DECIMALS';

/** `run_<32 lowercase alphanumerics>` per the run id schema; deterministic so artifacts are stable. */
function runIdFor(name: string): string {
  return runIdSchema.parse(`run_${name}${'0'.repeat(32 - name.length)}`);
}

/** The legacy contract, reimplemented exactly: amount in thousandths of a unit, fee in cents. */
function feeCents(amount: string, mode: 'half-up' | 'half-even'): number {
  const [whole = '0', fraction = ''] = amount.split('.');
  const thousandths = BigInt(whole + fraction.padEnd(3, '0').slice(0, 3));
  const quotient = thousandths / 2000n;
  const remainder = thousandths % 2000n;
  const twice = remainder * 2n;
  let cents = quotient;
  if (mode === 'half-up') {
    if (twice >= 2000n) cents += 1n;
  } else if (twice > 2000n || (twice === 2000n && quotient % 2n === 1n)) {
    cents += 1n;
  }
  if (cents < 25n) cents = 25n;
  return Number(cents);
}

interface FeeServer {
  target: ScenarioTarget;
  close: () => Promise<void>;
}

function startFeeServer(options: { mode: 'half-up' | 'half-even'; resetStatus?: number }): Promise<FeeServer> {
  return new Promise((resolve, reject) => {
    const server: Server = createServer((request, response) => {
      if (request.method === 'POST' && request.url === '/test/reset') {
        response.writeHead(options.resetStatus ?? 200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: (options.resetStatus ?? 200) < 300 }));
        return;
      }
      const url = new URL(request.url ?? '/', 'http://localhost');
      const amount = url.searchParams.get('amount') ?? '401.00';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ fee: feeCents(amount, options.mode) / 100, currency: 'USD' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('stub server has no port'));
        return;
      }
      resolve({
        target: {
          system: 'legacy',
          label: `stub-${options.mode}`,
          baseUrl: `http://127.0.0.1:${address.port}`,
        },
        close: () =>
          new Promise<void>((done, fail) => {
            server.close((error) => (error !== undefined && error !== null ? fail(error) : done()));
          }),
      });
    });
  });
}

function feeScenario() {
  return toScenario(
    modelScenarioSchema.parse({
      title: 'Fee on a 401.00 transfer',
      description: 'Query the fee endpoint for 401.00 and freeze the exact amount the legacy system answers.',
      category: 'boundary',
      hypothesis: 'The fee rounds half up to exactly 2.01, exercising the tie at the third decimal.',
      targetRuleIds: [RULE_ID],
      targetInvariantIds: [INVARIANT_ID],
      steps: [
        {
          stepId: 'get-fee',
          description: 'GET /api/fees?amount=401.00',
          kind: 'http',
          http: { method: 'GET', path: '/api/fees', query: { amount: '401.00' } },
        },
      ],
      rationale: 'The half-up tie is the rule most likely to be broken by a naive implementation.',
    }),
  );
}

function changeReport(resetPath = '/test/reset') {
  return modernizationChangeReportSchema.parse({
    generatedAt: '2026-10-01T00:00:00.000Z',
    generatedBy: 'modernizer:tsk_verification_test',
    summary: 'Minimal fee service exposing GET /api/fees and a POST reset endpoint.',
    entryPoint: 'implementation.mjs',
    resetPath,
    files: [{ path: 'implementation.mjs', bytes: 10, sha256: 'a'.repeat(64) }],
  });
}

function stageRuntime(fixtureRoot: typeof fixture, sink: InMemoryEventSink, runId: string): RunRuntime {
  const events = new EventSequencer([sink], (_name, error) => {
    throw error;
  });
  return createRunRuntime({
    config: fixtureConfig(fixtureRoot),
    runId,
    provider: new MockLlmProvider({ responses: [] }),
    events,
    logger: silentLogger(),
  });
}

describe('runVerificationStage', () => {
  let legacyStub: FeeServer | undefined;
  let suite: CharacterizationSuite;

  beforeAll(async () => {
    const stub = await startFeeServer({ mode: 'half-up' });
    legacyStub = stub;
    const captured = await captureSuite({
      capturedFrom: 'stub-legacy HALF_UP',
      generatedBy: 'characterization-engineer',
      proposals: [{ caseId: caseIdFor(0), scenario: feeScenario() }],
      knownRuleIds: [RULE_ID],
      knownInvariantIds: [INVARIANT_ID],
      target: stub.target,
    });
    suite = captured.suite;
  });

  afterAll(async () => {
    await legacyStub?.close();
  });

  it('passes when the modern system reproduces the captured baseline exactly', async () => {
    const sink = new InMemoryEventSink();
    const runtime = stageRuntime(fixture, sink, runIdFor('verifyequivalent'));
    const target = await startFeeServer({ mode: 'half-up' });
    try {
      const outcome = await runVerificationStage({
        runId: runIdFor('verifyequivalent'),
        runtime,
        suite,
        changeReport: changeReport(),
        target: target.target,
      });

      expect(outcome.verdict.verdict).toBe('EQUIVALENT');
      expect(outcome.mismatches).toEqual([]);
      expect(outcome.executedCaseIds).toEqual(['CHR-001']);
      expect(outcome.skippedCaseIds).toEqual([]);
      expect(outcome.resetFailures).toEqual([]);
      expect(outcome.report.statistics.equal).toBe(1);
      expect(outcome.report.statistics.mismatches).toBe(0);

      const byId = new Map(outcome.verdict.checks.map((check) => [check.checkId, check]));
      expect(byId.get('modern-startup')?.status).toBe('PASS');
      expect(byId.get('modern-reset')?.status).toBe('PASS');
      expect(byId.get('differential-equivalence')?.status).toBe('PASS');

      const results = sink.ofType('verification.result');
      expect(results).toHaveLength(1);
      expect(results[0]?.verdict).toBe('EQUIVALENT');
      expect(results[0]?.scenariosExecuted).toBe(1);
      expect(sink.ofType('failure.discovered')).toEqual([]);
      const executed = sink.ofType('test.executed');
      expect(executed).toHaveLength(1);
      expect(executed[0]?.target).toBe('modern');
      runtime.close();
    } finally {
      await target.close();
    }
  });

  it('reports a genuine precision mismatch with the exact divergent values', async () => {
    const sink = new InMemoryEventSink();
    const runtime = stageRuntime(fixture, sink, runIdFor('verifydivergent'));
    const target = await startFeeServer({ mode: 'half-even' });
    try {
      const outcome = await runVerificationStage({
        runId: runIdFor('verifydivergent'),
        runtime,
        suite,
        changeReport: changeReport(),
        target: target.target,
      });

      expect(outcome.verdict.verdict).toBe('NOT_EQUIVALENT');
      expect(outcome.mismatches).toHaveLength(1);
      const mismatch = outcome.mismatches[0];
      if (mismatch === undefined) throw new Error('expected one mismatch');
      expect(mismatch.mismatchId).toBe('CHR-001-M1');
      expect(mismatch.scenarioId).toBe(suite.cases[0]?.scenario.scenarioId);
      expect(mismatch.differenceKind).toBe('precision');
      expect(mismatch.path).toBe('get-fee.responseBody.fee');
      expect(mismatch.legacyValue).toBe(2.01);
      expect(mismatch.modernValue).toBe(2);
      expect(mismatch.severity).toBe('MAJOR');
      expect(mismatch.relevantRuleIds).toEqual([RULE_ID]);
      expect(mismatch.relevantInvariantIds).toEqual([INVARIANT_ID]);
      expect(mismatch.explanationStatus).toBe('unexplained');

      expect(outcome.verdict.repairTargets).toEqual(['CHR-001-M1']);

      const failures = sink.ofType('failure.discovered');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.kind).toBe('behavioral-mismatch');
      expect(failures[0]?.summary).toContain('legacy 2.01 vs modern 2');
    } finally {
      await target.close();
      runtime.close();
    }
  });

  it('fails the startup check when the modern system never becomes healthy', async () => {
    const sink = new InMemoryEventSink();
    const runtime = stageRuntime(fixture, sink, runIdFor('verifystartupfailure'));
    mkdirSync(join(runtime.paths.modernRoot), { recursive: true });
    writeFileSync(join(runtime.paths.modernRoot, 'run.sh'), '#!/usr/bin/env bash\nexit 3\n', { mode: 0o755 });

    const outcome = await runVerificationStage({
      runId: runIdFor('verifystartupfailure'),
      runtime,
      suite,
      changeReport: changeReport(),
    });

    expect(outcome.modern.started).toBe(false);
    expect(outcome.modern.startupError).toContain('exit code 3');
    expect(outcome.executedCaseIds).toEqual([]);
    expect(outcome.verdict.verdict).toBe('NOT_EQUIVALENT');

    const byId = new Map(outcome.verdict.checks.map((check) => [check.checkId, check]));
    expect(byId.get('modern-startup')?.status).toBe('FAIL');
    expect(byId.has('modern-reset')).toBe(false);
    expect(byId.get('differential-equivalence')?.status).toBe('UNKNOWN');
    runtime.close();
  });

  it('fails the reset check when the modern reset endpoint errors', async () => {
    const sink = new InMemoryEventSink();
    const runtime = stageRuntime(fixture, sink, runIdFor('verifyresetfailure'));
    const target = await startFeeServer({ mode: 'half-up', resetStatus: 500 });
    try {
      const outcome = await runVerificationStage({
        runId: runIdFor('verifyresetfailure'),
        runtime,
        suite,
        changeReport: changeReport(),
        target: target.target,
      });

      expect(outcome.resetFailures).toHaveLength(1);
      expect(outcome.resetFailures[0]).toContain('HTTP 500');
      expect(outcome.mismatches).toEqual([]);
      const byId = new Map(outcome.verdict.checks.map((check) => [check.checkId, check]));
      expect(byId.get('modern-reset')?.status).toBe('FAIL');
      expect(outcome.verdict.verdict).toBe('NOT_EQUIVALENT');
    } finally {
      await target.close();
      runtime.close();
    }
  });
});

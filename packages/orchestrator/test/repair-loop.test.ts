import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { captureSuite, type ScenarioTarget } from '@phoenix/characterization';
import { EventSequencer, InMemoryEventSink, runIdSchema, type CharacterizationSuite } from '@phoenix/shared';
import { MockLlmProvider, jsonResponse } from '@phoenix/llm/testing';
import {
  analystReportSchema,
  caseIdFor,
  classifyRepair,
  createRunRuntime,
  modelScenarioSchema,
  modernizationChangeReportSchema,
  renderRepairBrief,
  runModernizationLoop,
  runVerificationStage,
  toBusinessRuleSet,
  toInvariantSet,
  toScenario,
  type RunRuntime,
} from '../src/index.js';
import {
  BATCH_FEE_PATH,
  FEE_SERVICE_PATH,
  cleanupTemporaryDirectories,
  createLegacyFixture,
  fixtureCitation,
  fixtureConfig,
  silentLogger,
} from './support.js';

/**
 * The repair loop end to end: a first implementation that diverges on a real tie-breaking rule,
 * the diagnosis built from that divergence, the repair that follows it, and the re-verification
 * that passes. The modernization stage runs for real — scripted model answers pass through the
 * persister, the workspace is rewritten on disk, and the loop is served by two HTTP stubs through
 * `targetFor`, so no process is ever spawned for the modern side.
 *
 * The final probe imports the bytes the persister actually wrote with plain Node and recomputes
 * the fee, so the test pins the one thing that matters: what repair changed is the code on disk.
 */

const fixture = createLegacyFixture();
afterAll(cleanupTemporaryDirectories);

const RULE_ID = 'BR-FEE-HALF-UP';
const INVARIANT_ID = 'INV-FEE-TWO-DECIMALS';
const HALF_UP = 'setScale(2, RoundingMode.HALF_UP)';

const ATTRIBUTION = {
  generatedAt: '2026-10-01T00:00:00.000Z',
  generatedBy: 'business-rule-analyst:tsk_repair_loop_test',
  targetRoot: '/tmp/legacy',
};

/** `run_<32 lowercase alphanumerics>` per the run id schema; deterministic so artifacts are stable. */
function runIdFor(name: string): string {
  return runIdSchema.parse(`run_${name}${'0'.repeat(32 - name.length)}`);
}

function specification() {
  const ruleCitation = fixtureCitation(fixture.root, FEE_SERVICE_PATH, HALF_UP);
  const report = analystReportSchema.parse({
    summary:
      'The fee pipeline computes a percentage fee per transfer, floors it at a minimum, and rounds it to two decimal places using HALF_UP.',
    rules: [
      {
        ruleId: RULE_ID,
        title: 'Transfer fee rounds half up to two decimals',
        description:
          'FeeService charges 0.5% of the transfer amount, never below the configured minimum, rounded to two decimals with RoundingMode.HALF_UP.',
        kind: 'calculation',
        epistemicStatus: 'INFERRED',
        confidence: 0.9,
        confidenceBasis: 'The rounding mode is read directly from the source; the rate itself comes from configuration.',
        sourceEvidence: [ruleCitation],
        affectedComponents: ['FeeService'],
        observableBehavior:
          'The fee on a transfer is 0.5% of the amount, rounded to two decimals with RoundingMode.HALF_UP, and never below the configured minimum.',
        edgeCases: [],
        duplicateImplementations: [BATCH_FEE_PATH],
      },
    ],
    invariants: [
      {
        invariantId: INVARIANT_ID,
        statement: 'Every fee returned by the fee service has exactly two decimal places.',
        kind: 'rounding-stability',
        criticality: 'MAJOR',
        scope: { components: ['FeeService'], operations: ['GET /api/fees'] },
        epistemicStatus: 'INFERRED',
        confidence: 0.85,
        sourceEvidence: [ruleCitation],
        checkingStrategy: {
          kind: 'differential-scenario',
          detail: 'Compare the fee the modern system returns with the captured legacy baseline for the same request.',
        },
        violationSeverity: 'MAJOR',
        derivedFromRuleIds: [RULE_ID],
      },
    ],
    unknowns: [],
  });
  return {
    rules: toBusinessRuleSet(report, ATTRIBUTION),
    invariants: toInvariantSet(report, ATTRIBUTION),
  };
}

const { rules, invariants } = specification();

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
    generatedBy: 'modernizer:tsk_repair_loop_test',
    summary: 'Minimal fee service exposing GET /api/fees and a POST reset endpoint.',
    entryPoint: 'implementation.mjs',
    resetPath,
    files: [{ path: 'implementation.mjs', bytes: 10, sha256: 'a'.repeat(64) }],
  });
}

function stageRuntime(
  fixtureRoot: typeof fixture,
  sink: InMemoryEventSink,
  runId: string,
  provider: MockLlmProvider = new MockLlmProvider({ responses: [] }),
): RunRuntime {
  const events = new EventSequencer([sink], (_name, error) => {
    throw error;
  });
  return createRunRuntime({
    config: fixtureConfig(fixtureRoot),
    runId,
    provider,
    events,
    logger: silentLogger(),
  });
}

/** The implementation the Modernizer "returns": deterministic fee arithmetic with the given tie rule. */
function implementationModule(rounding: 'half-up' | 'half-even'): string {
  return [
    `const ROUNDING = '${rounding}';`,
    '',
    'export function computeFee(amount) {',
    "  const [whole = '0', fraction = ''] = String(amount).split('.');",
    "  const thousandths = BigInt(whole + fraction.padEnd(3, '0').slice(0, 3));",
    '  const quotient = thousandths / 2000n;',
    '  const remainder = thousandths % 2000n;',
    '  const twice = remainder * 2n;',
    '  let cents = quotient;',
    "  if (ROUNDING === 'half-up') {",
    '    if (twice >= 2000n) cents += 1n;',
    '  } else if (twice > 2000n || (twice === 2000n && quotient % 2n === 1n)) {',
    '    cents += 1n;',
    '  }',
    '  if (cents < 25n) cents = 25n;',
    '  return Number(cents) / 100;',
    '}',
    '',
  ].join('\n');
}

function implementationReport(rounding: 'half-up' | 'half-even') {
  return {
    summary: `Minimal fee module reproducing the captured legacy fee arithmetic with ${rounding} rounding at the tie.`,
    entryPoint: 'implementation.mjs',
    files: [
      {
        path: 'implementation.mjs',
        content: implementationModule(rounding),
        description: 'Deterministic fee arithmetic; this is the file the repair iteration is expected to change.',
      },
    ],
    resetPath: '/test/reset',
    ruleIdsImplemented: [RULE_ID],
    invariantIdsAddressed: [INVARIANT_ID],
    assumptions: ['The scenario exercises fee arithmetic only, so no HTTP server is included in this pass.'],
  };
}

describe('classifyRepair', () => {
  it('resolves only when the verdict is equivalent and nothing remains unresolved', () => {
    expect(classifyRepair({ mismatchesBefore: [], mismatchesAfter: [], equivalent: true })).toBe('RESOLVED');
    expect(classifyRepair({ mismatchesBefore: ['CHR-001-M1'], mismatchesAfter: [], equivalent: true })).toBe('RESOLVED');
  });

  it('improves when old mismatches disappear without new ones appearing', () => {
    expect(classifyRepair({ mismatchesBefore: ['CHR-001-M1'], mismatchesAfter: [], equivalent: false })).toBe('IMPROVED');
  });

  it('regresses whenever a new mismatch appears, no matter what was fixed', () => {
    expect(classifyRepair({ mismatchesBefore: ['CHR-001-M1'], mismatchesAfter: ['CHR-001-M2'], equivalent: false })).toBe('REGRESSED');
    expect(classifyRepair({ mismatchesBefore: [], mismatchesAfter: ['CHR-001-M1'], equivalent: false })).toBe('REGRESSED');
  });

  it('reports no change when the same mismatches survive', () => {
    expect(classifyRepair({ mismatchesBefore: ['CHR-001-M1'], mismatchesAfter: ['CHR-001-M1'], equivalent: false })).toBe('NO_CHANGE');
  });
});

describe('renderRepairBrief', () => {
  let stub: FeeServer | undefined;
  let suite: CharacterizationSuite;

  beforeAll(async () => {
    const server = await startFeeServer({ mode: 'half-up' });
    stub = server;
    const captured = await captureSuite({
      capturedFrom: 'stub-legacy HALF_UP',
      generatedBy: 'characterization-engineer',
      proposals: [{ caseId: caseIdFor(0), scenario: feeScenario() }],
      knownRuleIds: [RULE_ID],
      knownInvariantIds: [INVARIANT_ID],
      target: server.target,
    });
    suite = captured.suite;
  });

  afterAll(async () => {
    await stub?.close();
  });

  it('renders the observed divergence as a brief the Modernizer can repair against', async () => {
    const sink = new InMemoryEventSink();
    const runtime = stageRuntime(fixture, sink, runIdFor('repairbrief'));
    const target = await startFeeServer({ mode: 'half-even', resetStatus: 500 });
    try {
      const verification = await runVerificationStage({
        runId: runIdFor('repairbrief'),
        runtime,
        suite,
        changeReport: changeReport(),
        target: target.target,
      });

      expect(verification.verdict.verdict).toBe('NOT_EQUIVALENT');
      expect(verification.mismatches.map((mismatch) => mismatch.mismatchId)).toEqual(['CHR-001-M1']);
      expect(verification.resetFailures).toHaveLength(1);

      const diagnosis = renderRepairBrief({
        verification,
        rules,
        invariants,
        suite,
        modernRoot: runtime.paths.modernRoot,
        repairIteration: 1,
      });

      expect(diagnosis.iteration).toBe(1);
      expect(diagnosis.mismatchIds).toEqual(['CHR-001-M1']);
      expect(diagnosis.evidencePaths).toContain(FEE_SERVICE_PATH);

      const feeLine = fixtureCitation(fixture.root, FEE_SERVICE_PATH, HALF_UP).startLine;
      expect(diagnosis.text).toContain('# Repair iteration 1 — differential failures to fix');
      expect(diagnosis.text).toContain('## MISMATCH CHR-001-M1 — ');
      expect(diagnosis.text).toContain('[MAJOR, precision]');
      expect(diagnosis.text).toContain('- legacy answered: 2.01');
      expect(diagnosis.text).toContain('- your implementation answered: 2');
      expect(diagnosis.text).toContain(`    - enforced at ${FEE_SERVICE_PATH}:${feeLine}`);
      expect(diagnosis.text).toContain('## modern-reset [modern-implementation-builds]');
      expect(diagnosis.text).toContain('HTTP 500');
      expect(diagnosis.text).toContain(`Change ONLY the modern implementation under ${runtime.paths.modernRoot}`);
      expect(diagnosis.text).not.toContain('## differential-equivalence');
      expect(diagnosis.text).not.toContain('## characterization-suite-passes-on-legacy');

      expect(diagnosis.summary).toContain('repair iteration 1: 1 mismatch(es), 1 failed required check(s)');
      expect(diagnosis.summary).toContain('highest severity MAJOR');
      expect(diagnosis.summary).toContain('failed checks: modern-reset');
      expect(diagnosis.summary).toContain('CHR-001-M1');
    } finally {
      await target.close();
      runtime.close();
    }
  });
});

describe('runModernizationLoop', () => {
  let legacyStub: FeeServer | undefined;
  let suite: CharacterizationSuite;

  beforeAll(async () => {
    const server = await startFeeServer({ mode: 'half-up' });
    legacyStub = server;
    const captured = await captureSuite({
      capturedFrom: 'stub-legacy HALF_UP',
      generatedBy: 'characterization-engineer',
      proposals: [{ caseId: caseIdFor(0), scenario: feeScenario() }],
      knownRuleIds: [RULE_ID],
      knownInvariantIds: [INVARIANT_ID],
      target: server.target,
    });
    suite = captured.suite;
  });

  afterAll(async () => {
    await legacyStub?.close();
  });

  it('diagnoses the divergence, repairs the modern implementation, and re-verifies to EQUIVALENT', async () => {
    const runId = runIdFor('modernizationloop');
    const provider = new MockLlmProvider({
      responses: [jsonResponse(implementationReport('half-even')), jsonResponse(implementationReport('half-up'))],
    });
    const sink = new InMemoryEventSink();
    const runtime = stageRuntime(fixture, sink, runId, provider);
    const round0 = await startFeeServer({ mode: 'half-even' });
    const round1 = await startFeeServer({ mode: 'half-up' });
    try {
      const result = await runModernizationLoop({
        runId,
        runtime,
        rules,
        invariants,
        suite,
        maxRepairIterations: 2,
        targetFor: (round) => (round === 0 ? round0.target : round1.target),
      });

      expect(result.stopReason).toBe('equivalent');
      expect(result.repairIterations).toBe(1);
      expect(result.unresolvedMismatchIds).toEqual([]);
      expect(result.finalVerification?.verdict.verdict).toBe('EQUIVALENT');
      expect(result.rounds).toHaveLength(2);

      const [first, second] = result.rounds;
      if (first === undefined || second === undefined) throw new Error('expected two modernization rounds');

      expect(first.iteration).toBe(0);
      expect(first.diagnosis).toBeUndefined();
      expect(first.repairOutcome).toBeUndefined();
      expect(first.mismatchIds).toEqual(['CHR-001-M1']);
      expect(first.verification?.verdict.verdict).toBe('NOT_EQUIVALENT');
      expect(first.verification?.modern.baseUrl).toBe(round0.target.baseUrl);

      expect(second.iteration).toBe(1);
      expect(second.repairOutcome).toBe('RESOLVED');
      expect(second.mismatchIds).toEqual([]);
      expect(second.diagnosis?.iteration).toBe(1);
      expect(second.diagnosis?.text).toContain('legacy answered: 2.01');
      expect(second.verification?.verdict.verdict).toBe('EQUIVALENT');
      expect(second.verification?.modern.baseUrl).toBe(round1.target.baseUrl);

      for (const round of result.rounds) {
        expect(round.modernization.result.status).toBe('SUCCEEDED');
        expect(round.modernization.result.acceptance.map((outcome) => outcome.criterionId)).toEqual([
          'change-report-present',
          'change-report-schema-valid',
          'implementation-consistent',
        ]);
        expect(round.modernization.result.acceptance.every((outcome) => outcome.satisfied)).toBe(true);
      }

      expect(result.taskIds).toHaveLength(4);
      expect(new Set(result.taskIds).size).toBe(4);
      expect(provider.callCount).toBe(2);

      const firstPrompt = provider.requests[0]?.messages.at(-1)?.content ?? '';
      const secondPrompt = provider.requests[1]?.messages.at(-1)?.content ?? '';
      expect(firstPrompt).toContain('None. This is the first implementation');
      expect(secondPrompt).toContain('# Repair iteration 1 — differential failures to fix');
      expect(secondPrompt).toContain('legacy answered: 2.01');

      const requested = sink.ofType('repair.requested');
      expect(requested).toHaveLength(1);
      expect(requested[0]?.iteration).toBe(1);
      expect(requested[0]?.mismatchIds).toEqual(['CHR-001-M1']);
      const completed = sink.ofType('repair.completed');
      expect(completed).toHaveLength(1);
      expect(completed[0]?.iteration).toBe(1);
      expect(completed[0]?.outcome).toBe('RESOLVED');
      expect(completed[0]?.mismatchesBefore).toBe(1);
      expect(completed[0]?.mismatchesAfter).toBe(0);
      expect(sink.ofType('verification.result').map((event) => event.verdict)).toEqual([
        'NOT_EQUIVALENT',
        'EQUIVALENT',
      ]);
      const failures = sink.ofType('failure.discovered');
      expect(failures).toHaveLength(1);
      expect(failures[0]?.kind).toBe('behavioral-mismatch');

      const written = readFileSync(join(runtime.paths.modernRoot, 'implementation.mjs'), 'utf8');
      expect(written).toContain("const ROUNDING = 'half-up';");
      expect(written).not.toContain('half-even');
      expect(existsSync(join(runtime.paths.modernRoot, 'run.sh'))).toBe(true);

      const entryPath = join(runtime.paths.modernRoot, 'implementation.mjs');
      const probe = [
        "const { pathToFileURL } = await import('node:url');",
        `const mod = await import(pathToFileURL(${JSON.stringify(entryPath)}).href);`,
        "const fee = mod.computeFee('401.00');",
        'console.log(fee);',
        'if (fee !== 2.01) process.exit(3);',
      ].join('\n');
      const stdout = execFileSync(process.execPath, ['--input-type=module', '--eval', probe], { encoding: 'utf8' });
      expect(stdout.trim()).toBe('2.01');
    } finally {
      await round0.close();
      await round1.close();
      runtime.close();
    }
  });
});

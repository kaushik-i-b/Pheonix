import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { CustomCheckContext } from '@phoenix/agent-runtime';
import { FileArtifactStore } from '@phoenix/artifact-store';
import { PhoenixError, newRunId } from '@phoenix/shared';
import type { ScenarioTarget } from '@phoenix/characterization';
import { captureSuite } from '@phoenix/characterization';
import { analystReportSchema, toBusinessRuleSet, toInvariantSet } from '../src/index.js';
import {
  CASE_ID_PREFIX,
  RUNNABLE_STEP_KINDS,
  assertProposalsAreUsable,
  caseIdFor,
  characterizationConsistencyCheck,
  knownClaimsOf,
  modelScenarioSchema,
  scenarioProposalProblems,
  scenarioProposalReportSchema,
  toScenario,
  type ModelScenario,
  type ScenarioProposalReport,
} from '../src/stages/characterization-schema.js';
import { createLegacyFixture, FEE_SERVICE_PATH, fixtureCitation } from './support.js';

/**
 * The CHARACTERIZE glue that no other package tests: the proposal schema the model's answer must
 * survive inside the agent loop, the host-side conversion of a proposal into a runnable scenario,
 * and the consistency check that audits a captured suite against the specification it claims to
 * encode. The capture mechanics themselves are covered by @phoenix/characterization's own suite —
 * here the suite is captured from a live stub server so the check judges a real artifact, not a
 * hand-built one.
 */

const ATTRIBUTION = {
  generatedAt: '2026-10-01T00:00:00.000Z',
  generatedBy: 'business-rule-analyst:tsk_characterization_test',
  targetRoot: '/tmp/legacy',
};

const RULE_ID = 'BR-FEE-MINIMUM';
const INVARIANT_ID = 'INV-FEE-TWO-DECIMALS';

const HALF_UP = 'setScale(2, RoundingMode.HALF_UP)';

const fixture = createLegacyFixture();

function specification() {
  const report = analystReportSchema.parse({
    summary:
      'A single fee rule: the configured minimum replaces the computed percentage whenever the rate times the amount is smaller.',
    rules: [
      {
        ruleId: RULE_ID,
        title: 'The fee is floored at the configured minimum',
        description:
          'The comparison replaces the computed percentage with the hard minimum whenever the product is ' +
          'smaller, so amounts below the threshold pay the minimum and nothing else changes.',
        kind: 'calculation',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        confidenceBasis: 'The comparison is explicit in the method body; the minimum is a constant of the class.',
        sourceEvidence: [fixtureCitation(fixture.root, FEE_SERVICE_PATH, HALF_UP)],
        affectedComponents: [FEE_SERVICE_PATH],
        observableBehavior:
          'An amount small enough that rate times amount lands below the minimum is charged the minimum instead of the percentage.',
      },
    ],
    invariants: [
      {
        invariantId: INVARIANT_ID,
        statement: 'Every fee the system produces carries exactly two decimal places.',
        kind: 'rounding-stability',
        criticality: 'MAJOR',
        scope: { components: [FEE_SERVICE_PATH], operations: ['POST /api/transfers'] },
        epistemicStatus: 'OBSERVED',
        confidence: 0.85,
        sourceEvidence: [fixtureCitation(fixture.root, FEE_SERVICE_PATH, HALF_UP)],
        checkingStrategy: {
          kind: 'api-invariant-check',
          detail:
            'Price amounts spanning the half-cent boundary and assert every returned fee has a scale of two.',
          automated: true,
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

const known = knownClaimsOf(specification().rules, specification().invariants);

function validScenario(index: number, targetRuleIds: readonly string[] = [RULE_ID]): ModelScenario {
  return modelScenarioSchema.parse({
    title: `Fee floor applies to a small amount ${index}`,
    description: 'GET the fee endpoint for an amount below the minimum and read the fee value returned.',
    category: 'boundary',
    hypothesis: 'The response fee equals the configured minimum rather than the computed percentage.',
    targetRuleIds: [...targetRuleIds],
    steps: [
      {
        stepId: `get-fee-${index}`,
        description: 'Request the fee for a small amount',
        kind: 'http',
        http: { method: 'GET', path: '/api/fees', query: { amount: '1.00' } },
      },
    ],
    rationale: 'The floor is only observable on amounts below the minimum threshold.',
  });
}

function proposalReport(scenarios: readonly ModelScenario[]): ScenarioProposalReport {
  return {
    summary:
      'Scenarios that freeze the fee floor, each traced to the minimum-fee rule discovered in the specification.',
    scenarios: [...scenarios],
  };
}

describe('scenario proposal schema', () => {
  it('keeps the first ten scenarios when the model sends more than the cap', () => {
    const parsed = scenarioProposalReportSchema(known).parse(
      proposalReport(Array.from({ length: 12 }, (_, index) => validScenario(index + 1))),
    );
    expect(parsed.scenarios).toHaveLength(10);
    expect(parsed.scenarios[0]?.title).toBe(validScenario(1).title);
    expect(parsed.scenarios[9]?.title).toBe(validScenario(10).title);
  });

  it('accepts five scenarios that trace to the specification and only use runnable steps', () => {
    expect(() => scenarioProposalReportSchema(known).parse(proposalReport([
      validScenario(1),
      validScenario(2),
      validScenario(3),
      validScenario(4),
      validScenario(5),
    ]))).not.toThrow();
  });

  it('rejects inside the loop a scenario targeting a rule the specification does not contain', () => {
    const result = scenarioProposalReportSchema(known).safeParse(
      proposalReport([validScenario(1), validScenario(2), validScenario(3), validScenario(4), validScenario(5, ['BR-NOT-IN-SPEC'])]),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.message.includes('BR-NOT-IN-SPEC'))).toBe(true);
    }
  });

  it('reports every unrunnable or untraceable construction in one pass', () => {
    const problems = scenarioProposalProblems(
      {
        summary: 'a',
        scenarios: [
          modelScenarioSchema.parse({
            title: 'Broken scenario',
            description: 'A scenario exercising several proposal mistakes at once.',
            category: 'failure',
            hypothesis: 'It is reported as unrunnable rather than skipped at capture time.',
            steps: [
              { stepId: 'dup', description: 'query the database directly', kind: 'sql', sql: { statement: 'SELECT 1' } },
              { stepId: 'dup', description: 'wait a moment', kind: 'wait' },
            ],
            rationale: 'Each mistake here must surface in the problem list, not at execution time.',
          }),
        ],
      },
      known,
    );
    expect(problems).toEqual([
      expect.stringContaining('targets no rule and no invariant'),
      expect.stringContaining('which the capture target cannot run'),
      expect.stringContaining('repeats stepId dup'),
      expect.stringContaining('is kind "wait" but carries no waitMs'),
    ]);
  });

  it('keeps the runnable kind list honest', () => {
    expect(RUNNABLE_STEP_KINDS).toEqual(['http', 'wait']);
  });

  it('mints deterministic case ids from the proposal index', () => {
    expect(CASE_ID_PREFIX).toBe('CHR');
    expect(caseIdFor(0)).toBe('CHR-001');
    expect(caseIdFor(4)).toBe('CHR-005');
  });

  it('stamps identity and provenance on conversion, never expectation values', () => {
    const scenario = toScenario(validScenario(1));
    expect(scenario.provenance.createdBy).toBe('characterization-engineer');
    expect(scenario.provenance.origin).toBe('derived-from-rule');
    expect(scenario.deterministic).toBe(true);
    expect(scenario.steps[0]?.kind).toBe('http');

    const invariantOnly = toScenario(validScenario(2, []));
    expect(invariantOnly.provenance.origin).toBe('derived-from-invariant');
  });

  it('refuses an empty proposal set with a schema validation error', () => {
    expect(() =>
      assertProposalsAreUsable({ summary: 'nothing was proposed at all', scenarios: [] }),
    ).toThrowError(PhoenixError);
  });
});

async function startStub(): Promise<{ target: ScenarioTarget; close: () => Promise<void> }> {
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ fee: '0.25', currency: 'USD' }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    target: { system: 'legacy', label: 'stub-legacy', baseUrl: `http://127.0.0.1:${port}` },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

describe('characterizationConsistencyCheck', () => {
  const { rules, invariants } = specification();
  const check = characterizationConsistencyCheck(rules, invariants);

  async function capturedSuite() {
    const stub = await startStub();
    try {
      const { suite } = await captureSuite({
        capturedFrom: 'stub-legacy at http://127.0.0.1',
        generatedBy: 'characterization-engineer',
        proposals: [{ caseId: caseIdFor(0), scenario: toScenario(validScenario(1)) }],
        knownRuleIds: [RULE_ID],
        knownInvariantIds: [INVARIANT_ID],
        target: stub.target,
      });
      return suite;
    } finally {
      await stub.close();
    }
  }

  function contextWith(payload: unknown): CustomCheckContext {
    return {
      runId: newRunId(),
      artifacts: new FileArtifactStore(mkdtempSync(join(tmpdir(), 'phoenix-characterization-test-'))),
      generated: [],
      findings: [],
      testRuns: [],
      payloadOf: (kind) => (kind === 'characterization.suite' ? payload : undefined),
    };
  }

  it('passes a suite captured from a live target', async () => {
    const suite = await capturedSuite();
    const result = await check(contextWith(suite));
    expect(result.satisfied).toBe(true);
    expect(result.observed).toContain('1 case(s)');
  });

  it('fails when no suite artifact was produced', async () => {
    const result = await check(contextWith(undefined));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('no artifact of kind "characterization.suite"');
  });

  it('names the specific case that cites a rule outside the specification', async () => {
    const suite = await capturedSuite();
    const tampered = {
      ...suite,
      cases: suite.cases.map((item) => ({ ...item, targetRuleIds: ['BR-NOT-IN-SPEC'] })),
    };
    const result = await check(contextWith(tampered));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('BR-NOT-IN-SPEC');
  });

  it('catches a statistics block that disagrees with a recount', async () => {
    const suite = await capturedSuite();
    if (suite.statistics === undefined) throw new Error('captureSuite always supplies statistics');
    const tampered = { ...suite, statistics: { ...suite.statistics, total: 99 } };
    const result = await check(contextWith(tampered));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('statistics');
  });

  it('catches a coverage block that disagrees with a recomputation', async () => {
    const suite = await capturedSuite();
    const tampered = { ...suite, coverage: { ...suite.coverage, ruleIdsCovered: [] } };
    const result = await check(contextWith(tampered));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('coverage');
  });

  it('rejects a case that legacy could not reproduce against itself', async () => {
    const suite = await capturedSuite();
    const tampered = {
      ...suite,
      cases: suite.cases.map((item) => ({ ...item, status: 'failing-against-legacy' as const })),
    };
    const result = await check(contextWith(tampered));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('does not reproduce legacy against itself');
  });
});

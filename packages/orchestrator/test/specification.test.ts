import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { MockLlmProvider, jsonResponse } from '@phoenix/llm/testing';
import {
  EventSequencer,
  InMemoryEventSink,
  businessRuleSetSchema,
  discoveryFindingsSchema,
  invariantSetSchema,
  newRunId,
  type RunId,
} from '@phoenix/shared';
import {
  SPECIFICATION_ACCEPTANCE_CRITERIA,
  analystReportSchema,
  assertSpecificationIsUsable,
  createRunRuntime,
  danglingSpecificationReferences,
  runSpecificationStage,
  specificationBrief,
  toBusinessRuleSet,
} from '../src/index.js';
import { anchorSpecificationCitations } from '../src/stages/specification-evidence.js';
import {
  BATCH_FEE_PATH,
  CONTROLLER_PATH,
  FEE_SERVICE_PATH,
  TRIGGER_PATH,
  cleanupTemporaryDirectories,
  createLegacyFixture,
  fixtureCitation,
  fixtureConfig,
  silentLogger,
  type LegacyFixture,
} from './support.js';

/**
 * SPECIFY.
 *
 * The point of these tests is not that a scripted model can emit a well-formed report — it is what
 * happens to that report afterwards. Citations are re-read from the fixture by the test itself, the
 * persisted documents are re-read from disk through their schemas, and every rule must still be a
 * candidate. The negative cases matter as much as the positive one: a specification built on an
 * invented quotation has to be refused, because every later stage grades itself against these rules.
 */

const ATTRIBUTION = {
  generatedAt: '2026-09-30T00:00:00.000Z',
  generatedBy: 'business-rule-analyst:tsk_specification_test',
  targetRoot: '/tmp/legacy',
};

afterAll(() => {
  cleanupTemporaryDirectories();
});

const HALF_UP = 'setScale(2, RoundingMode.HALF_UP)';
const HALF_EVEN = 'setScale(2, RoundingMode.HALF_EVEN)';
const MINIMUM = 'fee.compareTo(MINIMUM) < 0';
const TRIGGER = 'RAISE EXCEPTION';

function citation(fixture: LegacyFixture, path: string, needle: string) {
  return fixtureCitation(fixture.root, path, needle);
}

/**
 * The reads that justify the report below. The loop refuses a source-code citation to a file the
 * agent never opened, so a test that expects this report to be accepted has to script them.
 */
const readSpecSources = {
  toolCalls: [FEE_SERVICE_PATH, BATCH_FEE_PATH, CONTROLLER_PATH, TRIGGER_PATH].map(
    (path, index) => ({
      id: `read-${index}`,
      name: 'read_file' as const,
      arguments: { path },
    }),
  ),
};

/** A report whose every quotation is read out of the fixture at the moment it is built. */
function analystReport(fixture: LegacyFixture) {
  return {
    summary:
      'A small transfer service whose fee calculation exists twice and whose two copies disagree about ' +
      'rounding, with the no-overdraft rule enforced by a database trigger rather than by the application.',
    rules: [
      {
        ruleId: 'BR-ONLINE-FEE-HALF-UP',
        title:
          'The online fee is a rate times the amount, rounded half-up to two decimals, floored at a minimum',
        description:
          'FeeService.onlineFee multiplies the amount by a fixed rate, rounds the product to two decimal ' +
          'places with HALF_UP, and replaces the result with a hard-coded minimum when it is smaller. ' +
          'The rate and the minimum are constants in the class, not configuration.',
        kind: 'calculation',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        confidenceBasis:
          'The rounding mode and the minimum comparison are both explicit in the method body. What source ' +
          'cannot tell me is whether the constants still match the values the database-side fee function uses.',
        sourceEvidence: [citation(fixture, FEE_SERVICE_PATH, HALF_UP)],
        affectedComponents: [FEE_SERVICE_PATH],
        observableBehavior:
          'POST /api/transfers for an amount whose fee lands on a half cent returns a fee equal to that ' +
          'half cent rounded up, and for an amount small enough that the rate produces less than the ' +
          'minimum, the fee equals the minimum instead.',
        edgeCases: [
          {
            id: 'EC-FEE-BELOW-MINIMUM',
            description:
              'An amount small enough that rate times amount is below the hard-coded minimum.',
            expectedBehavior: 'The minimum is charged rather than the computed percentage.',
            epistemicStatus: 'OBSERVED',
            confidence: 0.85,
            evidence: [citation(fixture, FEE_SERVICE_PATH, MINIMUM)],
          },
        ],
        assumptions: ['The rate and minimum constants are the values in effect for every request.'],
        testable: true,
        proposedChecks: [
          {
            id: 'CHK-ONLINE-FEE-HALF-CENT',
            description:
              'Post a transfer whose fee lands exactly on a half cent and read back the fee.',
            kind: 'api-scenario',
            targetsRuleId: 'BR-ONLINE-FEE-HALF-UP',
          },
        ],
        duplicateImplementations: [BATCH_FEE_PATH],
        contradictsRuleIds: [],
        derivedFromInvariantIds: ['INV-FEE-SCALE-STABLE'],
      },
      {
        ruleId: 'BR-BATCH-FEE-HALF-EVEN',
        title:
          'The batch fee is the same calculation rounded half-even, so it disagrees on half cents',
        description:
          'BatchFeeCalculator.batchFee repeats the online calculation with the same rate and minimum but ' +
          'rounds HALF_EVEN. On an amount whose fee lands on a half cent the two paths differ by one cent.',
        kind: 'calculation',
        epistemicStatus: 'OBSERVED',
        confidence: 0.88,
        confidenceBasis:
          'Both rounding modes are written down, so the disagreement is certain; which path a given caller ' +
          'reaches is not establishable from source and needs a runtime probe.',
        sourceEvidence: [citation(fixture, BATCH_FEE_PATH, HALF_EVEN)],
        affectedComponents: [BATCH_FEE_PATH],
        observableBehavior:
          'A transfer whose fee lands on a half cent produces a fee one cent lower when it is settled ' +
          'through the batch path than when it is priced through the online path.',
        duplicateImplementations: [FEE_SERVICE_PATH],
        contradictsRuleIds: ['BR-ONLINE-FEE-HALF-UP'],
      },
      {
        ruleId: 'BR-TRANSFER-POSTS-A-LEDGER-ENTRY',
        title: 'A transfer writes one ledger entry for the fee, and a failed write is not reported',
        description:
          'TransferController.transfer prices the fee, records it through FeeService.record and returns OK. ' +
          'record() wraps its insert in a catch block with an empty body, so an insert that throws still ' +
          'produces a successful response.',
        kind: 'error-handling',
        epistemicStatus: 'OBSERVED',
        confidence: 0.8,
        confidenceBasis:
          'The empty catch block is right there. Whether the insert can actually fail in production — and ' +
          'what the caller would then see — can only be established by making it fail at runtime.',
        sourceEvidence: [
          citation(fixture, CONTROLLER_PATH, 'fees.record(account, fee)'),
          citation(fixture, FEE_SERVICE_PATH, 'catch (RuntimeException e)'),
        ],
        affectedComponents: [CONTROLLER_PATH, FEE_SERVICE_PATH],
        observableBehavior:
          'POST /api/transfers returns OK whether or not the ledger insert succeeded, so a caller cannot ' +
          'distinguish a recorded fee from a lost one.',
      },
    ],
    invariants: [
      {
        invariantId: 'INV-FEE-SCALE-STABLE',
        statement: 'Every fee this system produces has exactly two decimal places.',
        kind: 'rounding-stability',
        criticality: 'MAJOR',
        scope: {
          components: [FEE_SERVICE_PATH, BATCH_FEE_PATH],
          operations: ['POST /api/transfers'],
        },
        epistemicStatus: 'OBSERVED',
        confidence: 0.85,
        sourceEvidence: [
          citation(fixture, FEE_SERVICE_PATH, HALF_UP),
          citation(fixture, BATCH_FEE_PATH, HALF_EVEN),
        ],
        checkingStrategy: {
          kind: 'api-invariant-check',
          detail:
            'Price a set of amounts spanning the half-cent boundary through both paths and assert that every ' +
            'returned fee has a scale of two; a fee with more or fewer decimals is a violation.',
          automated: true,
        },
        violationSeverity: 'MAJOR',
        derivedFromRuleIds: ['BR-ONLINE-FEE-HALF-UP', 'BR-BATCH-FEE-HALF-EVEN'],
        knownExceptions: [],
      },
      {
        invariantId: 'INV-NO-OVERDRAFT',
        statement: 'No account balance is ever negative, whatever path updates it.',
        kind: 'bound',
        criticality: 'CRITICAL',
        scope: {
          components: [TRIGGER_PATH],
          operations: ['POST /api/transfers', 'POST /api/withdrawals'],
        },
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        sourceEvidence: [citation(fixture, TRIGGER_PATH, TRIGGER)],
        checkingStrategy: {
          kind: 'database-query',
          detail:
            'After every scenario, select any account whose balance is below zero; a row in the result is a ' +
            'violation of the invariant regardless of what the API returned.',
          automated: true,
          executable: 'SELECT id, account_number, balance FROM accounts WHERE balance < 0',
        },
        violationSeverity: 'CRITICAL',
        examples: [
          {
            description: 'A withdrawal larger than the available balance',
            expected: 'The update is rejected by the trigger and the balance stays non-negative',
          },
        ],
      },
    ],
    unknowns: [
      {
        id: 'UNK-FEE-PATH-PRECEDENCE',
        question: 'Which of the two fee calculations does the live transfer path actually reach?',
        whyItMatters:
          'Characterizing the wrong copy would freeze behaviour no caller ever sees, and the differential ' +
          'stage would then compare the modern implementation against an unused path.',
        resolutionStrategy: 'runtime-probe',
        relatedRuleIds: ['BR-ONLINE-FEE-HALF-UP', 'BR-BATCH-FEE-HALF-EVEN'],
      },
      {
        id: 'UNK-SWALLOWED-INSERT-FREQUENCY',
        question: 'Can the ledger insert in FeeService.record actually fail, and how often?',
        whyItMatters:
          'If it can, the system silently loses money movements, and preserving that behaviour is a ' +
          'decision that has to be made deliberately rather than inherited by accident.',
        resolutionStrategy: 'characterization-test',
        relatedRuleIds: ['BR-TRANSFER-POSTS-A-LEDGER-ENTRY'],
        relatedInvariantIds: ['INV-NO-OVERDRAFT'],
      },
    ],
  };
}

function upstreamFindings(fixture: LegacyFixture) {
  const halfUp = citation(fixture, FEE_SERVICE_PATH, HALF_UP);
  const trigger = citation(fixture, TRIGGER_PATH, TRIGGER);
  return discoveryFindingsSchema.parse({
    generatedAt: '2026-09-30T00:00:00.000Z',
    summary: 'Discovery found duplicated fee logic and a database-side no-overdraft rule.',
    sections: [
      { heading: 'What the system does', body: 'A tiny transfer service over PostgreSQL.' },
    ],
    findings: [
      {
        id: 'F-FEE-LOGIC-DUPLICATED',
        kind: 'duplication',
        summary:
          'Two methods compute a transfer fee with the same shape and different rounding modes.',
        epistemicStatus: 'OBSERVED',
        confidence: 0.85,
        evidence: [
          {
            id: 'F-FEE-LOGIC-DUPLICATED-ev-1',
            kind: 'source-code',
            collectedAt: '2026-09-30T00:00:00.000Z',
            collectedBy: 'archaeologist:tsk_discovery',
            location: { path: FEE_SERVICE_PATH, startLine: halfUp.startLine },
            quote: HALF_UP,
          },
        ],
      },
      {
        id: 'F-OVERDRAFT-RULE-IN-DATABASE',
        kind: 'invariant-candidate',
        summary:
          'The no-overdraft rule is enforced by a trigger, so it is invisible to a Java-only rewrite.',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        evidence: [
          {
            id: 'F-OVERDRAFT-RULE-IN-DATABASE-ev-1',
            kind: 'source-code',
            collectedAt: '2026-09-30T00:00:00.000Z',
            collectedBy: 'archaeologist:tsk_discovery',
            location: {
              path: TRIGGER_PATH,
              startLine: trigger.startLine,
              symbol: 'reject_negative_balance',
            },
            quote: TRIGGER,
          },
        ],
      },
    ],
    openQuestions: [
      {
        id: 'Q-FEE-PATH-PRECEDENCE',
        question: 'Which fee calculation does the live path reach?',
        whyItMatters: 'Characterizing the unused copy would freeze behaviour nobody executes.',
        resolutionStrategy: 'characterization-test',
      },
    ],
  });
}

function stageRuntime(
  fixture: LegacyFixture,
  provider: MockLlmProvider,
  sink: InMemoryEventSink,
  runId: RunId,
) {
  return createRunRuntime({
    config: fixtureConfig(fixture),
    runId,
    provider,
    events: new EventSequencer([sink], (_name, error) => {
      throw error;
    }),
    logger: silentLogger(),
  });
}

describe('specification schema', () => {
  const fixture = createLegacyFixture();

  it('rejects the preserved missing-confidence response without inventing a default', () => {
    const malformed = JSON.parse(
      readFileSync(
        new URL('./fixtures/specification-missing-invariant-confidence.json', import.meta.url),
        'utf8',
      ),
    ) as { invariants: Array<Record<string, unknown>> };

    expect(malformed.invariants[0]?.confidence).toBeUndefined();
    const rejected = analystReportSchema.safeParse(malformed);
    expect(rejected.success).toBe(false);
    if (rejected.success) throw new Error('the malformed report unexpectedly passed validation');
    expect(rejected.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['invariants', 0, 'confidence'],
        message: 'expected a required JSON number from 0 through 1 inclusive',
      }),
    );

    const corrected = structuredClone(malformed);
    const invariant = corrected.invariants[0];
    if (invariant === undefined) throw new Error('the regression fixture contains no invariant');
    invariant.confidence = 0.5;
    const accepted = analystReportSchema.safeParse(corrected);
    expect(accepted.success).toBe(true);
    if (!accepted.success) throw accepted.error;
    expect(accepted.data.invariants[0]?.confidence).toBe(0.5);
  });

  it('refuses a specification that refers to claims it does not contain', () => {
    const report = analystReportSchema.parse(analystReport(fixture));
    expect(danglingSpecificationReferences(report)).toEqual([]);

    const dangling = analystReportSchema.parse({
      ...report,
      rules: report.rules.map((rule) =>
        rule.ruleId === 'BR-BATCH-FEE-HALF-EVEN'
          ? { ...rule, contradictsRuleIds: ['BR-NOT-WRITTEN'] }
          : rule,
      ),
    });
    expect(danglingSpecificationReferences(dangling)).toEqual([
      'BR-BATCH-FEE-HALF-EVEN contradicts unknown rule BR-NOT-WRITTEN',
    ]);
    expect(() => assertSpecificationIsUsable(dangling)).toThrow(/does not contain/);
  });

  it('refuses an OBSERVED claim that cites no line or symbol', () => {
    const report = analystReportSchema.parse({
      ...analystReport(fixture),
      invariants: [
        {
          invariantId: 'INV-UNLOCATED',
          statement: 'An invariant asserted without pointing at anything in the repository.',
          kind: 'other',
          criticality: 'MINOR',
          scope: { components: [], operations: [] },
          epistemicStatus: 'OBSERVED',
          confidence: 0.9,
          sourceEvidence: [{ path: FEE_SERVICE_PATH, quote: HALF_UP }],
          checkingStrategy: {
            kind: 'manual',
            detail: ' somebody would have to look ',
            automated: false,
          },
          violationSeverity: 'INFO',
        },
      ],
    });
    expect(() => assertSpecificationIsUsable(report)).toThrow(/cites no line or symbol/);
  });

  it('refuses a specification that claims nothing', () => {
    const empty = analystReportSchema.parse({
      summary: 'A report with no rules and no invariants at all.',
    });
    expect(empty.rules).toEqual([]);
    expect(empty.invariants).toEqual([]);
    expect(() => assertSpecificationIsUsable(empty)).toThrow(/no rules and no invariants/);
  });

  it('demotes an unsupported claim to an unknown instead of accepting empty evidence', () => {
    const report = analystReport(fixture);
    const unsupported = {
      ...report.rules[0],
      ruleId: 'BR-UNSUPPORTED-RECONCILIATION',
      title: 'Reconciliation follows an unverified policy',
      epistemicStatus: 'UNKNOWN',
      sourceEvidence: [],
      proposedChecks: [],
      contradictsRuleIds: [],
      derivedFromInvariantIds: [],
    };
    const parsed = analystReportSchema.parse({
      ...report,
      rules: [...report.rules, unsupported],
      unknowns: [
        ...report.unknowns,
        {
          id: 'UNK-UNSUPPORTED-RECONCILIATION',
          question: 'Which reconciliation policy does the running system use?',
          whyItMatters:
            'The proposed behavior has no source evidence and must be established at runtime.',
          resolutionStrategy: 'runtime-probe',
          relatedRuleIds: ['BR-UNSUPPORTED-RECONCILIATION'],
          relatedInvariantIds: [],
        },
      ],
    });

    expect(parsed.rules.some((rule) => rule.ruleId === 'BR-UNSUPPORTED-RECONCILIATION')).toBe(
      false,
    );
    expect(parsed.unknowns.at(-1)).toMatchObject({
      id: 'UNK-UNSUPPORTED-RECONCILIATION',
      relatedRuleIds: [],
    });
    expect(() => assertSpecificationIsUsable(parsed)).not.toThrow();
  });

  it('does not demote evidence when the host could not read complete source bytes', async () => {
    const report = analystReportSchema.parse(analystReport(fixture));
    const result = await anchorSpecificationCitations({
      value: report,
      read: async () => ({ problem: 'the source read was truncated' }),
      attemptsExhausted: true,
    });

    expect(result.value).toBeUndefined();
    expect(result.notes?.join('\n')).toContain('could not anchor');
    expect(result.notes?.join('\n')).toContain('source read was truncated');
  });

  it('cannot be told that a rule is confirmed, and computes its own statistics', () => {
    // `lifecycleStatus` and `confirmation` are not in the model's vocabulary: the schema strips them.
    const parsed = analystReportSchema.parse({
      ...analystReport(fixture),
      rules: analystReport(fixture).rules.map((rule) => ({
        ...rule,
        lifecycleStatus: 'confirmed',
        confirmation: {
          confirmedAt: '2026-09-30T00:00:00.000Z',
          confirmedBy: 'the model itself',
          evidence: [citation(fixture, FEE_SERVICE_PATH, HALF_UP)],
          observation: 'I am confident.',
        },
      })),
    });
    expect(parsed.rules.every((rule) => !('lifecycleStatus' in rule))).toBe(true);

    const set = toBusinessRuleSet(parsed, { ...ATTRIBUTION, targetRoot: fixture.root });
    expect(set.rules.map((rule) => rule.lifecycleStatus)).toEqual([
      'candidate',
      'candidate',
      'candidate',
    ]);
    expect(set.rules.every((rule) => rule.confirmation === undefined)).toBe(true);
    expect(set.statistics?.total).toBe(3);
    expect(set.statistics?.observed).toBe(3);
    expect(set.statistics?.withDuplicateImplementations).toBe(2);
    expect(set.targetRoot).toBe(fixture.root);
    // Only the unknown that bears on an invariant is carried into the invariant document.
    expect(set.unknowns.map((unknown) => unknown.id)).toEqual([
      'UNK-FEE-PATH-PRECEDENCE',
      'UNK-SWALLOWED-INSERT-FREQUENCY',
    ]);
  });
});

describe('specification stage', () => {
  const fixture = createLegacyFixture();

  it('persists both documents with citations that really are in the repository', async () => {
    const provider = new MockLlmProvider({
      responses: [readSpecSources, jsonResponse(analystReport(fixture))],
    });
    const sink = new InMemoryEventSink();
    const runId = newRunId();
    const runtime = stageRuntime(fixture, provider, sink, runId);

    try {
      const outcome = await runSpecificationStage({
        runId,
        runtime,
        findings: upstreamFindings(fixture),
      });

      expect(outcome.result.status, outcome.result.errorMessage ?? '').toBe('SUCCEEDED');
      expect(outcome.result.acceptance).toHaveLength(SPECIFICATION_ACCEPTANCE_CRITERIA.length);
      expect(outcome.result.acceptance.filter((item) => !item.satisfied)).toEqual([]);

      expect(outcome.artifacts.businessRules?.relativePath).toBe(
        'specification/business-rules.json',
      );
      expect(outcome.artifacts.invariants?.relativePath).toBe('specification/invariants.json');

      const rules = outcome.rules;
      const invariants = outcome.invariants;
      if (rules === undefined || invariants === undefined)
        throw new Error('the stage produced no specification');
      expect(rules.rules).toHaveLength(3);
      expect(invariants.invariants).toHaveLength(2);
      expect(invariants.unknowns.map((unknown) => unknown.id)).toEqual([
        'UNK-SWALLOWED-INSERT-FREQUENCY',
      ]);

      // Everything is attributed to the task that produced it, stamped in host code.
      for (const rule of rules.rules) {
        expect(rule.discoveredBy).toBe(`${outcome.task.role}:${outcome.task.taskId}`);
        expect(rule.discoveredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(rule.lifecycleStatus).toBe('candidate');
      }

      // Re-verify every quotation from disk, independently of the runtime's own evidence check.
      const citations = [
        ...rules.rules.flatMap((rule) => [
          ...rule.sourceEvidence,
          ...rule.edgeCases.flatMap((edgeCase) => edgeCase.evidence),
        ]),
        ...invariants.invariants.flatMap((invariant) => invariant.sourceEvidence),
      ];
      expect(citations.length).toBeGreaterThanOrEqual(8);
      for (const item of citations) {
        const location = item.location;
        if (location === undefined) throw new Error('a source-code citation carries no location');
        const text = readFileSync(join(fixture.root, location.path), 'utf8');
        const lines = text.split('\n');
        if (location.startLine !== undefined) {
          expect(
            lines[location.startLine - 1],
            `${location.path}:${location.startLine}`,
          ).toBeDefined();
        }
        const quote = item.quote ?? '';
        expect(quote.length).toBeGreaterThan(0);
        expect(text.replace(/\s+/g, ' '), location.path).toContain(quote.replace(/\s+/g, ' '));
      }

      // The persisted bytes, not the in-memory value, are what downstream stages will read.
      const envelopeOf = (relativePath: string): unknown =>
        (
          JSON.parse(readFileSync(join(runtime.paths.artifactRoot, relativePath), 'utf8')) as {
            payload?: unknown;
          }
        ).payload;
      const rulesOnDisk = businessRuleSetSchema.parse(
        envelopeOf('specification/business-rules.json'),
      );
      expect(rulesOnDisk.rules).toHaveLength(3);
      expect(rulesOnDisk.rules[0]?.ruleId).toBe('BR-ONLINE-FEE-HALF-UP');
      expect(rulesOnDisk.statistics?.total).toBe(3);
      const invariantsOnDisk = invariantSetSchema.parse(
        envelopeOf('specification/invariants.json'),
      );
      expect(invariantsOnDisk.invariants.map((invariant) => invariant.invariantId)).toEqual([
        'INV-FEE-SCALE-STABLE',
        'INV-NO-OVERDRAFT',
      ]);
      expect(
        invariantsOnDisk.invariants.every((invariant) => invariant.lifecycleStatus === 'candidate'),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('host-anchors an analyst citation to the repository bytes before persisting it', async () => {
    const report = analystReport(fixture);
    const nearMiss = {
      ...report,
      rules: report.rules.map((rule, index) =>
        index === 0
          ? {
              ...rule,
              sourceEvidence: [
                {
                  path: FEE_SERVICE_PATH,
                  startLine: citation(fixture, FEE_SERVICE_PATH, 'public BigDecimal onlineFee')
                    .startLine,
                  quote: 'public BigDecimal onlineFee(BigDecimal value) {',
                },
              ],
            }
          : rule,
      ),
    };
    const provider = new MockLlmProvider({
      responses: [readSpecSources, jsonResponse(nearMiss)],
    });
    const sink = new InMemoryEventSink();
    const runId = newRunId();
    const runtime = stageRuntime(fixture, provider, sink, runId);

    try {
      const outcome = await runSpecificationStage({
        runId,
        runtime,
        findings: upstreamFindings(fixture),
      });

      expect(outcome.result.status, outcome.result.errorMessage ?? '').toBe('SUCCEEDED');
      expect(provider.callCount).toBe(2);
      const anchored = outcome.rules?.rules.find((rule) => rule.ruleId === 'BR-ONLINE-FEE-HALF-UP')
        ?.sourceEvidence[0];
      expect(anchored?.quote).toContain('public BigDecimal onlineFee(BigDecimal amount) {');
      expect(anchored?.note).toContain('host-anchored to real bytes');
      expect(outcome.run.warnings.join('\n')).toContain(
        'host anchored rejected citations to real repository bytes',
      );
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('demotes a claim whose citation remains unresolvable after every repair', async () => {
    const report = analystReport(fixture);
    const fabricated = {
      ...report,
      rules: report.rules.map((rule, index) =>
        index === 0
          ? {
              ...rule,
              sourceEvidence: [
                {
                  path: FEE_SERVICE_PATH,
                  startLine: 99_999,
                  quote: 'quantumFluxCapacitor.enforceTemporalLedgerParity()',
                },
              ],
            }
          : rule,
      ),
    };
    const provider = new MockLlmProvider({
      responses: [
        readSpecSources,
        jsonResponse(fabricated),
        jsonResponse(fabricated),
        jsonResponse(fabricated),
      ],
    });
    const sink = new InMemoryEventSink();
    const runId = newRunId();
    const runtime = stageRuntime(fixture, provider, sink, runId);

    try {
      const outcome = await runSpecificationStage({
        runId,
        runtime,
        findings: upstreamFindings(fixture),
      });

      expect(outcome.result.status, outcome.result.errorMessage ?? '').toBe('SUCCEEDED');
      expect(provider.callCount).toBe(4);
      expect(outcome.rules?.rules.some((rule) => rule.ruleId === 'BR-ONLINE-FEE-HALF-UP')).toBe(
        false,
      );
      expect(outcome.rules?.unknowns.map((unknown) => unknown.id)).toContain(
        'UNK-ONLINE-FEE-HALF-UP',
      );
      expect(outcome.run.warnings.join('\n')).toContain('demoted BR-ONLINE-FEE-HALF-UP');
      expect(
        outcome.result.acceptance.find((item) => item.criterionId === 'citations-resolve')
          ?.satisfied,
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('anchors an excessively long invariant citation via its prefix lines', async () => {
    const report = analystReport(fixture);
    // Build a quote whose first lines are real FeeService content but whose full body exceeds
    // 1500 chars by including non-contiguous filler. This mirrors a model that dumps an entire
    // method body (or multiple methods) as a single citation.
    const realPrefix = readFileSync(join(fixture.root, FEE_SERVICE_PATH), 'utf8')
      .split('\n')
      .slice(
        citation(fixture, FEE_SERVICE_PATH, 'public BigDecimal onlineFee').startLine - 1,
        citation(fixture, FEE_SERVICE_PATH, 'public BigDecimal onlineFee').startLine + 7,
      )
      .join('\n');
    const filler =
      '\n    // --- model pasted additional unrelated method body below ---\n' +
      Array.from(
        { length: 60 },
        (_, i) => `    BigDecimal step${i} = amount.add(new BigDecimal("${i}.00"));`,
      ).join('\n');
    const oversizedQuote = realPrefix + filler;
    expect(oversizedQuote.length).toBeGreaterThan(1500);

    const withLongInvariant = {
      ...report,
      invariants: report.invariants.map((inv, index) =>
        index === 0
          ? {
              ...inv,
              sourceEvidence: [
                {
                  path: FEE_SERVICE_PATH,
                  startLine: citation(fixture, FEE_SERVICE_PATH, 'public BigDecimal onlineFee')
                    .startLine,
                  quote: oversizedQuote,
                },
              ],
            }
          : inv,
      ),
    };
    const provider = new MockLlmProvider({
      responses: [readSpecSources, jsonResponse(withLongInvariant)],
    });
    const sink = new InMemoryEventSink();
    const runId = newRunId();
    const runtime = stageRuntime(fixture, provider, sink, runId);

    try {
      const outcome = await runSpecificationStage({
        runId,
        runtime,
        findings: upstreamFindings(fixture),
      });

      expect(outcome.result.status, outcome.result.errorMessage ?? '').toBe('SUCCEEDED');
      expect(provider.callCount).toBe(2);
      const inv = outcome.invariants?.invariants.find(
        (i) => i.invariantId === 'INV-FEE-SCALE-STABLE',
      );
      expect(inv).toBeDefined();
      expect(inv?.sourceEvidence.length).toBeGreaterThanOrEqual(1);
      expect(inv?.sourceEvidence[0]?.quote).toContain(
        'public BigDecimal onlineFee(BigDecimal amount)',
      );
      expect(inv?.sourceEvidence[0]?.note).toContain('host-anchored');
    } finally {
      await runtime.close();
    }
  }, 60_000);

  it('refuses a specification with invented evidence until the model repairs the citation', async () => {
    const good = analystReport(fixture);
    const fabricated = {
      ...analystReport(fixture),
      rules: analystReport(fixture).rules.map((rule, index) =>
        index === 0
          ? {
              ...rule,
              sourceEvidence: [
                {
                  path: FEE_SERVICE_PATH,
                  startLine: 99_999,
                  quote: 'fee = fee.roundUpBecauseTheSpecificationSaysSo()',
                },
              ],
            }
          : rule,
      ),
    };
    const provider = new MockLlmProvider({
      responses: [readSpecSources, jsonResponse(fabricated), jsonResponse(good)],
    });
    const sink = new InMemoryEventSink();
    const runId = newRunId();
    const runtime = stageRuntime(fixture, provider, sink, runId);

    try {
      const outcome = await runSpecificationStage({
        runId,
        runtime,
        findings: upstreamFindings(fixture),
      });

      // The fabricated reply never reached the artifact store: the loop rejected it, named the rule
      // whose citation did not hold up, and accepted only the corrected reply.
      expect(outcome.result.status, outcome.result.errorMessage ?? '').toBe('SUCCEEDED');
      expect(provider.callCount).toBe(3);
      const repair = provider.requests[2]?.messages.at(-1);
      expect(repair?.content).toContain('citations that do not resolve');
      expect(repair?.content).toContain('BR-ONLINE-FEE-HALF-UP');
      expect(outcome.rules?.rules.map((rule) => rule.ruleId)).toContain('BR-ONLINE-FEE-HALF-UP');
      expect(
        outcome.result.acceptance.find((item) => item.criterionId === 'citations-resolve')
          ?.satisfied,
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  }, 60_000);
});

describe('specificationBrief', () => {
  const fixture = createLegacyFixture();

  it('hands the analyst citations and open questions, but not the archaeologist prose', () => {
    const brief = specificationBrief(upstreamFindings(fixture));
    expect(brief).toContain('F-FEE-LOGIC-DUPLICATED');
    expect(brief).toContain(
      `${FEE_SERVICE_PATH}:${citation(fixture, FEE_SERVICE_PATH, HALF_UP).startLine}`,
    );
    expect(brief).toContain('[duplication, OBSERVED, confidence 0.85]');
    expect(brief).toContain('Q-FEE-PATH-PRECEDENCE');
    // The section bodies are the Archaeologist's reading; the Analyst must form its own.
    expect(brief).not.toContain('A tiny transfer service over PostgreSQL.');
  });

  it('points at the quoted source instead of reproducing it', () => {
    const brief = specificationBrief(upstreamFindings(fixture));
    // A brief that carried the quote would let the Analyst write a rule about code it never opened,
    // and every citation it then produced would fail the read-before-you-cite check.
    expect(brief).not.toContain(HALF_UP);
    expect(brief).toContain(`${HALF_UP.length} characters quoted`);
    expect(brief).toContain('text withheld here: open the file');
  });

  it('says when it truncated, rather than looking complete', () => {
    const brief = specificationBrief(upstreamFindings(fixture), { maxChars: 120 });
    expect(brief.length).toBeLessThan(400);
    expect(brief).toContain('[brief truncated at 120 characters of');
    expect(brief).toContain('read discovery/findings.json for the rest');
  });

  it('names the findings it had to leave out', () => {
    const brief = specificationBrief(upstreamFindings(fixture), { maxFindings: 1 });
    expect(brief).toContain('F-FEE-LOGIC-DUPLICATED');
    expect(brief).not.toContain('F-OVERDRAFT-RULE-IN-DATABASE —');
    expect(brief).toContain('1 further finding(s) were omitted from this brief');
    expect(brief).toContain('F-OVERDRAFT-RULE-IN-DATABASE');
  });
});

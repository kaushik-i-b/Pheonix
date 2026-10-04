import {
  characterizationAssertionSchema,
  characterizationCaseSchema,
  characterizationSuiteSchema,
  hashStable,
  scenarioExecutionSchema,
  scenarioSchema,
  scenarioStepSchema,
  stepOutcomeSchema,
  type AssertionKind,
  type AssertionNormalization,
  type CharacterizationAssertion,
  type CharacterizationCase,
  type CharacterizationCaseStatus,
  type CharacterizationSuite,
  type HttpStep,
  type Scenario,
  type ScenarioExecution,
  type ScenarioStep,
  type StepOutcome,
} from '@phoenix/shared';

/**
 * Builders for the comparison tests. A comparison is a pure function of a recorded legacy baseline
 * and a recorded modern execution, so the fixtures have to state both precisely — including the
 * one-cent fee difference that the differential verifier must flag.
 */

export function httpStep(stepId: string, path: string, init: Partial<HttpStep> = {}): ScenarioStep {
  return scenarioStepSchema.parse({
    stepId,
    description: `${init.method ?? 'GET'} ${path}`,
    kind: 'http',
    http: { method: 'GET', path, ...init },
  });
}

export function scenario(steps: readonly ScenarioStep[], overrides: Partial<Scenario> = {}): Scenario {
  return scenarioSchema.parse({
    scenarioId: 'scn_fee-rounding',
    title: 'transfer fee is charged',
    description: 'A scenario built by a test.',
    category: 'rounding',
    hypothesis: 'The transfer fee matches the captured legacy value.',
    steps,
    provenance: { createdBy: 'characterization-engineer', origin: 'derived-from-rule' },
    ...overrides,
  });
}

export function outcome(stepId: string, init: Partial<Omit<StepOutcome, 'stepId'>> = {}): StepOutcome {
  return stepOutcomeSchema.parse({
    stepId,
    kind: 'http',
    status: 'ok',
    durationMs: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...init,
  });
}

export function execution(
  system: 'legacy' | 'modern',
  steps: readonly StepOutcome[],
  init: Partial<ScenarioExecution> = {},
): ScenarioExecution {
  return scenarioExecutionSchema.parse({
    scenarioId: 'scn_fee-rounding',
    system,
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    durationMs: 1000,
    status: 'completed',
    steps: [...steps],
    ...init,
  });
}

export interface AssertionInit {
  assertionId: string;
  kind: AssertionKind;
  description?: string;
  stepId?: string;
  path?: string;
  expected?: unknown;
  normalized?: boolean;
  normalization?: AssertionNormalization;
  sourceRuleIds?: readonly string[];
  sourceInvariantIds?: readonly string[];
}

export function assertion(init: AssertionInit): CharacterizationAssertion {
  return characterizationAssertionSchema.parse({
    assertionId: init.assertionId,
    description: init.description ?? `captured ${init.kind}`,
    kind: init.kind,
    stepId: init.stepId ?? 'transfer',
    ...(init.path !== undefined ? { path: init.path } : {}),
    ...(init.expected !== undefined ? { expected: init.expected } : {}),
    ...(init.normalized !== undefined ? { normalized: init.normalized } : {}),
    ...(init.normalization !== undefined ? { normalization: init.normalization } : {}),
    ...(init.sourceRuleIds !== undefined ? { sourceRuleIds: [...init.sourceRuleIds] } : {}),
    ...(init.sourceInvariantIds !== undefined
      ? { sourceInvariantIds: [...init.sourceInvariantIds] }
      : {}),
  });
}

export interface CaseInit {
  caseId: string;
  assertions: readonly CharacterizationAssertion[];
  status?: CharacterizationCaseStatus;
  scenario?: Scenario;
  captureExecutionId?: string;
  targetRuleIds?: readonly string[];
  targetInvariantIds?: readonly string[];
}

export function caseItem(init: CaseInit): CharacterizationCase {
  const scn = init.scenario ?? scenario([httpStep('transfer', '/api/transfers', { method: 'POST' })]);
  return characterizationCaseSchema.parse({
    caseId: init.caseId,
    title: scn.title,
    category: scn.category,
    scenario: scn,
    assertions: [...init.assertions],
    ...(init.status !== undefined ? { status: init.status } : {}),
    ...(init.captureExecutionId !== undefined ? { captureExecutionId: init.captureExecutionId } : {}),
    ...(init.targetRuleIds !== undefined ? { targetRuleIds: [...init.targetRuleIds] } : {}),
    ...(init.targetInvariantIds !== undefined
      ? { targetInvariantIds: [...init.targetInvariantIds] }
      : {}),
  });
}

export function suiteOf(input: {
  cases: readonly CharacterizationCase[];
  captures: readonly ScenarioExecution[];
}): CharacterizationSuite {
  return characterizationSuiteSchema.parse({
    generatedAt: '2026-01-01T00:00:02.000Z',
    generatedBy: 'characterization-engineer',
    capturedFrom: 'legacy http://127.0.0.1:8080',
    cases: [...input.cases],
    captures: [...input.captures],
  });
}

export interface FeeFixture {
  item: CharacterizationCase;
  baseline: ScenarioExecution;
  suite: CharacterizationSuite;
}

export const FEE_CASE_ID = 'CHR-FEE-001';
export const FEE_ASSERTION_ID = 'CHR-FEE-001-A1';
export const FEE_RULE_ID = 'BR-FEE-CALC';
export const FEE_INVARIANT_ID = 'INV-FEE-ROUNDING';
/** The captured legacy fee; 2.01 is deliberately a value whose last cent a naive modern rewrite loses. */
export const LEGACY_FEE = 2.01;

/** A captured transfer-fee case: legacy charged 2.01, and the assertion pins exactly that value. */
export function feeFixture(): FeeFixture {
  const baseline = execution('legacy', [
    outcome('transfer', {
      httpStatus: 200,
      responseBody: { transferId: 'TR-1', amount: 100, fee: LEGACY_FEE },
    }),
  ]);
  const item = caseItem({
    caseId: FEE_CASE_ID,
    status: 'passing-against-legacy',
    captureExecutionId: hashStable(baseline),
    assertions: [
      assertion({
        assertionId: FEE_ASSERTION_ID,
        description: 'the fee charged matches the legacy calculation',
        kind: 'json-value',
        path: 'responseBody.fee',
        expected: LEGACY_FEE,
        sourceRuleIds: [FEE_RULE_ID],
        sourceInvariantIds: [FEE_INVARIANT_ID],
      }),
    ],
    targetRuleIds: [FEE_RULE_ID],
    targetInvariantIds: [FEE_INVARIANT_ID],
  });
  return { item, baseline, suite: suiteOf({ cases: [item], captures: [baseline] }) };
}

export interface FeeCaseOptions {
  caseId: string;
  legacyFee: number;
  status?: CharacterizationCaseStatus;
  sourceRuleIds?: readonly string[];
  sourceInvariantIds?: readonly string[];
}

/**
 * One fee case with its own scenario id, so a multi-case suite for verdict tests reads like three
 * legitimate characterization records rather than the same one cloned.
 */
export function feeCase(
  options: FeeCaseOptions,
): { item: CharacterizationCase; baseline: ScenarioExecution } {
  const scenarioId = `scn_${options.caseId.toLowerCase()}`;
  const scn = scenario([httpStep('transfer', '/api/transfers', { method: 'POST' })], {
    scenarioId,
    title: `transfer fee ${options.caseId}`,
  });
  const baseline = execution(
    'legacy',
    [
      outcome('transfer', {
        httpStatus: 200,
        responseBody: { transferId: 'TR-1', amount: 100, fee: options.legacyFee },
      }),
    ],
    { scenarioId },
  );
  const item = caseItem({
    caseId: options.caseId,
    status: options.status ?? 'passing-against-legacy',
    scenario: scn,
    captureExecutionId: hashStable(baseline),
    assertions: [
      assertion({
        assertionId: `${options.caseId}-A1`,
        kind: 'json-value',
        path: 'responseBody.fee',
        expected: options.legacyFee,
        ...(options.sourceRuleIds !== undefined ? { sourceRuleIds: options.sourceRuleIds } : {}),
        ...(options.sourceInvariantIds !== undefined
          ? { sourceInvariantIds: options.sourceInvariantIds }
          : {}),
      }),
    ],
  });
  return { item, baseline };
}

export function feeModern(fee: number): ScenarioExecution {
  return execution('modern', [
    outcome('transfer', { httpStatus: 200, responseBody: { transferId: 'TR-9', amount: 100, fee } }),
  ]);
}

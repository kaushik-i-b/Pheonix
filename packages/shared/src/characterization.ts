import { z } from 'zod';
import {
  caseIdSchema,
  isoTimestampSchema,
  invariantIdSchema,
  ruleIdSchema,
  scenarioIdSchema,
  evidenceRefSchema,
} from './primitives.js';
import { agentRoleSchema } from './roles.js';
import {
  scenarioCategorySchema,
  scenarioExecutionSchema,
  scenarioSchema,
  systemLabelSchema,
} from './scenario.js';

/**
 * Characterization: the executable behavioral contract.
 *
 * A characterization case is *captured*, not authored. Phoenix runs a scenario against the legacy
 * system, records what actually happened, and derives assertions from that capture. The suite
 * therefore passes against legacy by construction — including where legacy behavior is a bug —
 * and any divergence when it is run against the modern system is meaningful.
 */

export const assertionKindSchema = z.enum([
  'http-status',
  'json-value',
  'text-value',
  'json-shape',
  'row-count',
  'db-value',
  'exit-code',
  'error-present',
  'ordering',
  'numeric-tolerance',
  'side-effect',
]);
export type AssertionKind = z.infer<typeof assertionKindSchema>;

/**
 * Why a captured value is excluded from comparison.
 *
 * Recorded rather than implied: a normalized assertion that cannot say what varied, what it varied
 * between, and which host policy excused it is indistinguishable from a difference somebody did not
 * want to see.
 */
export const assertionNormalizationSchema = z.object({
  reason: z.enum(['varied-across-repeated-legacy-executions', 'clock-reading']),
  policy: z.string().min(1),
  observedValues: z.array(z.unknown()).min(2).max(2),
});
export type AssertionNormalization = z.infer<typeof assertionNormalizationSchema>;

export const characterizationAssertionSchema = z.object({
  assertionId: z.string().min(1),
  description: z.string().min(1).max(2000),
  kind: assertionKindSchema,
  /** Step whose outcome is asserted. */
  stepId: z.string().min(1),
  /** Dotted path into the step outcome, e.g. `responseBody.balance` or `rows.0.amount`. */
  path: z.string().min(1).optional(),
  /** Captured value; `null` is a legitimate captured value, `undefined` means "any". */
  expected: z.unknown().optional(),
  tolerance: z.number().nonnegative().optional(),
  /** Set when the value is legitimately nondeterministic and normalization is configured for it. */
  normalized: z.boolean().default(false),
  normalization: assertionNormalizationSchema.optional(),
  sourceRuleIds: z.array(ruleIdSchema).default([]),
  sourceInvariantIds: z.array(invariantIdSchema).default([]),
  evidence: z.array(evidenceRefSchema).default([]),
});
export type CharacterizationAssertion = z.infer<typeof characterizationAssertionSchema>;

export const characterizationCaseStatusSchema = z.enum([
  'proposed',
  'captured',
  'passing-against-legacy',
  'failing-against-legacy',
  'inconclusive',
  'skipped',
]);
export type CharacterizationCaseStatus = z.infer<typeof characterizationCaseStatusSchema>;

export const characterizationCaseSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  caseId: caseIdSchema,
  title: z.string().min(1).max(300),
  category: scenarioCategorySchema,
  scenario: scenarioSchema,
  assertions: z.array(characterizationAssertionSchema).default([]),
  status: characterizationCaseStatusSchema.default('proposed'),
  /** True when the captured behavior looks wrong but is recorded as-is: legacy is the contract. */
  recordsLegacyDefect: z.boolean().default(false),
  defectNote: z.string().max(4000).optional(),
  /**
   * Paths that differed between two identical executions against legacy but that host policy will
   * not excuse from comparison. Their assertions stay live, so a scenario that mutates shared state
   * shows up as a mismatch to investigate rather than being silently forgiven.
   */
  unexplainedVolatility: z.array(z.string().min(1)).default([]),
  targetRuleIds: z.array(ruleIdSchema).default([]),
  targetInvariantIds: z.array(invariantIdSchema).default([]),
  captureExecutionId: z.string().min(1).optional(),
});
export type CharacterizationCase = z.infer<typeof characterizationCaseSchema>;

export const characterizationCoverageSchema = z.object({
  ruleIdsCovered: z.array(ruleIdSchema).default([]),
  ruleIdsUncovered: z.array(ruleIdSchema).default([]),
  invariantIdsCovered: z.array(invariantIdSchema).default([]),
  invariantIdsUncovered: z.array(invariantIdSchema).default([]),
  categoriesCovered: z.array(scenarioCategorySchema).default([]),
});
export type CharacterizationCoverage = z.infer<typeof characterizationCoverageSchema>;

export const characterizationSuiteSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generatedBy: agentRoleSchema,
  capturedFrom: z.string().min(1),
  cases: z.array(characterizationCaseSchema).default([]),
  captures: z.array(scenarioExecutionSchema).default([]),
  coverage: characterizationCoverageSchema.default({}),
  statistics: z
    .object({
      total: z.number().int().nonnegative(),
      captured: z.number().int().nonnegative(),
      assertions: z.number().int().nonnegative(),
      recordingLegacyDefects: z.number().int().nonnegative(),
    })
    .optional(),
});
export type CharacterizationSuite = z.infer<typeof characterizationSuiteSchema>;

export const assertionResultSchema = z.object({
  assertionId: z.string().min(1),
  satisfied: z.boolean(),
  actual: z.unknown().optional(),
  expected: z.unknown().optional(),
  path: z.string().min(1).optional(),
  message: z.string().max(2000).optional(),
  normalized: z.boolean().default(false),
});
export type AssertionResult = z.infer<typeof assertionResultSchema>;

export const caseExecutionResultSchema = z.object({
  caseId: caseIdSchema,
  scenarioId: scenarioIdSchema,
  system: systemLabelSchema,
  passed: z.boolean(),
  status: z.enum(['passed', 'failed', 'error', 'timeout', 'unreachable', 'skipped']),
  assertionResults: z.array(assertionResultSchema).default([]),
  execution: scenarioExecutionSchema.optional(),
  durationMs: z.number().int().nonnegative(),
  notes: z.string().max(4000).optional(),
});
export type CaseExecutionResult = z.infer<typeof caseExecutionResultSchema>;

export const characterizationExecutionReportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runId: z.string().min(1),
  executedAt: isoTimestampSchema,
  system: systemLabelSchema,
  results: z.array(caseExecutionResultSchema).default([]),
  summary: z.object({
    total: z.number().int().nonnegative(),
    passed: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    errored: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    passRate: z.number().min(0).max(1),
  }),
});
export type CharacterizationExecutionReport = z.infer<typeof characterizationExecutionReportSchema>;

export function computeSuiteStatistics(
  suite: CharacterizationSuite,
): NonNullable<CharacterizationSuite['statistics']> {
  return {
    total: suite.cases.length,
    captured: suite.cases.filter((item) => item.status !== 'proposed' && item.status !== 'skipped').length,
    assertions: suite.cases.reduce((acc, item) => acc + item.assertions.length, 0),
    recordingLegacyDefects: suite.cases.filter((item) => item.recordsLegacyDefect).length,
  };
}

export function computeCoverage(input: {
  cases: readonly CharacterizationCase[];
  knownRuleIds: readonly string[];
  knownInvariantIds: readonly string[];
}): CharacterizationCoverage {
  const coveredRules = new Set<string>();
  const coveredInvariants = new Set<string>();
  const categories = new Set<ScenarioCategoryLike>();
  for (const item of input.cases) {
    for (const ruleId of item.targetRuleIds) coveredRules.add(ruleId);
    for (const invariantId of item.targetInvariantIds) coveredInvariants.add(invariantId);
    for (const assertion of item.assertions) {
      for (const ruleId of assertion.sourceRuleIds) coveredRules.add(ruleId);
      for (const invariantId of assertion.sourceInvariantIds) coveredInvariants.add(invariantId);
    }
    categories.add(item.category);
  }
  return characterizationCoverageSchema.parse({
    ruleIdsCovered: [...coveredRules].filter((id) => input.knownRuleIds.includes(id)),
    ruleIdsUncovered: input.knownRuleIds.filter((id) => !coveredRules.has(id)),
    invariantIdsCovered: [...coveredInvariants].filter((id) => input.knownInvariantIds.includes(id)),
    invariantIdsUncovered: input.knownInvariantIds.filter((id) => !coveredInvariants.has(id)),
    categoriesCovered: [...categories],
  });
}

type ScenarioCategoryLike = z.infer<typeof scenarioCategorySchema>;

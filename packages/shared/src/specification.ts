import { z } from 'zod';
import {
  confidenceBandSchema,
  confidenceSchema,
  epistemicStatusSchema,
  evidenceRefSchema,
  invariantIdSchema,
  isoTimestampSchema,
  ruleIdSchema,
  severitySchema,
} from './primitives.js';

/**
 * The behavioral specification: candidate business rules and invariants derived from evidence.
 *
 * The taxonomies below are deliberately **domain-neutral**. Phoenix must not ship banking rules;
 * a banking workload should cause it to *discover* instances of `conservation`, `rounding-stability`
 * and `idempotency` with source evidence attached.
 */

export const businessRuleKindSchema = z.enum([
  'calculation',
  'derived-value',
  'validation',
  'constraint',
  'state-transition',
  'timing',
  'authorization',
  'persistence',
  'retry',
  'default-value',
  'error-handling',
  'other',
]);
export type BusinessRuleKind = z.infer<typeof businessRuleKindSchema>;

export const ruleLifecycleStatusSchema = z.enum([
  'candidate',
  'confirmed',
  'contradicted',
  'rejected',
  'unresolved',
]);
export type RuleLifecycleStatus = z.infer<typeof ruleLifecycleStatusSchema>;

export const edgeCaseSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(2000),
  expectedBehavior: z.string().max(2000).optional(),
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  evidence: z.array(evidenceRefSchema).default([]),
});
export type EdgeCase = z.infer<typeof edgeCaseSchema>;

export const proposedCheckSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(2000),
  kind: z.enum(['api-scenario', 'unit-test', 'db-query', 'property-test', 'concurrency-probe', 'time-probe']),
  targetsRuleId: ruleIdSchema.optional(),
  targetsInvariantId: invariantIdSchema.optional(),
});
export type ProposedCheck = z.infer<typeof proposedCheckSchema>;

export const ruleConfirmationSchema = z.object({
  confirmedAt: isoTimestampSchema,
  confirmedBy: z.string().min(1),
  evidence: z.array(evidenceRefSchema).min(1),
  /** What was actually observed, verbatim where possible. */
  observation: z.string().min(1).max(4000),
});
export type RuleConfirmation = z.infer<typeof ruleConfirmationSchema>;

export const businessRuleSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  ruleId: ruleIdSchema,
  title: z.string().min(1).max(300),
  description: z.string().min(1).max(8000),
  kind: businessRuleKindSchema,
  /** Never present an inference as an observation. */
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  confidenceBand: confidenceBandSchema.optional(),
  /** Why this confidence and not higher: what evidence is missing or ambiguous. */
  confidenceBasis: z.string().min(1).max(2000),
  sourceEvidence: z.array(evidenceRefSchema).min(1, 'a business rule without evidence is a guess'),
  affectedComponents: z.array(z.string().min(1)).min(1),
  /** Externally observable consequence — this is what characterization and differential tests assert. */
  observableBehavior: z.string().min(1).max(4000),
  edgeCases: z.array(edgeCaseSchema).default([]),
  assumptions: z.array(z.string().max(1000)).default([]),
  testable: z.boolean().default(true),
  proposedChecks: z.array(proposedCheckSchema).default([]),
  /** Other places implementing the same rule; drift between them is a modernization hazard. */
  duplicateImplementations: z.array(z.string().min(1)).default([]),
  contradictsRuleIds: z.array(ruleIdSchema).default([]),
  derivedFromInvariantIds: z.array(invariantIdSchema).default([]),
  lifecycleStatus: ruleLifecycleStatusSchema.default('candidate'),
  confirmation: ruleConfirmationSchema.optional(),
  discoveredBy: z.string().min(1),
  discoveredAt: isoTimestampSchema,
});
export type BusinessRule = z.infer<typeof businessRuleSchema>;

export const specificationUnknownSchema = z.object({
  id: z.string().min(1),
  question: z.string().min(1).max(2000),
  whyItMatters: z.string().min(1).max(2000),
  resolutionStrategy: z.enum([
    'runtime-probe',
    'characterization-test',
    'differential-scenario',
    'adversarial-scenario',
    'database-inspection',
    'human-input',
    'unresolvable',
  ]),
  relatedRuleIds: z.array(ruleIdSchema).default([]),
  relatedInvariantIds: z.array(invariantIdSchema).default([]),
});
export type SpecificationUnknown = z.infer<typeof specificationUnknownSchema>;

export const specificationStatisticsSchema = z.object({
  total: z.number().int().nonnegative(),
  observed: z.number().int().nonnegative(),
  inferred: z.number().int().nonnegative(),
  unknown: z.number().int().nonnegative(),
  confirmed: z.number().int().nonnegative(),
  contradicted: z.number().int().nonnegative(),
  averageConfidence: z.number().min(0).max(1),
  lowConfidenceCount: z.number().int().nonnegative(),
  withDuplicateImplementations: z.number().int().nonnegative(),
});
export type SpecificationStatistics = z.infer<typeof specificationStatisticsSchema>;

export const businessRuleSetSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generatedBy: z.string().min(1),
  targetRoot: z.string().min(1),
  rules: z.array(businessRuleSchema).default([]),
  /** Explicitly recorded gaps. An empty list must mean "nothing unknown", not "nothing recorded". */
  unknowns: z.array(specificationUnknownSchema).default([]),
  statistics: specificationStatisticsSchema.optional(),
});
export type BusinessRuleSet = z.infer<typeof businessRuleSetSchema>;

export const invariantKindSchema = z.enum([
  'conservation',
  'idempotency',
  'uniqueness',
  'monotonicity',
  'immutability',
  'rounding-stability',
  'ordering',
  'retry-semantics',
  'state-machine-legality',
  'precision',
  'referential-integrity',
  'bound',
  'totality',
  'determinism',
  'authorization',
  'auditability',
  'other',
]);
export type InvariantKind = z.infer<typeof invariantKindSchema>;

export const invariantCriticalitySchema = z.enum(['CRITICAL', 'MAJOR', 'MINOR']);
export type InvariantCriticality = z.infer<typeof invariantCriticalitySchema>;

export const checkingStrategySchema = z.object({
  kind: z.enum([
    'differential-scenario',
    'database-query',
    'property-test',
    'unit-test',
    'api-invariant-check',
    'concurrency-probe',
    'manual',
  ]),
  detail: z.string().min(1).max(4000),
  automated: z.boolean().default(true),
  /** Deterministic query/check text when the strategy is machine-executable. */
  executable: z.string().max(8000).optional(),
});
export type CheckingStrategy = z.infer<typeof checkingStrategySchema>;

export const invariantSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  invariantId: invariantIdSchema,
  /** A falsifiable sentence, e.g. "sum of ledger entries for an account equals its balance". */
  statement: z.string().min(1).max(2000),
  /** Optional machine-oriented restatement used to generate checks. */
  formalStatement: z.string().max(4000).optional(),
  kind: invariantKindSchema,
  criticality: invariantCriticalitySchema,
  scope: z.object({
    components: z.array(z.string().min(1)).default([]),
    operations: z.array(z.string().min(1)).default([]),
  }),
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  sourceEvidence: z.array(evidenceRefSchema).min(1, 'an invariant without evidence is an opinion'),
  checkingStrategy: checkingStrategySchema,
  violationSeverity: severitySchema,
  derivedFromRuleIds: z.array(ruleIdSchema).default([]),
  examples: z
    .array(z.object({ description: z.string().min(1).max(1000), expected: z.string().max(1000) }))
    .default([]),
  /** Cases where the invariant is known not to hold; prevents false blocking at release time. */
  knownExceptions: z.array(z.string().max(1000)).default([]),
  lifecycleStatus: z.enum(['candidate', 'confirmed', 'violated', 'rejected', 'unresolved']).default('candidate'),
  discoveredBy: z.string().min(1),
  discoveredAt: isoTimestampSchema,
});
export type Invariant = z.infer<typeof invariantSchema>;

export const invariantSetSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generatedBy: z.string().min(1),
  targetRoot: z.string().min(1),
  invariants: z.array(invariantSchema).default([]),
  unknowns: z.array(specificationUnknownSchema).default([]),
  statistics: z
    .object({
      total: z.number().int().nonnegative(),
      byCriticality: z.record(invariantCriticalitySchema, z.number().int().nonnegative()),
      observed: z.number().int().nonnegative(),
      inferred: z.number().int().nonnegative(),
      averageConfidence: z.number().min(0).max(1),
      automatable: z.number().int().nonnegative(),
    })
    .optional(),
});
export type InvariantSet = z.infer<typeof invariantSetSchema>;

export function computeRuleStatistics(rules: readonly BusinessRule[]): SpecificationStatistics {
  const total = rules.length;
  const sum = rules.reduce((acc, rule) => acc + rule.confidence, 0);
  return specificationStatisticsSchema.parse({
    total,
    observed: rules.filter((rule) => rule.epistemicStatus === 'OBSERVED').length,
    inferred: rules.filter((rule) => rule.epistemicStatus === 'INFERRED').length,
    unknown: rules.filter((rule) => rule.epistemicStatus === 'UNKNOWN').length,
    confirmed: rules.filter((rule) => rule.lifecycleStatus === 'confirmed').length,
    contradicted: rules.filter((rule) => rule.lifecycleStatus === 'contradicted').length,
    averageConfidence: total === 0 ? 0 : sum / total,
    lowConfidenceCount: rules.filter((rule) => rule.confidence < 0.6).length,
    withDuplicateImplementations: rules.filter((rule) => rule.duplicateImplementations.length > 0).length,
  });
}

export function computeInvariantStatistics(invariants: readonly Invariant[]): z.infer<
  typeof invariantSetSchema
>['statistics'] {
  const total = invariants.length;
  const sum = invariants.reduce((acc, invariant) => acc + invariant.confidence, 0);
  const byCriticality: Record<InvariantCriticality, number> = { CRITICAL: 0, MAJOR: 0, MINOR: 0 };
  for (const invariant of invariants) byCriticality[invariant.criticality] += 1;
  return {
    total,
    byCriticality,
    observed: invariants.filter((invariant) => invariant.epistemicStatus === 'OBSERVED').length,
    inferred: invariants.filter((invariant) => invariant.epistemicStatus === 'INFERRED').length,
    averageConfidence: total === 0 ? 0 : sum / total,
    automatable: invariants.filter((invariant) => invariant.checkingStrategy.automated).length,
  };
}

import { z } from 'zod';
import {
  evidenceRefSchema,
  invariantIdSchema,
  isoTimestampSchema,
  ruleIdSchema,
  scenarioIdSchema,
  severitySchema,
} from './primitives.js';
import { agentRoleSchema } from './roles.js';
import { scenarioSchema, scenarioExecutionSchema } from './scenario.js';
import { findingSchema } from './agent.js';

/**
 * Adversarial testing contracts (brief §4 "Adversary").
 *
 * Scenarios are derived from what was *discovered* about this particular system, not from a
 * hardcoded checklist. The attack classes below are a vocabulary for labeling and measuring
 * coverage — they do not by themselves generate scenarios.
 */

export const attackClassSchema = z.enum([
  'concurrency',
  'duplicate-request',
  'timeout',
  'partial-failure',
  'process-crash',
  'database-failure',
  'out-of-order-events',
  'invalid-state-transition',
  'boundary-value',
  'precision',
  'migration-inconsistency',
  'retry-storm',
  'clock-skew',
  'resource-exhaustion',
  'authorization-bypass',
  'malformed-payload',
  'state-restoration',
  'other',
]);
export type AttackClass = z.infer<typeof attackClassSchema>;

export const ATTACK_CLASSES: readonly AttackClass[] = [
  'concurrency',
  'duplicate-request',
  'timeout',
  'partial-failure',
  'process-crash',
  'database-failure',
  'out-of-order-events',
  'invalid-state-transition',
  'boundary-value',
  'precision',
  'migration-inconsistency',
  'retry-storm',
  'clock-skew',
  'resource-exhaustion',
  'authorization-bypass',
  'malformed-payload',
  'state-restoration',
  'other',
] as const;

export const adversarialScenarioSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  scenario: scenarioSchema,
  attackClass: attackClassSchema,
  /** What the Adversary expects to break, and why it thinks the modern implementation is vulnerable. */
  hypothesis: z.string().min(1).max(4000),
  expectedFailureMode: z.string().min(1).max(2000),
  severityIfBroken: severitySchema,
  derivedFrom: z.object({
    ruleIds: z.array(ruleIdSchema).default([]),
    invariantIds: z.array(invariantIdSchema).default([]),
    evidence: z.array(evidenceRefSchema).min(1, 'an attack must be grounded in discovered evidence'),
    /** Which discovered characteristic motivated the attack (duplication, rounding, retry, ...). */
    motivation: z.string().min(1).max(2000),
  }),
  /** True when the same scenario must also run against legacy to establish the reference behavior. */
  requiresLegacyBaseline: z.boolean().default(true),
});
export type AdversarialScenario = z.infer<typeof adversarialScenarioSchema>;

export const adversarialOutcomeSchema = z.enum([
  'modern-broke',
  'legacy-broke',
  'both-broke-identically',
  'both-broke-differently',
  'no-divergence',
  'inconclusive',
  'blocked-by-permissions',
  'error',
]);
export type AdversarialOutcome = z.infer<typeof adversarialOutcomeSchema>;

/** Every attempt is recorded, including the ones that failed to break anything. */
export const adversarialAttemptSchema = z.object({
  attemptId: z.string().min(1),
  scenarioId: scenarioIdSchema,
  attackClass: attackClassSchema,
  target: z.enum(['legacy', 'modern', 'both']),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  durationMs: z.number().int().nonnegative(),
  outcome: adversarialOutcomeSchema,
  mismatchIds: z.array(z.string().min(1)).default([]),
  legacyExecution: scenarioExecutionSchema.optional(),
  modernExecution: scenarioExecutionSchema.optional(),
  evidence: z.array(evidenceRefSchema).default([]),
  notes: z.string().max(4000).optional(),
});
export type AdversarialAttempt = z.infer<typeof adversarialAttemptSchema>;

export const attackClassCoverageSchema = z.object({
  attackClass: attackClassSchema,
  scenariosGenerated: z.number().int().nonnegative(),
  attemptsExecuted: z.number().int().nonnegative(),
  divergencesFound: z.number().int().nonnegative(),
  /** Why nothing was generated for this class, when that is the case. */
  notApplicableReason: z.string().max(1000).optional(),
});
export type AttackClassCoverage = z.infer<typeof attackClassCoverageSchema>;

export const adversarialReportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runId: z.string().min(1),
  generatedAt: isoTimestampSchema,
  generatedBy: agentRoleSchema,
  scenarios: z.array(adversarialScenarioSchema).default([]),
  attempts: z.array(adversarialAttemptSchema).default([]),
  findings: z.array(findingSchema).default([]),
  coverage: z.array(attackClassCoverageSchema).default([]),
  statistics: z.object({
    scenarios: z.number().int().nonnegative(),
    attempts: z.number().int().nonnegative(),
    modernBroke: z.number().int().nonnegative(),
    legacyBroke: z.number().int().nonnegative(),
    divergences: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(),
    blocked: z.number().int().nonnegative(),
    highestSeverity: severitySchema,
  }),
  /** Classes that were considered but judged inapplicable, with reasons — no silent gaps. */
  skippedClasses: z.array(z.object({ attackClass: attackClassSchema, reason: z.string().min(1).max(1000) })).default([]),
});
export type AdversarialReport = z.infer<typeof adversarialReportSchema>;

export function emptyAdversarialStatistics(): AdversarialReport['statistics'] {
  return {
    scenarios: 0,
    attempts: 0,
    modernBroke: 0,
    legacyBroke: 0,
    divergences: 0,
    inconclusive: 0,
    blocked: 0,
    highestSeverity: 'INFO',
  };
}

import { z } from 'zod';
import {
  artifactIdSchema,
  isoTimestampSchema,
  invariantIdSchema,
  ruleIdSchema,
  scenarioIdSchema,
} from './primitives.js';
import { agentRoleSchema } from './roles.js';

/**
 * Scenarios are the unit of executable behavior in Phoenix. The same scenario shape is used by
 * characterization (capture what legacy does), differential testing (run it against both systems)
 * and adversarial testing (run it to break the modern one), so a scenario discovered in one stage
 * can be replayed in another without translation.
 */

export const scenarioCategorySchema = z.enum([
  'normal-path',
  'boundary',
  'failure',
  'retry',
  'concurrency',
  'rounding',
  'precision',
  'state-transition',
  'history',
  'timing',
  'idempotency',
  'ordering',
  'partial-failure',
  'migration',
  'other',
]);
export type ScenarioCategory = z.infer<typeof scenarioCategorySchema>;

export const httpStepSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  /** Path is resolved against the target system's base URL, so one scenario runs on both. */
  path: z.string().min(1),
  query: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  headers: z.record(z.string(), z.string()).default({}),
  body: z.unknown().optional(),
  /** Raw body used when the payload must be byte-exact (malformed JSON, encoding edge cases). */
  rawBody: z.string().max(100_000).optional(),
  timeoutMs: z.number().int().positive().default(30_000),
});
export type HttpStep = z.infer<typeof httpStepSchema>;

export const sqlStepSchema = z.object({
  statement: z.string().min(1).max(20_000),
  params: z.array(z.unknown()).default([]),
  /** Read-only enforcement is decided by the tool layer, not by the scenario. */
  expectRows: z.boolean().optional(),
});
export type SqlStep = z.infer<typeof sqlStepSchema>;

export const commandStepSchema = z.object({
  argv: z.array(z.string().min(1)).min(1),
  cwd: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()).default({}),
  timeoutMs: z.number().int().positive().default(120_000),
});
export type CommandStep = z.infer<typeof commandStepSchema>;

export const scenarioStepSchema = z.object({
  stepId: z.string().min(1),
  description: z.string().min(1).max(1000),
  kind: z.enum(['http', 'sql', 'command', 'wait', 'reset', 'assert-db']),
  http: httpStepSchema.optional(),
  sql: sqlStepSchema.optional(),
  command: commandStepSchema.optional(),
  waitMs: z.number().int().nonnegative().optional(),
  /** Store this step's result under a name so later steps can reference it via `{{name.field}}`. */
  captureAs: z.string().min(1).optional(),
  /** Steps that must succeed for the scenario to be meaningful; failures abort the run. */
  required: z.boolean().default(true),
});
export type ScenarioStep = z.infer<typeof scenarioStepSchema>;

export const scenarioProvenanceSchema = z.object({
  createdBy: agentRoleSchema,
  origin: z.enum([
    'derived-from-rule',
    'derived-from-invariant',
    'derived-from-source',
    'runtime-observation',
    'adversarial',
    'repair-replay',
    'human',
  ]),
  artifactId: artifactIdSchema.optional(),
  rationale: z.string().max(4000).optional(),
});
export type ScenarioProvenance = z.infer<typeof scenarioProvenanceSchema>;

export const scenarioSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    scenarioId: scenarioIdSchema,
    title: z.string().min(1).max(300),
    description: z.string().min(1).max(4000),
    category: scenarioCategorySchema,
    /** What behavior this scenario is supposed to expose, in one sentence. */
    hypothesis: z.string().min(1).max(2000),
    targetRuleIds: z.array(ruleIdSchema).default([]),
    targetInvariantIds: z.array(invariantIdSchema).default([]),
    preconditions: z.array(z.string().max(1000)).default([]),
    setup: z.array(scenarioStepSchema).default([]),
    steps: z.array(scenarioStepSchema).min(1),
    teardown: z.array(scenarioStepSchema).default([]),
    /** Groups of step ids to execute concurrently; empty means strictly sequential. */
    concurrentStepGroups: z.array(z.array(z.string().min(1)).min(2)).default([]),
    /** Fields that are legitimately nondeterministic; normalization must be configured separately. */
    knownNondeterministicPaths: z.array(z.string().min(1)).default([]),
    deterministic: z.boolean().default(true),
    provenance: scenarioProvenanceSchema,
    tags: z.array(z.string().min(1)).default([]),
  })
  .superRefine((scenario, ctx) => {
    const ids = new Set<string>();
    for (const step of [...scenario.setup, ...scenario.steps, ...scenario.teardown]) {
      if (ids.has(step.stepId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate stepId "${step.stepId}"`,
        });
      }
      ids.add(step.stepId);
      if (step.kind === 'http' && step.http === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step ${step.stepId} is http but has no http payload` });
      }
      if ((step.kind === 'sql' || step.kind === 'assert-db') && step.sql === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step ${step.stepId} is sql but has no sql payload` });
      }
      if (step.kind === 'command' && step.command === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step ${step.stepId} is command but has no command payload` });
      }
      if (step.kind === 'wait' && step.waitMs === undefined) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: `step ${step.stepId} is wait but has no waitMs` });
      }
    }
    for (const group of scenario.concurrentStepGroups) {
      for (const stepId of group) {
        if (!ids.has(stepId)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `concurrent group references unknown stepId "${stepId}"`,
          });
        }
      }
    }
  });
export type Scenario = z.infer<typeof scenarioSchema>;

export const scenarioSetSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generatedBy: agentRoleSchema,
  scenarios: z.array(scenarioSchema).default([]),
});
export type ScenarioSet = z.infer<typeof scenarioSetSchema>;

export const stepOutcomeSchema = z.object({
  stepId: z.string().min(1),
  kind: scenarioStepSchema.shape.kind,
  status: z.enum(['ok', 'failed', 'skipped', 'error', 'timeout']),
  durationMs: z.number().int().nonnegative(),
  httpStatus: z.number().int().nonnegative().optional(),
  responseHeaders: z.record(z.string(), z.string()).default({}),
  responseBody: z.unknown().optional(),
  rowCount: z.number().int().nonnegative().optional(),
  rows: z.array(z.record(z.string(), z.unknown())).optional(),
  stdout: z.string().max(200_000).optional(),
  stderr: z.string().max(200_000).optional(),
  exitCode: z.number().int().optional(),
  error: z.string().max(4000).optional(),
  startedAt: isoTimestampSchema,
});
export type StepOutcome = z.infer<typeof stepOutcomeSchema>;

export const systemLabelSchema = z.enum(['legacy', 'modern']);
export type SystemLabel = z.infer<typeof systemLabelSchema>;

/** Raw, unnormalized result of running a scenario against one system. */
export const scenarioExecutionSchema = z.object({
  scenarioId: scenarioIdSchema,
  system: systemLabelSchema,
  baseUrl: z.string().min(1).optional(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  durationMs: z.number().int().nonnegative(),
  status: z.enum(['completed', 'failed', 'error', 'timeout', 'unreachable']),
  steps: z.array(stepOutcomeSchema).default([]),
  captured: z.record(z.string(), z.unknown()).default({}),
  /** Post-execution state used for invariant checks (balances, ledger sums, row counts). */
  stateSnapshot: z.record(z.string(), z.unknown()).default({}),
  error: z.string().max(4000).optional(),
});
export type ScenarioExecution = z.infer<typeof scenarioExecutionSchema>;

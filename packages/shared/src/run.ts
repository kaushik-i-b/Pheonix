import { z } from 'zod';
import {
  artifactIdSchema,
  confidenceSchema,
  costSchema,
  isoTimestampSchema,
  runIdSchema,
  severitySchema,
  sha256HexSchema,
  taskIdSchema,
  tokenUsageSchema,
} from './primitives.js';
import { agentRoleSchema } from './roles.js';

/**
 * Run identity, the stage pipeline, and the persisted run record.
 * A run is resumable: stage state plus input hashes are enough to continue where it stopped.
 */

export const pipelineStageSchema = z.enum([
  'DISCOVERY',
  'SPECIFICATION',
  'CHARACTERIZATION',
  'DESIGN',
  'IMPLEMENTATION',
  'ADVERSARIAL_TEST',
  'DIFFERENTIAL_TEST',
  'VERIFICATION',
  'RELEASE',
]);
export type PipelineStage = z.infer<typeof pipelineStageSchema>;

export const PIPELINE_ORDER: readonly PipelineStage[] = [
  'DISCOVERY',
  'SPECIFICATION',
  'CHARACTERIZATION',
  'DESIGN',
  'IMPLEMENTATION',
  'ADVERSARIAL_TEST',
  'DIFFERENTIAL_TEST',
  'VERIFICATION',
  'RELEASE',
] as const;

/** Sub-phases of the autonomous repair loop (brief §5). They are not pipeline stages. */
export const repairPhaseSchema = z.enum([
  'DIAGNOSE',
  'CREATE_REPAIR_TASK',
  'MODERNIZER',
  'RETEST',
]);
export type RepairPhase = z.infer<typeof repairPhaseSchema>;

export const stageStateSchema = z.enum([
  'WAITING',
  'RUNNING',
  'PASSED',
  'FAILED',
  'REPAIRING',
  'SKIPPED',
]);
export type StageState = z.infer<typeof stageStateSchema>;

export const runStatusSchema = z.enum([
  'PENDING',
  'RUNNING',
  'RELEASED_PASS',
  'REJECTED_WITH_UNRESOLVED_FAILURES',
  'FAILED_INTERNAL',
  'CANCELLED',
]);
export type RunStatus = z.infer<typeof runStatusSchema>;

/** Terminal statuses — a run in one of these never changes state again. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'RELEASED_PASS',
  'REJECTED_WITH_UNRESOLVED_FAILURES',
  'FAILED_INTERNAL',
  'CANCELLED',
] as const;

export function isTerminalRunStatus(status: RunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

export const runLimitsSchema = z.object({
  maxRepairIterations: z.number().int().positive().default(3),
  maxAgentSteps: z.number().int().positive().default(40),
  maxTotalToolCalls: z.number().int().positive().default(1200),
  maxToolCallsPerAgent: z.number().int().positive().default(150),
  stageTimeoutMs: z.number().int().positive().default(1_800_000),
  toolCallTimeoutMs: z.number().int().positive().default(120_000),
  /** A repair iteration must strictly improve the mismatch profile or the loop stops. */
  requireRepairProgress: z.boolean().default(true),
});
export type RunLimits = z.infer<typeof runLimitsSchema>;

export const llmRunConfigSchema = z.object({
  providerId: z.string().min(1),
  baseUrl: z.string().url(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.1),
  maxTokens: z.number().int().positive().default(4096),
  timeoutMs: z.number().int().positive().default(180_000),
  maxRetries: z.number().int().nonnegative().default(3),
  concurrency: z.number().int().positive().default(2),
  /** First 12 hex chars of sha256(apiKey) so runs are auditable without storing the secret. */
  apiKeyFingerprint: sha256HexSchema.optional(),
  pricingConfigured: z.boolean().default(false),
});
export type LlmRunConfig = z.infer<typeof llmRunConfigSchema>;

export const systemUnderTestSchema = z.object({
  label: z.string().min(1),
  rootPath: z.string().min(1),
  /** How Phoenix exercises the system at runtime. */
  runtime: z
    .object({
      kind: z.enum(['http', 'cli', 'library', 'none']),
      baseUrl: z.string().url().optional(),
      startCommand: z.string().min(1).optional(),
      stopCommand: z.string().min(1).optional(),
      healthPath: z.string().min(1).optional(),
      readyTimeoutMs: z.number().int().positive().default(120_000),
    })
    .default({ kind: 'none' }),
  databaseTarget: z.string().min(1).optional(),
});
export type SystemUnderTest = z.infer<typeof systemUnderTestSchema>;

export const runConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  legacy: systemUnderTestSchema,
  modern: systemUnderTestSchema,
  artifactRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
  llm: llmRunConfigSchema,
  limits: runLimitsSchema.default({}),
  /** Fingerprint of the effective configuration; two runs with equal fingerprints are comparable. */
  configHash: sha256HexSchema.optional(),
  /** Stages explicitly skipped by the operator (recorded, never silent). */
  skippedStages: z.array(pipelineStageSchema).default([]),
  startedBy: z.string().min(1).default('cli'),
});
export type RunConfig = z.infer<typeof runConfigSchema>;

export const stageAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.optional(),
  taskIds: z.array(taskIdSchema).default([]),
  artifactIds: z.array(artifactIdSchema).default([]),
  outcome: z.enum(['PASSED', 'FAILED', 'REPAIRING', 'SKIPPED']).optional(),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().max(4000).optional(),
  repairIteration: z.number().int().nonnegative().optional(),
});
export type StageAttempt = z.infer<typeof stageAttemptSchema>;

export const stageRecordSchema = z.object({
  stage: pipelineStageSchema,
  state: stageStateSchema.default('WAITING'),
  attempts: z.array(stageAttemptSchema).default([]),
  startedAt: isoTimestampSchema.optional(),
  finishedAt: isoTimestampSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  artifactIds: z.array(artifactIdSchema).default([]),
  summary: z.string().max(4000).optional(),
});
export type StageRecord = z.infer<typeof stageRecordSchema>;

export const repairIterationSchema = z.object({
  iteration: z.number().int().positive(),
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema.optional(),
  diagnosedMismatchIds: z.array(z.string().min(1)).default([]),
  repairTaskIds: z.array(taskIdSchema).default([]),
  mismatchesBefore: z.number().int().nonnegative(),
  mismatchesAfter: z.number().int().nonnegative().optional(),
  highestSeverityBefore: severitySchema.optional(),
  highestSeverityAfter: severitySchema.optional(),
  progressMade: z.boolean().optional(),
  outcome: z.enum(['IMPROVED', 'NO_CHANGE', 'REGRESSED', 'RESOLVED', 'FAILED']).optional(),
});
export type RepairIteration = z.infer<typeof repairIterationSchema>;

export const runCountersSchema = z.object({
  businessRules: z.number().int().nonnegative().default(0),
  invariants: z.number().int().nonnegative().default(0),
  characterizationTests: z.number().int().nonnegative().default(0),
  adversarialScenarios: z.number().int().nonnegative().default(0),
  differentialScenarios: z.number().int().nonnegative().default(0),
  mismatches: z.number().int().nonnegative().default(0),
  criticalInvariantsFailed: z.number().int().nonnegative().default(0),
  repairIterations: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  toolCallsDenied: z.number().int().nonnegative().default(0),
  llmCalls: z.number().int().nonnegative().default(0),
});
export type RunCounters = z.infer<typeof runCountersSchema>;

export const runRecordSchema = z.object({
  runId: runIdSchema,
  status: runStatusSchema.default('PENDING'),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
  startedAt: isoTimestampSchema.optional(),
  finishedAt: isoTimestampSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  config: runConfigSchema,
  currentStage: pipelineStageSchema.optional(),
  stages: z.array(stageRecordSchema).default([]),
  repairIterations: z.array(repairIterationSchema).default([]),
  counters: runCountersSchema.default({}),
  tokenUsage: tokenUsageSchema.default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  cost: costSchema.optional(),
  /** Set when the run terminates without a PASS; explains why in one line. */
  terminationReason: z.string().max(2000).optional(),
  releaseDecisionId: artifactIdSchema.optional(),
});
export type RunRecord = z.infer<typeof runRecordSchema>;

export function initialStageRecords(
  skipped: readonly PipelineStage[] = [],
): StageRecord[] {
  return PIPELINE_ORDER.map((stage) =>
    stageRecordSchema.parse({
      stage,
      state: skipped.includes(stage) ? 'SKIPPED' : 'WAITING',
      attempts: [],
      artifactIds: [],
    }),
  );
}

export function createRunRecord(input: {
  runId: z.infer<typeof runIdSchema>;
  config: RunConfig;
  at?: Date;
}): RunRecord {
  const at = isoTimestampSchema.parse((input.at ?? new Date()).toISOString());
  return runRecordSchema.parse({
    runId: input.runId,
    status: 'PENDING',
    createdAt: at,
    updatedAt: at,
    config: input.config,
    stages: initialStageRecords(input.config.skippedStages),
    repairIterations: [],
    counters: {},
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
  });
}

export const runSummarySchema = z.object({
  runId: runIdSchema,
  status: runStatusSchema,
  currentStage: pipelineStageSchema.optional(),
  stageStates: z.record(pipelineStageSchema, stageStateSchema),
  counters: runCountersSchema,
  durationMs: z.number().int().nonnegative().optional(),
  tokenUsage: tokenUsageSchema,
  cost: costSchema.optional(),
  terminationReason: z.string().max(2000).optional(),
  /** Aggregate confidence that the migration is behaviorally equivalent, 0..1. */
  equivalenceConfidence: confidenceSchema.optional(),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export function summarizeRun(run: RunRecord, equivalenceConfidence?: number): RunSummary {
  const stageStates = Object.fromEntries(
    run.stages.map((stage) => [stage.stage, stage.state]),
  ) as Record<PipelineStage, StageState>;
  return runSummarySchema.parse({
    runId: run.runId,
    status: run.status,
    ...(run.currentStage !== undefined ? { currentStage: run.currentStage } : {}),
    stageStates,
    counters: run.counters,
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    tokenUsage: run.tokenUsage,
    ...(run.cost !== undefined ? { cost: run.cost } : {}),
    ...(run.terminationReason !== undefined ? { terminationReason: run.terminationReason } : {}),
    ...(equivalenceConfidence !== undefined ? { equivalenceConfidence } : {}),
  });
}

export const taskRoleStageLinkSchema = z.object({
  taskId: taskIdSchema,
  role: agentRoleSchema,
  stage: pipelineStageSchema,
});
export type TaskRoleStageLink = z.infer<typeof taskRoleStageLinkSchema>;

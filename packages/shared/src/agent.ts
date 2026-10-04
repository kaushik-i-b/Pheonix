import { z } from 'zod';
import {
  artifactIdSchema,
  confidenceSchema,
  epistemicStatusSchema,
  evidenceRefSchema,
  isoTimestampSchema,
  runIdSchema,
  severitySchema,
  stepIdSchema,
  taskIdSchema,
  tokenUsageSchema,
} from './primitives.js';
import { agentRoleSchema, rolePermissionsSchema, toolNameSchema } from './roles.js';
import { artifactKindSchema } from './artifact.js';
import { pipelineStageSchema } from './run.js';

/**
 * The agent handoff contract (brief §6). Agents communicate through these structures and the
 * artifacts they reference — never through an informal shared conversation.
 */

export const agentTaskStatusSchema = z.enum(['PENDING', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'BLOCKED', 'TIMEOUT', 'CANCELLED']);
export type AgentTaskStatus = z.infer<typeof agentTaskStatusSchema>;

export const TERMINAL_TASK_STATUSES: readonly AgentTaskStatus[] = [
  'SUCCEEDED',
  'PARTIAL',
  'FAILED',
  'BLOCKED',
  'TIMEOUT',
  'CANCELLED',
] as const;

export const taskInputArtifactSchema = z.object({
  artifactId: artifactIdSchema,
  kind: artifactKindSchema,
  relativePath: z.string().min(1),
  role: z.enum(['input', 'reference']).default('input'),
});
export type TaskInputArtifact = z.infer<typeof taskInputArtifactSchema>;

export const taskBudgetSchema = z.object({
  maxSteps: z.number().int().positive().default(20),
  maxToolCalls: z.number().int().positive().default(80),
  maxTokens: z.number().int().positive().optional(),
  timeoutMs: z.number().int().positive().default(900_000),
});
export type TaskBudget = z.infer<typeof taskBudgetSchema>;

export const acceptanceCriterionKindSchema = z.enum([
  'artifact-present',
  'artifact-schema-valid',
  'min-item-count',
  'every-item-has-evidence',
  'no-unknown-status-items',
  'tests-executed',
  'tests-pass',
  'custom-check',
]);
export type AcceptanceCriterionKind = z.infer<typeof acceptanceCriterionKindSchema>;

/** Declarative so acceptance can be checked by deterministic code, not by the agent itself. */
export const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(1000),
  kind: acceptanceCriterionKindSchema,
  artifactKind: artifactKindSchema.optional(),
  minCount: z.number().int().nonnegative().optional(),
  /** Identifier of a deterministic check registered in the runtime (for `custom-check`). */
  checkId: z.string().min(1).optional(),
});
export type AcceptanceCriterion = z.infer<typeof acceptanceCriterionSchema>;

export const taskConstraintSchema = z.object({
  id: z.string().min(1),
  statement: z.string().min(1).max(2000),
  /** Hard constraints are enforced by the runtime; soft ones are only instructions to the model. */
  enforcement: z.enum(['architectural', 'prompt']).default('prompt'),
});
export type TaskConstraint = z.infer<typeof taskConstraintSchema>;

export const agentTaskSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  taskId: taskIdSchema,
  runId: runIdSchema,
  stage: pipelineStageSchema,
  role: agentRoleSchema,
  objective: z.string().min(1).max(8000),
  context: z.string().max(20_000).optional(),
  inputArtifacts: z.array(taskInputArtifactSchema).default([]),
  allowedTools: z.array(toolNameSchema),
  permissions: rolePermissionsSchema,
  constraints: z.array(taskConstraintSchema).default([]),
  acceptanceCriteria: z.array(acceptanceCriterionSchema).default([]),
  /** Artifact kinds this task is expected to produce; used by acceptance checking. */
  expectedOutputs: z.array(artifactKindSchema).default([]),
  budget: taskBudgetSchema.default({}),
  attempt: z.number().int().positive().default(1),
  repairIteration: z.number().int().nonnegative().default(0),
  parentTaskId: taskIdSchema.optional(),
  createdAt: isoTimestampSchema,
  promptIds: z.array(z.string().min(1)).default([]),
});
export type AgentTask = z.infer<typeof agentTaskSchema>;

export const findingKindSchema = z.enum([
  'behavior',
  'business-rule-candidate',
  'invariant-candidate',
  'risk',
  'anomaly',
  'duplication',
  'dead-code',
  'data-flow',
  'entry-point',
  'dependency',
  'configuration',
  'suspicious-behavior',
  'mismatch',
  'gap',
]);
export type FindingKind = z.infer<typeof findingKindSchema>;

/**
 * A finding is a claim plus its proof. `epistemicStatus` keeps observation and inference apart,
 * and a claim with no evidence is rejected by the schema rather than silently accepted.
 */
export const findingSchema = z.object({
  id: z.string().min(1),
  kind: findingKindSchema,
  summary: z.string().min(1).max(1000),
  detail: z.string().max(8000).optional(),
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  severity: severitySchema.optional(),
  evidence: z.array(evidenceRefSchema).min(1, 'a finding without evidence is not a finding'),
  affectedComponents: z.array(z.string().min(1)).default([]),
  relatedRuleIds: z.array(z.string().min(1)).default([]),
  relatedInvariantIds: z.array(z.string().min(1)).default([]),
});
export type Finding = z.infer<typeof findingSchema>;

export const generatedArtifactSchema = z.object({
  artifactId: artifactIdSchema,
  kind: artifactKindSchema,
  relativePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type GeneratedArtifact = z.infer<typeof generatedArtifactSchema>;

export const acceptanceOutcomeSchema = z.object({
  criterionId: z.string().min(1),
  satisfied: z.boolean(),
  observed: z.string().max(1000).optional(),
  reason: z.string().max(2000).optional(),
});
export type AcceptanceOutcome = z.infer<typeof acceptanceOutcomeSchema>;

export const nextActionSchema = z.object({
  kind: z.enum([
    'proceed',
    'run-stage',
    'repair',
    'request-human-input',
    'reject',
    'collect-more-evidence',
    'stop',
  ]),
  detail: z.string().max(2000).optional(),
  targetStage: pipelineStageSchema.optional(),
  mismatchIds: z.array(z.string().min(1)).default([]),
});
export type NextAction = z.infer<typeof nextActionSchema>;

export const agentResultSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  taskId: taskIdSchema,
  runId: runIdSchema,
  role: agentRoleSchema,
  stage: pipelineStageSchema,
  status: agentTaskStatusSchema,
  startedAt: isoTimestampSchema,
  finishedAt: isoTimestampSchema,
  durationMs: z.number().int().nonnegative(),
  generatedArtifacts: z.array(generatedArtifactSchema).default([]),
  findings: z.array(findingSchema).default([]),
  evidence: z.array(evidenceRefSchema).default([]),
  acceptance: z.array(acceptanceOutcomeSchema).default([]),
  nextRecommendedAction: nextActionSchema.optional(),
  tokenUsage: tokenUsageSchema.default({ promptTokens: 0, completionTokens: 0, totalTokens: 0 }),
  llmCalls: z.number().int().nonnegative().default(0),
  toolCalls: z.number().int().nonnegative().default(0),
  toolCallsDenied: z.number().int().nonnegative().default(0),
  /** Free-form but bounded: what the agent believes it established, and what it could not. */
  narrative: z.string().max(8000).optional(),
  unresolvedUnknowns: z.array(z.string().max(1000)).default([]),
  errorCode: z.string().min(1).optional(),
  errorMessage: z.string().max(4000).optional(),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

/** One recorded tool invocation — the audit trail required by brief §7. */
export const toolInvocationSchema = z.object({
  invocationId: stepIdSchema,
  taskId: taskIdSchema,
  runId: runIdSchema,
  role: agentRoleSchema,
  tool: toolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
  argumentsSummary: z.string().max(2000),
  requestedAt: isoTimestampSchema,
  durationMs: z.number().int().nonnegative(),
  outcome: z.enum(['ok', 'error', 'denied', 'timeout']),
  exitCode: z.number().int().optional(),
  outputSummary: z.string().max(4000),
  outputBytes: z.number().int().nonnegative().default(0),
  truncated: z.boolean().default(false),
  denialReason: z.string().max(2000).optional(),
  artifactId: artifactIdSchema.optional(),
});
export type ToolInvocation = z.infer<typeof toolInvocationSchema>;

/** The durable tool audit trail of one task, persisted as an `agent.tool-log` artifact. */
export const toolInvocationLogSchema = z.array(toolInvocationSchema);
export type ToolInvocationLog = z.infer<typeof toolInvocationLogSchema>;

/** A tool call as requested by the model. */
export const toolCallRequestSchema = z.object({
  id: z.string().min(1),
  name: toolNameSchema,
  arguments: z.record(z.string(), z.unknown()),
});
export type ToolCallRequest = z.infer<typeof toolCallRequestSchema>;

export const toolCallResultSchema = z.object({
  id: z.string().min(1),
  name: toolNameSchema,
  ok: z.boolean(),
  content: z.string(),
  truncated: z.boolean().default(false),
  denied: z.boolean().default(false),
  denialReason: z.string().max(2000).optional(),
  meta: z.record(z.string(), z.unknown()).default({}),
});
export type ToolCallResult = z.infer<typeof toolCallResultSchema>;

/** Persisted transcript of one agent step, so any decision can be reconstructed exactly. */
export const agentStepSchema = z.object({
  stepId: stepIdSchema,
  taskId: taskIdSchema,
  index: z.number().int().nonnegative(),
  at: isoTimestampSchema,
  kind: z.enum(['llm-call', 'tool-call', 'artifact', 'note', 'acceptance-check']),
  promptHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  model: z.string().min(1).optional(),
  assistantText: z.string().max(20_000).optional(),
  toolCalls: z.array(toolCallRequestSchema).default([]),
  toolResults: z.array(toolCallResultSchema).default([]),
  usage: tokenUsageSchema.optional(),
  durationMs: z.number().int().nonnegative().optional(),
  note: z.string().max(4000).optional(),
});
export type AgentStep = z.infer<typeof agentStepSchema>;

export const agentTranscriptSchema = z.object({
  taskId: taskIdSchema,
  runId: runIdSchema,
  role: agentRoleSchema,
  steps: z.array(agentStepSchema).default([]),
});
export type AgentTranscript = z.infer<typeof agentTranscriptSchema>;

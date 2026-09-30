import { z } from 'zod';
import {
  artifactIdSchema,
  costSchema,
  isoTimestampSchema,
  runIdSchema,
  severitySchema,
  sha256HexSchema,
  stepIdSchema,
  taskIdSchema,
  tokenUsageSchema,
} from './primitives.js';
import { agentRoleSchema, toolNameSchema } from './roles.js';
import { pipelineStageSchema, runStatusSchema, stageStateSchema } from './run.js';
import { artifactKindSchema } from './artifact.js';

/**
 * The structured observability stream. Every Phoenix run has one append-only sequence of these
 * events, identified by a monotonically increasing `seq` per run. Events are the single source
 * of truth for the API and dashboard timeline — nothing is reconstructed from prose.
 */

const baseEventSchema = z.object({
  runId: runIdSchema,
  seq: z.number().int().nonnegative(),
  at: isoTimestampSchema,
  stage: pipelineStageSchema.optional(),
  role: agentRoleSchema.optional(),
  taskId: taskIdSchema.optional(),
});

const typed = <TType extends string, TPayload extends z.ZodRawShape>(
  type: TType,
  payload: TPayload,
) => baseEventSchema.extend({ type: z.literal(type), ...payload });

export const runStartedEventSchema = typed('run.started', {
  configHash: sha256HexSchema,
  legacyRoot: z.string().min(1),
  modernRoot: z.string().min(1),
  providerId: z.string().min(1),
  model: z.string().min(1),
});

export const runFinishedEventSchema = typed('run.finished', {
  status: runStatusSchema,
  durationMs: z.number().int().nonnegative(),
  terminationReason: z.string().max(2000).optional(),
});

export const stageTransitionEventSchema = typed('stage.transition', {
  stage: pipelineStageSchema,
  from: stageStateSchema,
  to: stageStateSchema,
  attempt: z.number().int().positive(),
  repairIteration: z.number().int().nonnegative().optional(),
  detail: z.string().max(2000).optional(),
});

export const agentStartedEventSchema = typed('agent.started', {
  role: agentRoleSchema,
  taskId: taskIdSchema,
  objective: z.string().max(4000),
  allowedTools: z.array(toolNameSchema),
});

export const agentFinishedEventSchema = typed('agent.finished', {
  role: agentRoleSchema,
  taskId: taskIdSchema,
  status: z.enum(['SUCCEEDED', 'PARTIAL', 'FAILED']),
  durationMs: z.number().int().nonnegative(),
  artifactIds: z.array(artifactIdSchema),
  findingsCount: z.number().int().nonnegative(),
  nextRecommendedAction: z.string().max(2000).optional(),
});

export const agentFailedEventSchema = typed('agent.failed', {
  role: agentRoleSchema,
  taskId: taskIdSchema,
  errorCode: z.string().min(1),
  message: z.string().max(4000),
  retryable: z.boolean(),
});

export const agentStepEventSchema = typed('agent.step', {
  taskId: taskIdSchema,
  stepId: stepIdSchema,
  index: z.number().int().nonnegative(),
  kind: z.enum(['llm-call', 'tool-call', 'artifact', 'note']),
  summary: z.string().max(2000),
});

export const toolInvokedEventSchema = typed('tool.invoked', {
  tool: toolNameSchema,
  argumentsSummary: z.string().max(2000),
  exitCode: z.number().int().optional(),
  durationMs: z.number().int().nonnegative(),
  outputSummary: z.string().max(2000),
  outputBytes: z.number().int().nonnegative().optional(),
  truncated: z.boolean().default(false),
});

export const toolDeniedEventSchema = typed('tool.denied', {
  tool: toolNameSchema,
  reason: z.string().max(2000),
  requested: z.string().max(2000).optional(),
  role: agentRoleSchema,
});

export const artifactCreatedEventSchema = typed('artifact.created', {
  artifactId: artifactIdSchema,
  kind: artifactKindSchema,
  relativePath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  sha256: sha256HexSchema,
});

export const llmCompletedEventSchema = typed('llm.completed', {
  providerId: z.string().min(1),
  model: z.string().min(1),
  purpose: z.string().min(1),
  promptHash: sha256HexSchema,
  durationMs: z.number().int().nonnegative(),
  retries: z.number().int().nonnegative().default(0),
  usage: tokenUsageSchema,
  cost: costSchema.optional(),
  finishReason: z.string().max(64).optional(),
  structured: z.boolean().default(false),
  validationRepairs: z.number().int().nonnegative().default(0),
});

export const promptRenderedEventSchema = typed('prompt.rendered', {
  promptId: z.string().min(1),
  promptVersion: z.string().min(1),
  promptHash: sha256HexSchema,
  purpose: z.string().min(1),
  /** Artifacts are stored under `run/prompts/` so the exact prompt text is always recoverable. */
  artifactId: artifactIdSchema.optional(),
});

export const testExecutedEventSchema = typed('test.executed', {
  suiteId: z.string().min(1),
  caseId: z.string().min(1),
  target: z.enum(['legacy', 'modern', 'both']),
  passed: z.boolean(),
  durationMs: z.number().int().nonnegative(),
  message: z.string().max(4000).optional(),
  /** Characterization tests record reality: a "failure" against legacy is a discovered behavior. */
  recordedBehavior: z.boolean().default(false),
});

export const failureDiscoveredEventSchema = typed('failure.discovered', {
  failureId: z.string().min(1),
  kind: z.enum([
    'behavioral-mismatch',
    'invariant-violation',
    'characterization-gap',
    'adversarial-finding',
    'tool-error',
    'internal-error',
    'missing-evidence',
  ]),
  severity: severitySchema,
  summary: z.string().max(4000),
  stage: pipelineStageSchema,
  evidenceRefs: z.array(z.string().min(1)).default([]),
});

export const repairRequestedEventSchema = typed('repair.requested', {
  iteration: z.number().int().positive(),
  mismatchIds: z.array(z.string().min(1)),
  diagnosisSummary: z.string().max(4000),
  targetRoots: z.array(z.string().min(1)).default([]),
});

export const repairCompletedEventSchema = typed('repair.completed', {
  iteration: z.number().int().positive(),
  outcome: z.enum(['IMPROVED', 'NO_CHANGE', 'REGRESSED', 'RESOLVED', 'FAILED']),
  mismatchesBefore: z.number().int().nonnegative(),
  mismatchesAfter: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative(),
});

export const verificationResultEventSchema = typed('verification.result', {
  verdict: z.enum(['EQUIVALENT', 'NOT_EQUIVALENT', 'INCONCLUSIVE']),
  scenariosExecuted: z.number().int().nonnegative(),
  mismatches: z.number().int().nonnegative(),
  criticalInvariantFailures: z.number().int().nonnegative(),
  highestSeverity: severitySchema,
});

export const releaseDecisionEventSchema = typed('release.decision', {
  decision: z.enum(['PASS', 'REJECT']),
  blockingReasons: z.array(z.string().max(2000)),
  evidenceArtifactIds: z.array(artifactIdSchema),
});

export const phoenixEventSchema = z.discriminatedUnion('type', [
  runStartedEventSchema,
  runFinishedEventSchema,
  stageTransitionEventSchema,
  agentStartedEventSchema,
  agentFinishedEventSchema,
  agentFailedEventSchema,
  agentStepEventSchema,
  toolInvokedEventSchema,
  toolDeniedEventSchema,
  artifactCreatedEventSchema,
  llmCompletedEventSchema,
  promptRenderedEventSchema,
  testExecutedEventSchema,
  failureDiscoveredEventSchema,
  repairRequestedEventSchema,
  repairCompletedEventSchema,
  verificationResultEventSchema,
  releaseDecisionEventSchema,
]);

export type PhoenixEvent = z.infer<typeof phoenixEventSchema>;
export type PhoenixEventType = PhoenixEvent['type'];

export const PHOENIX_EVENT_TYPES: readonly PhoenixEventType[] = [
  'run.started',
  'run.finished',
  'stage.transition',
  'agent.started',
  'agent.finished',
  'agent.failed',
  'agent.step',
  'tool.invoked',
  'tool.denied',
  'artifact.created',
  'llm.completed',
  'prompt.rendered',
  'test.executed',
  'failure.discovered',
  'repair.requested',
  'repair.completed',
  'verification.result',
  'release.decision',
] as const;

export type EventPayload<TType extends PhoenixEventType> = Omit<
  Extract<PhoenixEvent, { type: TType }>,
  'runId' | 'seq' | 'at'
>;

/**
 * Emits validated events. Implementations: JSONL file mirror, Postgres sink, in-memory test sink.
 * A sink must never throw into the pipeline; failures are reported through `onSinkError`.
 */
export interface EventSink {
  readonly name: string;
  emit(event: PhoenixEvent): void | Promise<void>;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

/** Assigns `seq` per run and validates before dispatch, so no malformed event is ever persisted. */
export class EventSequencer {
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly sinks: readonly EventSink[] = [],
    private readonly onSinkError: (sink: string, error: unknown) => void = () => {},
  ) {}

  next<TType extends PhoenixEventType>(
    runId: string,
    type: TType,
    payload: Omit<EventPayload<TType>, 'type'>,
    at: Date = new Date(),
  ): PhoenixEvent {
    const seq = this.counters.get(runId) ?? 0;
    this.counters.set(runId, seq + 1);
    const candidate = { ...payload, type, runId, seq, at: at.toISOString() };
    const event = phoenixEventSchema.parse(candidate);
    void this.dispatch(event);
    return event;
  }

  /** Re-emits already-persisted events (e.g. replaying a JSONL mirror) without renumbering. */
  replay(event: PhoenixEvent): void {
    void this.dispatch(phoenixEventSchema.parse(event));
  }

  private async dispatch(event: PhoenixEvent): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.emit(event);
      } catch (error) {
        this.onSinkError(sink.name, error);
      }
    }
  }

  async flush(): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.flush?.();
      } catch (error) {
        this.onSinkError(sink.name, error);
      }
    }
  }

  async close(): Promise<void> {
    await this.flush();
    for (const sink of this.sinks) {
      try {
        await sink.close?.();
      } catch (error) {
        this.onSinkError(sink.name, error);
      }
    }
  }

  seqFor(runId: string): number {
    return this.counters.get(runId) ?? 0;
  }
}

export class InMemoryEventSink implements EventSink {
  readonly name = 'memory';
  readonly events: PhoenixEvent[] = [];

  emit(event: PhoenixEvent): void {
    this.events.push(event);
  }

  ofType<TType extends PhoenixEventType>(type: TType): Extract<PhoenixEvent, { type: TType }>[] {
    return this.events.filter((event) => event.type === type) as Extract<
      PhoenixEvent,
      { type: TType }
    >[];
  }

  clear(): void {
    this.events.length = 0;
  }
}

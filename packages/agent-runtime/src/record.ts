import type { ArtifactWriteRequest, FileArtifactStore, WrittenArtifact } from '@phoenix/artifact-store';
import {
  agentResultSchema,
  agentTaskSchema,
  agentTranscriptSchema,
  toolInvocationLogSchema,
  type AgentResult,
  type AgentRole,
  type AgentTask,
  type AgentTranscript,
  type ArtifactFormat,
  type ArtifactInputRef,
  type ArtifactKind,
  type EventSequencer,
  type GeneratedArtifact,
  type PipelineStage,
  type RunId,
  type TaskId,
  type ToolInvocation,
} from '@phoenix/shared';
import type { z } from 'zod';

/**
 * Durable records of an agent task: the task as issued, the transcript as it happened, and the
 * result as judged. All three are artifacts, so a run can be replayed and audited from the tree
 * alone. The task history of a run is the sequence of `agent.result` artifacts in its index —
 * there is no second, mutable copy to drift out of sync.
 */

export const AGENT_RUNTIME_GENERATOR = '@phoenix/agent-runtime';

/** Identity the writer stamps into provenance and events. */
export interface ArtifactProducerContext {
  runId: RunId;
  stage: PipelineStage;
  role: AgentRole;
  taskId: TaskId;
}

export interface ArtifactWriterOptions {
  store: FileArtifactStore;
  events: EventSequencer;
  run: ArtifactProducerContext;
  /** Recorded as the producing code path; defaults to the agent runtime. */
  generator?: string;
  inputs?: readonly ArtifactInputRef[];
}

export interface WriteOptions {
  slug?: string;
  title?: string;
  tags?: readonly string[];
  format?: ArtifactFormat;
  inputs?: readonly ArtifactInputRef[];
}

export interface ArtifactWriter {
  writeJson<TPayload>(kind: ArtifactKind, payload: TPayload, schema?: z.ZodType<TPayload>, options?: WriteOptions): GeneratedArtifact;
  writeText(kind: ArtifactKind, content: string, options?: WriteOptions): GeneratedArtifact;
  readonly inputs: readonly ArtifactInputRef[];
}

export function createArtifactWriter(options: ArtifactWriterOptions): ArtifactWriter {
  const inputs: ArtifactInputRef[] = [...(options.inputs ?? [])];
  const base: Omit<ArtifactWriteRequest, 'kind'> = {
    runId: options.run.runId,
    producedBy: {
      role: options.run.role,
      taskId: options.run.taskId,
      generator: options.generator ?? AGENT_RUNTIME_GENERATOR,
    },
    inputs,
  };

  const record = (written: WrittenArtifact): GeneratedArtifact => {
    const generated: GeneratedArtifact = {
      artifactId: written.meta.id,
      kind: written.meta.kind,
      relativePath: written.meta.relativePath,
      bytes: written.meta.bytes,
      sha256: written.meta.sha256,
    };
    options.events.next(options.run.runId, 'artifact.created', {
      stage: options.run.stage,
      role: options.run.role,
      taskId: options.run.taskId,
      artifactId: generated.artifactId,
      kind: generated.kind,
      relativePath: generated.relativePath,
      bytes: generated.bytes,
      sha256: generated.sha256,
    });
    return generated;
  };

  return {
    inputs,
    writeJson(kind, payload, schema, writeOptions = {}) {
      const written = options.store.writeJson(
        {
          ...base,
          kind,
          inputs: [...inputs, ...(writeOptions.inputs ?? [])],
          ...(writeOptions.slug !== undefined ? { slug: writeOptions.slug } : {}),
          ...(writeOptions.title !== undefined ? { title: writeOptions.title } : {}),
          ...(writeOptions.tags !== undefined ? { tags: [...writeOptions.tags] } : {}),
        },
        payload,
        schema,
      );
      return record(written);
    },
    writeText(kind, content, writeOptions = {}) {
      const written = options.store.writeText(
        {
          ...base,
          kind,
          inputs: [...inputs, ...(writeOptions.inputs ?? [])],
          ...(writeOptions.slug !== undefined ? { slug: writeOptions.slug } : {}),
          ...(writeOptions.title !== undefined ? { title: writeOptions.title } : {}),
          ...(writeOptions.tags !== undefined ? { tags: [...writeOptions.tags] } : {}),
          ...(writeOptions.format !== undefined ? { format: writeOptions.format } : {}),
        },
        content,
        writeOptions.format ?? 'markdown',
      );
      return record(written);
    },
  };
}

export function persistTaskRecord(writer: ArtifactWriter, task: AgentTask): GeneratedArtifact {
  return writer.writeJson('agent.task', agentTaskSchema.parse(task), agentTaskSchema, {
    slug: `task-${task.taskId}`,
    title: `${task.role} task ${task.taskId}`,
    tags: ['agent', task.stage.toLowerCase()],
  });
}

export function persistTranscript(writer: ArtifactWriter, transcript: AgentTranscript): GeneratedArtifact {
  return writer.writeJson('agent.transcript', agentTranscriptSchema.parse(transcript), agentTranscriptSchema, {
    slug: `transcript-${transcript.taskId}`,
    title: `${transcript.role} transcript`,
    tags: ['agent', 'transcript'],
  });
}

export function persistResultRecord(writer: ArtifactWriter, result: AgentResult): GeneratedArtifact {
  return writer.writeJson('agent.result', agentResultSchema.parse(result), agentResultSchema, {
    slug: `result-${result.taskId}`,
    title: `${result.role} result (${result.status})`,
    tags: ['agent', 'result', result.status.toLowerCase()],
  });
}

/**
 * The tool audit trail: every call a task made, allowed or denied, with arguments, exit code,
 * duration and output summary. Persisted separately from the transcript because the transcript
 * records what the *model* saw, and this records what the *machine* did.
 */
export function persistToolLog(writer: ArtifactWriter, taskId: TaskId, invocations: readonly ToolInvocation[]): GeneratedArtifact {
  return writer.writeJson('agent.tool-log', toolInvocationLogSchema.parse(invocations), toolInvocationLogSchema, {
    slug: `tool-log-${taskId}`,
    title: `tool audit log (${invocations.length} call(s))`,
    tags: ['agent', 'audit', 'tools'],
  });
}

/** Every task executed in a run, oldest first — the persisted task execution history. */
export function loadTaskHistory(store: FileArtifactStore, runId: RunId): AgentResult[] {
  const history = store
    .list(runId, { kind: 'agent.result' })
    .map((meta) => agentResultSchema.parse(store.readJson(meta, agentResultSchema)));
  return history.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.taskId.localeCompare(b.taskId));
}

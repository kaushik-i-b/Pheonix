import type { FileArtifactStore } from '@phoenix/artifact-store';
import {
  PhoenixError,
  agentResultSchema,
  runIdSchema,
  type ArtifactKind,
  type ArtifactMeta,
  type PipelineStage,
  type RunId,
} from '@phoenix/shared';
import type { ZodType, ZodTypeDef } from 'zod';

/**
 * Reading a run that already happened.
 *
 * Downstream stages must name the run they consume. They also bind their inputs to the latest result
 * of the required predecessor, so artifacts left by an older successful attempt cannot mask a later
 * failed attempt under the same run id.
 */

export function requireExplicitRunId(value: string | undefined, command: string, usage: string): RunId {
  if (value === undefined) {
    throw new PhoenixError('CONFIG_INVALID', `${command} requires --run-id; implicit run selection is disabled`, {
      command,
      usage,
    });
  }
  const parsed = runIdSchema.safeParse(value);
  if (!parsed.success) {
    throw new PhoenixError('CONFIG_INVALID', `invalid --run-id "${value}"`, {
      command,
      issues: parsed.error.issues,
      usage,
    });
  }
  return parsed.data;
}

export function requireSuccessfulPredecessor(
  store: FileArtifactStore,
  runId: RunId,
  stage: PipelineStage,
  requiredKinds: readonly ArtifactKind[],
): void {
  const results = store
    .list(runId, { kind: 'agent.result' })
    .map((meta) => agentResultSchema.parse(store.readJson(meta, agentResultSchema)))
    .filter((result) => result.stage === stage);
  const latest = results.at(-1);

  if (latest === undefined) {
    throw new PhoenixError('STAGE_FAILED', `run ${runId} has no ${stage} result`, { runId, stage });
  }
  if (latest.status !== 'SUCCEEDED') {
    throw new PhoenixError('STAGE_FAILED', `run ${runId} predecessor ${stage} ended ${latest.status}`, {
      runId,
      stage,
      taskId: latest.taskId,
      status: latest.status,
      errorCode: latest.errorCode,
      errorMessage: latest.errorMessage,
    });
  }

  const required = requiredKinds.map((kind) => {
    const meta = store.latest(runId, kind);
    if (meta === undefined) {
      throw new PhoenixError('EVIDENCE_INCOMPLETE', `run ${runId} successful ${stage} result has no "${kind}" artifact`, {
        runId,
        stage,
        taskId: latest.taskId,
        kind,
      });
    }
    const generated = latest.generatedArtifacts.some(
      (artifact) => artifact.kind === kind && artifact.artifactId === meta.id,
    );
    if (!generated) {
      throw new PhoenixError(
        'EVIDENCE_INCOMPLETE',
        `run ${runId} latest "${kind}" artifact was not produced by the successful ${stage} result`,
        { runId, stage, taskId: latest.taskId, kind, artifactId: meta.id },
      );
    }
    return meta;
  });

  const requiredIds = new Set(required.map((meta) => meta.id));
  const problems = store.verify(runId).problems.filter((problem) => requiredIds.has(problem.artifactId));
  if (problems.length > 0) {
    throw new PhoenixError('ARTIFACT_TAMPERED', `run ${runId} has untrustworthy ${stage} output`, {
      runId,
      stage,
      problems,
    });
  }
}

/** The newest artifact of a kind in a run, and its payload re-validated through its schema. */
export function readLatest<TPayload>(
  store: FileArtifactStore,
  runId: RunId,
  kind: ArtifactKind,
  schema: ZodType<TPayload, ZodTypeDef, unknown>,
): { meta: ArtifactMeta; payload: TPayload } {
  const meta = store.latest(runId, kind);
  if (meta === undefined) {
    throw new PhoenixError(
      'ARTIFACT_NOT_FOUND',
      `run ${runId} has no "${kind}" artifact; the stage that produces it has not run for this run id`,
      { runId, kind },
    );
  }
  return { meta, payload: schema.parse(store.readJson(meta, schema)) };
}

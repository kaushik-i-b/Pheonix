import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { FileArtifactStore } from '@phoenix/artifact-store';
import {
  agentResultSchema,
  newRunId,
  newTaskId,
  nowIso,
  type AgentTaskStatus,
  type GeneratedArtifact,
} from '@phoenix/shared';
import { requireExplicitRunId, requireSuccessfulPredecessor } from '../src/runs.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createStore(): FileArtifactStore {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-cli-runs-'));
  roots.push(root);
  return new FileArtifactStore(root);
}

function writeResult(
  store: FileArtifactStore,
  runId: ReturnType<typeof newRunId>,
  status: AgentTaskStatus,
  generatedArtifacts: GeneratedArtifact[] = [],
): void {
  const taskId = newTaskId();
  const at = nowIso();
  const result = agentResultSchema.parse({
    taskId,
    runId,
    role: 'archaeologist',
    stage: 'DISCOVERY',
    status,
    startedAt: at,
    finishedAt: at,
    durationMs: 0,
    generatedArtifacts,
  });
  store.writeJson(
    {
      kind: 'agent.result',
      runId,
      producedBy: { role: 'archaeologist', taskId },
      slug: `result-${taskId}`,
    },
    result,
    agentResultSchema,
  );
}

describe('pinned run prerequisites', () => {
  it('requires an explicit valid run id', () => {
    expect(() => requireExplicitRunId(undefined, 'phoenix specify', 'usage')).toThrowError(
      /requires --run-id/,
    );
    expect(() => requireExplicitRunId('latest', 'phoenix specify', 'usage')).toThrowError(
      /invalid --run-id/,
    );
  });

  it('does not let stale artifacts mask the latest failed predecessor', () => {
    const store = createStore();
    const runId = newRunId();
    const taskId = newTaskId();
    const written = store.writeJson(
      { kind: 'raw.file', runId, producedBy: { role: 'archaeologist', taskId }, slug: 'evidence' },
      { evidence: true },
    );
    const generated: GeneratedArtifact = {
      artifactId: written.meta.id,
      kind: written.meta.kind,
      relativePath: written.meta.relativePath,
      bytes: written.meta.bytes,
      sha256: written.meta.sha256,
    };

    writeResult(store, runId, 'SUCCEEDED', [generated]);
    writeResult(store, runId, 'FAILED');

    expect(() => requireSuccessfulPredecessor(store, runId, 'DISCOVERY', ['raw.file'])).toThrowError(
      /predecessor DISCOVERY ended FAILED/,
    );
  });

  it('rejects a successful predecessor whose required artifact is absent', () => {
    const store = createStore();
    const runId = newRunId();
    writeResult(store, runId, 'SUCCEEDED');

    expect(() => requireSuccessfulPredecessor(store, runId, 'DISCOVERY', ['discovery.findings'])).toThrowError(
      /has no "discovery.findings" artifact/,
    );
  });

  it('returns a nonzero process status when a downstream command omits its run id', () => {
    const tsx = resolve(import.meta.dirname, '../../../node_modules/tsx/dist/cli.mjs');
    const cli = resolve(import.meta.dirname, '../src/main.ts');
    const result = spawnSync(process.execPath, [tsx, cli, 'specify'], { encoding: 'utf8' });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain('implicit run selection is disabled');
  });
});

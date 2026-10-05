import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './repo-root.js';
import type { RawEvent } from './events.js';

export type TaskStatus = 'SUCCEEDED' | 'PARTIAL' | 'FAILED' | 'UNKNOWN';

export interface TaskOutcome {
  taskId: string;
  role: string;
  stage: string | null;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface TaskRow {
  taskId: string;
  role: string | null;
  stage: string | null;
  status: TaskStatus;
  startedAt: string | null;
  finishedAt: string | null;
  artifactCount: number;
}

const RECORDED_STATUSES: ReadonlySet<string> = new Set(['SUCCEEDED', 'PARTIAL', 'FAILED']);

export function loadTaskOutcomes(ws: Workspace, runId: string): Map<string, TaskOutcome> {
  const outcomes = new Map<string, TaskOutcome>();
  const dir = path.join(ws.artifactsDir, runId, 'agent');
  if (!existsSync(dir)) return outcomes;
  const fileNames = readdirSync(dir)
    .filter((name) => name.startsWith('result-task_') && name.endsWith('.json'))
    .sort();
  for (const fileName of fileNames) {
    const outcome = readOutcome(path.join(dir, fileName));
    if (outcome !== null) outcomes.set(outcome.taskId, outcome);
  }
  return outcomes;
}

export function taskRows(
  events: RawEvent[],
  outcomes: Map<string, TaskOutcome>,
  artifactTaskIds: Map<string, number>,
): TaskRow[] {
  const seen: string[] = [];
  for (const event of events) {
    if (typeof event.taskId !== 'string') continue;
    if (!seen.includes(event.taskId)) seen.push(event.taskId);
  }
  return seen.map((taskId) => {
    const outcome = outcomes.get(taskId);
    return {
      taskId,
      role: outcome?.role ?? null,
      stage: outcome?.stage ?? null,
      status: outcome?.status ?? 'UNKNOWN',
      startedAt: outcome?.startedAt ?? null,
      finishedAt: outcome?.finishedAt ?? null,
      artifactCount: artifactTaskIds.get(taskId) ?? 0,
    };
  });
}

function readOutcome(file: string): TaskOutcome | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  const payload = asRecord(asRecord(parsed)?.payload);
  if (payload === null) return null;
  const taskId = payload.taskId;
  const role = payload.role;
  const status = payload.status;
  if (typeof taskId !== 'string' || taskId.length === 0) return null;
  if (typeof role !== 'string' || role.length === 0) return null;
  if (typeof status !== 'string' || !RECORDED_STATUSES.has(status)) return null;
  return {
    taskId,
    role,
    stage: typeof payload.stage === 'string' ? payload.stage : null,
    status: status as TaskStatus,
    startedAt: typeof payload.startedAt === 'string' ? payload.startedAt : null,
    finishedAt: typeof payload.finishedAt === 'string' ? payload.finishedAt : null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

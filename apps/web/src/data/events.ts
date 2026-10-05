import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Workspace } from './repo-root';
import { sanitizeForDisplay } from './sanitize';

export interface RawEvent {
  runId: string;
  seq: number;
  at: string;
  type: string;
  stage?: string;
  role?: string;
  taskId?: string;
  [k: string]: unknown;
}

export interface TimelineEvent {
  seq: number;
  at: string;
  type: string;
  stage: string | null;
  role: string | null;
  taskId: string | null;
  fields: Array<{ label: string; value: string }>;
}

export interface StageGroup {
  stage: string;
  label: string;
  events: TimelineEvent[];
}

const rawEventSchema = z
  .object({
    runId: z.string(),
    seq: z.number().int(),
    at: z.string(),
    type: z.string(),
    stage: z.string().optional(),
    role: z.string().optional(),
    taskId: z.string().optional(),
  })
  .passthrough();

export function readRunEvents(ws: Workspace, runId: string): RawEvent[] {
  const file = path.join(ws.artifactsDir, runId, 'run', 'events.jsonl');
  const lines = readFileSync(file, 'utf8').split('\n');
  const events: RawEvent[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim().length === 0) continue;
    const lineNumber = index + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`events.jsonl line ${lineNumber} is not a valid event: ${message}`);
    }
    const result = rawEventSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `events.jsonl line ${lineNumber} is not a valid event: ${describeZodError(result.error)}`,
      );
    }
    events.push(result.data);
  }
  return events;
}

export function writerSessions(events: RawEvent[]): number {
  if (events.length === 0) return 0;
  let sessions = 1;
  let previous = events[0]!.seq;
  for (let index = 1; index < events.length; index += 1) {
    const current = events[index]!.seq;
    if (current <= previous) sessions += 1;
    previous = current;
  }
  return sessions;
}

export function toTimelineEvent(event: RawEvent, ws: Workspace): TimelineEvent {
  const specs = eventFieldSpecs[event.type] ?? [];
  const fields: TimelineEvent['fields'] = [];
  for (const spec of specs) {
    const value = spec.read(event);
    if (value === null) continue;
    fields.push({ label: spec.label, value: sanitizeForDisplay(value, ws) });
  }
  return {
    seq: event.seq,
    at: event.at,
    type: event.type,
    stage: event.stage ?? null,
    role: event.role ?? null,
    taskId: event.taskId ?? null,
    fields,
  };
}

export function groupTimeline(events: RawEvent[], ws: Workspace): StageGroup[] {
  const groups = new Map<string, StageGroup>();
  const unattributed: TimelineEvent[] = [];
  for (const event of events) {
    const timeline = toTimelineEvent(event, ws);
    if (event.stage === undefined) {
      unattributed.push(timeline);
      continue;
    }
    let group = groups.get(event.stage);
    if (!group) {
      group = { stage: event.stage, label: event.stage, events: [] };
      groups.set(event.stage, group);
    }
    group.events.push(timeline);
  }
  const result = [...groups.values()];
  if (unattributed.length > 0) {
    result.push({
      stage: 'unattributed',
      label: 'unattributed (no stage recorded)',
      events: unattributed,
    });
  }
  return result;
}

interface FieldSpec {
  label: string;
  read: (event: RawEvent) => string | null;
}

function field(label: string, key: string): FieldSpec {
  return { label, read: (event) => stringValue(event[key]) };
}

function listField(label: string, key: string): FieldSpec {
  return {
    label,
    read: (event) => {
      const value = event[key];
      if (!Array.isArray(value)) return null;
      return value.map((item) => String(item)).join(', ');
    },
  };
}

function countField(label: string, key: string): FieldSpec {
  return {
    label,
    read: (event) => {
      const value = event[key];
      if (!Array.isArray(value)) return null;
      return String(value.length);
    },
  };
}

function hashField(label: string, key: string): FieldSpec {
  return {
    label,
    read: (event) => {
      const value = event[key];
      if (typeof value !== 'string') return null;
      return value.slice(0, 12);
    },
  };
}

function stringValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return String(value);
}

const eventFieldSpecs: Record<string, FieldSpec[]> = {
  'agent.started': [field('objective', 'objective'), listField('allowed tools', 'allowedTools')],
  'agent.step': [
    field('step', 'index'),
    field('kind', 'kind'),
    field('stepId', 'stepId'),
    field('summary', 'summary'),
  ],
  'agent.finished': [
    field('status', 'status'),
    field('durationMs', 'durationMs'),
    field('findingsCount', 'findingsCount'),
    countField('artifactCount', 'artifactIds'),
    field('next', 'nextRecommendedAction'),
  ],
  'agent.failed': [
    field('errorCode', 'errorCode'),
    field('message', 'message'),
    field('retryable', 'retryable'),
  ],
  'tool.invoked': [
    field('tool', 'tool'),
    field('args', 'argumentsSummary'),
    field('durationMs', 'durationMs'),
    field('outputBytes', 'outputBytes'),
    field('truncated', 'truncated'),
  ],
  'tool.denied': [
    field('tool', 'tool'),
    field('requested', 'requested'),
    field('reason', 'reason'),
  ],
  'artifact.created': [
    field('kind', 'kind'),
    field('path', 'relativePath'),
    field('bytes', 'bytes'),
    hashField('sha', 'sha256'),
  ],
  'llm.completed': [
    field('provider', 'providerId'),
    field('model', 'model'),
    field('purpose', 'purpose'),
    field('durationMs', 'durationMs'),
    field('finishReason', 'finishReason'),
    field('structured', 'structured'),
    field('retries', 'retries'),
    field('validationRepairs', 'validationRepairs'),
  ],
  'prompt.rendered': [
    field('promptId', 'promptId'),
    field('promptVersion', 'promptVersion'),
    field('purpose', 'purpose'),
    hashField('hash', 'promptHash'),
  ],
  'verification.result': [
    field('verdict', 'verdict'),
    field('scenarios', 'scenariosExecuted'),
    field('mismatches', 'mismatches'),
    field('highestSeverity', 'highestSeverity'),
    field('criticalInvariantFailures', 'criticalInvariantFailures'),
  ],
  'failure.discovered': [
    field('failureId', 'failureId'),
    field('kind', 'kind'),
    field('severity', 'severity'),
    field('summary', 'summary'),
    countField('evidenceRefs', 'evidenceRefs'),
  ],
  'test.executed': [
    field('suiteId', 'suiteId'),
    field('caseId', 'caseId'),
    field('passed', 'passed'),
    field('durationMs', 'durationMs'),
    field('target', 'target'),
  ],
  'repair.requested': [
    field('iteration', 'iteration'),
    field('diagnosis', 'diagnosisSummary'),
    countField('mismatches', 'mismatchIds'),
    listField('targetRoots', 'targetRoots'),
  ],
  'repair.completed': [
    field('iteration', 'iteration'),
    field('outcome', 'outcome'),
    field('before', 'mismatchesBefore'),
    field('after', 'mismatchesAfter'),
    field('durationMs', 'durationMs'),
  ],
};

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid event';
  return `${issue.path.join('.') || 'event'}: ${issue.message}`;
}

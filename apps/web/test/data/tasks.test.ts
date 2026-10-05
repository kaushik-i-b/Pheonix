import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, envelope, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import type { RawEvent } from '../../src/data/events.js';
import { loadTaskOutcomes, taskRows } from '../../src/data/tasks.js';

const fixtures: FixtureWorkspace[] = [];
const runId = 'run_fixture0000000000000000000000000';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(
  files: Record<string, unknown>,
  rawFiles?: Record<string, string>,
): Workspace {
  const fixture = makeWorkspace({ runs: [{ runId, files, rawFiles }] });
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

function rawEvent(overrides: Partial<RawEvent>): RawEvent {
  return {
    runId,
    seq: 0,
    at: '2026-01-01T00:00:00.000Z',
    type: 'agent.finished',
    ...overrides,
  } as RawEvent;
}

describe('loadTaskOutcomes', () => {
  it('maps status, role, stage, startedAt and finishedAt from the result payload', () => {
    const ws = workspaceWith({
      'agent/result-task_aaa.json': envelope('agent.result', {
        taskId: 'task_aaa',
        role: 'business-rule-analyst',
        stage: 'SPECIFICATION',
        status: 'SUCCEEDED',
        startedAt: '2026-01-01T00:00:01.000Z',
        finishedAt: '2026-01-01T00:00:51.000Z',
      }),
    });

    const outcomes = loadTaskOutcomes(ws, runId);

    expect(outcomes.get('task_aaa')).toEqual({
      taskId: 'task_aaa',
      role: 'business-rule-analyst',
      stage: 'SPECIFICATION',
      status: 'SUCCEEDED',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: '2026-01-01T00:00:51.000Z',
    });
  });

  it('returns an empty map when the run has no agent directory', () => {
    const ws = workspaceWith({});

    expect(loadTaskOutcomes(ws, runId).size).toBe(0);
  });

  it('skips files with a wrong payload shape without throwing', () => {
    const ws = workspaceWith(
      {
        'agent/result-task_missing.json': envelope('agent.result', {
          role: 'x',
          status: 'SUCCEEDED',
        }),
        'agent/result-task_badstatus.json': envelope('agent.result', {
          taskId: 'task_badstatus',
          role: 'x',
          status: 'DONE',
        }),
        'agent/result-task_ok.json': envelope('agent.result', {
          taskId: 'task_ok',
          role: 'x',
          stage: 'DISCOVERY',
          status: 'PARTIAL',
        }),
      },
      { 'agent/result-task_notjson.json': 'not json at all' },
    );

    const outcomes = loadTaskOutcomes(ws, runId);

    expect([...outcomes.keys()]).toEqual(['task_ok']);
    expect(outcomes.get('task_ok')?.status).toBe('PARTIAL');
  });

  it('tolerates a missing stage/startedAt/finishedAt by reporting null', () => {
    const ws = workspaceWith({
      'agent/result-task_aaa.json': envelope('agent.result', {
        taskId: 'task_aaa',
        role: 'x',
        status: 'FAILED',
      }),
    });

    const outcome = loadTaskOutcomes(ws, runId).get('task_aaa');

    expect(outcome?.stage).toBeNull();
    expect(outcome?.startedAt).toBeNull();
    expect(outcome?.finishedAt).toBeNull();
  });
});

describe('taskRows', () => {
  it('orders rows by first appearance of taskId in the event stream, deduplicated', () => {
    const events = [
      rawEvent({ taskId: 'task_b', at: '2026-01-01T00:00:00.000Z' }),
      rawEvent({ taskId: 'task_a', at: '2026-01-01T00:00:01.000Z' }),
      rawEvent({ taskId: 'task_b', at: '2026-01-01T00:00:02.000Z' }),
      rawEvent({ type: 'agent.step', at: '2026-01-01T00:00:03.000Z' }),
    ];

    const rows = taskRows(events, new Map(), new Map());

    expect(rows.map((row) => row.taskId)).toEqual(['task_b', 'task_a']);
  });

  it('joins recorded outcomes and reports UNKNOWN for tasks without a result file', () => {
    const events = [rawEvent({ taskId: 'task_known' }), rawEvent({ taskId: 'task_missing' })];
    const outcomes = new Map([
      [
        'task_known',
        {
          taskId: 'task_known',
          role: 'implementer',
          stage: 'IMPLEMENTATION',
          status: 'SUCCEEDED' as const,
          startedAt: '2026-01-01T00:00:01.000Z',
          finishedAt: '2026-01-01T00:00:09.000Z',
        },
      ],
    ]);

    const rows = taskRows(events, outcomes, new Map());

    expect(rows[0]).toEqual({
      taskId: 'task_known',
      role: 'implementer',
      stage: 'IMPLEMENTATION',
      status: 'SUCCEEDED',
      startedAt: '2026-01-01T00:00:01.000Z',
      finishedAt: '2026-01-01T00:00:09.000Z',
      artifactCount: 0,
    });
    expect(rows[1]).toEqual({
      taskId: 'task_missing',
      role: null,
      stage: null,
      status: 'UNKNOWN',
      startedAt: null,
      finishedAt: null,
      artifactCount: 0,
    });
  });

  it('joins artifact counts by taskId', () => {
    const events = [rawEvent({ taskId: 'task_a' }), rawEvent({ taskId: 'task_b' })];
    const artifactTaskIds = new Map([
      ['task_a', 3],
      ['task_b', 1],
    ]);

    const rows = taskRows(events, new Map(), artifactTaskIds);

    expect(rows.map((row) => row.artifactCount)).toEqual([3, 1]);
  });
});

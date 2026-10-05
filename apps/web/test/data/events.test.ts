import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import {
  groupTimeline,
  readRunEvents,
  toTimelineEvent,
  writerSessions,
} from '../../src/data/events.js';
import type { RawEvent } from '../../src/data/events.js';

const fixtures: FixtureWorkspace[] = [];
const runId = 'run_fixture0000000000000000000000000';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(spec?: Parameters<typeof makeWorkspace>[0]): Workspace {
  const fixture = makeWorkspace(spec);
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

function rawEvent(overrides: Record<string, unknown> = {}): RawEvent {
  return {
    runId,
    seq: 0,
    at: '2026-01-01T00:00:00.000Z',
    type: 'agent.step',
    ...overrides,
  } as RawEvent;
}

const at = (minute: number): string => `2026-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;

describe('readRunEvents', () => {
  it('preserves file append order across a seq restart', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          events: [
            rawEvent({ seq: 0, at: at(0) }),
            rawEvent({ seq: 1, at: at(1) }),
            rawEvent({ seq: 2, at: at(2) }),
            rawEvent({ seq: 0, at: at(10) }),
            rawEvent({ seq: 1, at: at(11) }),
          ],
        },
      ],
    });

    const events = readRunEvents(ws, runId);

    expect(events.map((event) => event.seq)).toEqual([0, 1, 2, 0, 1]);
    expect(events.map((event) => event.at)).toEqual([at(0), at(1), at(2), at(10), at(11)]);
    expect(events[3]!.at).toBe(at(10));
  });

  it('keeps unlisted fields from the raw line (passthrough)', () => {
    const ws = workspaceWith({
      runs: [{ runId, events: [rawEvent({ seq: 0, customField: 'kept' })] }],
    });

    expect(readRunEvents(ws, runId)[0]!.customField).toBe('kept');
  });

  it('throws naming the line when a line is not JSON', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          rawFiles: {
            'run/events.jsonl': `${JSON.stringify(rawEvent({ seq: 0 }))}\nnot json at all\n`,
          },
        },
      ],
    });

    expect(() => readRunEvents(ws, runId)).toThrowError(
      /events\.jsonl line 2 is not a valid event/,
    );
  });

  it('throws naming the line when a line is JSON but not an event', () => {
    const ws = workspaceWith({
      runs: [{ runId, rawFiles: { 'run/events.jsonl': '{"seq":1}\n' } }],
    });

    expect(() => readRunEvents(ws, runId)).toThrowError(
      /events\.jsonl line 1 is not a valid event/,
    );
  });
});

describe('writerSessions', () => {
  it('counts a restart of seq as a new writer session', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          events: [
            rawEvent({ seq: 0 }),
            rawEvent({ seq: 1 }),
            rawEvent({ seq: 2 }),
            rawEvent({ seq: 0 }),
            rawEvent({ seq: 1 }),
          ],
        },
      ],
    });

    expect(writerSessions(readRunEvents(ws, runId))).toBe(2);
  });

  it('reports zero sessions when there are no events', () => {
    expect(writerSessions([])).toBe(0);
  });
});

describe('toTimelineEvent', () => {
  it('emits only whitelisted tool.invoked fields and never leaks outputSummary', () => {
    const ws = workspaceWith();
    const timeline = toTimelineEvent(
      rawEvent({
        type: 'tool.invoked',
        tool: 'read-file',
        argumentsSummary: 'read examples/legacy-bank/src/Main.java',
        durationMs: 12,
        outputBytes: 2048,
        truncated: false,
        outputSummary: 'CANARY_OUTPUT_SUMMARY_DO_NOT_RENDER',
      }),
      ws,
    );

    expect(timeline.fields).toEqual([
      { label: 'tool', value: 'read-file' },
      { label: 'args', value: 'read examples/legacy-bank/src/Main.java' },
      { label: 'durationMs', value: '12' },
      { label: 'outputBytes', value: '2048' },
      { label: 'truncated', value: 'false' },
    ]);
    expect(JSON.stringify(timeline)).not.toContain('CANARY_OUTPUT_SUMMARY_DO_NOT_RENDER');
  });

  it('masks absolute host paths in tool.denied reasons', () => {
    const ws = workspaceWith();
    const timeline = toTimelineEvent(
      rawEvent({
        type: 'tool.denied',
        tool: 'read-file',
        requested: '/Users/nobody/passwd',
        reason: 'read outside allowed roots: /Users/nobody/secret/x',
      }),
      ws,
    );

    expect(timeline.fields).toEqual([
      { label: 'tool', value: 'read-file' },
      { label: 'requested', value: '[host path withheld]' },
      { label: 'reason', value: 'read outside allowed roots: [host path withheld]' },
    ]);
  });

  it('returns identity columns with empty fields for an unknown event type', () => {
    const ws = workspaceWith();
    const timeline = toTimelineEvent(
      rawEvent({ type: 'mystery.event', detail: 'CANARY_NOT_WHITELISTED' }),
      ws,
    );

    expect(timeline.fields).toEqual([]);
    expect(timeline.type).toBe('mystery.event');
    expect(timeline.stage).toBeNull();
    expect(timeline.role).toBeNull();
    expect(timeline.taskId).toBeNull();
    expect(JSON.stringify(timeline)).not.toContain('CANARY_NOT_WHITELISTED');
  });

  it('derives array counts and shortened hashes', () => {
    const ws = workspaceWith();
    const artifact = toTimelineEvent(
      rawEvent({
        type: 'artifact.created',
        kind: 'specification',
        relativePath: 'specification/rules/BR-001.json',
        bytes: 1234,
        sha256: 'b'.repeat(64),
      }),
      ws,
    );
    expect(artifact.fields).toEqual([
      { label: 'kind', value: 'specification' },
      { label: 'path', value: 'specification/rules/BR-001.json' },
      { label: 'bytes', value: '1234' },
      { label: 'sha', value: 'b'.repeat(12) },
    ]);

    const finished = toTimelineEvent(
      rawEvent({
        type: 'agent.finished',
        status: 'SUCCEEDED',
        durationMs: 1200,
        findingsCount: 3,
        artifactIds: ['art_1', 'art_2', 'art_3'],
        nextRecommendedAction: 'proceed to SPECIFICATION',
      }),
      ws,
    );
    expect(finished.fields).toEqual([
      { label: 'status', value: 'SUCCEEDED' },
      { label: 'durationMs', value: '1200' },
      { label: 'findingsCount', value: '3' },
      { label: 'artifactCount', value: '3' },
      { label: 'next', value: 'proceed to SPECIFICATION' },
    ]);
  });

  it('omits whitelisted fields that are absent from the raw event', () => {
    const ws = workspaceWith();
    const timeline = toTimelineEvent(rawEvent({ type: 'agent.finished', status: 'FAILED' }), ws);

    expect(timeline.fields).toEqual([{ label: 'status', value: 'FAILED' }]);
  });
});

describe('groupTimeline', () => {
  it('orders groups by first stage appearance and keeps unattributed last', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          events: [
            rawEvent({ type: 'agent.started', stage: 'DISCOVERY', at: at(0) }),
            rawEvent({ type: 'llm.completed', at: at(1) }),
            rawEvent({ type: 'agent.step', stage: 'SPECIFICATION', at: at(2) }),
            rawEvent({ type: 'artifact.created', stage: 'DISCOVERY', at: at(3) }),
            rawEvent({ type: 'agent.step', at: at(4) }),
          ],
        },
      ],
    });

    const groups = groupTimeline(readRunEvents(ws, runId), ws);

    expect(groups.map((group) => group.stage)).toEqual([
      'DISCOVERY',
      'SPECIFICATION',
      'unattributed',
    ]);
    expect(groups[0]!.label).toBe('DISCOVERY');
    expect(groups[0]!.events.map((event) => event.at)).toEqual([at(0), at(3)]);
    expect(groups[1]!.events.map((event) => event.at)).toEqual([at(2)]);
    expect(groups[2]!.label).toBe('unattributed (no stage recorded)');
    expect(groups[2]!.events.map((event) => event.at)).toEqual([at(1), at(4)]);
  });

  it('keeps VERIFICATION-stage events separate from no-stage events', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          events: [
            rawEvent({ type: 'verification.result', stage: 'VERIFICATION', at: at(0) }),
            rawEvent({ type: 'test.executed', at: at(1) }),
            rawEvent({ type: 'verification.result', stage: 'VERIFICATION', at: at(2) }),
            rawEvent({ type: 'repair.requested', at: at(3) }),
          ],
        },
      ],
    });

    const groups = groupTimeline(readRunEvents(ws, runId), ws);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.stage).toBe('VERIFICATION');
    expect(groups[0]!.events).toHaveLength(2);
    expect(groups[1]!.stage).toBe('unattributed');
    expect(groups[1]!.events.map((event) => event.type)).toEqual([
      'test.executed',
      'repair.requested',
    ]);
  });
});

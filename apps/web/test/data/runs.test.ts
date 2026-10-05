import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, event, envelope, indexEntry, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace, WorkspaceSpec } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { assertFeaturedIntact, featuredRun, scanRuns } from '../../src/data/runs.js';

const fixtures: FixtureWorkspace[] = [];

function trackedWorkspace(spec: WorkspaceSpec = {}): Workspace {
  const fixture = makeWorkspace(spec);
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function at(day: number, minute: number): string {
  return `2026-01-${String(day).padStart(2, '0')}T00:${String(minute).padStart(2, '0')}:00.000Z`;
}

describe('scanRuns', () => {
  it('lists runs newest first and summarizes a run', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_old',
          index: [
            indexEntry({
              runId: 'run_old',
              kind: 'discovery-report',
              relativePath: 'discovery/report.json',
            }),
          ],
          events: [
            event({
              runId: 'run_old',
              seq: 0,
              at: at(1, 0),
              type: 'agent.started',
              stage: 'DISCOVERY',
              taskId: 'task_a',
            }),
            event({
              runId: 'run_old',
              seq: 1,
              at: at(1, 1),
              type: 'agent.finished',
              stage: 'DISCOVERY',
              taskId: 'task_a',
            }),
            event({
              runId: 'run_old',
              seq: 2,
              at: at(1, 2),
              type: 'artifact.created',
              stage: 'DISCOVERY',
              taskId: 'task_b',
            }),
          ],
        },
        {
          runId: 'run_new',
          index: [
            indexEntry({
              runId: 'run_new',
              kind: 'discovery-report',
              relativePath: 'discovery/report.json',
            }),
          ],
          events: [
            event({
              runId: 'run_new',
              seq: 0,
              at: at(2, 0),
              type: 'agent.started',
              stage: 'DISCOVERY',
            }),
          ],
        },
        { runId: 'run_silent', index: [] },
      ],
    });

    const runs = scanRuns(ws);
    expect(runs.map((run) => run.runId)).toEqual(['run_new', 'run_old', 'run_silent']);

    const old = runs[1];
    expect(old?.artifactCount).toBe(1);
    expect(old?.eventCount).toBe(3);
    expect(old?.firstEventAt).toBe(at(1, 0));
    expect(old?.lastEventAt).toBe(at(1, 2));
    expect(old?.writerSessions).toBe(1);
    expect(old?.stages).toEqual(['DISCOVERY']);
    expect(old?.taskCount).toBe(2);
    expect(old?.latestVerdict).toBeNull();
    expect(old?.problems).toEqual([]);

    const silent = runs[2];
    expect(silent?.artifactCount).toBe(0);
    expect(silent?.eventCount).toBe(0);
    expect(silent?.firstEventAt).toBeNull();
    expect(silent?.lastEventAt).toBeNull();
    expect(silent?.writerSessions).toBe(0);
    expect(silent?.stages).toEqual([]);
    expect(silent?.taskCount).toBe(0);
    expect(silent?.problems).toEqual(['events.jsonl missing']);
  });

  it('flags a missing or unreadable index without dropping the run', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_noindex',
          events: [event({ runId: 'run_noindex', seq: 0, at: at(1, 0), type: 'agent.started' })],
        },
        {
          runId: 'run_badindex',
          rawFiles: { 'index.json': '[{ "broken": ' },
          events: [event({ runId: 'run_badindex', seq: 0, at: at(1, 5), type: 'agent.started' })],
        },
      ],
    });

    const runs = scanRuns(ws);
    expect(runs.map((run) => run.runId)).toEqual(['run_badindex', 'run_noindex']);
    const badindex = runs.find((run) => run.runId === 'run_badindex');
    const noindex = runs.find((run) => run.runId === 'run_noindex');
    expect(badindex?.artifactCount).toBe(-1);
    expect(badindex?.problems).toEqual(['index.json missing or unreadable']);
    expect(noindex?.artifactCount).toBe(-1);
    expect(noindex?.problems).toEqual(['index.json missing or unreadable']);
  });

  it('counts writer sessions across seq restarts', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_restart',
          index: [],
          events: [
            event({ seq: 0, at: at(1, 0), type: 'agent.started' }),
            event({ seq: 1, at: at(1, 1), type: 'agent.step' }),
            event({ seq: 2, at: at(1, 2), type: 'agent.finished' }),
            event({ seq: 0, at: at(1, 3), type: 'agent.started' }),
            event({ seq: 1, at: at(1, 4), type: 'agent.finished' }),
          ],
        },
      ],
    });

    const run = scanRuns(ws)[0];
    expect(run?.writerSessions).toBe(2);
    expect(run?.eventCount).toBe(5);
    expect(run?.lastEventAt).toBe(at(1, 4));
  });

  it('keeps stage values in first-appearance order', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_stages',
          index: [],
          events: [
            event({ seq: 0, at: at(1, 0), type: 'agent.started', stage: 'SPECIFICATION' }),
            event({ seq: 1, at: at(1, 1), type: 'agent.started', stage: 'DISCOVERY' }),
            event({ seq: 2, at: at(1, 2), type: 'agent.step' }),
            event({ seq: 3, at: at(1, 3), type: 'agent.step', stage: 'SPECIFICATION' }),
          ],
        },
      ],
    });

    expect(scanRuns(ws)[0]?.stages).toEqual(['SPECIFICATION', 'DISCOVERY']);
  });

  it('skips directories that are not runs and tolerates an empty artifacts dir', () => {
    const empty = trackedWorkspace();
    expect(scanRuns(empty)).toEqual([]);

    const ws = trackedWorkspace({
      runs: [
        { runId: 'run_notes', rawFiles: { 'notes.txt': 'hello' } },
        { runId: 'run_empty' },
        { runId: '.ghost', index: [] },
      ],
    });
    expect(scanRuns(ws)).toEqual([]);
  });
});

describe('latestVerdict', () => {
  it('picks the highest repair iteration and flags unreadable verdict files', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_verdicts',
          index: [],
          events: [
            event({ seq: 0, at: at(1, 0), type: 'verification.result', stage: 'VERIFICATION' }),
          ],
          files: {
            'verification/verdict.json': envelope('verification-report', {
              repairIteration: 0,
              verdict: 'NOT_EQUIVALENT',
              mismatchSummary: { total: 123 },
            }),
            'verification/verdict-r1.json': envelope('verification-report', {
              repairIteration: 1,
              verdict: 'NOT_EQUIVALENT',
              mismatchSummary: { total: 85 },
            }),
            'verification/verdict-r5.json': envelope('verification-report', {
              repairIteration: 5,
              verdict: 'EQUIVALENT',
              mismatchSummary: { total: 0 },
            }),
            'verification/verdict-empty.json': envelope('verification-report', {}),
          },
          rawFiles: { 'verification/verdict-broken.json': '{ not json' },
        },
      ],
    });

    const run = scanRuns(ws)[0];
    expect(run?.latestVerdict).toEqual({ iteration: 5, verdict: 'EQUIVALENT', mismatchTotal: 0 });
    expect(run?.problems).toEqual(['unparseable verdict file verdict-broken.json']);
  });

  it('prefers the canonical verdict over an attempt at the same iteration', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_canonical',
          index: [],
          events: [event({ seq: 0, at: at(1, 0), type: 'verification.result' })],
          files: {
            'verification/verdict-r1.json': envelope('verification-report', {
              repairIteration: 1,
              verdict: 'NOT_EQUIVALENT',
              mismatchSummary: { total: 85 },
            }),
            'verification/verdict-r1-attempt-task_041af08b84be4b89839494f2a12d53fb.json': envelope(
              'verification-report',
              {
                repairIteration: 1,
                verdict: 'EQUIVALENT',
                mismatchSummary: { total: 0 },
              },
            ),
          },
        },
      ],
    });

    expect(scanRuns(ws)[0]?.latestVerdict).toEqual({
      iteration: 1,
      verdict: 'NOT_EQUIVALENT',
      mismatchTotal: 85,
    });
  });

  it('breaks filename ties deterministically', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_attempts',
          index: [],
          events: [event({ seq: 0, at: at(1, 0), type: 'verification.result' })],
          files: {
            'verification/verdict-attempt-task_aaa.json': envelope('verification-report', {
              repairIteration: 0,
              verdict: 'NOT_EQUIVALENT',
              mismatchSummary: { total: 1 },
            }),
            'verification/verdict-attempt-task_zzz.json': envelope('verification-report', {
              repairIteration: 0,
              verdict: 'EQUIVALENT',
              mismatchSummary: { total: 0 },
            }),
          },
        },
      ],
    });

    expect(scanRuns(ws)[0]?.latestVerdict).toEqual({
      iteration: 0,
      verdict: 'NOT_EQUIVALENT',
      mismatchTotal: 1,
    });
  });
});

describe('featuredRun and assertFeaturedIntact', () => {
  it('features the newest run and tolerates an empty listing', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_older',
          index: [
            indexEntry({ runId: 'run_older', kind: 'discovery-report', relativePath: 'a.json' }),
          ],
          events: [event({ seq: 0, at: at(1, 0), type: 'agent.started' })],
        },
        {
          runId: 'run_newer',
          index: [
            indexEntry({ runId: 'run_newer', kind: 'discovery-report', relativePath: 'a.json' }),
          ],
          events: [event({ seq: 0, at: at(3, 0), type: 'agent.started' })],
        },
      ],
    });

    expect(featuredRun(scanRuns(ws))?.runId).toBe('run_newer');
    expect(featuredRun([])).toBeNull();
  });

  it('throws for a featured run with a problem and passes for a clean one', () => {
    const ws = trackedWorkspace({
      runs: [
        {
          runId: 'run_clean',
          index: [
            indexEntry({ runId: 'run_clean', kind: 'discovery-report', relativePath: 'a.json' }),
          ],
          events: [event({ seq: 0, at: at(1, 0), type: 'agent.started' })],
        },
        {
          runId: 'run_broken',
          events: [event({ seq: 0, at: at(3, 0), type: 'agent.started' })],
        },
      ],
    });

    const runs = scanRuns(ws);
    const featured = featuredRun(runs);
    expect(featured?.runId).toBe('run_broken');
    expect(() => assertFeaturedIntact(featured)).toThrowError(/index\.json missing or unreadable/);
    expect(() =>
      assertFeaturedIntact(runs.find((run) => run.runId === 'run_clean') ?? null),
    ).not.toThrow();
    expect(() => assertFeaturedIntact(null)).not.toThrow();
  });
});

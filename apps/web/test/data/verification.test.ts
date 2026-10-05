import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, envelope, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { loadVerifications } from '../../src/data/verification.js';

const fixtures: FixtureWorkspace[] = [];
const runId = 'run_fixture0000000000000000000000000';
const taskA = 'task_00000000000000000000000000000001';
const taskB = 'task_00000000000000000000000000000002';
const taskC = 'task_00000000000000000000000000000003';
const taskD = 'task_00000000000000000000000000000004';
const taskE = 'task_00000000000000000000000000000005';
const taskG = 'task_0000000000000000000000000000000b';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(spec: Parameters<typeof makeWorkspace>[0]): Workspace {
  const fixture = makeWorkspace(spec);
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

function check(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    checkId: 'differential-equivalence',
    kind: 'differential-equivalence',
    status: 'FAIL',
    required: true,
    description: 'Every judged scenario must reproduce its captured legacy behavior exactly.',
    observed: { divergent: 9, equal: 0 },
    threshold: { divergent: 0 },
    ...overrides,
  };
}

function verdictPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    repairIteration: 0,
    verdict: 'NOT_EQUIVALENT',
    confidence: 1,
    computedAt: '2026-01-01T00:00:02.000Z',
    computedBy: '@phoenix/differential-testing/verdict.computeDifferentialVerdict',
    reasons: ['9 of 9 scenario(s) diverged from the legacy baseline'],
    mismatchSummary: {
      total: 12,
      unexplained: 12,
      unresolved: 3,
      highestSeverity: 'MAJOR',
      bySeverity: { MAJOR: 9, MINOR: 3 },
    },
    checks: [
      check(),
      check({
        checkId: 'modern-startup',
        kind: 'modern-implementation-builds',
        status: 'PASS',
        description: 'The modern system becomes usable.',
        observed: { readyMs: 258 },
        threshold: undefined,
      }),
    ],
    ...overrides,
  };
}

function comparison(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    scenarioId: 'scn_1',
    scenarioTitle: 'Transfer above the review threshold',
    category: 'boundary',
    outcome: 'divergent',
    equal: false,
    durationMs: 3,
    normalizationApplied: [{ path: 'settlement.startedAt' }, { path: 'settlement.finishedAt' }],
    legacy: { system: 'legacy', body: 'LEGACY-CANARY' },
    modern: { system: 'modern', body: 'MODERN-CANARY' },
    ...overrides,
  };
}

function reportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    generatedAt: '2026-01-01T00:00:03.000Z',
    statistics: { scenarios: 9, divergent: 9, equal: 0, mismatches: 123 },
    comparisons: [comparison()],
    ...overrides,
  };
}

describe('loadVerifications', () => {
  it('merges verdicts and reports into one sorted iteration timeline per taskId', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'verification/verdict.json': envelope('verification.verdict', verdictPayload(), {
              runId,
              taskId: taskA,
            }),
            'verification/differential-report.json': envelope(
              'verification.differential-report',
              reportPayload(),
              { runId, taskId: taskA },
            ),
            'verification/verdict-r1.json': envelope(
              'verification.verdict',
              verdictPayload({ repairIteration: 1 }),
              { runId, taskId: taskB },
            ),
            'verification/differential-report-r1.json': envelope(
              'verification.differential-report',
              reportPayload(),
              { runId, taskId: taskB },
            ),
            [`verification/verdict-r1-attempt-${taskC}.json`]: envelope(
              'verification.verdict',
              verdictPayload({
                repairIteration: 1,
                verdict: 'EQUIVALENT',
                reasons: ['10 scenario(s) reproduce their captured legacy behavior exactly'],
                mismatchSummary: {
                  total: 0,
                  unexplained: 0,
                  unresolved: 0,
                  highestSeverity: null,
                  bySeverity: {},
                },
                checks: [],
              }),
              { runId, taskId: taskC },
            ),
            [`verification/differential-report-r1-attempt-${taskC}.json`]: envelope(
              'verification.differential-report',
              reportPayload(),
              { runId, taskId: taskC },
            ),
          },
        },
      ],
    });
    const view = loadVerifications(ws, runId);
    expect(view.problems).toEqual([]);
    expect(
      view.iterations.map((it) => [it.iteration, it.variant, it.verdict?.label ?? null]),
    ).toEqual([
      [0, 'canonical', 'canonical'],
      [1, 'canonical', 'canonical'],
      [1, 'attempt', `attempt ${taskC}`],
    ]);
    expect(view.iterations[0]).toEqual({
      iteration: 0,
      variant: 'canonical',
      verdict: {
        iteration: 0,
        variant: 'canonical',
        label: 'canonical',
        verdict: 'NOT_EQUIVALENT',
        confidence: 1,
        reasons: ['9 of 9 scenario(s) diverged from the legacy baseline'],
        mismatchSummary: {
          total: 12,
          unexplained: 12,
          unresolved: 3,
          highestSeverity: 'MAJOR',
          bySeverity: { MAJOR: 9, MINOR: 3 },
        },
        checks: [
          {
            checkId: 'differential-equivalence',
            kind: 'differential-equivalence',
            status: 'FAIL',
            required: true,
            description:
              'Every judged scenario must reproduce its captured legacy behavior exactly.',
            observed: '{"divergent":9,"equal":0}',
            threshold: '{"divergent":0}',
          },
          {
            checkId: 'modern-startup',
            kind: 'modern-implementation-builds',
            status: 'PASS',
            required: true,
            description: 'The modern system becomes usable.',
            observed: '{"readyMs":258}',
            threshold: null,
          },
        ],
        taskId: taskA,
        computedAt: '2026-01-01T00:00:02.000Z',
      },
      report: {
        statistics: { scenarios: 9, divergent: 9, equal: 0, mismatches: 123 },
        generatedAt: '2026-01-01T00:00:03.000Z',
        comparisons: [
          {
            scenarioId: 'scn_1',
            scenarioTitle: 'Transfer above the review threshold',
            category: 'boundary',
            outcome: 'divergent',
            equal: false,
            durationMs: 3,
            normalizationApplied: 2,
          },
        ],
      },
    });
    expect(view.iterations[1]?.report?.comparisons).toHaveLength(1);
    expect(view.iterations[2]?.verdict?.verdict).toBe('EQUIVALENT');
    expect(view.iterations[2]?.verdict?.mismatchSummary).toEqual({
      total: 0,
      unexplained: 0,
      unresolved: 0,
      highestSeverity: null,
      bySeverity: {},
    });
    expect(view.iterations[2]?.verdict?.checks).toEqual([]);
    expect(view.iterations[2]?.report).not.toBeNull();
  });

  it('pairs by taskId even when file names are shuffled and disagree on the iteration', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            [`verification/verdict-r1-attempt-${taskG}.json`]: envelope(
              'verification.verdict',
              verdictPayload({ repairIteration: 1, verdict: 'EQUIVALENT', reasons: [] }),
              { runId, taskId: taskG },
            ),
            [`verification/differential-report-attempt-${taskG}.json`]: envelope(
              'verification.differential-report',
              reportPayload(),
              { runId, taskId: taskG },
            ),
          },
        },
      ],
    });
    const view = loadVerifications(ws, runId);
    expect(view.problems).toEqual([]);
    expect(view.iterations).toHaveLength(1);
    expect(view.iterations[0]?.iteration).toBe(1);
    expect(view.iterations[0]?.variant).toBe('attempt');
    expect(view.iterations[0]?.verdict?.verdict).toBe('EQUIVALENT');
    expect(view.iterations[0]?.report).not.toBeNull();
    expect(view.iterations[0]?.report?.comparisons).toHaveLength(1);
  });

  it('keeps unpaired verdicts and reports as entries with an explicit null side', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'verification/verdict-r2.json': envelope(
              'verification.verdict',
              verdictPayload({ repairIteration: 2 }),
              {
                runId,
                taskId: taskD,
              },
            ),
            'verification/differential-report-r4.json': envelope(
              'verification.differential-report',
              reportPayload(),
              { runId, taskId: taskE },
            ),
            [`verification/differential-report-r1-attempt-${taskG}.json`]: envelope(
              'verification.differential-report',
              reportPayload(),
              { runId, taskId: taskG },
            ),
          },
        },
      ],
    });
    const view = loadVerifications(ws, runId);
    expect(view.problems).toEqual([]);
    expect(
      view.iterations.map((it) => [
        it.iteration,
        it.variant,
        it.verdict === null,
        it.report === null,
      ]),
    ).toEqual([
      [1, 'attempt', true, false],
      [2, 'canonical', false, true],
      [4, 'canonical', true, false],
    ]);
    expect(view.iterations[1]?.verdict?.taskId).toBe(taskD);
    expect(view.iterations[2]?.report?.comparisons).toHaveLength(1);
  });

  it('never leaks legacy or modern bodies into comparison views', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'verification/differential-report.json': envelope(
              'verification.differential-report',
              reportPayload(),
              { runId, taskId: taskA },
            ),
          },
        },
      ],
    });
    const view = loadVerifications(ws, runId);
    expect(view.problems).toEqual([]);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain('LEGACY-CANARY');
    expect(serialized).not.toContain('MODERN-CANARY');
    expect(Object.keys(view.iterations[0]?.report?.comparisons[0] ?? {})).toEqual([
      'scenarioId',
      'scenarioTitle',
      'category',
      'outcome',
      'equal',
      'durationMs',
      'normalizationApplied',
    ]);
  });

  it('renders observed values as sanitized, clipped strings', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'verification/verdict.json': envelope(
              'verification.verdict',
              verdictPayload({
                checks: [
                  check({
                    observed: {
                      path: '/Users/kaushikitagi/secret/run/verdict.json',
                      key: 'sk-abcdefgh1234567890',
                      note: 'n'.repeat(400),
                    },
                  }),
                  check({
                    checkId: 'primitives',
                    status: 'PASS',
                    required: false,
                    description: 'A primitive observation.',
                    observed: 42,
                    threshold: undefined,
                  }),
                  check({
                    checkId: 'missing-observed',
                    status: 'PASS',
                    description: 'No observation recorded.',
                    required: undefined,
                    observed: undefined,
                    threshold: undefined,
                  }),
                ],
              }),
              { runId, taskId: taskA },
            ),
          },
        },
      ],
    });
    const view = loadVerifications(ws, runId);
    expect(view.problems).toEqual([]);
    const checks = view.iterations[0]?.verdict?.checks ?? [];
    expect(checks).toHaveLength(3);
    expect(checks[0]?.observed).toContain('[host path withheld]');
    expect(checks[0]?.observed).toContain('[redacted api key]');
    expect(checks[0]?.observed).not.toContain('/Users/');
    expect(checks[0]?.observed).toHaveLength(240);
    expect(checks[0]?.observed.endsWith('…')).toBe(true);
    expect(checks[1]?.observed).toBe('42');
    expect(checks[1]?.required).toBe(false);
    expect(checks[2]?.observed).toBe('');
    expect(checks[2]?.required).toBeNull();
  });

  it('voices problems for malformed candidates and skips them', () => {
    const noIteration = verdictPayload();
    delete noIteration.repairIteration;
    const noVerdict = verdictPayload();
    delete noVerdict.verdict;
    noVerdict.repairIteration = 10;
    const ws = workspaceWith({
      runs: [
        {
          runId,
          rawFiles: {
            'verification/notes.json': '{}',
            'verification/verdict-r6.json': '{ not json',
            'verification/verdict-r9.json': '[]',
          },
          files: {
            'verification/verdict-r7.json': envelope('verification.verdict', noIteration, {
              runId,
              taskId: taskA,
            }),
            'verification/verdict-r8.json': envelope(
              'verification.verdict',
              verdictPayload({
                repairIteration: 8,
                checks: [
                  { kind: 'x', status: 'FAIL' },
                  { checkId: 'c2', kind: 'k', status: 'PASS', observed: 1 },
                ],
              }),
              { runId, taskId: taskD },
            ),
            'verification/verdict-r10.json': envelope('verification.verdict', noVerdict, {
              runId,
              taskId: taskB,
            }),
          },
        },
      ],
    });
    const view = loadVerifications(ws, runId);
    expect(view.problems).toEqual([
      'verdict-r10.json: missing verdict',
      'verdict-r6.json: unparseable JSON',
      'verdict-r7.json: missing repairIteration',
      'verdict-r8.json: dropped check 1: missing checkId or status',
      'verdict-r9.json: payload is not an object',
    ]);
    expect(view.iterations).toHaveLength(1);
    expect(view.iterations[0]?.iteration).toBe(8);
    expect(view.iterations[0]?.verdict?.checks).toEqual([
      {
        checkId: 'c2',
        kind: 'k',
        status: 'PASS',
        required: null,
        description: '',
        observed: '1',
        threshold: null,
      },
    ]);
  });

  it('reports a missing verification directory', () => {
    const ws = workspaceWith({ runs: [{ runId }] });
    const view = loadVerifications(ws, runId);
    expect(view).toEqual({ iterations: [], problems: ['verification directory missing'] });
  });
});

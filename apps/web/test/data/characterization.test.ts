import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, envelope, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { loadCharacterization } from '../../src/data/characterization.js';

const fixtures: FixtureWorkspace[] = [];
const runId = 'run_fixture0000000000000000000000000';
const taskA = 'task_00000000000000000000000000000001';
const taskB = 'task_0000000000000000000000000000000b';
const taskC = 'task_0000000000000000000000000000000c';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(spec: Parameters<typeof makeWorkspace>[0]): Workspace {
  const fixture = makeWorkspace(spec);
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

function assertionFixture(
  caseIndex: number,
  assertionIndex: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    assertionId: `CHR-${String(caseIndex + 1).padStart(3, '0')}-a${assertionIndex + 1}`,
    description: `assertion ${assertionIndex + 1}`,
    kind: assertionIndex === 0 ? 'http-status' : 'json-value',
    path: assertionIndex === 0 ? 'httpStatus' : 'body.balance',
    expected: assertionIndex === 0 ? 200 : 1000,
    normalized: assertionIndex === 1,
    stepId: `step-${assertionIndex + 1}`,
    evidence: [],
    sourceRuleIds: [],
    sourceInvariantIds: [],
    ...overrides,
  };
}

function caseFixture(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    caseId: `CHR-${String(index + 1).padStart(3, '0')}`,
    title: `Captured scenario ${index + 1}`,
    category: 'boundary',
    scenario: {
      scenarioId: `scn_fixture_${String(index + 1).padStart(2, '0')}`,
      description: 'synthetic',
    },
    status: 'passing-against-legacy',
    recordsLegacyDefect: false,
    unexplainedVolatility: [],
    targetRuleIds: ['BR-TRANSFER-FEE-ONLINE-THRESHOLD-AND-ROUNDING'],
    targetInvariantIds: [],
    assertions: [assertionFixture(index, 0), assertionFixture(index, 1)],
    captureExecutionId: `capture_${index + 1}`,
    schemaVersion: 1,
    ...overrides,
  };
}

function suitePayload(
  caseCount: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    capturedFrom: 'legacy-bank at http://localhost:8080',
    captures: [],
    cases: Array.from({ length: caseCount }, (_, index) => caseFixture(index)),
    coverage: {},
    generatedAt: '2026-01-01T00:00:04.000Z',
    generatedBy: 'characterization-engineer',
    schemaVersion: 1,
    statistics: {
      assertions: caseCount * 2,
      captured: caseCount,
      recordingLegacyDefects: 0,
      total: caseCount,
    },
    ...overrides,
  };
}

describe('loadCharacterization', () => {
  it('loads canonical and attempt suites with their own numbers, canonical first', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'characterization/suite.json': envelope(
              'characterization.suite',
              suitePayload(9, {
                statistics: { assertions: 381, captured: 9, recordingLegacyDefects: 0, total: 9 },
              }),
              { runId, taskId: taskA },
            ),
            [`characterization/suite-attempt-${taskB}.json`]: envelope(
              'characterization.suite',
              suitePayload(10, {
                statistics: { assertions: 662, captured: 10, recordingLegacyDefects: 0, total: 10 },
              }),
              { runId, taskId: taskB },
            ),
          },
        },
      ],
    });
    const view = loadCharacterization(ws, runId);
    expect(view.problems).toEqual([]);
    expect(
      view.suites.map((suite) => [
        suite.slug,
        suite.variant,
        suite.taskId,
        suite.statistics?.total,
        suite.cases.length,
      ]),
    ).toEqual([
      ['suite', 'canonical', taskA, 9, 9],
      [`suite-attempt-${taskB}`, 'attempt', taskB, 10, 10],
    ]);
    expect(view.suites[0]?.statistics).toEqual({
      total: 9,
      captured: 9,
      assertions: 381,
      recordingLegacyDefects: 0,
    });
    expect(view.suites[0]?.cases[0]).toEqual({
      caseId: 'CHR-001',
      title: 'Captured scenario 1',
      category: 'boundary',
      scenario: 'scn_fixture_01',
      status: 'passing-against-legacy',
      recordsLegacyDefect: false,
      unexplainedVolatility: [],
      targetRuleIds: ['BR-TRANSFER-FEE-ONLINE-THRESHOLD-AND-ROUNDING'],
      targetInvariantIds: [],
      assertions: [
        {
          assertionId: 'CHR-001-a1',
          description: 'assertion 1',
          kind: 'http-status',
          path: 'httpStatus',
          expected: '200',
          normalized: false,
          stepId: 'step-1',
        },
        {
          assertionId: 'CHR-001-a2',
          description: 'assertion 2',
          kind: 'json-value',
          path: 'body.balance',
          expected: '1000',
          normalized: true,
          stepId: 'step-2',
        },
      ],
    });
    expect(view.suites[1]?.cases[0]?.caseId).toBe('CHR-001');
    expect(view.suites[1]?.cases[0]?.assertions).toHaveLength(2);
  });

  it('renders expected values like observed values and carries defects and volatility', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'characterization/suite.json': envelope(
              'characterization.suite',
              suitePayload(1, {
                cases: [
                  caseFixture(0, {
                    recordsLegacyDefect: true,
                    unexplainedVolatility: ['read.responseBody.balance'],
                    assertions: [
                      assertionFixture(0, 0, { expected: { equal: true, nested: [1, 2] } }),
                      assertionFixture(0, 1, {
                        expected: '/Users/kaushikitagi/secret/legacy/AccountService.java',
                        normalized: undefined,
                        path: undefined,
                        stepId: undefined,
                      }),
                      assertionFixture(0, 2, {
                        expected: undefined,
                        description: undefined,
                        kind: undefined,
                        normalized: undefined,
                      }),
                    ],
                  }),
                ],
              }),
              { runId, taskId: taskA },
            ),
          },
        },
      ],
    });
    const view = loadCharacterization(ws, runId);
    expect(view.problems).toEqual([]);
    const holder = view.suites[0]?.cases[0];
    expect(holder?.recordsLegacyDefect).toBe(true);
    expect(holder?.unexplainedVolatility).toEqual(['read.responseBody.balance']);
    expect(holder?.assertions[0]?.expected).toBe('{"equal":true,"nested":[1,2]}');
    expect(holder?.assertions[1]?.expected).toBe('[host path withheld]');
    expect(holder?.assertions[1]?.expected).not.toContain('/Users/');
    expect(holder?.assertions[1]?.normalized).toBeNull();
    expect(holder?.assertions[1]?.path).toBeNull();
    expect(holder?.assertions[1]?.stepId).toBeNull();
    expect(holder?.assertions[2]?.expected).toBe('');
    expect(holder?.assertions[2]?.description).toBe('');
    expect(holder?.assertions[2]?.kind).toBe('');
  });

  it('voices problems for malformed suites and cases, and skips what cannot be read', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          rawFiles: {
            'characterization/notes.json': '{}',
            [`characterization/suite-attempt-${taskB}.json`]: '{ not json',
            [`characterization/suite-attempt-${taskC}.json`]:
              '{"kind":"characterization.suite","payload":[]}',
          },
          files: {
            'characterization/suite.json': envelope(
              'characterization.suite',
              suitePayload(3, {
                statistics: { total: 3, captured: 3 },
                cases: [
                  caseFixture(0, {
                    assertions: [
                      assertionFixture(0, 0),
                      assertionFixture(0, 1, { assertionId: undefined }),
                    ],
                  }),
                  caseFixture(1, { caseId: undefined }),
                  caseFixture(2, { caseId: 'CHR-003', assertions: 'not-an-array' }),
                ],
              }),
              { runId, taskId: taskA },
            ),
          },
        },
      ],
    });
    const view = loadCharacterization(ws, runId);
    expect(view.problems).toEqual([
      `suite-attempt-${taskB}.json: unparseable JSON`,
      `suite-attempt-${taskC}.json: payload is not an object`,
      'suite.json: case CHR-001 dropped assertion 2: missing assertionId',
      'suite.json: dropped case 2: missing caseId',
      'suite.json: case CHR-003 assertions is not an array',
    ]);
    expect(view.suites).toHaveLength(1);
    expect(view.suites[0]?.variant).toBe('canonical');
    expect(view.suites[0]?.statistics).toBeNull();
    expect(view.suites[0]?.cases.map((item) => [item.caseId, item.assertions.length])).toEqual([
      ['CHR-001', 1],
      ['CHR-003', 0],
    ]);
  });

  it('reports a missing characterization directory', () => {
    const ws = workspaceWith({ runs: [{ runId }] });
    const view = loadCharacterization(ws, runId);
    expect(view).toEqual({ suites: [], problems: ['characterization directory missing'] });
  });
});

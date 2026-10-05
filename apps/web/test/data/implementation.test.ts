import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, envelope, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { loadImplementation } from '../../src/data/implementation.js';

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

function changeReportPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    assumptions: [],
    entryPoint: 'server.ts',
    files: [
      {
        bytes: 26714,
        description: 'HTTP server implementing the transfer fee rules',
        path: 'server.ts',
        sha256: 'c6aa825868752b7be64957f822e4f942509b2a2e79108e75cc5d0a4641440425',
      },
      {
        bytes: 272,
        description:
          'Host-owned launcher: the model does not write it and the harness starts the server with it.',
        path: 'run.sh',
        sha256: 'b'.repeat(64),
      },
    ],
    generatedAt: '2026-01-01T00:00:05.000Z',
    generatedBy: 'modernizer',
    invariantIdsAddressed: ['INV-SETTLED-LEDGER-ROW-IMMUTABLE'],
    resetPath: '/test/reset',
    ruleIdsImplemented: ['BR-TRANSFER-FEE-ONLINE-THRESHOLD-AND-ROUNDING'],
    schemaVersion: 1,
    summary: 'Implemented transfer fee rules in the modern service.',
    ...overrides,
  };
}

describe('loadImplementation', () => {
  it('loads canonical and attempt reports with their own numbers, canonical first', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'implementation/change-report.json': envelope(
              'implementation.change-report',
              changeReportPayload(),
              { runId, taskId: taskA },
            ),
            'implementation/change-report-r2.json': envelope(
              'implementation.change-report',
              changeReportPayload({ summary: 'Repaired rounding after mismatch.' }),
              { runId, taskId: taskB },
            ),
            [`implementation/change-report-attempt-${taskC}.json`]: envelope(
              'implementation.change-report',
              changeReportPayload({ summary: 'Attempted repair.' }),
              { runId, taskId: taskC },
            ),
          },
        },
      ],
    });
    const view = loadImplementation(ws, runId);
    expect(view.problems).toEqual([]);
    expect(
      view.reports.map((report) => [report.slug, report.variant, report.iteration, report.taskId]),
    ).toEqual([
      ['change-report', 'canonical', 0, taskA],
      ['change-report-r2', 'canonical', 2, taskB],
      [`change-report-attempt-${taskC}`, 'attempt', 0, taskC],
    ]);
    expect(view.reports[0]).toEqual({
      slug: 'change-report',
      variant: 'canonical',
      iteration: 0,
      taskId: taskA,
      summary: 'Implemented transfer fee rules in the modern service.',
      entryPoint: 'server.ts',
      resetPath: '/test/reset',
      generatedAt: '2026-01-01T00:00:05.000Z',
      generatedBy: 'modernizer',
      ruleIdsImplemented: ['BR-TRANSFER-FEE-ONLINE-THRESHOLD-AND-ROUNDING'],
      invariantIdsAddressed: ['INV-SETTLED-LEDGER-ROW-IMMUTABLE'],
      files: [
        {
          path: 'server.ts',
          description: 'HTTP server implementing the transfer fee rules',
          bytes: 26714,
          sha256: 'c6aa825868752b7be64957f822e4f942509b2a2e79108e75cc5d0a4641440425',
        },
        {
          path: 'run.sh',
          description:
            'Host-owned launcher: the model does not write it and the harness starts the server with it.',
          bytes: 272,
          sha256: 'b'.repeat(64),
        },
      ],
    });
    expect(view.reports[1]?.summary).toBe('Repaired rounding after mismatch.');
    expect(view.reports[2]?.summary).toBe('Attempted repair.');
  });

  it('withholds host paths and secrets in display strings while keeping bytes and digests', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'implementation/change-report.json': envelope(
              'implementation.change-report',
              changeReportPayload({
                summary:
                  'Wrote output to /Users/kaushikitagi/phoenix/build with key sk-example-not-a-real-key',
                entryPoint: '/Users/kaushikitagi/phoenix/server.ts',
                resetPath: '/Users/kaushikitagi/phoenix/reset',
                generatedBy: 'modernizer at /Users/kaushikitagi/phoenix',
                files: [
                  {
                    bytes: 10,
                    description: 'loader from /Users/kaushikitagi/phoenix/run.sh',
                    path: '/Users/kaushikitagi/phoenix/server.ts',
                    sha256: 'a'.repeat(64),
                  },
                  { bytes: 'not-a-number', description: 42, path: 'run.sh', sha256: 7 },
                ],
              }),
              { runId, taskId: taskA },
            ),
          },
        },
      ],
    });
    const view = loadImplementation(ws, runId);
    expect(view.problems).toEqual([]);
    const report = view.reports[0];
    expect(report?.summary).toBe(
      'Wrote output to [host path withheld] with key [redacted api key]',
    );
    expect(report?.entryPoint).toBe('[host path withheld]');
    expect(report?.resetPath).toBe('[host path withheld]');
    expect(report?.generatedBy).toBe('modernizer at [host path withheld]');
    expect(report?.files[0]).toEqual({
      path: '[host path withheld]',
      description: 'loader from [host path withheld]',
      bytes: 10,
      sha256: 'a'.repeat(64),
    });
    expect(report?.files[1]).toEqual({
      path: 'run.sh',
      description: '',
      bytes: null,
      sha256: null,
    });
    expect(JSON.stringify(view)).not.toContain('/Users/');
    expect(JSON.stringify(view)).not.toContain('sk-');
  });

  it('voices problems for malformed reports and skips what cannot be read', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          rawFiles: {
            'implementation/notes.json': '{}',
            [`implementation/change-report-attempt-${taskA}.json`]: '{ not json',
            [`implementation/change-report-attempt-${taskB}.json`]:
              '{"kind":"change-report","payload":[]}',
          },
          files: {
            'implementation/change-report-r1.json': envelope(
              'implementation.change-report',
              changeReportPayload({ files: 'not-an-array' }),
              { runId, taskId: taskB },
            ),
            'implementation/change-report.json': envelope(
              'implementation.change-report',
              changeReportPayload({
                files: [
                  { path: 'server.ts', bytes: 10, sha256: 'a'.repeat(64), description: 'ok' },
                  { bytes: 5, sha256: 'b'.repeat(64), description: 'missing path' },
                ],
              }),
              { runId, taskId: taskC },
            ),
          },
        },
      ],
    });
    const view = loadImplementation(ws, runId);
    expect(view.problems).toEqual([
      `change-report-attempt-${taskA}.json: unparseable JSON`,
      `change-report-attempt-${taskB}.json: payload is not an object`,
      'change-report-r1.json: payload.files is not an array',
      'change-report.json: dropped file 2: missing path',
    ]);
    expect(view.reports).toHaveLength(2);
    expect(view.reports[0]?.files.map((file) => file.path)).toEqual(['server.ts']);
    expect(view.reports[1]?.files).toEqual([]);
  });

  it('reports a missing implementation directory', () => {
    const ws = workspaceWith({ runs: [{ runId }] });
    const view = loadImplementation(ws, runId);
    expect(view).toEqual({ reports: [], problems: ['implementation directory missing'] });
  });
});

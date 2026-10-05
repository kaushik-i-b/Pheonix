import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, envelope, event, indexEntry, makeWorkspace } from './fixtures.js';
import type { FixtureWorkspace } from './fixtures.js';

const workspaces: FixtureWorkspace[] = [];

function tracked(spec?: Parameters<typeof makeWorkspace>[0]): FixtureWorkspace {
  const ws = makeWorkspace(spec);
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) {
    if (existsSync(ws.root)) cleanupWorkspace(ws);
  }
});

describe('makeWorkspace', () => {
  it('writes a run directory with index, events, JSON files, and raw files', () => {
    const runId = 'run_fixture0000000000000000000000001';
    const entry = indexEntry({
      relativePath: 'discovery/findings.json',
      kind: 'findings',
      runId,
    });
    const ws = tracked({
      runs: [
        {
          runId,
          index: [entry],
          events: [
            event({
              seq: 1,
              at: '2026-01-01T00:00:00.000Z',
              type: 'agent.started',
              stage: 'DISCOVERY',
            }),
            event({ seq: 2, at: '2026-01-01T00:00:01.000Z', type: 'artifact.created' }),
          ],
          files: {
            'discovery/findings.json': envelope(
              'findings',
              { findings: [], summary: {} },
              { runId },
            ),
          },
          rawFiles: { 'run/notes.txt': 'hello\n' },
        },
      ],
      legacySources: { 'src/main/java/Bank.java': 'class Bank {}\n' },
    });

    const runDir = join(ws.artifactsDir, runId);
    expect(ws.artifactsDir).toBe(join(ws.repoRoot, 'artifacts'));
    expect(ws.legacyRoot).toBe(join(ws.repoRoot, 'examples', 'legacy-bank'));
    expect(readFileSync(join(ws.repoRoot, 'pnpm-workspace.yaml'), 'utf8')).toBe(
      'packages:\n  - apps/*\n',
    );

    expect(JSON.parse(readFileSync(join(runDir, 'index.json'), 'utf8'))).toEqual([entry]);

    const eventsRaw = readFileSync(join(runDir, 'run', 'events.jsonl'), 'utf8');
    expect(eventsRaw.split('\n').filter((line) => line !== '')).toHaveLength(2);
    expect(JSON.parse(eventsRaw.split('\n')[0] ?? '')).toMatchObject({
      seq: 1,
      type: 'agent.started',
    });

    const finding = JSON.parse(readFileSync(join(runDir, 'discovery', 'findings.json'), 'utf8'));
    expect(finding).toMatchObject({ kind: 'findings', runId });

    expect(readFileSync(join(runDir, 'run', 'notes.txt'), 'utf8')).toBe('hello\n');
    expect(readFileSync(join(ws.legacyRoot, 'src/main/java/Bank.java'), 'utf8')).toBe(
      'class Bank {}\n',
    );
  });

  it('creates the base tree even with no runs or sources', () => {
    const ws = tracked();
    expect(existsSync(join(ws.repoRoot, 'pnpm-workspace.yaml'))).toBe(true);
    expect(existsSync(ws.artifactsDir)).toBe(true);
    expect(existsSync(ws.legacyRoot)).toBe(true);
  });
});

describe('helpers', () => {
  it('fills envelope defaults and honors overrides', () => {
    const base = envelope('findings', { a: 1 });
    expect(base).toMatchObject({
      createdAt: '2026-01-01T00:00:00.000Z',
      envelopeVersion: 1,
      inputs: [],
      kind: 'findings',
      payload: { a: 1 },
      producedBy: {
        role: 'archaeologist',
        taskId: 'task_fixture0000000000000000000000000',
        generator: 'test',
      },
      runId: 'run_fixture0000000000000000000000000',
    });

    const overridden = envelope(
      'business-rules',
      {},
      {
        runId: 'run_x',
        role: 'business-rule-analyst',
        taskId: 'task_x',
        generator: 'model',
        createdAt: '2026-02-02T00:00:00.000Z',
      },
    );
    expect(overridden).toMatchObject({
      runId: 'run_x',
      producedBy: { role: 'business-rule-analyst', taskId: 'task_x', generator: 'model' },
      createdAt: '2026-02-02T00:00:00.000Z',
    });
  });

  it('fills indexEntry defaults', () => {
    const entry = indexEntry({
      relativePath: 'discovery/findings.json',
      kind: 'findings',
      runId: 'run_x',
    });
    expect(entry).toMatchObject({
      id: `art_${'a'.repeat(64)}`,
      kind: 'findings',
      format: 'json',
      runId: 'run_x',
      relativePath: 'discovery/findings.json',
      sha256: 'a'.repeat(64),
      schemaVersion: 1,
      inputs: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      producedBy: {
        role: 'archaeologist',
        taskId: 'task_fixture0000000000000000000000000',
        generator: 'test',
      },
      tags: [],
    });
  });

  it('passes event fields through unchanged', () => {
    const ev = event({
      seq: 7,
      at: '2026-01-01T00:00:07.000Z',
      type: 'tool.invoked',
      stage: 'DISCOVERY',
    });
    expect(ev).toEqual({
      seq: 7,
      at: '2026-01-01T00:00:07.000Z',
      type: 'tool.invoked',
      stage: 'DISCOVERY',
    });
  });
});

describe('cleanupWorkspace', () => {
  it('removes the whole tree', () => {
    const ws = makeWorkspace();
    expect(existsSync(ws.root)).toBe(true);
    cleanupWorkspace(ws);
    expect(existsSync(ws.root)).toBe(false);
  });
});

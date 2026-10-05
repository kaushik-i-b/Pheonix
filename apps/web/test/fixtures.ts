import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface FixtureRunSpec {
  runId: string;
  index?: Record<string, unknown>[];
  events?: Record<string, unknown>[];
  files?: Record<string, unknown>;
  rawFiles?: Record<string, string>;
}

export interface WorkspaceSpec {
  runs?: FixtureRunSpec[];
  legacySources?: Record<string, string>;
}

export interface FixtureWorkspace {
  root: string;
  repoRoot: string;
  artifactsDir: string;
  legacyRoot: string;
}

export function makeWorkspace(spec: WorkspaceSpec = {}): FixtureWorkspace {
  const root = mkdtempSync(join(tmpdir(), 'phoenix-web-'));
  const repoRoot = join(root, 'repo');
  const artifactsDir = join(repoRoot, 'artifacts');
  const legacyRoot = join(repoRoot, 'examples', 'legacy-bank');
  mkdirSync(artifactsDir, { recursive: true });
  mkdirSync(legacyRoot, { recursive: true });
  writeFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');

  for (const run of spec.runs ?? []) {
    const runDir = join(artifactsDir, run.runId);
    mkdirSync(runDir, { recursive: true });
    if (run.index) {
      writeFileSync(join(runDir, 'index.json'), `${JSON.stringify(run.index, null, 2)}\n`);
    }
    if (run.events) {
      mkdirSync(join(runDir, 'run'), { recursive: true });
      const lines = run.events.map((item) => JSON.stringify(item));
      writeFileSync(join(runDir, 'run', 'events.jsonl'), `${lines.join('\n')}\n`);
    }
    for (const [relativePath, content] of Object.entries(run.files ?? {})) {
      const filePath = join(runDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, `${JSON.stringify(content, null, 2)}\n`);
    }
    for (const [relativePath, content] of Object.entries(run.rawFiles ?? {})) {
      const filePath = join(runDir, relativePath);
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content);
    }
  }

  for (const [relativePath, content] of Object.entries(spec.legacySources ?? {})) {
    const filePath = join(legacyRoot, relativePath);
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  return { root, repoRoot, artifactsDir, legacyRoot };
}

export function cleanupWorkspace(ws: FixtureWorkspace): void {
  rmSync(ws.root, { recursive: true, force: true });
}

export interface EnvelopeOptions {
  runId?: string;
  role?: string;
  taskId?: string;
  generator?: string;
  createdAt?: string;
}

export function envelope(
  kind: string,
  payload: Record<string, unknown>,
  opts: EnvelopeOptions = {},
): Record<string, unknown> {
  return {
    createdAt: opts.createdAt ?? '2026-01-01T00:00:00.000Z',
    envelopeVersion: 1,
    inputs: [],
    kind,
    payload,
    producedBy: {
      role: opts.role ?? 'archaeologist',
      taskId: opts.taskId ?? 'task_fixture0000000000000000000000000',
      generator: opts.generator ?? 'test',
    },
    runId: opts.runId ?? 'run_fixture0000000000000000000000000',
  };
}

export interface IndexEntryOptions {
  relativePath: string;
  kind: string;
  runId: string;
  role?: string;
  taskId?: string;
  title?: string;
  bytes?: number;
  generator?: string;
  tags?: string[];
}

export function indexEntry(opts: IndexEntryOptions): Record<string, unknown> {
  const sha256 = 'a'.repeat(64);
  return {
    id: `art_${sha256}`,
    kind: opts.kind,
    format: 'json',
    runId: opts.runId,
    relativePath: opts.relativePath,
    sha256,
    bytes: opts.bytes ?? 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    schemaVersion: 1,
    producedBy: {
      role: opts.role ?? 'archaeologist',
      taskId: opts.taskId ?? 'task_fixture0000000000000000000000000',
      generator: opts.generator ?? 'test',
    },
    inputs: [],
    ...(opts.title === undefined ? {} : { title: opts.title }),
    tags: opts.tags ?? [],
  };
}

export function event(
  fields: Record<string, unknown> & { seq: number; at: string; type: string },
): Record<string, unknown> {
  return { ...fields };
}

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { PhoenixError} from '@phoenix/shared';
import { newRunId, newTaskId, sha256Hex, type ArtifactMeta } from '@phoenix/shared';
import { FileArtifactStore, inputsHashOf } from '../src/index.js';

const rulesSchema = z.object({
  rules: z.array(z.object({ id: z.string().min(1), confidence: z.number().min(0).max(1) })),
});

const directories: string[] = [];
function tempRoot(): string {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-artifacts-'));
  directories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

const RUN = newRunId();
const producer = { role: 'business-rule-analyst' as const, taskId: newTaskId() };

describe('FileArtifactStore', () => {
  let root: string;
  let store: FileArtifactStore;

  beforeEach(() => {
    root = tempRoot();
    store = new FileArtifactStore(root);
  });

  it('writes JSON to the canonical path from the brief and wraps it in provenance', () => {
    const written = store.writeJson(
      { kind: 'specification.business-rules', runId: RUN, producedBy: producer },
      { rules: [{ id: 'BR-1', confidence: 0.8 }] },
      rulesSchema,
    );

    expect(written.meta.relativePath).toBe('specification/business-rules.json');
    expect(written.absolutePath).toBe(join(root, RUN, 'specification', 'business-rules.json'));
    expect(written.deduplicated).toBe(false);

    const onDisk = JSON.parse(readFileSync(written.absolutePath, 'utf8')) as Record<string, unknown>;
    expect(onDisk.envelopeVersion).toBe(1);
    expect(onDisk.kind).toBe('specification.business-rules');
    expect(onDisk.runId).toBe(RUN);
    expect(onDisk.producedBy).toEqual(producer);
    expect(onDisk.payload).toEqual({ rules: [{ id: 'BR-1', confidence: 0.8 }] });
  });

  it('round-trips a validated payload', () => {
    const written = store.writeJson(
      { kind: 'specification.invariants', runId: RUN, producedBy: { role: 'invariant-analyst' } },
      { rules: [{ id: 'INV-1', confidence: 1 }] },
      rulesSchema,
    );
    expect(store.readJson(written.meta, rulesSchema)).toEqual({ rules: [{ id: 'INV-1', confidence: 1 }] });
  });

  it('rejects a payload that does not match its schema before anything hits disk', () => {
    expect(() =>
      store.writeJson(
        { kind: 'specification.business-rules', runId: RUN, producedBy: producer },
        { rules: [{ id: 'BR-1', confidence: 7 }] },
        rulesSchema,
      ),
    ).toThrowError(/confidence/);
    expect(store.list(RUN)).toEqual([]);
  });

  it('reads raw JSON captures that were stored verbatim, without an envelope', () => {
    const written = store.writeText(
      {
        kind: 'raw.database-snapshot',
        slug: 'accounts-snapshot',
        format: 'json',
        runId: RUN,
        producedBy: { role: 'archaeologist', generator: 'repository-tools/query_database' },
      },
      '{"rows":3}',
    );
    expect(written.meta.relativePath).toBe('raw/accounts-snapshot.json');
    expect(readFileSync(written.absolutePath, 'utf8')).toBe('{"rows":3}');
    expect(store.readJson(written.meta, z.object({ rows: z.number() }))).toEqual({ rows: 3 });
  });

  it('reports schema violations with field paths instead of a bare parse error', () => {
    const written = store.writeJson(
      { kind: 'specification.business-rules', runId: RUN, producedBy: producer },
      { rules: [{ id: 'BR-1', confidence: 0.5 }] },
      rulesSchema,
    );
    const wrongSchema = z.object({ rules: z.array(z.object({ id: z.string(), severity: z.string() })) });
    try {
      store.readJson(written.meta, wrongSchema);
      throw new Error('readJson should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('ARTIFACT_SCHEMA_INVALID');
      expect((error as PhoenixError).details.issues).toEqual(['rules.0.severity: Required']);
    }
  });

  it('derives artifact ids from content so identical bytes share an id', () => {
    const first = store.writeText(
      { kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } },
      '# Findings\n',
    );
    const second = store.writeText(
      { kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } },
      '# Findings\n',
    );
    expect(first.meta.id).toBe(second.meta.id);
    expect(first.meta.id).toBe(`art_${sha256Hex('# Findings\n')}`);
    expect(second.deduplicated).toBe(true);
    expect(store.list(RUN, { kind: 'discovery.findings' })).toHaveLength(1);
  });

  it('refuses to overwrite an existing artifact with different bytes', () => {
    store.writeText({ kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } }, 'original');
    try {
      store.writeText({ kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } }, 'rewritten');
      throw new Error('writeText should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('ARTIFACT_WRITE_FAILED');
      expect((error as PhoenixError).message).toContain('refusing to overwrite');
    }
    expect(readFileSync(join(root, RUN, 'discovery', 'findings.md'), 'utf8')).toBe('original');
  });

  it('keeps every version of a repeated kind addressable so repairs supersede rather than mutate', () => {
    store.writeJson(
      { kind: 'verification.differential-report', runId: RUN, producedBy: { role: 'differential-verifier' } },
      { attempt: 1 },
    );
    const repaired = store.writeJson(
      {
        kind: 'verification.differential-report',
        runId: RUN,
        slug: 'after-repair-1',
        producedBy: { role: 'differential-verifier' },
      },
      { attempt: 2 },
    );
    expect(repaired.meta.relativePath).toBe('verification/after-repair-1.json');
    const all = store.list(RUN, { kind: 'verification.differential-report' });
    expect(all).toHaveLength(2);
    expect(store.latest(RUN, 'verification.differential-report')?.id).toBe(repaired.meta.id);
  });

  it('refuses paths that escape the run directory', () => {
    for (const relativePath of ['../escape.json', 'discovery/../../escape.json', '/etc/passwd']) {
      try {
        store.writeText({ kind: 'raw.file', runId: RUN, relativePath, producedBy: producer }, 'x');
        throw new Error(`writeText should have thrown for ${relativePath}`);
      } catch (error) {
        expect((error as PhoenixError).code).toBe('ARTIFACT_WRITE_FAILED');
      }
    }
  });

  it('persists an index a fresh process can resume from', () => {
    store.writeJson(
      {
        kind: 'discovery.repository-map',
        runId: RUN,
        producedBy: { role: 'archaeologist', generator: 'legacy-analysis/map-repository' },
        tags: ['discovery'],
        title: 'Repository map',
      },
      { files: 12 },
    );
    const reopened = new FileArtifactStore(root);
    const metas = reopened.list(RUN, { tag: 'discovery' });
    expect(metas).toHaveLength(1);
    expect(metas[0]?.title).toBe('Repository map');
    expect(metas[0]?.producedBy.generator).toBe('legacy-analysis/map-repository');
    expect(reopened.readJson(metas[0] as ArtifactMeta, z.object({ files: z.number() }))).toEqual({ files: 12 });
    expect(reopened.list(RUN, { producedByRole: 'modernizer' })).toEqual([]);
  });

  it('fails loudly on a corrupt index rather than pretending the run is empty', () => {
    store.writeText({ kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } }, 'x');
    writeFileSync(join(root, RUN, 'index.json'), '{not json', 'utf8');
    expect(() => new FileArtifactStore(root).list(RUN)).toThrowError(/corrupt/);
  });

  it('reports unknown artifact ids with the ids that do exist', () => {
    const written = store.writeText(
      { kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } },
      'x',
    );
    try {
      store.readMeta(RUN, 'art_deadbeef');
      throw new Error('readMeta should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('ARTIFACT_NOT_FOUND');
      expect((error as PhoenixError).details.indexed).toEqual([written.meta.id]);
    }
  });

  it('detects tampering and deletion', () => {
    const findings = store.writeText(
      { kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } },
      'honest observations',
    );
    const rules = store.writeJson(
      { kind: 'specification.business-rules', runId: RUN, producedBy: producer },
      { rules: [] },
      rulesSchema,
    );
    expect(store.verify(RUN)).toMatchObject({ checked: 2, ok: 2, problems: [] });

    writeFileSync(findings.absolutePath, 'rewritten history', 'utf8');
    rmSync(rules.absolutePath);

    const report = store.verify(RUN);
    expect(report.ok).toBe(0);
    expect(report.problems).toHaveLength(2);
    expect(report.problems[0]).toMatchObject({
      artifactId: findings.meta.id,
      problem: 'tampered',
      expectedSha256: findings.meta.sha256,
    });
    expect(report.problems[1]).toMatchObject({ artifactId: rules.meta.id, problem: 'missing' });
  });

  it('reports a missing artifact file on read', () => {
    const written = store.writeText(
      { kind: 'discovery.findings', runId: RUN, producedBy: { role: 'archaeologist' } },
      'x',
    );
    rmSync(written.absolutePath);
    try {
      store.readText(written.meta);
      throw new Error('readText should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('ARTIFACT_NOT_FOUND');
    }
  });
});

describe('inputsHashOf', () => {
  const inputs = [
    { artifactId: 'art_aaa' as const, kind: 'discovery.repository-map' as const, role: 'input' as const },
    { artifactId: 'art_bbb' as const, kind: 'discovery.data-flow' as const, role: 'reference' as const },
  ];

  it('is stable regardless of input order', () => {
    expect(inputsHashOf(inputs)).toBe(inputsHashOf([...inputs].reverse()));
  });

  it('changes when an input changes', () => {
    const changed = [
      { artifactId: 'art_ccc' as const, kind: 'discovery.repository-map' as const, role: 'input' as const },
      { artifactId: 'art_bbb' as const, kind: 'discovery.data-flow' as const, role: 'reference' as const },
    ];
    expect(inputsHashOf(inputs)).not.toBe(inputsHashOf(changed));
  });

  it('distinguishes an input from a mere reference to the same bytes', () => {
    const asReference = [
      { artifactId: 'art_aaa' as const, kind: 'discovery.repository-map' as const, role: 'reference' as const },
      { artifactId: 'art_bbb' as const, kind: 'discovery.data-flow' as const, role: 'reference' as const },
    ];
    expect(inputsHashOf(inputs)).not.toBe(inputsHashOf(asReference));
  });

  it('is a sha256 hex digest', () => {
    expect(inputsHashOf(inputs)).toMatch(/^[0-9a-f]{64}$/);
    expect(inputsHashOf([])).toMatch(/^[0-9a-f]{64}$/);
  });
});

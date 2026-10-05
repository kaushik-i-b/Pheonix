import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, indexEntry, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import {
  artifactSlug,
  assertUniqueSlugs,
  groupArtifacts,
  loadArtifactIndex,
} from '../../src/data/artifacts.js';

const fixtures: FixtureWorkspace[] = [];
const runId = 'run_fixture0000000000000000000000000';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(index?: Record<string, unknown>[]): Workspace {
  const fixture = makeWorkspace({ runs: [index === undefined ? { runId } : { runId, index }] });
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

describe('loadArtifactIndex', () => {
  it('maps entries and classifies canonical against attempt paths', () => {
    const ws = workspaceWith([
      indexEntry({
        relativePath: 'specification/business-rules.json',
        kind: 'specification.business-rules',
        runId,
      }),
      indexEntry({
        relativePath: 'specification/business-rules-attempt-task_ab12.json',
        kind: 'specification.business-rules',
        runId,
      }),
      indexEntry({
        relativePath: 'verification/verdict-r1-attempt-task_ab12.json',
        kind: 'verification.verdict',
        runId,
        title: 'verdict r1 (attempt)',
        tags: ['verification'],
      }),
    ]);

    const entries = loadArtifactIndex(ws, runId);

    expect(entries).toHaveLength(3);
    expect(entries[0]).toEqual({
      id: `art_${'a'.repeat(64)}`,
      kind: 'specification.business-rules',
      format: 'json',
      relativePath: 'specification/business-rules.json',
      sha256: 'a'.repeat(64),
      bytes: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
      title: null,
      tags: [],
      role: 'archaeologist',
      taskId: 'task_fixture0000000000000000000000000',
      generator: 'test',
      variant: 'canonical',
    });
    expect(entries[1]!.variant).toBe('attempt');
    expect(entries[2]!.variant).toBe('attempt');
    expect(entries[2]!.title).toBe('verdict r1 (attempt)');
    expect(entries[2]!.tags).toEqual(['verification']);
    expect(() => assertUniqueSlugs(entries)).not.toThrow();
  });

  it('throws when the run has no index.json', () => {
    const ws = workspaceWith(undefined);

    expect(() => loadArtifactIndex(ws, runId)).toThrow(/artifact index missing for run/);
  });

  it('throws when an entry is malformed instead of skipping it', () => {
    const complete = indexEntry({
      relativePath: 'verification/verdict.json',
      kind: 'verification.verdict',
      runId,
    });
    const ws = workspaceWith([{ ...complete, sha256: undefined }]);

    expect(() => loadArtifactIndex(ws, runId)).toThrow(
      /artifact index entry 1 is malformed: sha256/,
    );
  });
});

describe('artifactSlug', () => {
  it('strips the directory and .json extension', () => {
    expect(artifactSlug('specification/business-rules-attempt-task_ab12.json')).toBe(
      'business-rules-attempt-task_ab12',
    );
    expect(artifactSlug('specification/business-rules.json')).toBe('business-rules');
  });
});

describe('assertUniqueSlugs', () => {
  it('throws listing duplicate specification slugs only', () => {
    const ws = workspaceWith([
      indexEntry({
        relativePath: 'specification/business-rules.json',
        kind: 'specification.business-rules',
        runId,
      }),
      indexEntry({
        relativePath: 'specification/archive/business-rules.json',
        kind: 'specification.business-rules',
        runId,
      }),
      indexEntry({
        relativePath: 'verification/verdict.json',
        kind: 'verification.verdict',
        runId,
      }),
      indexEntry({
        relativePath: 'verification/archive/verdict.json',
        kind: 'verification.verdict',
        runId,
      }),
    ]);

    const entries = loadArtifactIndex(ws, runId);

    expect(() => assertUniqueSlugs(entries)).toThrow(
      /duplicate specification artifact slugs: .*business-rules/,
    );
    expect(() => assertUniqueSlugs(entries)).not.toThrow(/verdict/);
  });
});

describe('groupArtifacts', () => {
  it('groups by kind in first-appearance order, preserving entry order within a kind', () => {
    const ws = workspaceWith([
      indexEntry({
        relativePath: 'specification/invariants.json',
        kind: 'specification.invariants',
        runId,
      }),
      indexEntry({
        relativePath: 'verification/verdict.json',
        kind: 'verification.verdict',
        runId,
      }),
      indexEntry({
        relativePath: 'specification/business-rules.json',
        kind: 'specification.business-rules',
        runId,
      }),
      indexEntry({
        relativePath: 'specification/invariants-attempt-task_ab12.json',
        kind: 'specification.invariants',
        runId,
      }),
    ]);

    const groups = groupArtifacts(loadArtifactIndex(ws, runId));

    expect(groups.map((group) => group.kind)).toEqual([
      'specification.invariants',
      'verification.verdict',
      'specification.business-rules',
    ]);
    expect(groups[0]!.entries.map((entry) => entry.relativePath)).toEqual([
      'specification/invariants.json',
      'specification/invariants-attempt-task_ab12.json',
    ]);
  });
});

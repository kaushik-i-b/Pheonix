import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { displayPath, findRepoRoot, resolveWorkspace } from '../../src/data/repo-root.js';

const workspaces: FixtureWorkspace[] = [];
const looseDirs: string[] = [];

function tracked(spec?: Parameters<typeof makeWorkspace>[0]): FixtureWorkspace {
  const ws = makeWorkspace(spec);
  workspaces.push(ws);
  return ws;
}

afterEach(() => {
  for (const ws of workspaces.splice(0)) cleanupWorkspace(ws);
  for (const dir of looseDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('findRepoRoot', () => {
  it('finds the fixture repo root from a nested directory', () => {
    const ws = tracked();
    const nested = join(ws.repoRoot, 'apps', 'web', 'src', 'deep');
    mkdirSync(nested, { recursive: true });
    expect(findRepoRoot(nested)).toBe(ws.repoRoot);
  });

  it('throws when no workspace marker exists up the chain', () => {
    const loose = mkdtempSync(join(tmpdir(), 'phoenix-loose-'));
    looseDirs.push(loose);
    expect(() => findRepoRoot(loose)).toThrowError(`repo root not found above ${loose}`);
  });
});

describe('resolveWorkspace', () => {
  it('defaults to the repo root with artifacts and legacy-bank paths', () => {
    const ws = tracked();
    const resolved = resolveWorkspace({ cwd: ws.repoRoot, env: {} });
    expect(resolved.repoRoot).toBe(ws.repoRoot);
    expect(resolved.artifactsDir).toBe(ws.artifactsDir);
    expect(resolved.legacyRoot).toBe(ws.legacyRoot);
    expect(resolved.buildTime).toBeNull();
    expect(resolved.sourceMode).toBe('working-tree');
  });

  it('lets non-empty env overrides win and ignores empty strings', () => {
    const ws = tracked();
    const overridden = resolveWorkspace({
      cwd: ws.repoRoot,
      env: {
        PHOENIX_ARTIFACTS_DIR: '/opt/phoenix-artifacts',
        PHOENIX_LEGACY_ROOT: '/opt/legacy-checkout',
      },
    });
    expect(overridden.artifactsDir).toBe('/opt/phoenix-artifacts');
    expect(overridden.legacyRoot).toBe('/opt/legacy-checkout');

    const empty = resolveWorkspace({
      cwd: ws.repoRoot,
      env: { PHOENIX_ARTIFACTS_DIR: '', PHOENIX_LEGACY_ROOT: '' },
    });
    expect(empty.artifactsDir).toBe(ws.artifactsDir);
    expect(empty.legacyRoot).toBe(ws.legacyRoot);
  });

  it('enters snapshot mode in production with the injected now', () => {
    const ws = tracked();
    const resolved = resolveWorkspace({
      cwd: ws.repoRoot,
      env: { NODE_ENV: 'production' },
      now: new Date('2026-03-03T00:00:00.000Z'),
    });
    expect(resolved.buildTime).toBe('2026-03-03T00:00:00.000Z');
    expect(resolved.sourceMode).toBe('snapshot');
  });

  it('takes PHOENIX_BUILD_TIME verbatim when set', () => {
    const ws = tracked();
    const resolved = resolveWorkspace({
      cwd: ws.repoRoot,
      env: { NODE_ENV: 'production', PHOENIX_BUILD_TIME: '2026-04-04T00:00:00.000Z' },
      now: new Date('2026-03-03T00:00:00.000Z'),
    });
    expect(resolved.buildTime).toBe('2026-04-04T00:00:00.000Z');
    expect(resolved.sourceMode).toBe('snapshot');
  });

  it('stays in working-tree mode outside production', () => {
    const ws = tracked();
    const resolved = resolveWorkspace({
      cwd: ws.repoRoot,
      env: { NODE_ENV: 'development' },
      now: new Date('2026-03-03T00:00:00.000Z'),
    });
    expect(resolved.buildTime).toBeNull();
    expect(resolved.sourceMode).toBe('working-tree');
  });
});

describe('displayPath', () => {
  it('relativizes paths under the repo root', () => {
    const ws = tracked();
    const absolute = join(ws.repoRoot, 'examples', 'legacy-bank', 'src', 'Main.java');
    expect(displayPath({ ...resolveWorkspace({ cwd: ws.repoRoot, env: {} }) }, absolute)).toBe(
      'examples/legacy-bank/src/Main.java',
    );
  });

  it('withholds other absolute paths and passes relative paths through', () => {
    const ws = tracked();
    const resolved = resolveWorkspace({ cwd: ws.repoRoot, env: {} });
    expect(displayPath(resolved, '/etc/passwd')).toBe('[host path withheld]');
    expect(displayPath(resolved, 'src/main/java/Main.java')).toBe('src/main/java/Main.java');
  });
});

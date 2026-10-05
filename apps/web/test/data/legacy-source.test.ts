import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { readLegacySource, splitLines } from '../../src/data/legacy-source.js';

const fixtures: FixtureWorkspace[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(legacySources: Record<string, string>): Workspace {
  const fixture = makeWorkspace({ legacySources });
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

describe('splitLines', () => {
  it('normalizes CRLF and does not add an empty line for a single trailing newline', () => {
    expect(splitLines('a\r\nb\r\n')).toEqual(['a', 'b']);
    expect(splitLines('a\nb')).toEqual(['a', 'b']);
    expect(splitLines('a\n\nb\n')).toEqual(['a', '', 'b']);
  });
});

describe('readLegacySource', () => {
  it('reads a fixture file verbatim', () => {
    const ws = workspaceWith({ 'src/AccountService.java': 'class AccountService {\n}\n' });
    const source = readLegacySource(ws, 'src/AccountService.java');
    expect(source).toEqual({
      ok: true,
      content: 'class AccountService {\n}\n',
      lineCount: 2,
    });
  });

  it('resolves a path that stays inside the legacy root', () => {
    const ws = workspaceWith({ 'src/x.txt': 'inside\n' });
    expect(readLegacySource(ws, 'src/../src/x.txt')).toEqual({
      ok: true,
      content: 'inside\n',
      lineCount: 1,
    });
  });

  it('rejects traversal above the legacy root', () => {
    const ws = workspaceWith({ 'src/x.txt': 'inside\n' });
    expect(readLegacySource(ws, '../../etc/passwd')).toEqual({ ok: false, reason: 'missing' });
  });

  it('rejects absolute paths', () => {
    const ws = workspaceWith({ 'src/x.txt': 'inside\n' });
    expect(readLegacySource(ws, '/etc/passwd')).toEqual({ ok: false, reason: 'missing' });
  });

  it('reports a missing file as missing', () => {
    const ws = workspaceWith({ 'src/x.txt': 'inside\n' });
    expect(readLegacySource(ws, 'src/nope.txt')).toEqual({ ok: false, reason: 'missing' });
  });

  it('counts a trailing-newline file as its real number of lines', () => {
    const ws = workspaceWith({ 'src/two.txt': 'first\nsecond\n' });
    const source = readLegacySource(ws, 'src/two.txt');
    expect(source.ok).toBe(true);
    if (source.ok) {
      expect(source.lineCount).toBe(2);
      expect(source.content).toBe('first\nsecond\n');
    }
  });

  it('keeps CRLF bytes verbatim while normalizing line counting', () => {
    const ws = workspaceWith({ 'src/crlf.txt': 'alpha\r\nbeta\r\n' });
    expect(readLegacySource(ws, 'src/crlf.txt')).toEqual({
      ok: true,
      content: 'alpha\r\nbeta\r\n',
      lineCount: 2,
    });
  });
});

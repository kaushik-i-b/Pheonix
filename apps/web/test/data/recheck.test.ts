import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { recheckEvidence } from '../../src/data/recheck.js';

const fixtures: FixtureWorkspace[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(legacySources: Record<string, string>): Workspace {
  const fixture = makeWorkspace({ legacySources });
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

describe('recheckEvidence', () => {
  it('matches exact bytes at the recorded range', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\nbeta\ngamma\n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 2, endLine: 3 }, 'beta\ngamma'),
    ).toEqual({ state: 'matched' });
  });

  it('reports drifted when only trailing whitespace differs, with the first differing line', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\nbeta \n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 1, endLine: 2 }, 'alpha\nbeta'),
    ).toEqual({ state: 'drifted', firstDiffLine: 2 });
  });

  it('reports drifted when the quote is shorter than the recorded range', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\nbeta\ngamma\n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 1, endLine: 3 }, 'alpha\nbeta'),
    ).toEqual({ state: 'drifted', firstDiffLine: 3 });
  });

  it('never treats a matching prefix as proof', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'balance = balance - fee; applied\n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 1 }, 'balance = balance - fee'),
    ).toEqual({ state: 'drifted', firstDiffLine: 1 });
  });

  it('matches despite CRLF bytes in the working tree', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\r\nbeta\r\n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 1, endLine: 2 }, 'alpha\nbeta'),
    ).toEqual({ state: 'matched' });
  });

  it('reports the exact range when the quote moved one line down', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\nbeta\ngamma\n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 1, endLine: 2 }, 'beta\ngamma'),
    ).toEqual({ state: 'relocated', foundStart: 2, foundEnd: 3 });
  });

  it('reports file-missing for a path with no file', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\n' });
    expect(recheckEvidence(ws, { path: 'src/gone.txt', startLine: 1 }, 'alpha')).toEqual({
      state: 'file-missing',
    });
  });

  it('reports out-of-range when the recorded range runs past the file', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\nbeta\n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 1, endLine: 5 }, 'alpha\nbeta'),
    ).toEqual({ state: 'out-of-range', lineCount: 2 });
  });

  it('reports file-missing for a traversal path', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\n' });
    expect(recheckEvidence(ws, { path: '../../etc/passwd', startLine: 1 }, 'alpha')).toEqual({
      state: 'file-missing',
    });
  });

  it('defaults endLine to startLine', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\nbeta\n' });
    expect(recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 2 }, 'beta')).toEqual({
      state: 'matched',
    });
  });

  it('reports a boundary-only difference with no differing line', () => {
    const ws = workspaceWith({ 'src/ledger.txt': 'alpha\nbeta\n' });
    expect(
      recheckEvidence(ws, { path: 'src/ledger.txt', startLine: 1, endLine: 2 }, 'alpha\nbeta\n'),
    ).toEqual({ state: 'drifted', firstDiffLine: null });
  });
});

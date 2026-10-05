import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { maskHostPaths, maskSecrets, sanitizeForDisplay } from '../../src/data/sanitize.js';

const fixtures: FixtureWorkspace[] = [];

function trackedWorkspace(): Workspace {
  const fixture = makeWorkspace();
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

describe('maskHostPaths', () => {
  it('replaces absolute host paths with a withheld marker', () => {
    expect(maskHostPaths('denied /Users/nobody/secret/x now')).toBe(
      'denied [host path withheld] now',
    );
    expect(maskHostPaths('at /private/var/folders/ab/cd yes')).toBe(
      'at [host path withheld] yes',
    );
  });

  it('leaves relative paths and URLs alone', () => {
    expect(maskHostPaths('src/main/java/Main.java')).toBe('src/main/java/Main.java');
    expect(maskHostPaths('https://example.com/home/page')).toBe('https://example.com/home/page');
  });
});

describe('maskSecrets', () => {
  it('masks api key shapes', () => {
    expect(maskSecrets('key sk-test1234567890abcdef end')).toBe('key [redacted api key] end');
    expect(maskSecrets('key AQ.test12345678abcdef end')).toBe('key [redacted api key] end');
  });

  it('masks bearer and authorization values', () => {
    const masked = maskSecrets('Authorization: Bearer abcdefgh12345');
    expect(masked).not.toContain('abcdefgh12345');
    expect(maskSecrets('authorization=abcdefgh12345')).toBe('Authorization: [redacted]');
  });

  it('does not mask bare words without values', () => {
    expect(maskSecrets('Authorization')).toBe('Authorization');
    expect(maskSecrets('bearer of news')).toBe('bearer of news');
  });
});

describe('sanitizeForDisplay', () => {
  it('renders repo-absolute paths as repo-relative', () => {
    const ws = trackedWorkspace();
    const reason = `denied: read outside allowed roots: ${join(ws.repoRoot, 'artifacts', 'run_x')}/file.txt`;
    expect(sanitizeForDisplay(reason, ws)).toBe(
      'denied: read outside allowed roots: artifacts/run_x/file.txt',
    );
  });

  it('withholds other host paths and masks secrets', () => {
    const ws = trackedWorkspace();
    expect(sanitizeForDisplay('see /Users/nobody/secret/x', ws)).toBe('see [host path withheld]');
    expect(sanitizeForDisplay('key sk-test1234567890abcdef', ws)).toBe('key [redacted api key]');
  });

  it('collapses whitespace and clips long text to 240 with an ellipsis', () => {
    const ws = trackedWorkspace();
    expect(sanitizeForDisplay('a \n  b\t\tc  ', ws)).toBe('a b c');
    const clipped = sanitizeForDisplay('a'.repeat(1000), ws);
    expect(clipped).toHaveLength(240);
    expect(clipped.endsWith('…')).toBe(true);
  });
});

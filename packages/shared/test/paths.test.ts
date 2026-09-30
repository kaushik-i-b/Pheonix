import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { canonicalizePath, isWithinRoots, pathIsInside, pathIsInsideAny } from '../src/paths.js';

const directories: string[] = [];
function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'phoenix-paths-'));
  directories.push(directory);
  return directory;
}
afterAll(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

describe('canonicalizePath', () => {
  it('resolves an existing path through its symlinks', () => {
    const directory = tempDirectory();
    // On macOS tmpdir is /var/... which is a symlink to /private/var/...; the two must agree.
    expect(canonicalizePath(directory)).toBe(canonicalizePath(`${directory}/`));
    expect(canonicalizePath(join(directory, 'missing', 'file.txt'))).toBe(
      join(canonicalizePath(directory), 'missing', 'file.txt'),
    );
  });

  it('canonicalises a root that does not exist yet', () => {
    const directory = tempDirectory();
    const future = join(directory, 'artifacts', 'run_x', 'discovery');
    expect(canonicalizePath(future)).toBe(join(canonicalizePath(directory), 'artifacts', 'run_x', 'discovery'));
  });

  it('follows a symlink to its real location', () => {
    const directory = tempDirectory();
    const outside = join(tempDirectory(), 'secret.txt');
    writeFileSync(outside, 'x', 'utf8');
    const link = join(directory, 'link.txt');
    symlinkSync(outside, link);
    expect(canonicalizePath(link)).toBe(canonicalizePath(outside));
  });

  it('follows a dangling symlink to where it points, not to the link itself', () => {
    const directory = tempDirectory();
    const outside = join(tempDirectory(), 'not-created-yet.txt');
    const link = join(directory, 'dangling.txt');
    symlinkSync(outside, link);
    expect(canonicalizePath(link)).toBe(canonicalizePath(outside));
  });
});

describe('containment checks', () => {
  it('is prefix-safe at directory boundaries', () => {
    expect(pathIsInside('/repo/src/A.java', '/repo')).toBe(true);
    expect(pathIsInside('/repo', '/repo')).toBe(true);
    expect(pathIsInside('/repository/A.java', '/repo')).toBe(false);
    expect(pathIsInsideAny('/repo/a', ['/other', '/repo'])).toBe(true);
  });

  it('compares canonical forms on both sides', () => {
    const directory = tempDirectory();
    const canonical = canonicalizePath(directory);
    // The literal temp path may differ from its canonical form (macOS /var -> /private/var).
    expect(isWithinRoots(join(canonical, 'a', 'b.txt'), [directory])).toBe(true);
    expect(isWithinRoots(join(directory, 'a', 'b.txt'), [canonical])).toBe(true);
    expect(isWithinRoots('/etc/passwd', [directory])).toBe(false);
    expect(isWithinRoots(join(directory, 'a'), [])).toBe(false);
  });

  it('refuses a symlink that leaves the root', () => {
    const root = tempDirectory();
    const outside = tempDirectory();
    symlinkSync(outside, join(root, 'escape'));
    expect(isWithinRoots(join(root, 'escape', 'file.txt'), [root])).toBe(false);
    expect(isWithinRoots(join(root, 'real', 'file.txt'), [root])).toBe(true);
  });
});

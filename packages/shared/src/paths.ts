import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve, sep } from 'node:path';

/**
 * Path canonicalisation.
 *
 * Permission checks are prefix comparisons, and prefix comparisons are wrong on any machine where
 * a directory in the path is a symlink — `/var` on macOS, `/tmp` on many Linux hosts, home
 * directories under a mount. Both sides of the comparison therefore have to be canonical, and
 * roots that do not exist yet (an artifact directory for a run that has not written anything) must
 * still canonicalise, so missing trailing components are resolved against their nearest existing
 * ancestor.
 */

export function canonicalizePath(path: string): string {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  let linkHops = 0;
  for (;;) {
    try {
      const real = realpathSync(current);
      return missing.length === 0 ? real : resolve(real, ...missing.reverse());
    } catch {
      // A symlink whose target does not exist still points somewhere: follow the link rather than
      // trusting the link's own location, or a dangling link could be used to write outside a root.
      const target = readlinkTarget(current);
      if (target !== undefined && linkHops < 32) {
        linkHops += 1;
        current = target;
        continue;
      }
      const parent = dirname(current);
      if (parent === current) return resolved;
      missing.push(basename(current));
      current = parent;
    }
  }
}

function readlinkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined;
    return resolve(dirname(path), readlinkSync(path));
  } catch {
    return undefined;
  }
}

export function pathIsInside(path: string, root: string): boolean {
  const resolvedRoot = resolve(root);
  return path === resolvedRoot || path.startsWith(resolvedRoot + sep);
}

export function pathIsInsideAny(path: string, roots: readonly string[]): boolean {
  return roots.some((root) => pathIsInside(path, root));
}

/** True when `path` resolves inside at least one of `roots`, comparing canonical forms. */
export function isWithinRoots(path: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return false;
  const candidate = canonicalizePath(isAbsolute(path) ? path : resolve(path));
  return pathIsInsideAny(candidate, roots.map(canonicalizePath));
}

/**
 * Directories that carry no behavioural evidence: build output, dependency trees and editor
 * state. Shared by the tool layer and static analysis so both see the same repository.
 */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'dist',
  '.next',
  '.idea',
  '.gradle',
  '.mvn',
  '__pycache__',
  '.venv',
  'coverage',
]);

export function shouldSkipDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

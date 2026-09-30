import { isAbsolute, resolve } from 'node:path';
import { PhoenixError, canonicalizePath, pathIsInsideAny } from '@phoenix/shared';

/**
 * Path scoping. Every file the tools touch must resolve inside a root the role is entitled to.
 * The check is done on the *resolved real* path, so a symlink inside the legacy repository cannot
 * be used to read something outside it.
 */

export { canonicalizePath, pathIsInside as isInsideRoot, pathIsInsideAny as isInsideAnyRoot } from '@phoenix/shared';

export interface ResolveScopedPathOptions {
  /** Roots the path must resolve inside. */
  roots: readonly string[];
  /** Base for relative paths, typically the system under test. */
  defaultRoot?: string;
  /** Human-readable scope name used in the failure message, e.g. "read" or "write". */
  scope?: string;
}

export function resolveScopedPath(path: string, options: ResolveScopedPathOptions): string {
  if (path.trim().length === 0) {
    throw new PhoenixError('TOOL_PATH_OUT_OF_SCOPE', 'path must not be empty', { scope: options.scope ?? 'read' });
  }
  const base = isAbsolute(path) ? path : resolve(options.defaultRoot ?? process.cwd(), path);
  // Both the candidate and the roots are canonicalised: a symlinked /var or /tmp must not turn a
  // legitimate read into a denial, and a symlink inside the repository must not escape it.
  const real = canonicalizePath(base);
  if (!pathIsInsideAny(real, options.roots.map(canonicalizePath))) {
    throw new PhoenixError(
      'TOOL_PATH_OUT_OF_SCOPE',
      `path "${path}" resolves to ${real}, outside the permitted ${options.scope ?? 'read'} roots`,
      { path, resolved: real, roots: options.roots, scope: options.scope ?? 'read' },
    );
  }
  return real;
}

/** Directories that carry no behavioural evidence and would only burn the tool budget. */
export const IGNORED_DIRECTORIES = new Set([
  '.git',
  'node_modules',
  'target',
  'build',
  'dist',
  '.next',
  '.idea',
  '.gradle',
  '__pycache__',
  '.venv',
]);

export function shouldSkipDirectory(name: string): boolean {
  return IGNORED_DIRECTORIES.has(name);
}

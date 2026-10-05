import { existsSync } from 'node:fs';
import path from 'node:path';

export interface Workspace {
  repoRoot: string;
  artifactsDir: string;
  legacyRoot: string;
  buildTime: string | null;
  sourceMode: 'working-tree' | 'snapshot';
}

export function findRepoRoot(startDir: string): string {
  const start = path.resolve(startDir);
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`repo root not found above ${start}`);
    dir = parent;
  }
}

export function resolveWorkspace(opts?: {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: Date;
}): Workspace {
  const env = opts?.env ?? process.env;
  const repoRoot = findRepoRoot(opts?.cwd ?? process.cwd());
  const artifactsDir = nonEmpty(env.PHOENIX_ARTIFACTS_DIR) ?? path.join(repoRoot, 'artifacts');
  const legacyRoot =
    nonEmpty(env.PHOENIX_LEGACY_ROOT) ?? path.join(repoRoot, 'examples', 'legacy-bank');
  const buildTime =
    nonEmpty(env.PHOENIX_BUILD_TIME) ??
    (env.NODE_ENV === 'production' ? (opts?.now ?? new Date()).toISOString() : null);
  return {
    repoRoot,
    artifactsDir,
    legacyRoot,
    buildTime,
    sourceMode: buildTime ? 'snapshot' : 'working-tree',
  };
}

export function displayPath(ws: Workspace, p: string): string {
  const prefix = ws.repoRoot + path.sep;
  if (p.startsWith(prefix)) return p.slice(prefix.length);
  if (path.isAbsolute(p)) return '[host path withheld]';
  return p;
}

function nonEmpty(value: string | undefined): string | undefined {
  return value && value.length > 0 ? value : undefined;
}

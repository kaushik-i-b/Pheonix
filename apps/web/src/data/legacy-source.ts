import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './repo-root';

export type LegacySource =
  { ok: true; content: string; lineCount: number } | { ok: false; reason: 'missing' | 'io-error' };

export function splitLines(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function readLegacySource(ws: Workspace, relativePath: string): LegacySource {
  if (relativePath.length === 0 || path.isAbsolute(relativePath)) {
    return { ok: false, reason: 'missing' };
  }
  const resolved = path.resolve(ws.legacyRoot, relativePath);
  if (!resolved.startsWith(ws.legacyRoot + path.sep)) {
    return { ok: false, reason: 'missing' };
  }
  let content: string;
  try {
    content = readFileSync(resolved, 'utf8');
  } catch (error) {
    const code =
      typeof error === 'object' && error !== null && 'code' in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'io-error' };
  }
  return { ok: true, content, lineCount: splitLines(content).length };
}

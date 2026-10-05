import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { Workspace } from './repo-root.js';

export type Variant = 'canonical' | 'attempt';

export interface ArtifactEntry {
  id: string;
  kind: string;
  format: string;
  relativePath: string;
  sha256: string;
  bytes: number;
  createdAt: string;
  title: string | null;
  tags: string[];
  role: string | null;
  taskId: string | null;
  generator: string | null;
  variant: Variant;
}

export interface ArtifactGroup {
  kind: string;
  entries: ArtifactEntry[];
}

const attemptPattern = /-attempt-task_[0-9a-f]+\.json$/;

const indexEntrySchema = z.object({
  id: z.string(),
  kind: z.string(),
  format: z.string(),
  relativePath: z.string(),
  sha256: z.string(),
  bytes: z.number(),
  createdAt: z.string(),
  title: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  producedBy: z
    .object({
      role: z.string().nullish(),
      taskId: z.string().nullish(),
      generator: z.string().nullish(),
    })
    .nullish(),
});

export function loadArtifactIndex(ws: Workspace, runId: string): ArtifactEntry[] {
  const file = path.join(ws.artifactsDir, runId, 'index.json');
  if (!existsSync(file)) throw new Error(`artifact index missing for run ${runId}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`artifact index for run ${runId} is not valid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`artifact index for run ${runId} is not an array`);
  }
  return parsed.map((raw, index) => {
    const result = indexEntrySchema.safeParse(raw);
    if (!result.success) {
      throw new Error(
        `artifact index entry ${index + 1} is malformed: ${describeZodError(result.error)}`,
      );
    }
    const entry = result.data;
    return {
      id: entry.id,
      kind: entry.kind,
      format: entry.format,
      relativePath: entry.relativePath,
      sha256: entry.sha256,
      bytes: entry.bytes,
      createdAt: entry.createdAt,
      title: entry.title ?? null,
      tags: entry.tags ?? [],
      role: entry.producedBy?.role ?? null,
      taskId: entry.producedBy?.taskId ?? null,
      generator: entry.producedBy?.generator ?? null,
      variant: classifyVariant(entry.relativePath),
    };
  });
}

export function classifyVariant(relativePath: string): Variant {
  return attemptPattern.test(relativePath) ? 'attempt' : 'canonical';
}

export function artifactSlug(relativePath: string): string {
  const base = path.posix.basename(relativePath);
  return base.endsWith('.json') ? base.slice(0, -'.json'.length) : base;
}

export function assertUniqueSlugs(entries: ArtifactEntry[]): void {
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const entry of entries) {
    if (!entry.kind.startsWith('specification.')) continue;
    const slug = artifactSlug(entry.relativePath);
    if (seen.has(slug)) {
      if (!duplicates.includes(slug)) duplicates.push(slug);
      continue;
    }
    seen.add(slug);
  }
  if (duplicates.length > 0) {
    throw new Error(`duplicate specification artifact slugs: ${duplicates.join(', ')}`);
  }
}

export function groupArtifacts(entries: ArtifactEntry[]): ArtifactGroup[] {
  const groups = new Map<string, ArtifactGroup>();
  for (const entry of entries) {
    let group = groups.get(entry.kind);
    if (group === undefined) {
      group = { kind: entry.kind, entries: [] };
      groups.set(entry.kind, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()];
}

function describeZodError(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'invalid entry';
  return `${issue.path.join('.') || 'entry'}: ${issue.message}`;
}

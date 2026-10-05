import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { artifactSlug, classifyVariant } from './artifacts';
import type { Variant } from './artifacts';
import type { Workspace } from './repo-root';
import { sanitizeForDisplay } from './sanitize';

export interface ChangeFile {
  path: string;
  description: string;
  bytes: number | null;
  sha256: string | null;
}

export interface ChangeReport {
  slug: string;
  variant: Variant;
  iteration: number;
  taskId: string | null;
  summary: string | null;
  entryPoint: string | null;
  resetPath: string | null;
  generatedAt: string | null;
  generatedBy: string | null;
  ruleIdsImplemented: string[];
  invariantIdsAddressed: string[];
  files: ChangeFile[];
}

export interface ImplementationView {
  reports: ChangeReport[];
  problems: string[];
}

const reportFilePattern = /^change-report(?:-r(\d+))?(?:-attempt-task_[0-9a-f]+)?\.json$/;

export function loadImplementation(ws: Workspace, runId: string): ImplementationView {
  const dir = path.join(ws.artifactsDir, runId, 'implementation');
  if (!existsSync(dir)) {
    return { reports: [], problems: ['implementation directory missing'] };
  }
  const problems: string[] = [];
  const reports: ChangeReport[] = [];
  const fileNames = readdirSync(dir)
    .filter((name) => reportFilePattern.test(name))
    .sort();
  for (const fileName of fileNames) {
    const report = readReport(path.join(dir, fileName), fileName, ws, problems);
    if (report !== null) reports.push(report);
  }
  reports.sort(compareReports);
  return { reports, problems };
}

function readReport(
  file: string,
  fileName: string,
  ws: Workspace,
  problems: string[],
): ChangeReport | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    problems.push(`${fileName}: unparseable JSON`);
    return null;
  }
  const root = asRecord(parsed);
  const payload = asRecord(root?.payload);
  if (payload === null) {
    problems.push(`${fileName}: payload is not an object`);
    return null;
  }
  const iterationRaw = reportFilePattern.exec(fileName)?.[1];
  return {
    slug: artifactSlug(fileName),
    variant: classifyVariant(fileName),
    iteration: iterationRaw === undefined ? 0 : Number(iterationRaw),
    taskId: asString(asRecord(root?.producedBy)?.taskId),
    summary: sanitizeString(payload.summary, ws),
    entryPoint: sanitizeString(payload.entryPoint, ws),
    resetPath: sanitizeString(payload.resetPath, ws),
    generatedAt: asString(payload.generatedAt),
    generatedBy: sanitizeString(payload.generatedBy, ws),
    ruleIdsImplemented: stringArray(payload.ruleIdsImplemented),
    invariantIdsAddressed: stringArray(payload.invariantIdsAddressed),
    files: normalizeFiles(payload.files, fileName, ws, problems),
  };
}

function normalizeFiles(
  raw: unknown,
  fileName: string,
  ws: Workspace,
  problems: string[],
): ChangeFile[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: payload.files is not an array`);
    return [];
  }
  const out: ChangeFile[] = [];
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item);
    const filePath = record === null ? null : asString(record.path);
    if (record === null || filePath === null) {
      problems.push(`${fileName}: dropped file ${index + 1}: missing path`);
      continue;
    }
    out.push({
      path: sanitizeForDisplay(filePath, ws),
      description: sanitizeForDisplay(asString(record.description) ?? '', ws),
      bytes: asNumber(record.bytes),
      sha256: asString(record.sha256),
    });
  }
  return out;
}

function compareReports(a: ChangeReport, b: ChangeReport): number {
  if (a.variant !== b.variant) return a.variant === 'canonical' ? -1 : 1;
  if (a.iteration !== b.iteration) return a.iteration - b.iteration;
  if (a.slug === b.slug) return 0;
  return a.slug < b.slug ? -1 : 1;
}

function sanitizeString(value: unknown, ws: Workspace): string | null {
  const text = asString(value);
  return text === null ? null : sanitizeForDisplay(text, ws);
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

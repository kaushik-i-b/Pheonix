import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { artifactSlug, classifyVariant } from './artifacts';
import type { Variant } from './artifacts';
import type { Workspace } from './repo-root';
import { renderObserved } from './verification';

export interface AssertionView {
  assertionId: string;
  description: string;
  kind: string;
  path: string | null;
  expected: string;
  normalized: boolean | null;
  stepId: string | null;
}

export interface CaseView {
  caseId: string;
  title: string;
  category: string;
  scenario: string | null;
  status: string;
  recordsLegacyDefect: boolean | null;
  unexplainedVolatility: string[];
  targetRuleIds: string[];
  targetInvariantIds: string[];
  assertions: AssertionView[];
}

export interface SuiteStatistics {
  total: number;
  captured: number;
  assertions: number;
  recordingLegacyDefects: number;
}

export interface SuiteView {
  slug: string;
  variant: Variant;
  taskId: string | null;
  statistics: SuiteStatistics | null;
  cases: CaseView[];
}

export interface CharacterizationView {
  suites: SuiteView[];
  problems: string[];
}

const suiteFilePattern = /^suite(-attempt-task_[0-9a-f]+)?\.json$/;

interface SuiteEntry extends SuiteView {
  fileName: string;
}

export function loadCharacterization(ws: Workspace, runId: string): CharacterizationView {
  const dir = path.join(ws.artifactsDir, runId, 'characterization');
  let fileNames: string[];
  try {
    fileNames = readdirSync(dir);
  } catch {
    return { suites: [], problems: ['characterization directory missing'] };
  }
  const problems: string[] = [];
  const entries: SuiteEntry[] = [];
  for (const fileName of fileNames.filter((name) => suiteFilePattern.test(name)).sort()) {
    const entry = readSuite(path.join(dir, fileName), fileName, ws, problems);
    if (entry !== null) entries.push(entry);
  }
  entries.sort(compareSuiteEntries);
  return {
    suites: entries.map((entry) => ({
      slug: entry.slug,
      variant: entry.variant,
      taskId: entry.taskId,
      statistics: entry.statistics,
      cases: entry.cases,
    })),
    problems,
  };
}

function readSuite(
  file: string,
  fileName: string,
  ws: Workspace,
  problems: string[],
): SuiteEntry | null {
  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    problems.push(`${fileName}: unreadable`);
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
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
  return {
    slug: artifactSlug(fileName),
    variant: classifyVariant(fileName),
    taskId: asString(asRecord(root?.producedBy)?.taskId),
    statistics: normalizeStatistics(payload.statistics),
    cases: normalizeCases(payload.cases, fileName, ws, problems),
    fileName,
  };
}

function compareSuiteEntries(a: SuiteEntry, b: SuiteEntry): number {
  if (a.variant !== b.variant) return a.variant === 'canonical' ? -1 : 1;
  return a.fileName.localeCompare(b.fileName);
}

function normalizeStatistics(raw: unknown): SuiteStatistics | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const total = asNumber(record.total);
  const captured = asNumber(record.captured);
  const assertions = asNumber(record.assertions);
  const recordingLegacyDefects = asNumber(record.recordingLegacyDefects);
  if (
    total === null ||
    captured === null ||
    assertions === null ||
    recordingLegacyDefects === null
  ) {
    return null;
  }
  return { total, captured, assertions, recordingLegacyDefects };
}

function normalizeCases(
  raw: unknown,
  fileName: string,
  ws: Workspace,
  problems: string[],
): CaseView[] {
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: payload.cases is not an array`);
    return [];
  }
  const cases: CaseView[] = [];
  raw.forEach((item, index) => {
    const record = asRecord(item);
    const caseId = asString(record?.caseId);
    if (record === null || caseId === null) {
      problems.push(`${fileName}: dropped case ${index + 1}: missing caseId`);
      return;
    }
    cases.push({
      caseId,
      title: asString(record.title) ?? '',
      category: asString(record.category) ?? '',
      scenario: asString(asRecord(record.scenario)?.scenarioId),
      status: asString(record.status) ?? '',
      recordsLegacyDefect:
        typeof record.recordsLegacyDefect === 'boolean' ? record.recordsLegacyDefect : null,
      unexplainedVolatility: stringArray(record.unexplainedVolatility),
      targetRuleIds: stringArray(record.targetRuleIds),
      targetInvariantIds: stringArray(record.targetInvariantIds),
      assertions: normalizeAssertions(record.assertions, caseId, fileName, ws, problems),
    });
  });
  return cases;
}

function normalizeAssertions(
  raw: unknown,
  caseId: string,
  fileName: string,
  ws: Workspace,
  problems: string[],
): AssertionView[] {
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: case ${caseId} assertions is not an array`);
    return [];
  }
  const assertions: AssertionView[] = [];
  raw.forEach((item, index) => {
    const record = asRecord(item);
    const assertionId = asString(record?.assertionId);
    if (record === null || assertionId === null) {
      problems.push(
        `${fileName}: case ${caseId} dropped assertion ${index + 1}: missing assertionId`,
      );
      return;
    }
    assertions.push({
      assertionId,
      description: asString(record.description) ?? '',
      kind: asString(record.kind) ?? '',
      path: asString(record.path),
      expected: record.expected === undefined ? '' : renderObserved(record.expected, ws),
      normalized: typeof record.normalized === 'boolean' ? record.normalized : null,
      stepId: asString(record.stepId),
    });
  });
  return assertions;
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

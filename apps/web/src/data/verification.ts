import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { classifyVariant } from './artifacts';
import type { Variant } from './artifacts';
import type { Workspace } from './repo-root';
import { sanitizeForDisplay } from './sanitize';

export interface VerdictCheck {
  checkId: string;
  kind: string;
  status: string;
  required: boolean | null;
  description: string;
  observed: string;
  threshold: string | null;
}

export interface MismatchSummary {
  total: number;
  unexplained: number;
  unresolved: number;
  highestSeverity: string | null;
  bySeverity: Record<string, number>;
}

export interface VerdictView {
  iteration: number;
  variant: Variant;
  label: string;
  verdict: string;
  confidence: number | null;
  reasons: string[];
  mismatchSummary: MismatchSummary | null;
  checks: VerdictCheck[];
  taskId: string | null;
  computedAt: string | null;
}

export interface ComparisonView {
  scenarioId: string;
  scenarioTitle: string;
  category: string;
  outcome: string;
  equal: boolean | null;
  durationMs: number | null;
  normalizationApplied: number;
}

export interface ReportView {
  statistics: Record<string, unknown> | null;
  generatedAt: string | null;
  comparisons: ComparisonView[];
}

export interface IterationView {
  iteration: number;
  variant: Variant;
  verdict: VerdictView | null;
  report: ReportView | null;
}

export interface VerificationView {
  iterations: IterationView[];
  problems: string[];
}

const verdictFilePattern = /^verdict(-r\d+)?(-attempt-task_[0-9a-f]+)?\.json$/;
const reportFilePattern = /^differential-report(-r\d+)?(-attempt-task_[0-9a-f]+)?\.json$/;
const reportIterationPattern = /-r(\d+)(?:-attempt-task_[0-9a-f]+)?\.json$/;

interface CandidateFile {
  fileName: string;
  payload: Record<string, unknown>;
  taskId: string | null;
}

interface VerdictCandidate {
  fileName: string;
  view: VerdictView;
}

interface ReportCandidate {
  fileName: string;
  taskId: string | null;
  view: ReportView;
  variant: Variant;
  iteration: number;
}

interface IterationEntry extends IterationView {
  fileName: string;
}

export function loadVerifications(ws: Workspace, runId: string): VerificationView {
  const dir = path.join(ws.artifactsDir, runId, 'verification');
  if (!existsSync(dir)) {
    return { iterations: [], problems: ['verification directory missing'] };
  }
  const problems: string[] = [];
  const fileNames = readdirSync(dir)
    .filter((name) => verdictFilePattern.test(name) || reportFilePattern.test(name))
    .sort();
  const verdicts: VerdictCandidate[] = [];
  const reports: ReportCandidate[] = [];
  for (const fileName of fileNames) {
    const candidate = readCandidate(path.join(dir, fileName), fileName, problems);
    if (candidate === null) continue;
    if (verdictFilePattern.test(fileName)) {
      const view = normalizeVerdict(candidate, fileName, ws, problems);
      if (view !== null) verdicts.push({ fileName, view });
    } else {
      reports.push(normalizeReport(candidate, fileName, problems));
    }
  }
  return { iterations: buildIterations(verdicts, reports), problems };
}

function readCandidate(file: string, fileName: string, problems: string[]): CandidateFile | null {
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
  return { fileName, payload, taskId: asString(asRecord(root?.producedBy)?.taskId) };
}

function normalizeVerdict(
  candidate: CandidateFile,
  fileName: string,
  ws: Workspace,
  problems: string[],
): VerdictView | null {
  const iteration = asNumber(candidate.payload.repairIteration);
  if (iteration === null) {
    problems.push(`${fileName}: missing repairIteration`);
    return null;
  }
  const verdict = asString(candidate.payload.verdict);
  if (verdict === null) {
    problems.push(`${fileName}: missing verdict`);
    return null;
  }
  const variant = classifyVariant(fileName);
  const taskId = candidate.taskId;
  return {
    iteration,
    variant,
    label:
      variant === 'attempt' ? (taskId === null ? 'attempt' : `attempt ${taskId}`) : 'canonical',
    verdict,
    confidence: asNumber(candidate.payload.confidence),
    reasons: stringArray(candidate.payload.reasons),
    mismatchSummary: normalizeMismatchSummary(candidate.payload.mismatchSummary),
    checks: normalizeChecks(candidate.payload.checks, fileName, ws, problems),
    taskId,
    computedAt: asString(candidate.payload.computedAt),
  };
}

function normalizeMismatchSummary(raw: unknown): MismatchSummary | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const total = asNumber(record.total);
  const unexplained = asNumber(record.unexplained);
  const unresolved = asNumber(record.unresolved);
  if (total === null || unexplained === null || unresolved === null) return null;
  const bySeverity: Record<string, number> = {};
  const contents = asRecord(record.bySeverity);
  if (contents !== null) {
    for (const [key, value] of Object.entries(contents)) {
      const count = asNumber(value);
      if (count !== null) bySeverity[key] = count;
    }
  }
  return {
    total,
    unexplained,
    unresolved,
    highestSeverity: asString(record.highestSeverity),
    bySeverity,
  };
}

function normalizeChecks(
  raw: unknown,
  fileName: string,
  ws: Workspace,
  problems: string[],
): VerdictCheck[] {
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: payload.checks is not an array`);
    return [];
  }
  const out: VerdictCheck[] = [];
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item);
    const checkId = record === null ? null : asString(record.checkId);
    const status = record === null ? null : asString(record.status);
    if (record === null || checkId === null || status === null) {
      problems.push(`${fileName}: dropped check ${index + 1}: missing checkId or status`);
      continue;
    }
    out.push({
      checkId,
      status,
      kind: asString(record.kind) ?? '',
      description: asString(record.description) ?? '',
      required: typeof record.required === 'boolean' ? record.required : null,
      observed: record.observed === undefined ? '' : renderObserved(record.observed, ws),
      threshold:
        record.threshold === undefined || record.threshold === null
          ? null
          : renderObserved(record.threshold, ws),
    });
  }
  return out;
}

export function renderObserved(value: unknown, ws: Workspace): string {
  if (typeof value === 'string') return sanitizeForDisplay(value, ws);
  if (typeof value === 'object' && value !== null) {
    return sanitizeForDisplay(JSON.stringify(value) ?? '', ws);
  }
  return sanitizeForDisplay(String(value), ws);
}

function normalizeReport(
  candidate: CandidateFile,
  fileName: string,
  problems: string[],
): ReportCandidate {
  return {
    fileName,
    taskId: candidate.taskId,
    variant: classifyVariant(fileName),
    iteration: iterationFromFileName(fileName),
    view: {
      statistics: asRecord(candidate.payload.statistics),
      generatedAt: asString(candidate.payload.generatedAt),
      comparisons: normalizeComparisons(candidate.payload.comparisons, fileName, problems),
    },
  };
}

function normalizeComparisons(
  raw: unknown,
  fileName: string,
  problems: string[],
): ComparisonView[] {
  if (!Array.isArray(raw)) {
    problems.push(`${fileName}: payload.comparisons is not an array`);
    return [];
  }
  const out: ComparisonView[] = [];
  for (const [index, item] of raw.entries()) {
    const record = asRecord(item);
    const scenarioId = record === null ? null : asString(record.scenarioId);
    if (record === null || scenarioId === null) {
      problems.push(`${fileName}: dropped comparison ${index + 1}: missing scenarioId`);
      continue;
    }
    out.push({
      scenarioId,
      scenarioTitle: asString(record.scenarioTitle) ?? '',
      category: asString(record.category) ?? '',
      outcome: asString(record.outcome) ?? '',
      equal: typeof record.equal === 'boolean' ? record.equal : null,
      durationMs: asNumber(record.durationMs),
      normalizationApplied: Array.isArray(record.normalizationApplied)
        ? record.normalizationApplied.length
        : 0,
    });
  }
  return out;
}

function iterationFromFileName(fileName: string): number {
  const match = reportIterationPattern.exec(fileName);
  const digits = match?.[1];
  return digits === undefined ? 0 : Number(digits);
}

function buildIterations(
  verdicts: VerdictCandidate[],
  reports: ReportCandidate[],
): IterationView[] {
  const entries: IterationEntry[] = [];
  const consumed = new Set<string>();
  for (const verdict of verdicts) {
    let report: ReportView | null = null;
    if (verdict.view.taskId !== null) {
      for (const candidate of reports) {
        if (!consumed.has(candidate.fileName) && candidate.taskId === verdict.view.taskId) {
          consumed.add(candidate.fileName);
          report = candidate.view;
          break;
        }
      }
    }
    entries.push({
      iteration: verdict.view.iteration,
      variant: verdict.view.variant,
      verdict: verdict.view,
      report,
      fileName: verdict.fileName,
    });
  }
  for (const candidate of reports) {
    if (consumed.has(candidate.fileName)) continue;
    entries.push({
      iteration: candidate.iteration,
      variant: candidate.variant,
      verdict: null,
      report: candidate.view,
      fileName: candidate.fileName,
    });
  }
  entries.sort(compareEntries);
  return entries.map(({ iteration, variant, verdict, report }) => ({
    iteration,
    variant,
    verdict,
    report,
  }));
}

function compareEntries(a: IterationEntry, b: IterationEntry): number {
  if (a.iteration !== b.iteration) return a.iteration - b.iteration;
  if (a.variant !== b.variant) return a.variant === 'canonical' ? -1 : 1;
  if (a.fileName === b.fileName) return 0;
  return a.fileName < b.fileName ? -1 : 1;
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

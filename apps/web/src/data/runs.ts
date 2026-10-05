import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './repo-root.js';

export interface VerdictSummary {
  iteration: number;
  verdict: string;
  mismatchTotal: number;
}

export interface RunSummary {
  runId: string;
  artifactCount: number;
  eventCount: number;
  firstEventAt: string | null;
  lastEventAt: string | null;
  writerSessions: number;
  stages: string[];
  taskCount: number;
  latestVerdict: VerdictSummary | null;
  problems: string[];
}

interface ScannedEvent {
  seq: number | null;
  at: string | null;
  stage: string | null;
  taskId: string | null;
}

interface VerdictCandidate extends VerdictSummary {
  fileName: string;
  attempt: boolean;
}

export function scanRuns(ws: Workspace): RunSummary[] {
  if (!existsSync(ws.artifactsDir)) return [];
  const runIds = readdirSync(ws.artifactsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => entry.name);
  const runs: RunSummary[] = [];
  for (const runId of runIds) {
    const runDir = path.join(ws.artifactsDir, runId);
    const hasIndex = existsSync(path.join(runDir, 'index.json'));
    const hasEvents = existsSync(path.join(runDir, 'run', 'events.jsonl'));
    if (!hasIndex && !hasEvents) continue;
    runs.push(summarizeRun(runId, runDir));
  }
  return runs.sort(compareRuns);
}

export function featuredRun(runs: RunSummary[]): RunSummary | null {
  return runs[0] ?? null;
}

export function assertFeaturedIntact(run: RunSummary | null): void {
  if (run === null || run.problems.length === 0) return;
  throw new Error(`featured run ${run.runId} has integrity problems: ${run.problems.join('; ')}`);
}

function compareRuns(a: RunSummary, b: RunSummary): number {
  if (a.lastEventAt !== b.lastEventAt) {
    if (a.lastEventAt === null) return 1;
    if (b.lastEventAt === null) return -1;
    return a.lastEventAt < b.lastEventAt ? 1 : -1;
  }
  if (a.runId === b.runId) return 0;
  return a.runId < b.runId ? -1 : 1;
}

function summarizeRun(runId: string, runDir: string): RunSummary {
  const problems: string[] = [];

  const index = readJson(path.join(runDir, 'index.json'));
  const artifactCount = Array.isArray(index) ? index.length : -1;
  if (artifactCount === -1) problems.push('index.json missing or unreadable');

  const eventsFile = path.join(runDir, 'run', 'events.jsonl');
  const events: ScannedEvent[] = [];
  if (existsSync(eventsFile)) {
    let corrupt = 0;
    for (const line of readFileSync(eventsFile, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        corrupt += 1;
        continue;
      }
      const record = asRecord(parsed);
      if (record === null) {
        corrupt += 1;
        continue;
      }
      events.push({
        seq: typeof record.seq === 'number' ? record.seq : null,
        at: typeof record.at === 'string' ? record.at : null,
        stage: typeof record.stage === 'string' ? record.stage : null,
        taskId: typeof record.taskId === 'string' ? record.taskId : null,
      });
    }
    if (corrupt > 0) problems.push('events.jsonl has unparseable lines');
  } else {
    problems.push('events.jsonl missing');
  }

  let firstEventAt: string | null = null;
  let lastEventAt: string | null = null;
  const stages: string[] = [];
  const taskIds = new Set<string>();
  let writerSessions = 0;
  let previousSeq: number | null = null;
  for (const item of events) {
    if (item.at !== null) {
      if (firstEventAt === null) firstEventAt = item.at;
      lastEventAt = item.at;
    }
    if (item.stage !== null && !stages.includes(item.stage)) stages.push(item.stage);
    if (item.taskId !== null) taskIds.add(item.taskId);
    if (item.seq !== null) {
      if (previousSeq === null || item.seq <= previousSeq) writerSessions += 1;
      previousSeq = item.seq;
    }
  }

  const latestVerdict = readLatestVerdict(runDir, problems);

  return {
    runId,
    artifactCount,
    eventCount: events.length,
    firstEventAt,
    lastEventAt,
    writerSessions,
    stages,
    taskCount: taskIds.size,
    latestVerdict,
    problems,
  };
}

function readLatestVerdict(runDir: string, problems: string[]): VerdictSummary | null {
  const dir = path.join(runDir, 'verification');
  if (!existsSync(dir)) return null;
  const fileNames = readdirSync(dir)
    .filter((name) => name.startsWith('verdict') && name.endsWith('.json'))
    .sort();
  const candidates: VerdictCandidate[] = [];
  for (const fileName of fileNames) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path.join(dir, fileName), 'utf8'));
    } catch {
      problems.push(`unparseable verdict file ${fileName}`);
      continue;
    }
    const payload = asRecord(asRecord(parsed)?.payload);
    const iteration = payload?.repairIteration;
    const verdict = payload?.verdict;
    const mismatchTotal = asRecord(payload?.mismatchSummary)?.total;
    if (
      typeof iteration !== 'number' ||
      typeof verdict !== 'string' ||
      typeof mismatchTotal !== 'number'
    ) {
      continue;
    }
    candidates.push({
      iteration,
      verdict,
      mismatchTotal,
      fileName,
      attempt: fileName.includes('attempt'),
    });
  }
  if (candidates.length === 0) return null;
  const best = candidates.reduce((winner, candidate) =>
    compareVerdictCandidates(candidate, winner) < 0 ? candidate : winner,
  );
  return { iteration: best.iteration, verdict: best.verdict, mismatchTotal: best.mismatchTotal };
}

function compareVerdictCandidates(a: VerdictCandidate, b: VerdictCandidate): number {
  if (a.iteration !== b.iteration) return b.iteration - a.iteration;
  if (a.attempt !== b.attempt) return a.attempt ? 1 : -1;
  if (a.fileName === b.fileName) return 0;
  return a.fileName < b.fileName ? -1 : 1;
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

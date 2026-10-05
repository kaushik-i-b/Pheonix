import { spawn, type ChildProcess } from 'node:child_process';
import {
  PhoenixError,
  differentialReportSchema,
  newTaskId,
  verificationVerdictSchema,
  type ArtifactId,
  type CharacterizationSuite,
  type DifferentialComparison,
  type DifferentialReport,
  type GeneratedArtifact,
  type Mismatch,
  type RunId,
  type StepOutcome,
  type TaskId,
  type VerificationCheck,
  type VerificationVerdict,
} from '@phoenix/shared';
import { executeScenario, type ScenarioTarget } from '@phoenix/characterization';
import { slugAvoidingCollision } from '../slug.js';
import {
  buildDifferentialReport,
  clipTo,
  compareSuite,
  computeDifferentialVerdict,
  renderValue,
  type ModernExecution,
  type UnjudgeableCase,
} from '@phoenix/differential-testing';
import { createArtifactWriter } from '@phoenix/agent-runtime';
import type { RunRuntime } from '../runtime.js';
import type { ModernizationChangeReport } from './modernization-schema.js';

/**
 * DIFFERENTIAL VERIFY.
 *
 * Deterministic host code, no model: the generated modern system is started, every comparable
 * scenario from the captured suite is executed against it, and the recorded behavior is compared
 * with the legacy baselines. The verdict is arithmetic over those comparisons — an LLM may explain
 * a mismatch, but it never decides one.
 *
 * The legacy side is not re-executed: the suite *is* the recorded contract. What the modern system
 * produced here is kept in full inside the report, so a later repair iteration, the diagnoser and
 * the release guardian all read the same recorded truth.
 */

export const VERIFICATION_ROLE = 'differential-verifier';
export const VERIFICATION_GENERATOR = '@phoenix/orchestrator/stages/verification';

const HEALTH_POLL_INTERVAL_MS = 250;
const HEALTH_REQUEST_TIMEOUT_MS = 3_000;
const RESET_TIMEOUT_MS = 10_000;
const STOP_GRACE_MS = 5_000;
const KILL_GRACE_MS = 2_000;
const LOG_TAIL_CHARS = 8_000;
const DETAIL_LIMIT = 4_000;

export interface VerificationStageOptions {
  runId: RunId;
  runtime: RunRuntime;
  suite: CharacterizationSuite;
  suiteArtifactId?: ArtifactId;
  /** The implementation under test; its `resetPath` restores a clean startup condition. */
  changeReport: ModernizationChangeReport;
  changeReportArtifactId?: ArtifactId;
  /** Invariants whose ids make any mismatch touching them CRITICAL in the comparison layer. */
  criticalInvariantIds?: readonly string[];
  repairIteration?: number;
  /**
   * Connect to an already-running modern system instead of starting one. Tests use this to run the
   * whole verification path — execute, compare, verdict — against an in-process server.
   */
  target?: ScenarioTarget;
  taskId?: TaskId;
  onStep?: (outcome: StepOutcome) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface VerificationOutcome {
  report: DifferentialReport;
  verdict: VerificationVerdict;
  reportArtifact: GeneratedArtifact;
  verdictArtifact: GeneratedArtifact;
  comparisons: DifferentialComparison[];
  mismatches: Mismatch[];
  unjudgeable: UnjudgeableCase[];
  /** Cases executed against the modern system, in execution order. */
  executedCaseIds: string[];
  /** Cases the suite marked as not comparable, so they were never executed. */
  skippedCaseIds: string[];
  resetFailures: string[];
  modern: {
    label: string;
    baseUrl: string;
    started: boolean;
    readyMs?: number;
    /** Why the modern system never became usable, when it did not. */
    startupError?: string;
  };
  /** Tail of the modern process output, kept for startup-failure evidence. */
  processOutput: string;
}

export async function runVerificationStage(options: VerificationStageOptions): Promise<VerificationOutcome> {
  const { runtime, runId, suite, changeReport } = options;
  const repairIteration = options.repairIteration ?? 0;
  const comparables = suite.cases.filter(
    (item) => item.status === 'passing-against-legacy' && item.captureExecutionId !== undefined,
  );
  const skippedCaseIds = suite.cases
    .filter((item) => !comparables.includes(item))
    .map((item) => item.caseId);

  const launch =
    options.target === undefined
      ? await launchModern(runtime, changeReport.resetPath, options.signal)
      : undefined;
  const target: ScenarioTarget =
    options.target ??
    (launch !== undefined && launch.running !== undefined
      ? launch.running.target
      : {
          // Startup failed: nothing will be executed, but the target still names the system so the
          // report says plainly which one could not be reached.
          system: 'modern',
          label: runtime.config.modern.label,
          baseUrl: runtime.config.modern.baseUrl ?? 'http://unreachable.invalid',
        });
  const baseUrl = target.baseUrl;
  const started = options.target !== undefined || launch?.running !== undefined;
  const startupError = launch?.startupError;
  const processOutput = launch?.tail() ?? '';

  const executedCaseIds: string[] = [];
  const modernExecutions: ModernExecution[] = [];
  const resetFailures: string[] = [];
  try {
    if (started) {
      for (const item of comparables) {
        if (options.signal?.aborted) break;
        // Reset first: every case should meet the same clean startup condition the next repair
        // iteration will meet. A reset that fails is recorded, not excused — the verdict layer
        // turns it into a required check.
        const resetError = await postReset(new URL(changeReport.resetPath, baseUrl), options.signal);
        if (resetError !== undefined) resetFailures.push(`${item.caseId}: ${resetError}`);
        const execution = await executeScenario(item.scenario, target, {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          ...(options.onStep !== undefined ? { onStep: options.onStep } : {}),
        });
        modernExecutions.push({ caseId: item.caseId, execution });
        executedCaseIds.push(item.caseId);
        runtime.events.next(runId, 'test.executed', {
          suiteId: 'characterization',
          caseId: item.caseId,
          target: 'modern',
          passed: execution.status === 'completed',
          durationMs: execution.durationMs,
          recordedBehavior: false,
          ...(execution.error !== undefined ? { message: execution.error } : {}),
        });
      }
    }
  } finally {
    await launch?.running?.stop();
  }

  const comparison = compareSuite({
    suite,
    modernExecutions,
    ...(options.suiteArtifactId !== undefined ? { suiteArtifactId: options.suiteArtifactId } : {}),
    ...(options.criticalInvariantIds !== undefined
      ? { criticalInvariantIds: options.criticalInvariantIds }
      : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const checks = buildChecks({
    started,
    ...(startupError !== undefined ? { startupError } : {}),
    readyMs: launch?.running?.readyMs,
    overridden: options.target !== undefined,
    resetAttempted: started && comparables.length > 0,
    resetFailures,
    processOutput,
  });

  const verdict = computeDifferentialVerdict({
    runId,
    comparisons: comparison.comparisons,
    mismatches: comparison.mismatches,
    legacySelfCheckFailures: comparison.legacySelfCheckFailures,
    repairIteration,
    inputArtifactIds: [
      ...(options.suiteArtifactId !== undefined ? [options.suiteArtifactId] : []),
      ...(options.changeReportArtifactId !== undefined ? [options.changeReportArtifactId] : []),
    ],
    additionalChecks: checks,
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const report = buildDifferentialReport({
    runId,
    comparisons: comparison.comparisons,
    mismatches: comparison.mismatches,
    summary: summarize({
      label: target.label,
      baseUrl,
      started,
      ...(startupError !== undefined ? { startupError } : {}),
      readyMs: launch?.running?.readyMs,
      overridden: options.target !== undefined,
      comparable: comparables.length,
      skipped: skippedCaseIds.length,
      executed: executedCaseIds.length,
      resetFailures,
    }),
    ...(options.now !== undefined ? { now: options.now } : {}),
  });

  const taskId = options.taskId ?? newTaskId();
  const writer = createArtifactWriter({
    store: runtime.artifacts,
    events: runtime.events,
    run: { runId, stage: 'VERIFICATION', role: VERIFICATION_ROLE, taskId },
    generator: VERIFICATION_GENERATOR,
    inputs: [
      ...(options.suiteArtifactId !== undefined
        ? [{ artifactId: options.suiteArtifactId, kind: 'characterization.suite' as const, role: 'input' as const }]
        : []),
      ...(options.changeReportArtifactId !== undefined
        ? [
            {
              artifactId: options.changeReportArtifactId,
              kind: 'implementation.change-report' as const,
              role: 'input' as const,
            },
          ]
        : []),
    ],
  });
  const repairSuffix = repairIteration > 0 ? `-r${repairIteration}` : '';
  const reportSlug = slugAvoidingCollision(
    runtime.artifacts,
    runId,
    'verification.differential-report',
    repairSuffix === '' ? undefined : `differential-report${repairSuffix}`,
    taskId,
  );
  const verdictSlug = slugAvoidingCollision(
    runtime.artifacts,
    runId,
    'verification.verdict',
    repairSuffix === '' ? undefined : `verdict${repairSuffix}`,
    taskId,
  );
  const reportArtifact = writer.writeJson('verification.differential-report', report, differentialReportSchema, {
    ...(reportSlug === undefined ? {} : { slug: reportSlug }),
    title: `${report.statistics.equal}/${report.statistics.scenarios} equivalent, ${report.statistics.mismatches} mismatch(es)`,
    tags: ['verification', 'differential', `iteration-${repairIteration}`],
  });
  const verdictArtifact = writer.writeJson('verification.verdict', verdict, verificationVerdictSchema, {
    ...(verdictSlug === undefined ? {} : { slug: verdictSlug }),
    title: `differential verdict: ${verdict.verdict} (iteration ${repairIteration})`,
    tags: ['verification', 'verdict', verdict.verdict.toLowerCase()],
  });

  runtime.events.next(runId, 'verification.result', {
    stage: 'VERIFICATION',
    role: VERIFICATION_ROLE,
    verdict: verdict.verdict,
    scenariosExecuted: executedCaseIds.length,
    mismatches: comparison.mismatches.length,
    criticalInvariantFailures: comparison.mismatches.filter((entry) => entry.severity === 'CRITICAL').length,
    highestSeverity: verdict.mismatchSummary.highestSeverity,
  });
  for (const mismatch of comparison.mismatches) {
    runtime.events.next(runId, 'failure.discovered', {
      stage: 'VERIFICATION',
      role: VERIFICATION_ROLE,
      failureId: mismatch.mismatchId,
      kind: 'behavioral-mismatch',
      severity: mismatch.severity,
      summary: clipTo(
        `${mismatch.title} — ${mismatch.path}: legacy ${renderValue(mismatch.legacyValue)} vs modern ${renderValue(
          mismatch.modernValue,
        )} (${mismatch.scenarioId})`,
        4_000,
      ),
      evidenceRefs: mismatch.evidence.map((ref) => ref.artifactId ?? ref.id),
    });
  }

  return {
    report,
    verdict,
    reportArtifact,
    verdictArtifact,
    comparisons: comparison.comparisons,
    mismatches: comparison.mismatches,
    unjudgeable: comparison.unjudgeable,
    executedCaseIds,
    skippedCaseIds,
    resetFailures,
    modern: {
      label: target.label,
      baseUrl,
      started,
      ...(launch?.running !== undefined ? { readyMs: launch.running.readyMs } : {}),
      ...(startupError !== undefined ? { startupError } : {}),
    },
    processOutput,
  };
}

interface BuildChecksInput {
  started: boolean;
  startupError?: string;
  readyMs?: number;
  overridden: boolean;
  resetAttempted: boolean;
  resetFailures: readonly string[];
  processOutput: string;
}

function buildChecks(input: BuildChecksInput): VerificationCheck[] {
  const checks: VerificationCheck[] = [];
  if (input.started) {
    checks.push({
      checkId: 'modern-startup',
      kind: 'modern-implementation-builds',
      description:
        'The modern system becomes usable: its start command launches and its health endpoint answers HTTP 200 within the ready timeout.',
      status: 'PASS',
      required: true,
      observed: input.overridden ? { target: 'provided by the caller' } : { readyMs: input.readyMs },
      relatedRuleIds: [],
      relatedInvariantIds: [],
      evidence: [],
    });
  } else {
    checks.push({
      checkId: 'modern-startup',
      kind: 'modern-implementation-builds',
      description:
        'The modern system becomes usable: its start command launches and its health endpoint answers HTTP 200 within the ready timeout.',
      status: 'FAIL',
      required: true,
      detail: clipTo(`${input.startupError ?? 'the modern system never became ready'}\n${input.processOutput}`, DETAIL_LIMIT),
      observed: { startupError: input.startupError ?? 'unknown' },
      relatedRuleIds: [],
      relatedInvariantIds: [],
      evidence: [],
    });
  }
  if (input.resetAttempted) {
    checks.push({
      checkId: 'modern-reset',
      kind: 'modern-implementation-builds',
      description:
        'The declared reset path returns every piece of state to a clean startup condition before each scenario.',
      status: input.resetFailures.length > 0 ? 'FAIL' : 'PASS',
      required: true,
      observed: { failures: input.resetFailures.length },
      relatedRuleIds: [],
      relatedInvariantIds: [],
      evidence: [],
      ...(input.resetFailures.length > 0
        ? { detail: clipTo(input.resetFailures.join('; '), DETAIL_LIMIT) }
        : {}),
    });
  }
  return checks;
}

interface SummarizeInput {
  label: string;
  baseUrl: string;
  started: boolean;
  startupError?: string;
  readyMs?: number;
  overridden: boolean;
  comparable: number;
  skipped: number;
  executed: number;
  resetFailures: readonly string[];
}

function summarize(input: SummarizeInput): string {
  const lines: string[] = [];
  if (input.started) {
    lines.push(
      input.overridden
        ? `Modern system "${input.label}" at ${input.baseUrl} was provided by the caller.`
        : `Modern system "${input.label}" at ${input.baseUrl} became ready in ${input.readyMs ?? 0}ms.`,
    );
  } else {
    lines.push(
      `Modern system "${input.label}" at ${input.baseUrl} could not be started: ${input.startupError ?? 'unknown error'}`,
    );
  }
  lines.push(
    `${input.executed} of ${input.comparable} comparable scenario(s) were executed against the modern system; ` +
      `${input.skipped} case(s) were skipped because their legacy baseline was not comparable.`,
  );
  if (input.resetFailures.length > 0) {
    lines.push(`The reset path failed before ${input.resetFailures.length} case(s): ${input.resetFailures.join('; ')}`);
  }
  return lines.join('\n');
}

interface RunningModern {
  target: ScenarioTarget;
  readyMs: number;
  stop: () => Promise<void>;
}

interface LaunchResult {
  running?: RunningModern;
  startupError?: string;
  /** Tail of the process output so far; still valid after stop for failure evidence. */
  tail: () => string;
}

async function launchModern(
  runtime: RunRuntime,
  resetPath: string,
  signal?: AbortSignal,
): Promise<LaunchResult> {
  const target = runtime.config.modern;
  if (target.baseUrl === undefined) {
    throw new PhoenixError(
      'CONFIG_INVALID',
      `the modern target "${target.label}" has no baseUrl; differential verification needs an address to call`,
      { label: target.label },
    );
  }
  if (target.startCommand === undefined) {
    throw new PhoenixError(
      'CONFIG_INVALID',
      `the modern target "${target.label}" has no startCommand; Phoenix cannot start the generated system to verify it`,
      { label: target.label },
    );
  }
  const argv = target.startCommand.trim().split(/\s+/);
  const command = argv[0];
  if (command === undefined || command === '') {
    throw new PhoenixError('CONFIG_INVALID', 'the modern startCommand is empty', {});
  }

  const log = createTail(LOG_TAIL_CHARS);
  let spawnError: Error | undefined;
  let child: ChildProcess;
  try {
    child = spawn(command, argv.slice(1), {
      cwd: runtime.paths.modernRoot,
      env: {
        ...process.env,
        ...(target.port !== undefined ? { PORT: String(target.port) } : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // Its own process group: stopping the launcher must also stop whatever it spawned, or the
      // port stays occupied and the next repair iteration fails for the wrong reason.
      detached: true,
    });
  } catch (error) {
    return { startupError: `the modern start command could not be launched: ${describe(error)}`, tail: log.tail };
  }
  child.on('error', (error) => {
    spawnError = error;
  });
  child.stdout?.on('data', (chunk: Buffer) => log.append(chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => log.append(chunk.toString('utf8')));

  const startedAtMs = Date.now();
  const deadline = startedAtMs + target.readyTimeoutMs;
  let readyMs: number | undefined;
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      await stopChild(child);
      return { startupError: 'aborted while waiting for the modern system to become ready', tail: log.tail };
    }
    if (spawnError !== undefined) {
      await stopChild(child);
      return { startupError: `the modern start command failed: ${describe(spawnError)}`, tail: log.tail };
    }
    if (child.exitCode !== null || child.signalCode !== null) {
      return {
        startupError: `the modern system exited (${describeExit(child)}) before answering its health endpoint:\n${log.tail()}`,
        tail: log.tail,
      };
    }
    try {
      const response = await fetch(new URL(target.healthPath, target.baseUrl), {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      await response.text().catch(() => '');
      if (response.status === 200) {
        readyMs = Date.now() - startedAtMs;
        break;
      }
    } catch {
      // Not up yet; the deadline below is the real limit.
    }
    await sleep(HEALTH_POLL_INTERVAL_MS);
  }

  if (readyMs === undefined) {
    await stopChild(child);
    return {
      startupError:
        `the modern system did not answer GET ${target.healthPath} with HTTP 200 within ` +
        `${target.readyTimeoutMs}ms:\n${log.tail()}`,
      tail: log.tail,
    };
  }

  return {
    running: {
      readyMs,
      target: {
        system: 'modern',
        label: target.label,
        baseUrl: target.baseUrl,
        reset: async () => {
          const error = await postReset(new URL(resetPath, target.baseUrl as string), signal);
          if (error !== undefined) throw new PhoenixError('SCENARIO_EXECUTION_FAILED', error, {});
        },
      },
      stop: () => stopChild(child),
    },
    tail: log.tail,
  };
}

async function postReset(url: URL, signal?: AbortSignal): Promise<string | undefined> {
  const abort =
    signal === undefined
      ? AbortSignal.timeout(RESET_TIMEOUT_MS)
      : AbortSignal.any([AbortSignal.timeout(RESET_TIMEOUT_MS), signal]);
  try {
    const response = await fetch(url, { method: 'POST', signal: abort });
    await response.text().catch(() => '');
    if (response.status < 200 || response.status >= 300) {
      return `POST ${url.pathname} returned HTTP ${response.status}`;
    }
    return undefined;
  } catch (error) {
    return `POST ${url.pathname} failed: ${describe(error)}`;
  }
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  signalTree(child, 'SIGTERM');
  if (await waitForExit(child, STOP_GRACE_MS)) return;
  signalTree(child, 'SIGKILL');
  await waitForExit(child, KILL_GRACE_MS);
}

function signalTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  try {
    // Negative pid targets the whole process group; run.sh and tsx may sit between us and node.
    process.kill(-pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Already gone between the exit check and the kill: nothing left to stop.
    }
  }
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.removeListener('exit', onExit);
      resolve(false);
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve(true);
    };
    child.once('exit', onExit);
  });
}

function describeExit(child: ChildProcess): string {
  if (child.signalCode !== null) return `signal ${child.signalCode}`;
  if (child.exitCode !== null) return `exit code ${child.exitCode}`;
  return 'still running';
}

function createTail(limit: number): { append: (chunk: string) => void; tail: () => string } {
  let text = '';
  return {
    append: (chunk) => {
      text = `${text}${chunk}`;
      if (text.length > limit) text = text.slice(text.length - limit);
    },
    tail: () => text,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

import { resolve } from 'node:path';
import { FileArtifactStore } from '@phoenix/artifact-store';
import { loadConfig } from '@phoenix/config';
import { clipTo, describeDifferentialReport } from '@phoenix/differential-testing';
import {
  MODERNIZATION_ROLE,
  createRunRuntime,
  runModernizationLoop,
  type ModernizationLoopResult,
  type ModernizationLoopRound,
  type RepairDiagnosis,
} from '@phoenix/orchestrator';
import {
  PhoenixError,
  businessRuleSetSchema,
  characterizationSuiteSchema,
  invariantSetSchema,
  type GeneratedArtifact,
  type RunId,
} from '@phoenix/shared';
import { readLatest, requireExplicitRunId, requireSuccessfulPredecessor } from './runs.js';

/**
 * `phoenix modernize` — MODERNIZE → VERIFY → DIAGNOSE → REPAIR → RE-VERIFY.
 *
 * The loop that makes the result trustworthy: the first modern implementation is judged by running
 * the captured characterization scenarios against it, every divergence is handed back to the
 * Modernizer as a diagnosis brief built from those observations, and the repair is accepted only
 * when the same harness says EQUIVALENT. Phoenix exits non-zero unless the final verdict is
 * EQUIVALENT — a run that ends with open mismatches has not modernized anything.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');
const CHECK_DETAIL_LIMIT = 400;
const DIAGNOSIS_PATH_LIMIT = 500;

interface Options {
  runId?: string;
  maxSteps?: number;
  maxRepairs?: number;
  json: boolean;
}

export const MODERNIZE_USAGE = [
  'usage: phoenix modernize --run-id <id> [--max-steps <n>] [--max-repairs <n>] [--json]',
  '',
  '  --run-id              required run whose successful characterization will be modernized',
  '  --max-steps           cap on model round-trips per modernization attempt',
  '  --max-repairs         cap on repair iterations after the first implementation (default: the configured run limit)',
  '  --json                print the machine-readable outcome instead of the summary',
].join('\n');

export async function modernizeCommand(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const runId = requireExplicitRunId(options.runId, 'phoenix modernize', MODERNIZE_USAGE);
  const { config } = loadConfig({ cwd: REPO_ROOT });
  const store = new FileArtifactStore(config.paths.artifactRoot);
  requireSuccessfulPredecessor(store, runId, 'CHARACTERIZATION', ['characterization.suite']);
  const { payload: rules } = readLatest(store, runId, 'specification.business-rules', businessRuleSetSchema);
  const { payload: invariants } = readLatest(store, runId, 'specification.invariants', invariantSetSchema);
  const { meta: suiteMeta, payload: suite } = readLatest(store, runId, 'characterization.suite', characterizationSuiteSchema);

  const runtime = createRunRuntime({ config, runId });
  try {
    const result = await runModernizationLoop({
      runId,
      runtime,
      rules,
      invariants,
      suite,
      suiteArtifactId: suiteMeta.id,
      inputArtifacts: loopInputs(store, runId),
      ...(options.maxSteps !== undefined ? { budget: { maxSteps: options.maxSteps } } : {}),
      ...(options.maxRepairs !== undefined ? { maxRepairIterations: options.maxRepairs } : {}),
    });

    if (options.json) {
      process.stdout.write(`${JSON.stringify(buildJsonOutcome(runId, result), null, 2)}\n`);
      return exitCodeFor(result);
    }

    const comparable = suite.cases.filter(
      (item) => item.status === 'passing-against-legacy' && item.captureExecutionId !== undefined,
    ).length;
    const lines: string[] = [
      `run ${runId} — MODERNIZATION LOOP / ${MODERNIZATION_ROLE} → differential-verifier`,
      `target       ${config.modern.label} (${config.modern.baseUrl ?? 'no baseUrl'}) — start command: ${config.modern.startCommand ?? 'none'}`,
      `upstream     ${rules.rules.length} rule(s), ${invariants.invariants.length} invariant(s), ${suite.cases.length} case(s) in the suite (${comparable} comparable)`,
      '',
    ];

    for (const round of result.rounds) {
      lines.push(...roundLines(round));
    }

    lines.push('');
    const verdict = result.finalVerification?.verdict.verdict ?? 'NO_VERDICT';
    lines.push(
      `result       ${verdict} — stop reason: ${result.stopReason}, ${result.repairIterations} repair iteration(s), ` +
        `${result.unresolvedMismatchIds.length} unresolved mismatch(es)`,
    );
    for (const artifact of collectArtifacts(result)) {
      lines.push(`artifact     ${artifact.relativePath}  (${artifact.artifactId})`);
    }
    lines.push(`events       ${resolve(config.paths.artifactRoot, runId, 'run', 'events.jsonl')}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return exitCodeFor(result);
  } finally {
    await runtime.close();
  }
}

function exitCodeFor(result: ModernizationLoopResult): number {
  return result.finalVerification?.verdict.verdict === 'EQUIVALENT' ? 0 : 1;
}

function roundLines(round: ModernizationLoopRound): string[] {
  const lines: string[] = [];
  if (round.iteration > 0 && round.diagnosis !== undefined) {
    lines.push(diagnosisLine(round.diagnosis));
    lines.push(`[REPAIR]    Modernizer patching implementation... (iteration ${round.iteration})`);
  }
  lines.push(...modernizationLines(round));
  if (round.verification !== undefined) {
    lines.push(...verificationLines(round));
  } else {
    lines.push('[VERIFY]    not run — the Modernizer produced nothing usable this round');
  }
  return lines;
}

function diagnosisLine(diagnosis: RepairDiagnosis): string {
  return diagnosis.evidencePaths.length > 0
    ? `[DIAGNOSE]  Relevant legacy evidence located — ${clipTo(diagnosis.evidencePaths.join(', '), DIAGNOSIS_PATH_LIMIT)}`
    : '[DIAGNOSE]  No legacy source locations were recorded for the targeted claims; the brief carries the observed values and rule statements.';
}

function modernizationLines(round: ModernizationLoopRound): string[] {
  const { modernization } = round;
  const { result, report } = modernization;
  const acceptance = `${result.acceptance.filter((item) => item.satisfied).length}/${result.acceptance.length}`;
  const stats =
    `${result.status}, ${result.llmCalls} model call(s), ${result.toolCalls} tool call(s), ` +
    `${(result.durationMs / 1000).toFixed(1)}s, acceptance ${acceptance}`;
  if (report === undefined) {
    const failure = result.errorCode === undefined ? '' : ` (${result.errorCode})`;
    const lines = [`[MODERNIZE] no implementation was produced this round${failure} — ${stats}`];
    if (result.errorMessage !== undefined) lines.push(`  error: ${clipTo(result.errorMessage, CHECK_DETAIL_LIMIT)}`);
    return lines;
  }
  return [
    `[MODERNIZE] Modern implementation generated ✓ — ${report.files.length} file(s), entry ${report.entryPoint}`,
    `  ${stats}`,
  ];
}

function verificationLines(round: ModernizationLoopRound): string[] {
  const { verification } = round;
  if (verification === undefined) return [];
  const equivalent = verification.verdict.verdict === 'EQUIVALENT';
  const label = round.iteration === 0 ? '[VERIFY]   ' : '[REVERIFY] ';
  const described = describeDifferentialReport(verification.report).split('\n');
  const lines = [
    `${label} ${described[0] ?? 'no comparisons were recorded'}${equivalent ? ' PASS' : ` — verdict ${verification.verdict.verdict}`}`,
  ];
  for (const extra of described.slice(1)) {
    lines.push(`  ${extra}`);
  }
  for (const check of verification.verdict.checks) {
    if (check.required && check.status === 'FAIL') {
      lines.push(
        `  CHECK FAILED ${check.checkId} — ${clipTo(check.detail ?? check.description, CHECK_DETAIL_LIMIT)}`,
      );
    }
  }
  if (round.repairOutcome !== undefined) {
    lines.push(`  repair outcome: ${round.repairOutcome}`);
  }
  return lines;
}

function collectArtifacts(result: ModernizationLoopResult): GeneratedArtifact[] {
  const artifacts: GeneratedArtifact[] = [];
  for (const round of result.rounds) {
    const changeReport = round.modernization.artifacts.changeReport;
    if (changeReport !== undefined) artifacts.push(changeReport);
  }
  if (result.finalVerification !== undefined) {
    artifacts.push(result.finalVerification.verdictArtifact, result.finalVerification.reportArtifact);
  }
  return artifacts;
}

function buildJsonOutcome(runId: RunId, result: ModernizationLoopResult): Record<string, unknown> {
  return {
    runId,
    stopReason: result.stopReason,
    repairIterations: result.repairIterations,
    verdict: result.finalVerification?.verdict.verdict ?? null,
    statistics: result.finalVerification?.report.statistics ?? null,
    unresolvedMismatchIds: result.unresolvedMismatchIds,
    taskIds: result.taskIds,
    rounds: result.rounds.map((round) => roundDigest(round)),
  };
}

function roundDigest(round: ModernizationLoopRound): Record<string, unknown> {
  const { modernization, verification, diagnosis, repairOutcome } = round;
  return {
    iteration: round.iteration,
    repairOutcome: repairOutcome ?? null,
    durationMs: round.durationMs,
    modernize: {
      taskId: modernization.task.taskId,
      status: modernization.result.status,
      files: modernization.report?.files.length ?? null,
      entryPoint: modernization.report?.entryPoint ?? null,
      changeReportPath: modernization.artifacts.changeReport?.relativePath ?? null,
      llmCalls: modernization.result.llmCalls,
      toolCalls: modernization.result.toolCalls,
    },
    verification:
      verification === undefined
        ? null
        : {
            verdict: verification.verdict.verdict,
            modernStarted: verification.modern.started,
            reportPath: verification.reportArtifact.relativePath,
            verdictPath: verification.verdictArtifact.relativePath,
            statistics: verification.report.statistics,
            mismatches: verification.mismatches.map((mismatch) => ({
              mismatchId: mismatch.mismatchId,
              title: mismatch.title,
              severity: mismatch.severity,
              differenceKind: mismatch.differenceKind,
              path: mismatch.path,
              scenarioId: mismatch.scenarioId,
              legacyValue: mismatch.legacyValue,
              modernValue: mismatch.modernValue,
              relatedRuleIds: mismatch.relevantRuleIds,
              relatedInvariantIds: mismatch.relevantInvariantIds,
            })),
            unjudgeable: verification.unjudgeable.map((entry) => ({
              caseId: entry.caseId,
              outcome: entry.outcome,
              reason: entry.reason,
            })),
            failedChecks: verification.verdict.checks
              .filter((check) => check.required && check.status === 'FAIL')
              .map((check) => ({ checkId: check.checkId, detail: check.detail ?? null })),
          },
    diagnosis:
      diagnosis === undefined
        ? null
        : {
            iteration: diagnosis.iteration,
            summary: diagnosis.summary,
            mismatchIds: diagnosis.mismatchIds,
            evidencePaths: diagnosis.evidencePaths,
          },
  };
}

/** The specification and suite artifacts, recorded as the inputs the implementation's provenance points at. */
function loopInputs(store: FileArtifactStore, runId: RunId): GeneratedArtifact[] {
  return store
    .list(runId, {
      kinds: ['specification.business-rules', 'specification.invariants', 'characterization.suite'],
    })
    .filter((meta) => meta.relativePath.endsWith('.json'))
    .map((meta) => ({
      artifactId: meta.id,
      kind: meta.kind,
      relativePath: meta.relativePath,
      bytes: meta.bytes,
      sha256: meta.sha256,
    }));
}

function parseArguments(argv: readonly string[]): Options {
  const options: Options = { json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const next = (): string => {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new PhoenixError('CONFIG_INVALID', `${flag} needs a value`, { flag });
      }
      index += 1;
      return value;
    };
    switch (flag) {
      case '--run-id':
        options.runId = next();
        break;
      case '--max-steps': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new PhoenixError('CONFIG_INVALID', `${flag} must be a positive integer`, { flag });
        }
        options.maxSteps = parsed;
        break;
      }
      case '--max-repairs': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed) || parsed < 0) {
          throw new PhoenixError('CONFIG_INVALID', `${flag} must be a non-negative integer`, { flag });
        }
        options.maxRepairs = parsed;
        break;
      }
      case '--json':
        options.json = true;
        break;
      default:
        throw new PhoenixError('CONFIG_INVALID', `unknown argument "${flag}" for modernize`, {
          usage: MODERNIZE_USAGE,
        });
    }
  }
  return options;
}

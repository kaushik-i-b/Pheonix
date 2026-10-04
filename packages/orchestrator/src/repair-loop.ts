import {
  PhoenixError,
  newTaskId,
  type ArtifactId,
  type BusinessRuleSet,
  type CharacterizationSuite,
  type DifferentialComparison,
  type GeneratedArtifact,
  type InvariantSet,
  type Mismatch,
  type RunId,
  type Scenario,
  type Severity,
  type TaskBudget,
  type TaskId,
} from '@phoenix/shared';
import type { ScenarioTarget } from '@phoenix/characterization';
import { clipTo, renderValue } from '@phoenix/differential-testing';
import type { RunRuntime } from './runtime.js';
import { runModernizationStage, type ModernizationOutcome } from './stages/modernization.js';
import { runVerificationStage, type VerificationOutcome } from './stages/verification.js';

/**
 * MODERNIZE → VERIFY → DIAGNOSE → REPAIR → RE-VERIFY.
 *
 * The loop that makes Phoenix a factory rather than a pipeline: the first implementation is
 * verified against the captured legacy baselines, each divergence is rendered into a diagnosis
 * brief that names the legacy behavior to reproduce and the legacy code behind it, and the
 * Modernizer is rerun with that brief until the suite says EQUIVALENT, the attempts run out, or a
 * repair fails to strictly improve the mismatch profile.
 *
 * The Modernizer still never grades itself. Every judgment in this loop comes from rerunning the
 * differential harness; the brief is evidence for the next attempt, not a verdict. Mismatch ids
 * are deterministic (`caseId-M<ordinal>`), which is what makes "did this repair actually improve
 * anything" a set comparison rather than a guess.
 */

export type LoopStopReason =
  | 'equivalent'
  | 'attempts-exhausted'
  | 'no-progress'
  | 'modernization-failed'
  | 'aborted';

/** The observable change a repair made to the mismatch profile. */
export type RepairOutcome = 'IMPROVED' | 'NO_CHANGE' | 'REGRESSED' | 'RESOLVED';

/** What a round recorded: the classification, or FAILED when the Modernizer produced nothing usable. */
export type RepairRoundOutcome = RepairOutcome | 'FAILED';

export interface ClassifyRepairInput {
  mismatchesBefore: readonly string[];
  mismatchesAfter: readonly string[];
  equivalent: boolean;
}

/**
 * RESOLVED requires the verdict, not just an empty mismatch list: required checks can fail with no
 * mismatches at all (a server that never starts), and only the verdict reflects both. Anything the
 * repair made worse is REGRESSED regardless of how much it fixed — a repair that trades one
 * divergence for another has not made progress.
 */
export function classifyRepair(input: ClassifyRepairInput): RepairOutcome {
  if (input.equivalent && input.mismatchesAfter.length === 0) return 'RESOLVED';
  const before = new Set(input.mismatchesBefore);
  const after = new Set(input.mismatchesAfter);
  if (input.mismatchesAfter.some((id) => !before.has(id))) return 'REGRESSED';
  return input.mismatchesBefore.some((id) => !after.has(id)) ? 'IMPROVED' : 'NO_CHANGE';
}

/** The diagnosis handed to a repair iteration's Modernizer, plus what the DIAGNOSE line reports. */
export interface RepairDiagnosis {
  /** The repair iteration this brief was written for (1-based). */
  iteration: number;
  /** The failure report handed to the Modernizer verbatim. */
  text: string;
  /** One-paragraph diagnosis for the event stream. */
  summary: string;
  /** Mismatch ids the brief covers, worst severity first. */
  mismatchIds: string[];
  /** Legacy files the cited rules are enforced at, for the DIAGNOSE line. */
  evidencePaths: string[];
}

export interface RepairBriefInput {
  verification: VerificationOutcome;
  rules: BusinessRuleSet;
  invariants: InvariantSet;
  /** Used to resolve an unjudgeable scenario back to the rules its case targets. */
  suite: CharacterizationSuite;
  /** The workspace the Modernizer may regenerate; restated so the brief stands alone. */
  modernRoot: string;
  repairIteration: number;
}

const BRIEF_LIMIT = 24_000;
const SUMMARY_LIMIT = 4_000;
const RULE_BEHAVIOR_LIMIT = 700;
const INVARIANT_LIMIT = 400;
const CHECK_DETAIL_LIMIT = 2_000;
const REASON_LIMIT = 1_000;
const OBSERVATION_LIMIT = 1_200;
const MAX_RULES_PER_MISMATCH = 4;
const MAX_INVARIANTS_PER_MISMATCH = 4;
const MAX_EVIDENCE_PATHS = 12;
const MAX_LISTED_TARGETS = 6;

/**
 * Renders the recorded differential failures into the failure report the Modernizer repairs
 * against. Values come from the comparison layer, never from the model's own answer; the legacy
 * side of every pair is the captured baseline and is presented as the contract it is.
 */
export function renderRepairBrief(input: RepairBriefInput): RepairDiagnosis {
  const { verification, rules, invariants, suite } = input;
  const ruleById = new Map(rules.rules.map((rule) => [rule.ruleId, rule]));
  const invariantById = new Map(invariants.invariants.map((invariant) => [invariant.invariantId, invariant]));

  const priority = new Map(verification.verdict.repairTargets.map((id, index) => [id, index]));
  const mismatches = [...verification.mismatches].sort(
    (left, right) =>
      (priority.get(left.mismatchId) ?? Number.MAX_SAFE_INTEGER) -
      (priority.get(right.mismatchId) ?? Number.MAX_SAFE_INTEGER),
  );
  const unjudgeable = verification.comparisons.filter(
    (entry) => entry.outcome === 'inconclusive' || entry.outcome === 'modern-unreachable',
  );
  const failedChecks = verification.verdict.checks.filter(
    (check) =>
      check.required &&
      check.status === 'FAIL' &&
      check.checkId !== 'characterization-suite-passes-on-legacy' &&
      check.checkId !== 'differential-equivalence',
  );

  const evidencePaths: string[] = [];
  const notePath = (path: string | undefined): void => {
    if (path === undefined || evidencePaths.includes(path)) return;
    evidencePaths.push(path);
  };

  const lines: string[] = [
    `# Repair iteration ${input.repairIteration} — differential failures to fix`,
    '',
    'The characterization suite was executed against your implementation and compared with the recorded legacy behavior. Everything below was observed by running both systems; the legacy values are the contract and are not negotiable.',
    '',
    `Change ONLY the modern implementation under ${input.modernRoot}. The legacy repository is read-only. Return the complete file set again in your answer — the host rewrites the modern workspace from scratch each pass, so a partial patch would be lost.`,
  ];

  for (const mismatch of mismatches) {
    lines.push('', ...mismatchSection(mismatch, ruleById, invariantById, notePath));
  }

  if (unjudgeable.length > 0) {
    lines.push('', '# Scenarios the harness could not judge', '');
    lines.push(
      'These scenarios produced no verdict, so they count against the result exactly like a divergence would: the verdict is never EQUIVALENT while any scenario is unjudged. Make them executable and answerable on the modern system.',
    );
    for (const entry of unjudgeable) {
      lines.push('', ...unjudgeableSection(entry, suite, ruleById, notePath));
    }
  }

  if (failedChecks.length > 0) {
    lines.push('', '# Required checks that failed', '');
    lines.push(
      'These are not scenario divergences: they are reasons the harness could not verify the implementation at all. Fix them first — while a required check fails, no number of matching scenarios can make the verdict EQUIVALENT.',
    );
    for (const check of failedChecks) {
      lines.push('', `## ${check.checkId} [${check.kind}]`, `- ${check.description}`);
      if (check.detail !== undefined) {
        lines.push(`- observed: ${clipTo(check.detail, CHECK_DETAIL_LIMIT)}`);
      }
    }
  }

  lines.push(
    '',
    '# After you answer',
    '',
    'The host writes your files, starts the server, resets it before every scenario, and reruns the same suite. The repair is judged by that rerun — not by anything you state in your answer.',
  );

  const summary = buildDiagnosisSummary({
    iteration: input.repairIteration,
    mismatches,
    unjudgeable,
    failedChecks,
    highestSeverity: verification.verdict.mismatchSummary.highestSeverity,
  });

  return {
    iteration: input.repairIteration,
    text: clipTo(lines.join('\n'), BRIEF_LIMIT),
    summary,
    mismatchIds: mismatches.map((mismatch) => mismatch.mismatchId),
    evidencePaths: evidencePaths.slice(0, MAX_EVIDENCE_PATHS),
  };
}

function mismatchSection(
  mismatch: Mismatch,
  ruleById: ReadonlyMap<string, BusinessRuleSet['rules'][number]>,
  invariantById: ReadonlyMap<string, InvariantSet['invariants'][number]>,
  notePath: (path: string | undefined) => void,
): string[] {
  const lines: string[] = [
    `## MISMATCH ${mismatch.mismatchId} — ${mismatch.title} [${mismatch.severity}, ${mismatch.differenceKind}]`,
    `- scenario: ${mismatch.scenarioId} — ${mismatch.scenarioTitle}`,
    `- divergent path: ${mismatch.path}`,
    `- legacy answered: ${renderValue(mismatch.legacyValue)}`,
    `- your implementation answered: ${renderValue(mismatch.modernValue)}`,
    '- required behavior: reproduce the legacy value exactly; the captured baseline is the contract.',
  ];

  const relatedRules = mismatch.relevantRuleIds
    .map((ruleId) => ruleById.get(ruleId))
    .filter((rule): rule is BusinessRuleSet['rules'][number] => rule !== undefined);
  if (relatedRules.length > 0) {
    lines.push('- related business rules:');
    for (const rule of relatedRules.slice(0, MAX_RULES_PER_MISMATCH)) {
      lines.push(`  - ${rule.ruleId} — ${rule.title}: ${clipTo(rule.observableBehavior, RULE_BEHAVIOR_LIMIT)}`);
      for (const location of locationsOf(rule)) {
        notePath(location.path);
        lines.push(`    - enforced at ${renderLocation(location)}`);
      }
    }
  }

  const relatedInvariants = mismatch.relevantInvariantIds
    .map((invariantId) => invariantById.get(invariantId))
    .filter((invariant): invariant is InvariantSet['invariants'][number] => invariant !== undefined);
  if (relatedInvariants.length > 0) {
    lines.push('- related invariants:');
    for (const invariant of relatedInvariants.slice(0, MAX_INVARIANTS_PER_MISMATCH)) {
      lines.push(`  - ${invariant.invariantId} — ${clipTo(invariant.statement, INVARIANT_LIMIT)}`);
    }
  }

  const observation = mismatch.evidence.find((entry) => entry.observation !== undefined)?.observation;
  if (observation !== undefined) {
    lines.push(`- recorded observation: ${clipTo(observation, OBSERVATION_LIMIT)}`);
  }

  return lines;
}

function unjudgeableSection(
  entry: DifferentialComparison,
  suite: CharacterizationSuite,
  ruleById: ReadonlyMap<string, BusinessRuleSet['rules'][number]>,
  notePath: (path: string | undefined) => void,
): string[] {
  const lines: string[] = [`## ${entry.scenarioId} — ${entry.scenarioTitle} [${entry.outcome}]`];
  if (entry.inconclusiveReason !== undefined) {
    lines.push(`- reason: ${clipTo(entry.inconclusiveReason, REASON_LIMIT)}`);
  }
  const item = suite.cases.find((candidate) => candidate.scenario.scenarioId === entry.scenarioId);
  if (item !== undefined) {
    const claims = [...item.targetRuleIds, ...item.targetInvariantIds];
    if (claims.length > 0) lines.push(`- targeted claims: ${claims.join(', ')}`);
    for (const ruleId of item.targetRuleIds) {
      const rule = ruleById.get(ruleId);
      if (rule === undefined) continue;
      for (const location of locationsOf(rule)) notePath(location.path);
    }
  }
  return lines;
}

function locationsOf(
  rule: BusinessRuleSet['rules'][number],
): { path: string; startLine?: number; symbol?: string }[] {
  const entries = [...rule.sourceEvidence, ...rule.edgeCases.flatMap((edgeCase) => edgeCase.evidence)];
  const seen = new Set<string>();
  const locations: { path: string; startLine?: number; symbol?: string }[] = [];
  for (const item of entries) {
    if (item.location === undefined) continue;
    const rendered = renderLocation(item.location);
    if (seen.has(rendered)) continue;
    seen.add(rendered);
    locations.push(item.location);
  }
  return locations;
}

function renderLocation(location: { path: string; startLine?: number; symbol?: string }): string {
  const line = location.startLine !== undefined ? `:${location.startLine}` : '';
  const symbol = location.symbol !== undefined ? ` (${location.symbol})` : '';
  return `${location.path}${line}${symbol}`;
}

function buildDiagnosisSummary(input: {
  iteration: number;
  mismatches: readonly Mismatch[];
  unjudgeable: readonly DifferentialComparison[];
  failedChecks: readonly { checkId: string }[];
  highestSeverity: Severity;
}): string {
  const counts =
    `repair iteration ${input.iteration}: ${input.mismatches.length} mismatch(es)` +
    (input.failedChecks.length > 0 ? `, ${input.failedChecks.length} failed required check(s)` : '') +
    (input.unjudgeable.length > 0 ? `, ${input.unjudgeable.length} scenario(s) with no verdict` : '');
  const parts = [counts, `highest severity ${input.highestSeverity}`];
  if (input.mismatches.length > 0) {
    const listed = input.mismatches
      .slice(0, MAX_LISTED_TARGETS)
      .map((mismatch) => `${mismatch.mismatchId} ${mismatch.title}`)
      .join('; ');
    const more = input.mismatches.length > MAX_LISTED_TARGETS ? ` (+${input.mismatches.length - MAX_LISTED_TARGETS} more)` : '';
    parts.push(`targets: ${listed}${more}`);
  }
  if (input.failedChecks.length > 0) {
    parts.push(`failed checks: ${input.failedChecks.map((check) => check.checkId).join(', ')}`);
  }
  if (input.unjudgeable.length > 0) {
    const listed = input.unjudgeable
      .slice(0, MAX_LISTED_TARGETS)
      .map((entry) => entry.scenarioId)
      .join(', ');
    parts.push(`no verdict: ${listed}`);
  }
  return clipTo(parts.join(' — '), SUMMARY_LIMIT);
}

export interface ModernizationLoopOptions {
  runId: RunId;
  runtime: RunRuntime;
  rules: BusinessRuleSet;
  invariants: InvariantSet;
  /** The captured contract; only cases that passed their own legacy self-check are used. */
  suite: CharacterizationSuite;
  suiteArtifactId?: ArtifactId;
  /** Specification and suite artifacts, recorded as modernization inputs for provenance. */
  inputArtifacts?: readonly GeneratedArtifact[];
  /** Defaults to the run limit `maxRepairIterations`. */
  maxRepairIterations?: number;
  /** Defaults to the run limit `requireRepairProgress`. */
  requireProgress?: boolean;
  budget?: Partial<TaskBudget>;
  objective?: string;
  /**
   * Connect a verification round to an already-running modern system instead of starting one.
   * Tests use this to serve different implementations per round without spawning processes.
   */
  targetFor?: (verificationRound: number) => ScenarioTarget | undefined;
  signal?: AbortSignal;
}

export interface ModernizationLoopRound {
  /** 0 is the first implementation; n is the implementation produced by repair iteration n. */
  iteration: number;
  modernization: ModernizationOutcome;
  /** Absent when the Modernizer produced nothing usable, so no verification could run. */
  verification?: VerificationOutcome;
  /** What the Diagnoser handed this round's Modernizer; absent on iteration 0. */
  diagnosis?: RepairDiagnosis;
  /** How this repair compared with the previous verification; absent on iteration 0. */
  repairOutcome?: RepairRoundOutcome;
  /** Mismatch ids observed by the verification that followed this round; empty when none ran. */
  mismatchIds: string[];
  durationMs: number;
}

export interface ModernizationLoopResult {
  rounds: ModernizationLoopRound[];
  stopReason: LoopStopReason;
  finalVerification?: VerificationOutcome;
  /** Repair rounds actually attempted; 0 when the first implementation was already equivalent. */
  repairIterations: number;
  /** Tasks created by the loop, in order (each round's Modernizer, then its Verifier). */
  taskIds: TaskId[];
  /** Unresolved mismatch ids as of the last completed verification. */
  unresolvedMismatchIds: string[];
}

export async function runModernizationLoop(
  options: ModernizationLoopOptions,
): Promise<ModernizationLoopResult> {
  const { runId, runtime, rules, invariants, suite, signal } = options;
  const maxRepairs = options.maxRepairIterations ?? runtime.config.limits.maxRepairIterations;
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0) {
    throw new PhoenixError(
      'CONFIG_INVALID',
      `maxRepairIterations must be a non-negative integer, got ${maxRepairs}`,
      { maxRepairIterations: maxRepairs },
    );
  }
  const requireProgress = options.requireProgress ?? runtime.config.limits.requireRepairProgress;

  const comparables = suite.cases.filter(
    (item) => item.status === 'passing-against-legacy' && item.captureExecutionId !== undefined,
  );
  if (comparables.length === 0) {
    throw new PhoenixError(
      'CONFIG_INVALID',
      `the characterization suite has no case that passed its legacy baseline (${suite.cases.length} case(s) recorded); there is nothing the modern implementation can be verified against`,
      { cases: suite.cases.length },
    );
  }
  const scenarios: readonly Scenario[] = comparables.map((item) => item.scenario);
  const criticalInvariantIds = invariants.invariants
    .filter((invariant) => invariant.criticality === 'CRITICAL')
    .map((invariant) => invariant.invariantId);

  const rounds: ModernizationLoopRound[] = [];
  const taskIds: TaskId[] = [];
  let stopReason: LoopStopReason = 'attempts-exhausted';
  let finalVerification: VerificationOutcome | undefined;
  let unresolvedMismatchIds: string[] = [];
  let previousVerification: VerificationOutcome | undefined;
  let previousMismatchIds: string[] = [];
  let previousModernizationTaskId: TaskId | undefined;

  for (let iteration = 0; ; iteration += 1) {
    if (signal?.aborted) {
      stopReason = 'aborted';
      break;
    }
    const roundStartedAt = Date.now();

    let diagnosis: RepairDiagnosis | undefined;
    if (iteration > 0) {
      if (previousVerification === undefined) {
        throw new PhoenixError(
          'INTERNAL',
          'a repair iteration started without a previous verification to diagnose',
          { iteration },
        );
      }
      diagnosis = renderRepairBrief({
        verification: previousVerification,
        rules,
        invariants,
        suite,
        modernRoot: runtime.paths.modernRoot,
        repairIteration: iteration,
      });
      runtime.events.next(runId, 'repair.requested', {
        iteration,
        mismatchIds: diagnosis.mismatchIds,
        diagnosisSummary: clipTo(diagnosis.summary, SUMMARY_LIMIT),
        targetRoots: [runtime.paths.modernRoot],
      });
    }

    const modernization = await runModernizationStage({
      runId,
      runtime,
      rules,
      invariants,
      scenarios,
      ...(options.inputArtifacts !== undefined ? { inputArtifacts: options.inputArtifacts } : {}),
      ...(options.budget !== undefined ? { budget: options.budget } : {}),
      ...(options.objective !== undefined ? { objective: options.objective } : {}),
      ...(diagnosis !== undefined ? { failureReport: diagnosis.text } : {}),
      ...(iteration > 0 ? { repairIteration: iteration } : {}),
      ...(previousModernizationTaskId !== undefined ? { parentTaskId: previousModernizationTaskId } : {}),
      ...(signal !== undefined ? { signal } : {}),
    });
    taskIds.push(modernization.task.taskId);

    const changeReport = modernization.report;
    const changeReportArtifact = modernization.artifacts.changeReport;
    if (changeReport === undefined || changeReportArtifact === undefined) {
      const round: ModernizationLoopRound = {
        iteration,
        modernization,
        ...(diagnosis !== undefined ? { diagnosis } : {}),
        ...(iteration > 0 ? { repairOutcome: 'FAILED' as const } : {}),
        mismatchIds: [],
        durationMs: Date.now() - roundStartedAt,
      };
      rounds.push(round);
      if (iteration > 0) {
        runtime.events.next(runId, 'repair.completed', {
          iteration,
          outcome: 'FAILED',
          mismatchesBefore: previousMismatchIds.length,
          durationMs: round.durationMs,
        });
      }
      stopReason = 'modernization-failed';
      break;
    }

    const verificationTaskId = newTaskId();
    const target = options.targetFor?.(iteration);
    const verification = await runVerificationStage({
      runId,
      runtime,
      suite,
      ...(options.suiteArtifactId !== undefined ? { suiteArtifactId: options.suiteArtifactId } : {}),
      changeReport,
      changeReportArtifactId: changeReportArtifact.artifactId,
      criticalInvariantIds,
      repairIteration: iteration,
      ...(target !== undefined ? { target } : {}),
      taskId: verificationTaskId,
      ...(signal !== undefined ? { signal } : {}),
    });
    taskIds.push(verificationTaskId);

    const mismatchIdsAfter = verification.mismatches.map((mismatch) => mismatch.mismatchId);
    const equivalent = verification.verdict.verdict === 'EQUIVALENT';
    let repairOutcome: RepairOutcome | undefined;
    if (iteration > 0) {
      repairOutcome = classifyRepair({
        mismatchesBefore: previousMismatchIds,
        mismatchesAfter: mismatchIdsAfter,
        equivalent,
      });
      runtime.events.next(runId, 'repair.completed', {
        iteration,
        outcome: repairOutcome,
        mismatchesBefore: previousMismatchIds.length,
        mismatchesAfter: mismatchIdsAfter.length,
        durationMs: Date.now() - roundStartedAt,
      });
    }

    rounds.push({
      iteration,
      modernization,
      verification,
      ...(diagnosis !== undefined ? { diagnosis } : {}),
      ...(repairOutcome !== undefined ? { repairOutcome } : {}),
      mismatchIds: mismatchIdsAfter,
      durationMs: Date.now() - roundStartedAt,
    });
    finalVerification = verification;
    unresolvedMismatchIds = mismatchIdsAfter;
    previousMismatchIds = mismatchIdsAfter;
    previousVerification = verification;
    previousModernizationTaskId = modernization.task.taskId;

    if (equivalent) {
      stopReason = 'equivalent';
      break;
    }
    if (iteration >= maxRepairs) {
      stopReason = 'attempts-exhausted';
      break;
    }
    if (iteration > 0 && requireProgress && repairOutcome !== 'IMPROVED') {
      stopReason = 'no-progress';
      break;
    }
  }

  return {
    rounds,
    stopReason,
    ...(finalVerification !== undefined ? { finalVerification } : {}),
    repairIterations: rounds.filter((round) => round.iteration > 0).length,
    taskIds,
    unresolvedMismatchIds,
  };
}

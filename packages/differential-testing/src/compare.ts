import {
  PhoenixError,
  differentialComparisonSchema,
  hashStable,
  mismatchSchema,
  nowIso,
  stableStringify,
  type ArtifactId,
  type AssertionResult,
  type CharacterizationAssertion,
  type CharacterizationSuite,
  type DifferenceKind,
  type DifferentialComparison,
  type Mismatch,
  type NormalizationApplied,
  type ScenarioExecution,
  type Severity,
} from '@phoenix/shared';
import { evaluateCase, isClockReading, type CaseEvaluation } from '@phoenix/characterization';

/**
 * Differential comparison between the legacy baselines captured in a characterization suite and the
 * executions the modern system just produced.
 *
 * The legacy side is never re-executed here: it is recovered from the suite's own captures and
 * re-judged with the same evaluator the modern side gets. If the recorded baseline no longer
 * satisfies its captured assertions, that is fixture drift — reported as a self-check failure and
 * never softened into `equal`, because an "equivalent" verdict resting on a stale baseline would be
 * a lie about the one thing differential testing exists to establish.
 *
 * A case that cannot be judged is `inconclusive`, never quietly passed. The verdict layer is what
 * turns these counts into EQUIVALENT / NOT_EQUIVALENT / INCONCLUSIVE.
 */

export interface ModernExecution {
  caseId: string;
  execution: ScenarioExecution;
}

export interface CompareSuiteInput {
  suite: CharacterizationSuite;
  modernExecutions: readonly ModernExecution[];
  /** Artifact id of the persisted suite, attached to mismatch evidence for traceability. */
  suiteArtifactId?: ArtifactId;
  /** Invariants whose ids are listed here make any mismatch that touches them CRITICAL. */
  criticalInvariantIds?: readonly string[];
  now?: () => Date;
}

export interface UnjudgeableCase {
  caseId: string;
  outcome: DifferentialComparison['outcome'];
  reason: string;
}

export interface CompareSuiteResult {
  comparisons: DifferentialComparison[];
  mismatches: Mismatch[];
  /** Cases whose recorded legacy baseline no longer satisfies its own captured assertions. */
  legacySelfCheckFailures: string[];
  /** Cases that produced no verdict, with the reason the verdict layer must carry forward. */
  unjudgeable: UnjudgeableCase[];
}

interface CaseComparisonResult {
  comparison: DifferentialComparison;
  mismatches: Mismatch[];
  legacySelfCheckFailure?: string;
}

const MISMATCH_TITLE_LIMIT = 500;
const INCONCLUSIVE_REASON_LIMIT = 2_000;
const OBSERVATION_LIMIT = 8_000;
const RENDER_LIMIT = 200;

export function compareSuite(input: CompareSuiteInput): CompareSuiteResult {
  const now = input.now ?? (() => new Date());
  const criticalInvariants = new Set(input.criticalInvariantIds ?? []);
  const modernByCase = new Map<string, ScenarioExecution>();
  for (const entry of input.modernExecutions) {
    modernByCase.set(entry.caseId, entry.execution);
  }

  const knownCaseIds = new Set(input.suite.cases.map((item) => item.caseId));
  for (const caseId of modernByCase.keys()) {
    if (!knownCaseIds.has(caseId)) {
      throw new PhoenixError(
        'INTERNAL',
        `a modern execution was supplied for case "${caseId}", which the characterization suite does not contain`,
        { caseId },
      );
    }
  }

  const comparisons: DifferentialComparison[] = [];
  const mismatches: Mismatch[] = [];
  const legacySelfCheckFailures: string[] = [];
  const unjudgeable: UnjudgeableCase[] = [];

  for (const item of input.suite.cases) {
    const outcome = compareCase({
      item,
      captures: input.suite.captures,
      modern: modernByCase.get(item.caseId),
      criticalInvariants,
      suiteArtifactId: input.suiteArtifactId,
      now,
    });
    comparisons.push(outcome.comparison);
    mismatches.push(...outcome.mismatches);
    if (outcome.legacySelfCheckFailure !== undefined) {
      legacySelfCheckFailures.push(outcome.legacySelfCheckFailure);
    }
    if (outcome.comparison.outcome === 'inconclusive' || outcome.comparison.outcome === 'modern-unreachable') {
      unjudgeable.push({
        caseId: item.caseId,
        outcome: outcome.comparison.outcome,
        reason: outcome.comparison.inconclusiveReason ?? 'no reason recorded',
      });
    }
  }

  return { comparisons, mismatches, legacySelfCheckFailures, unjudgeable };
}

interface CompareCaseInput {
  item: CharacterizationSuite['cases'][number];
  captures: CharacterizationSuite['captures'];
  modern: ScenarioExecution | undefined;
  criticalInvariants: ReadonlySet<string>;
  suiteArtifactId: ArtifactId | undefined;
  now: () => Date;
}

function compareCase(input: CompareCaseInput): CaseComparisonResult {
  const { item, captures, modern, criticalInvariants, suiteArtifactId, now } = input;
  const base = {
    scenarioId: item.scenario.scenarioId,
    scenarioTitle: item.scenario.title,
    category: item.category,
    durationMs: modern?.durationMs ?? 0,
  };

  const inconclusive = (
    reason: string,
    failure?: string,
    legacy?: ScenarioExecution,
  ): CaseComparisonResult => ({
    comparison: differentialComparisonSchema.parse({
      ...base,
      ...(legacy !== undefined ? { legacy } : {}),
      ...(modern !== undefined ? { modern } : {}),
      equal: false,
      outcome: 'inconclusive',
      inconclusiveReason: clipTo(reason, INCONCLUSIVE_REASON_LIMIT),
      mismatches: [],
      normalizationApplied: [],
    }),
    mismatches: [],
    ...(failure !== undefined ? { legacySelfCheckFailure: failure } : {}),
  });

  if (item.status !== 'passing-against-legacy') {
    return inconclusive(
      `the case is "${item.status}"; only a case that passed its captured legacy baseline can be compared`,
    );
  }

  const baseline =
    item.captureExecutionId === undefined
      ? undefined
      : captures.find((capture) => hashStable(capture) === item.captureExecutionId);
  if (baseline === undefined) {
    return inconclusive(
      `the captured legacy baseline (execution ${item.captureExecutionId ?? '<none recorded>'}) is not present in the suite captures`,
    );
  }

  const legacyEvaluation = evaluateCase(item, baseline);
  if (!legacyEvaluation.passed) {
    const failed = unsatisfiedLive(legacyEvaluation, item.assertions).map(
      (entry) => entry.assertion.assertionId,
    );
    return inconclusive(
      `the recorded legacy baseline no longer satisfies ${failed.length} captured assertion(s): ${failed.join(', ')} — the fixture has drifted and nothing can be concluded from it`,
      `${item.caseId}: legacy baseline failed ${failed.join(', ')}`,
      baseline,
    );
  }

  if (modern === undefined) {
    return inconclusive('no modern execution was recorded for this case', undefined, baseline);
  }

  if (modern.status === 'unreachable') {
    return {
      comparison: differentialComparisonSchema.parse({
        ...base,
        legacy: baseline,
        modern,
        equal: false,
        outcome: 'modern-unreachable',
        inconclusiveReason: clipTo(
          modern.error ?? 'the modern system could not be reached',
          INCONCLUSIVE_REASON_LIMIT,
        ),
        mismatches: [],
        normalizationApplied: [],
      }),
      mismatches: [],
    };
  }

  if (modern.status === 'error' || modern.status === 'timeout') {
    return inconclusive(
      `the modern execution ended "${modern.status}"${modern.error !== undefined ? `: ${modern.error}` : ''}`,
      undefined,
      baseline,
    );
  }

  const modernEvaluation = evaluateCase(item, modern);
  const liveEntries = unsatisfiedLive(modernEvaluation, item.assertions);
  const mismatchEntries = liveEntries.filter((entry) => !isClockReading(entry.assertion.path ?? ''));
  const clockEntries = liveEntries.filter((entry) => isClockReading(entry.assertion.path ?? ''));

  const mismatches: Mismatch[] = mismatchEntries.map((entry, position) =>
    buildMismatch({
      item,
      entry,
      ordinal: position + 1,
      criticalInvariants,
      suiteArtifactId,
      now,
    }),
  );

  const normalizationApplied: NormalizationApplied[] = [];
  for (const assertion of item.assertions) {
    const result = resultFor(modernEvaluation, assertion);
    if (!result.normalized || result.satisfied) continue;
    if (assertion.normalization === undefined) {
      throw new PhoenixError(
        'INTERNAL',
        `assertion ${assertion.assertionId} is marked normalized but carries no normalization record`,
        { assertionId: assertion.assertionId },
      );
    }
    normalizationApplied.push({
      ruleId: assertion.normalization.policy,
      scenarioId: item.scenario.scenarioId,
      system: 'modern',
      path: `${assertion.stepId}.${result.path ?? assertion.kind}`,
      strategy: 'ignore',
      before: assertion.expected,
      after: result.actual,
      reason: assertion.normalization.reason,
    });
  }
  for (const entry of clockEntries) {
    normalizationApplied.push({
      ruleId: 'clock-reading',
      scenarioId: item.scenario.scenarioId,
      system: 'modern',
      path: `${entry.assertion.stepId}.${entry.assertion.path ?? entry.assertion.kind}`,
      strategy: 'ignore',
      before: entry.assertion.expected,
      after: entry.result.actual,
      reason: 'clock-reading',
    });
  }

  const equal = mismatchEntries.length === 0;
  return {
    comparison: differentialComparisonSchema.parse({
      ...base,
      legacy: baseline,
      modern,
      equal,
      outcome: equal ? 'equal' : 'divergent',
      mismatches: mismatches.map((mismatch) => mismatch.mismatchId),
      normalizationApplied,
    }),
    mismatches,
  };
}

interface MismatchEntry {
  assertion: CharacterizationAssertion;
  result: AssertionResult;
}

function unsatisfiedLive(
  evaluation: CaseEvaluation,
  assertions: readonly CharacterizationAssertion[],
): MismatchEntry[] {
  const entries: MismatchEntry[] = [];
  for (const assertion of assertions) {
    const result = resultFor(evaluation, assertion);
    if (!result.satisfied && !result.normalized) entries.push({ assertion, result });
  }
  return entries;
}

function resultFor(evaluation: CaseEvaluation, assertion: CharacterizationAssertion): AssertionResult {
  const result = evaluation.results.find((entry) => entry.assertionId === assertion.assertionId);
  if (result === undefined) {
    throw new PhoenixError(
      'INTERNAL',
      `the evaluator produced no result for assertion ${assertion.assertionId}; the case and its evaluation disagree`,
      { assertionId: assertion.assertionId, caseId: evaluation.caseId },
    );
  }
  return result;
}

interface BuildMismatchInput {
  item: CharacterizationSuite['cases'][number];
  entry: MismatchEntry;
  ordinal: number;
  criticalInvariants: ReadonlySet<string>;
  suiteArtifactId: ArtifactId | undefined;
  now: () => Date;
}

function buildMismatch(input: BuildMismatchInput): Mismatch {
  const { item, entry, ordinal, criticalInvariants, suiteArtifactId, now } = input;
  const { assertion, result } = entry;
  const mismatchId = `${item.caseId}-M${ordinal}`;
  const path = `${assertion.stepId}.${result.path ?? assertion.kind}`;
  const differenceKind = differenceKindFor(assertion, result);
  const relevantRuleIds =
    assertion.sourceRuleIds.length > 0 ? assertion.sourceRuleIds : item.targetRuleIds;
  const relevantInvariantIds =
    assertion.sourceInvariantIds.length > 0 ? assertion.sourceInvariantIds : item.targetInvariantIds;
  const severity: Severity =
    differenceKind === 'http-status' ||
    differenceKind === 'error-vs-success' ||
    differenceKind === 'one-side-unreachable' ||
    relevantInvariantIds.some((id) => criticalInvariants.has(id))
      ? 'CRITICAL'
      : 'MAJOR';

  return mismatchSchema.parse({
    mismatchId,
    scenarioId: item.scenario.scenarioId,
    scenarioTitle: item.scenario.title,
    title: clipTo(assertion.description, MISMATCH_TITLE_LIMIT),
    differenceKind,
    path,
    legacyValue: assertion.expected,
    modernValue: result.actual,
    severity,
    relevantRuleIds,
    relevantInvariantIds,
    evidence: [
      {
        id: `${mismatchId}-E1`,
        kind: 'runtime-observation',
        collectedAt: nowIso(now()),
        collectedBy: 'differential-testing.compareSuite',
        observation: clipTo(
          `${assertion.description}: legacy ${renderValue(assertion.expected)} vs modern ${renderValue(result.actual)} at ${path}` +
            (result.message !== undefined ? ` — ${result.message}` : ''),
          OBSERVATION_LIMIT,
        ),
        ...(suiteArtifactId !== undefined ? { artifactId: suiteArtifactId } : {}),
      },
    ],
    explanationStatus: 'unexplained',
    firstObservedAt: nowIso(now()),
    observedCount: 1,
  });
}

function differenceKindFor(
  assertion: CharacterizationAssertion,
  result: AssertionResult,
): DifferenceKind {
  switch (assertion.kind) {
    case 'http-status':
      return 'http-status';
    case 'row-count':
      return 'row-count';
    case 'error-present':
      return 'error-vs-success';
    case 'exit-code':
      return 'value-difference';
    default:
      break;
  }
  const actual = result.actual;
  const expected = assertion.expected;
  if (actual === undefined) return 'missing-field';
  if (expected === undefined) return 'extra-field';
  if (typeof actual !== typeof expected) return 'type-difference';
  if (
    typeof actual === 'number' &&
    typeof expected === 'number' &&
    actual !== expected &&
    Math.round(actual) === Math.round(expected)
  ) {
    return 'precision';
  }
  return 'value-difference';
}

export function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function renderValue(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'string') {
    return clipTo(`"${value}"`, RENDER_LIMIT + 2);
  }
  const text = stableStringify(value);
  return clipTo(text, RENDER_LIMIT);
}

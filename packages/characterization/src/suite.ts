import {
  characterizationCaseSchema,
  characterizationSuiteSchema,
  computeCoverage,
  computeSuiteStatistics,
  hashStable,
  type AgentRole,
  type CharacterizationCase,
  type CharacterizationCaseStatus,
  type CharacterizationSuite,
  type Scenario,
  type ScenarioExecution,
} from '@phoenix/shared';
import { deriveAssertions, type CaptureResult } from './capture.js';
import { evaluateCase, type CaseEvaluation } from './evaluate.js';
import { executeScenario, type ExecutorOptions, type ScenarioTarget } from './executor.js';

/**
 * Assembling the suite: proposed scenarios in, captured behavioral fixtures out.
 *
 * A scenario arrives with steps and no expectations. This module supplies the expectations, and it
 * supplies them from exactly one place — what the legacy system actually did. Each scenario is run
 * twice against the same target: the first execution becomes the baseline whose values are frozen
 * into assertions, the second exists only to reveal which of those values legacy will not reproduce.
 *
 * The baseline is then judged against the assertions derived from it. That self-check should always
 * pass; when it does not, the capture and the evaluator disagree with each other and the case is
 * reported `failing-against-legacy` rather than being quietly marked good. A suite that cannot
 * reproduce legacy against itself has no business being used to judge anything else.
 */

export interface ProposedCase {
  caseId: string;
  /** The scenario as proposed. Everything else about the case is read off it. */
  scenario: Scenario;
}

export type CaptureProgress =
  | { caseId: string; phase: 'baseline' | 'probe' }
  | {
      caseId: string;
      phase: 'captured';
      status: CharacterizationCaseStatus;
      assertions: number;
      normalized: number;
      unexplained: number;
    }
  | { caseId: string; phase: 'skipped'; reason: string };

export interface CaptureSuiteInput {
  /** What the suite was captured from — the legacy label and base URL, recorded verbatim. */
  capturedFrom: string;
  generatedBy: AgentRole;
  proposals: readonly ProposedCase[];
  knownRuleIds: readonly string[];
  knownInvariantIds: readonly string[];
  target: ScenarioTarget;
  executor?: ExecutorOptions;
  maxAssertions?: number;
  onProgress?: (event: CaptureProgress) => void;
  /** Injectable for tests; production callers leave it alone and get the wall clock. */
  now?: () => Date;
}

export interface CapturedCase {
  item: CharacterizationCase;
  baseline: ScenarioExecution;
  probe: ScenarioExecution;
  /** The baseline judged against its own capture: the self-check described above. */
  selfCheck: CaseEvaluation;
  capture: CaptureResult;
}

export interface SkippedCase {
  caseId: string;
  scenario: Scenario;
  reason: string;
}

export interface CaptureSuiteResult {
  suite: CharacterizationSuite;
  cases: CapturedCase[];
  skipped: SkippedCase[];
}

export async function captureSuite(input: CaptureSuiteInput): Promise<CaptureSuiteResult> {
  const cases: CapturedCase[] = [];
  const skipped: SkippedCase[] = [];
  const captures: ScenarioExecution[] = [];

  for (const proposal of input.proposals) {
    const captured = await captureOne(proposal, input, captures);
    if ('reason' in captured) {
      skipped.push({ caseId: proposal.caseId, scenario: proposal.scenario, reason: captured.reason });
      input.onProgress?.({ caseId: proposal.caseId, phase: 'skipped', reason: captured.reason });
      continue;
    }
    cases.push(captured);
    input.onProgress?.({
      caseId: proposal.caseId,
      phase: 'captured',
      status: captured.item.status,
      assertions: captured.item.assertions.length,
      normalized: captured.capture.normalized.length,
      unexplained: captured.capture.unexplainedVolatility.length,
    });
  }

  const suite = characterizationSuiteSchema.parse({
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    generatedBy: input.generatedBy,
    capturedFrom: input.capturedFrom,
    cases: cases.map((entry) => entry.item),
    captures,
    coverage: computeCoverage({
      cases: cases.map((entry) => entry.item),
      knownRuleIds: input.knownRuleIds,
      knownInvariantIds: input.knownInvariantIds,
    }),
  });
  return { suite: { ...suite, statistics: computeSuiteStatistics(suite) }, cases, skipped };
}

async function captureOne(
  proposal: ProposedCase,
  input: CaptureSuiteInput,
  captures: ScenarioExecution[],
): Promise<CapturedCase | { reason: string }> {
  const resetFailure = await resetTarget(input.target);
  if (resetFailure !== undefined) return { reason: `${resetFailure} before the baseline` };

  let baseline: ScenarioExecution;
  try {
    input.onProgress?.({ caseId: proposal.caseId, phase: 'baseline' });
    baseline = await executeScenario(proposal.scenario, input.target, input.executor);
  } catch (error) {
    // A scenario that could not even be performed once — an unresolvable `{{token}}`, a step kind the
    // target has no runner for. Nothing was observed, so nothing is characterized.
    return { reason: `baseline execution threw: ${describe(error)}` };
  }
  captures.push(baseline);

  if (baseline.status === 'unreachable') {
    return { reason: `legacy at ${input.target.baseUrl} never answered: ${baseline.error ?? 'no detail recorded'}` };
  }

  const probeResetFailure = await resetTarget(input.target);
  if (probeResetFailure !== undefined) return { reason: `${probeResetFailure} before the repeat` };

  let probe: ScenarioExecution;
  try {
    input.onProgress?.({ caseId: proposal.caseId, phase: 'probe' });
    probe = await executeScenario(proposal.scenario, input.target, input.executor);
  } catch (error) {
    return { reason: `repeat execution threw: ${describe(error)}` };
  }
  captures.push(probe);

  const capture = deriveAssertions({
    caseId: proposal.caseId,
    baseline,
    probe,
    targetRuleIds: proposal.scenario.targetRuleIds,
    targetInvariantIds: proposal.scenario.targetInvariantIds,
    ...(input.maxAssertions === undefined ? {} : { maxAssertions: input.maxAssertions }),
  });

  const selfCheck = evaluateCase({ caseId: proposal.caseId, assertions: capture.assertions }, baseline);
  const status = caseStatus(baseline, capture, selfCheck);
  const item = characterizationCaseSchema.parse({
    caseId: proposal.caseId,
    title: proposal.scenario.title,
    category: proposal.scenario.category,
    scenario: proposal.scenario,
    assertions: capture.assertions,
    status,
    unexplainedVolatility: capture.unexplainedVolatility,
    targetRuleIds: proposal.scenario.targetRuleIds,
    targetInvariantIds: proposal.scenario.targetInvariantIds,
    captureExecutionId: hashStable(baseline),
  });
  return { item, baseline, probe, selfCheck, capture };
}

/**
 * What the capture proved about this scenario.
 *
 * `passing-against-legacy` is the only status that means the fixture can be trusted to judge the
 * modern system. Everything else is a statement about the capture, not about modern: legacy could not
 * be reached, it produced nothing assertable, or it did not agree with itself.
 */
function caseStatus(
  baseline: ScenarioExecution,
  capture: CaptureResult,
  selfCheck: CaseEvaluation,
): CharacterizationCaseStatus {
  if (baseline.status === 'timeout') return 'inconclusive';
  if (capture.assertions.length === 0) return 'inconclusive';
  return selfCheck.passed ? 'passing-against-legacy' : 'failing-against-legacy';
}

async function resetTarget(target: ScenarioTarget): Promise<string | undefined> {
  if (target.reset === undefined) return undefined;
  try {
    await target.reset();
    return undefined;
  } catch (error) {
    return `reset failed: ${describe(error)}`;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

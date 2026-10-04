import { z } from 'zod';
import type { CustomCheck } from '@phoenix/agent-runtime';
import {
  PhoenixError,
  caseIdSchema,
  characterizationSuiteSchema,
  computeCoverage,
  computeSuiteStatistics,
  invariantIdSchema,
  newScenarioId,
  ruleIdSchema,
  scenarioCategorySchema,
  scenarioSchema,
  scenarioStepSchema,
  type BusinessRuleSet,
  type HttpEndpoint,
  type InvariantSet,
  type Scenario,
} from '@phoenix/shared';

/**
 * What the Characterization Engineer is allowed to say, and how a proposal becomes a case.
 *
 * The model proposes scenarios — steps and hypotheses only. It never supplies an expected output:
 * expectations are read off what the legacy system actually did, by the host, inside `captureSuite`.
 * The scenario id, provenance and case id are stamped here too, for the same reason discovery stamps
 * attribution: identity is a fact about the run, not something an agent declares.
 */

export const modelScenarioSchema = z.object({
  title: z.string().min(5).max(300),
  description: z.string().min(10).max(4000),
  category: scenarioCategorySchema,
  /** What this scenario expects to observe, in terms of the rules or invariants it targets. */
  hypothesis: z.string().min(10).max(2000),
  targetRuleIds: z.array(ruleIdSchema).max(10).default([]),
  targetInvariantIds: z.array(invariantIdSchema).max(10).default([]),
  setup: z.array(scenarioStepSchema).max(10).default([]),
  steps: z.array(scenarioStepSchema).min(1).max(20),
  teardown: z.array(scenarioStepSchema).max(10).default([]),
  /** Response paths the proposal already knows vary between identical calls; recorded, not excused. */
  knownNondeterministicPaths: z.array(z.string().min(1)).max(50).default([]),
  /** Why this behavior is worth freezing, in terms of the targeted rules. */
  rationale: z.string().min(10).max(2000),
});
export type ModelScenario = z.infer<typeof modelScenarioSchema>;

export interface KnownClaims {
  readonly ruleIds: ReadonlySet<string>;
  readonly invariantIds: ReadonlySet<string>;
}

export function knownClaimsOf(rules: BusinessRuleSet, invariants: InvariantSet): KnownClaims {
  return {
    ruleIds: new Set(rules.rules.map((rule) => rule.ruleId)),
    invariantIds: new Set(invariants.invariants.map((invariant) => invariant.invariantId)),
  };
}

/** Step kinds the live capture target can actually perform; everything else is a guaranteed skip. */
export const RUNNABLE_STEP_KINDS: readonly string[] = ['http', 'wait'];

/** Everything that would make a proposal unrunnable or untraceable, reported in one pass. */
export function scenarioProposalProblems(
  report: ScenarioProposalReport,
  known: KnownClaims,
  endpoints: readonly HttpEndpoint[] = [],
): string[] {
  const problems: string[] = [];
  const seenScenarios = new Set<string>();
  for (const [index, scenario] of report.scenarios.entries()) {
    const label = `scenario ${index + 1} (${scenario.title.slice(0, 80)})`;
    if (scenario.targetRuleIds.length === 0 && scenario.targetInvariantIds.length === 0) {
      problems.push(`${label} targets no rule and no invariant — every scenario must trace to the specification`);
    }
    const fingerprint = JSON.stringify({
      targetRuleIds: scenario.targetRuleIds,
      targetInvariantIds: scenario.targetInvariantIds,
      setup: scenario.setup,
      steps: scenario.steps,
      teardown: scenario.teardown,
    });
    if (seenScenarios.has(fingerprint)) {
      problems.push(`${label} duplicates an earlier scenario exactly; use a distinct input or boundary instead`);
    }
    seenScenarios.add(fingerprint);
    const seenSteps = new Set<string>();
    const steps = [...scenario.setup, ...scenario.steps, ...scenario.teardown];
    for (const step of steps) {
      if (seenSteps.has(step.stepId)) {
        problems.push(`${label} repeats stepId ${step.stepId}`);
      }
      seenSteps.add(step.stepId);
      if (!RUNNABLE_STEP_KINDS.includes(step.kind)) {
        problems.push(
          `${label} step ${step.stepId} is kind "${step.kind}", which the capture target cannot run (runnable kinds: ${RUNNABLE_STEP_KINDS.join(', ')})`,
        );
      }
      for (const [kind, payload] of [
        ['http', step.http],
        ['sql', step.sql],
        ['command', step.command],
      ] as const) {
        if (step.kind === kind && payload === undefined) {
          problems.push(`${label} step ${step.stepId} is kind "${kind}" but carries no ${kind} payload`);
        }
        if (step.kind !== kind && payload !== undefined) {
          problems.push(`${label} step ${step.stepId} is kind "${step.kind}" but carries a ${kind} payload`);
        }
      }
      if (step.kind === 'wait' && step.waitMs === undefined) {
        problems.push(`${label} step ${step.stepId} is kind "wait" but carries no waitMs`);
      }
      if (step.http?.body !== undefined && typeof step.http.body === 'string') {
        problems.push(
          `${label} step ${step.stepId} puts a string in http.body; body must be a JSON object, array, number, boolean or null. Use rawBody only when intentionally sending byte-exact text.`,
        );
      }
      const http = step.kind === 'http' ? step.http : undefined;
      if (
        http !== undefined &&
        endpoints.length > 0 &&
        !endpoints.some((endpoint) => endpointMatches(endpoint, http.method, http.path))
      ) {
        problems.push(
          `${label} step ${step.stepId} uses ${http.method} ${http.path}, which is not in the discovered API surface. ` +
            `Use one of: ${endpointSummary(endpoints)}`,
        );
      }
    }
    for (const ruleId of scenario.targetRuleIds) {
      if (!known.ruleIds.has(ruleId)) problems.push(`${label} targets rule ${ruleId}, which the specification does not contain`);
    }
    for (const invariantId of scenario.targetInvariantIds) {
      if (!known.invariantIds.has(invariantId)) {
        problems.push(`${label} targets invariant ${invariantId}, which the specification does not contain`);
      }
    }
  }
  return problems;
}

function endpointMatches(endpoint: HttpEndpoint, method: string, path: string): boolean {
  if (endpoint.method !== method) return false;
  const pattern = endpoint.path
    .split('/')
    .map((segment) => (/^\{[^}]+\}$/.test(segment) ? '[^/]+' : escapeRegex(segment)))
    .join('/');
  return new RegExp(`^${pattern}$`).test(path);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function endpointSummary(endpoints: readonly HttpEndpoint[]): string {
  return endpoints
    .slice(0, 20)
    .map((endpoint) => `${endpoint.method} ${endpoint.path}`)
    .join(', ');
}

/**
 * Built per stage run so dangling references to the specification are rejected inside the agent
 * loop — a repairable mistake — instead of failing the task after the model finished.
 */
export function scenarioProposalReportSchema(known: KnownClaims, endpoints: readonly HttpEndpoint[] = []) {
  return z
    .object({
      summary: z.string().min(20).max(4000),
      scenarios: z.array(modelScenarioSchema).min(5).max(10),
    })
    .superRefine((report, ctx) => {
      for (const problem of scenarioProposalProblems(report, known, endpoints)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
      }
    });
}

export type ScenarioProposalReport = {
  summary: string;
  scenarios: ModelScenario[];
};

export interface ScenarioAttribution {
  generatedAt: string;
  /** Usually `characterization-engineer:<taskId>`. */
  generatedBy: string;
}

export const CASE_ID_PREFIX = 'CHR';

/** Deterministic per proposal index, so reports and artifacts refer to stable case ids. */
export function caseIdFor(index: number): string {
  return caseIdSchema.parse(`${CASE_ID_PREFIX}-${String(index + 1).padStart(3, '0')}`);
}

export function toScenario(proposal: ModelScenario): Scenario {
  return scenarioSchema.parse({
    scenarioId: newScenarioId(),
    title: proposal.title,
    description: proposal.description,
    category: proposal.category,
    hypothesis: proposal.hypothesis,
    targetRuleIds: proposal.targetRuleIds,
    targetInvariantIds: proposal.targetInvariantIds,
    setup: proposal.setup,
    steps: proposal.steps,
    teardown: proposal.teardown,
    knownNondeterministicPaths: proposal.knownNondeterministicPaths,
    deterministic: proposal.knownNondeterministicPaths.length === 0,
    provenance: {
      createdBy: 'characterization-engineer',
      origin: proposal.targetRuleIds.length > 0 ? 'derived-from-rule' : 'derived-from-invariant',
      rationale: proposal.rationale,
    },
  });
}

/** Guards the stage against persisting a suite that cannot judge anything. */
export function assertProposalsAreUsable(report: ScenarioProposalReport): void {
  if (report.scenarios.length === 0) {
    throw new PhoenixError(
      'SCHEMA_VALIDATION_FAILED',
      'the characterization engineer proposed no scenarios; there is nothing to capture',
      {},
    );
  }
}

const sameMembers = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * The suite is the contract every later stage trusts, so it is audited against the specification it
 * claims to encode rather than against its own word. A case nobody can trace, an assertion set that
 * is empty, a statistics block that disagrees with a recount — any of these would poison the
 * differential verdict downstream while looking perfectly plausible on disk.
 */
export function characterizationConsistencyCheck(rules: BusinessRuleSet, invariants: InvariantSet): CustomCheck {
  const ruleIds = new Set(rules.rules.map((rule) => rule.ruleId));
  const invariantIds = new Set(invariants.invariants.map((invariant) => invariant.invariantId));

  return (context) => {
    const payload = context.payloadOf('characterization.suite');
    if (payload === undefined) {
      return { satisfied: false, reason: 'no artifact of kind "characterization.suite" was produced' };
    }
    const parsed = characterizationSuiteSchema.safeParse(payload);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message ?? 'unknown schema issue';
      return { satisfied: false, reason: `characterization.suite does not parse: ${message}` };
    }
    const suite = parsed.data;
    const problems: string[] = [];

    const scenarioIds = new Set<string>();
    for (const item of suite.cases) {
      if (scenarioIds.has(item.scenario.scenarioId)) {
        problems.push(`${item.caseId} repeats scenario ${item.scenario.scenarioId}`);
      }
      scenarioIds.add(item.scenario.scenarioId);
      if (item.assertions.length === 0) problems.push(`${item.caseId} carries no assertion`);
      if (item.status === 'failing-against-legacy') {
        problems.push(`${item.caseId} is failing-against-legacy: the capture does not reproduce legacy against itself`);
      }
      if (item.captureExecutionId === undefined) problems.push(`${item.caseId} records no capture execution id`);
      for (const ruleId of item.targetRuleIds) {
        if (!ruleIds.has(ruleId)) problems.push(`${item.caseId} targets rule ${ruleId}, which the specification does not contain`);
      }
      for (const invariantId of item.targetInvariantIds) {
        if (!invariantIds.has(invariantId)) {
          problems.push(`${item.caseId} targets invariant ${invariantId}, which the specification does not contain`);
        }
      }
      for (const assertion of item.assertions) {
        for (const ruleId of assertion.sourceRuleIds) {
          if (!ruleIds.has(ruleId)) problems.push(`${item.caseId} assertion ${assertion.assertionId} cites unknown rule ${ruleId}`);
        }
        for (const invariantId of assertion.sourceInvariantIds) {
          if (!invariantIds.has(invariantId)) {
            problems.push(`${item.caseId} assertion ${assertion.assertionId} cites unknown invariant ${invariantId}`);
          }
        }
      }
    }

    const capturedScenarioIds = new Set(suite.captures.map((execution) => execution.scenarioId));
    for (const scenarioId of scenarioIds) {
      if (!capturedScenarioIds.has(scenarioId)) problems.push(`scenario ${scenarioId} has no recorded capture`);
    }

    const statistics = computeSuiteStatistics(suite);
    if (
      suite.statistics !== undefined &&
      (suite.statistics.total !== statistics.total ||
        suite.statistics.captured !== statistics.captured ||
        suite.statistics.assertions !== statistics.assertions ||
        suite.statistics.recordingLegacyDefects !== statistics.recordingLegacyDefects)
    ) {
      problems.push('the statistics block disagrees with a recount of the cases');
    }

    const expectedCoverage = computeCoverage({
      cases: suite.cases,
      knownRuleIds: rules.rules.map((rule) => rule.ruleId),
      knownInvariantIds: invariants.invariants.map((invariant) => invariant.invariantId),
    });
    const coverageMatches =
      sameMembers(expectedCoverage.ruleIdsCovered, suite.coverage.ruleIdsCovered) &&
      sameMembers(expectedCoverage.ruleIdsUncovered, suite.coverage.ruleIdsUncovered) &&
      sameMembers(expectedCoverage.invariantIdsCovered, suite.coverage.invariantIdsCovered) &&
      sameMembers(expectedCoverage.invariantIdsUncovered, suite.coverage.invariantIdsUncovered) &&
      sameMembers(expectedCoverage.categoriesCovered, suite.coverage.categoriesCovered);
    if (!coverageMatches) problems.push('the coverage block disagrees with a recomputation from the specification');

    if (problems.length > 0) {
      return { satisfied: false, reason: `${problems.length} problem(s): ${problems.slice(0, 6).join('; ')}` };
    }
    const assertions = suite.cases.reduce((acc, item) => acc + item.assertions.length, 0);
    return {
      satisfied: true,
      observed: `${suite.cases.length} case(s), ${assertions} assertion(s), every case traceable to the specification and backed by a recorded capture`,
    };
  };
}

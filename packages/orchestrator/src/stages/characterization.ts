import type { ZodType, ZodTypeDef } from 'zod';
import { runAgentTask, type AgentRun, type ArtifactExpectation, type OutputContext, type OutputContribution } from '@phoenix/agent-runtime';
import { captureSuite, type CaptureProgress, type ScenarioTarget } from '@phoenix/characterization';
import { slugAvoidingCollision } from '../slug.js';
import { snapshotLegacySeed } from './legacy-seed.js';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PhoenixError,
  agentTaskSchema,
  characterizationSuiteSchema,
  newTaskId,
  nowIso,
  type AgentResult,
  type AgentTask,
  type BusinessRuleSet,
  type CharacterizationSuite,
  type GeneratedArtifact,
  type InvariantSet,
  type RepositoryMap,
  type RunId,
  type TaskBudget,
  type TaskId,
  type TaskInputArtifact,
} from '@phoenix/shared';
import type { RunRuntime } from '../runtime.js';
import {
  assertProposalsAreUsable,
  caseIdFor,
  characterizationConsistencyCheck,
  knownClaimsOf,
  scenarioProposalReportSchema,
  toScenario,
  type ScenarioProposalReport,
} from './characterization-schema.js';

/**
 * CHARACTERIZE.
 *
 * The Characterization Engineer proposes scenarios; the host executes them. A proposal is steps and
 * a hypothesis — the schema gives it nowhere to declare an expected output, because expectations are
 * not authored, they are captured: every scenario runs against the live legacy system, twice, and
 * the assertions are frozen from what legacy actually did. The suite on disk is therefore legacy's
 * behavior, whatever it turns out to be — including its bugs, which is precisely what makes it a
 * standard the modern implementation can be measured against.
 */

export const CHARACTERIZATION_ROLE = 'characterization-engineer';
export const CHARACTERIZATION_SYSTEM_PROMPT = 'engineer.system';
export const CHARACTERIZATION_USER_PROMPT = 'engineer.scenarios';

const DEFAULT_OBJECTIVE = [
  'Propose 5 to 10 executable HTTP scenarios that probe the discovered business rules and invariants of this legacy system.',
  'Each scenario targets at least one rule or invariant from the specification.',
  'You do not decide what the responses should be; Phoenix captures what the legacy system actually does.',
].join(' ');

export interface CharacterizationStageOptions {
  runId: RunId;
  runtime: RunRuntime;
  /** The persisted specification the scenarios must trace to. */
  rules: BusinessRuleSet;
  invariants: InvariantSet;
  /** Deterministically discovered API surface used to reject invented routes before capture. */
  repositoryMap?: RepositoryMap;
  /** Upstream artifacts to record as inputs, so the suite's provenance points back at them. */
  specificationArtifacts?: readonly GeneratedArtifact[];
  taskId?: TaskId;
  brief?: CharacterizationBriefOptions;
  budget?: Partial<TaskBudget>;
  objective?: string;
  attempt?: number;
  repairIteration?: number;
  parentTaskId?: TaskId;
  /** Defaults to the configured legacy workload; overridable for tests. */
  target?: ScenarioTarget;
  signal?: AbortSignal;
}

export interface CharacterizationArtifacts {
  /** Absent when the task failed before the capture could be persisted. */
  suite?: GeneratedArtifact;
}

export interface SkippedCapture {
  caseId: string;
  reason: string;
}

export interface CharacterizationOutcome {
  task: AgentTask;
  run: AgentRun<ScenarioProposalReport>;
  result: AgentResult;
  artifacts: CharacterizationArtifacts;
  /** The persisted suite, read back from disk through its schema. */
  suite?: CharacterizationSuite;
  capturedCount: number;
  skipped: readonly SkippedCapture[];
  briefChars: number;
}

export async function runCharacterizationStage(options: CharacterizationStageOptions): Promise<CharacterizationOutcome> {
  const { runtime, runId, rules, invariants } = options;
  const taskId = options.taskId ?? newTaskId();
  const brief = characterizationBrief(rules, invariants, {
    ...(options.brief ?? {}),
    ...(options.repositoryMap === undefined ? {} : { repositoryMap: options.repositoryMap }),
  });
  const legacy = runtime.config.legacy;
  const target =
    options.target ?? (await attachLegacyReset(legacyCaptureTarget(legacy), runtime.config.databaseTargets.legacy));
  const capturedFrom = `${target.label} at ${target.baseUrl}`;
  const skipped: SkippedCapture[] = [];

  const inputs = (options.specificationArtifacts ?? []).map(toInput);

  const task = agentTaskSchema.parse({
    taskId,
    runId,
    stage: 'CHARACTERIZATION',
    role: CHARACTERIZATION_ROLE,
    objective: options.objective ?? DEFAULT_OBJECTIVE,
    context: buildContext(rules, invariants, brief, capturedFrom),
    inputArtifacts: inputs,
    allowedTools: DEFAULT_ROLE_PERMISSIONS[CHARACTERIZATION_ROLE].tools,
    permissions: runtime.permissionsFor(CHARACTERIZATION_ROLE),
    constraints: CHARACTERIZATION_CONSTRAINTS,
    acceptanceCriteria: CHARACTERIZATION_ACCEPTANCE_CRITERIA,
    expectedOutputs: ['characterization.suite'],
    budget: runtime.budgetFor(options.budget),
    createdAt: nowIso(),
    promptIds: [CHARACTERIZATION_SYSTEM_PROMPT, CHARACTERIZATION_USER_PROMPT],
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.repairIteration !== undefined ? { repairIteration: options.repairIteration } : {}),
    ...(options.parentTaskId !== undefined ? { parentTaskId: options.parentTaskId } : {}),
  });

  const known = knownClaimsOf(rules, invariants);

  const run = await runAgentTask<ScenarioProposalReport>(
    {
      task,
      systemPromptId: CHARACTERIZATION_SYSTEM_PROMPT,
      userPromptId: CHARACTERIZATION_USER_PROMPT,
      promptVariables: {
        brief,
        briefChars: brief.length,
        capturedFrom,
        repositoryRoot: runtime.paths.legacyRoot,
        ruleCount: rules.rules.length,
        invariantCount: invariants.invariants.length,
      },
      purpose: 'characterization.engineer',
      // Dangling references to the specification and unrunnable steps are repairable rejections
      // inside the loop; the schema factory carries this run's rule and invariant ids for that.
      outputSchema: scenarioProposalReportSchema(known, options.repositoryMap?.httpEndpoints),
      expectations: CHARACTERIZATION_EXPECTATIONS,
      customChecks: { 'characterization-consistent': characterizationConsistencyCheck(rules, invariants) },
      persistOutput: createCapturePersister({
        capturedFrom,
        target,
        known,
        taskId,
        suiteSlug: slugAvoidingCollision(
          runtime.artifacts,
          runId,
          'characterization.suite',
          undefined,
          taskId,
        ),
        onProgress: (event) => {
          const skip = collectSkip(event);
          if (skip !== undefined) skipped.push(skip);
          reportProgress(runtime, event);
        },
      }),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    runtime.agent,
  );

  const suiteArtifact = findOutput(run.result.generatedArtifacts);
  const suite = readBack(runtime, runId, suiteArtifact, characterizationSuiteSchema);

  return {
    task,
    run,
    result: run.result,
    artifacts: {
      ...(suiteArtifact !== undefined ? { suite: suiteArtifact } : {}),
    },
    ...(suite !== undefined ? { suite } : {}),
    capturedCount: suite?.cases.length ?? 0,
    skipped,
    briefChars: brief.length,
  };
}

function findOutput(artifacts: readonly GeneratedArtifact[]): GeneratedArtifact | undefined {
  return artifacts.find((artifact) => artifact.kind === 'characterization.suite');
}

function readBack<T>(
  runtime: RunRuntime,
  runId: RunId,
  artifact: GeneratedArtifact | undefined,
  schema: ZodType<T, ZodTypeDef, unknown>,
): T | undefined {
  if (artifact === undefined) return undefined;
  const meta = runtime.artifacts.find(runId, artifact.artifactId);
  if (meta === undefined) return undefined;
  return schema.parse(runtime.artifacts.readJson(meta, schema));
}

interface CapturePersisterOptions {
  capturedFrom: string;
  target: ScenarioTarget;
  known: ReturnType<typeof knownClaimsOf>;
  taskId: TaskId;
  /** Set when `characterization/suite.json` already belongs to an earlier attempt. */
  suiteSlug?: string;
  onProgress: (event: CaptureProgress) => void;
}

/**
 * Runs the proposals against the live legacy system, in host code, after the report is validated.
 * This is the only place expectations come from: the baseline execution. Nothing the model wrote is
 * compared with what legacy did — the model never saw legacy's responses.
 */
export function createCapturePersister(
  options: CapturePersisterOptions,
): (report: ScenarioProposalReport, context: OutputContext) => Promise<OutputContribution> {
  return async (report, context) => {
    assertProposalsAreUsable(report);
    const proposals = report.scenarios.map((proposal, index) => ({
      caseId: caseIdFor(index),
      scenario: toScenario(proposal),
    }));

    const capture = await captureSuite({
      capturedFrom: options.capturedFrom,
      generatedBy: context.task.role,
      proposals,
      knownRuleIds: [...options.known.ruleIds],
      knownInvariantIds: [...options.known.invariantIds],
      target: options.target,
      onProgress: options.onProgress,
    });

    const suite = capture.suite;
    const title = `${suite.cases.length} captured scenario(s), ${suite.statistics?.assertions ?? 0} assertion(s)`;
    const artifact = context.writer.writeJson('characterization.suite', suite, characterizationSuiteSchema, {
      ...(options.suiteSlug === undefined ? {} : { slug: options.suiteSlug }),
      title,
      tags: ['characterization', 'suite', 'captured'],
      inputs: context.inputs,
    });

    return {
      artifacts: [artifact],
      unresolvedUnknowns: capture.skipped.map((skip) => `${skip.caseId} skipped: ${skip.reason}`),
      narrative: report.summary,
    };
  };
}

function collectSkip(event: CaptureProgress): SkippedCapture | undefined {
  return event.phase === 'skipped' ? { caseId: event.caseId, reason: event.reason } : undefined;
}

function reportProgress(runtime: RunRuntime, event: CaptureProgress): void {
  switch (event.phase) {
    case 'baseline':
    case 'probe':
      runtime.logger.info('capture executing', { caseId: event.caseId, phase: event.phase });
      return;
    case 'captured':
      runtime.logger.info('capture recorded', {
        caseId: event.caseId,
        status: event.status,
        assertions: event.assertions,
        unexplainedVolatility: event.unexplained,
      });
      return;
    case 'skipped':
      runtime.logger.warn('capture skipped', { caseId: event.caseId, reason: event.reason });
      return;
  }
}

/**
 * Capture is an HTTP affair: the suite is frozen from responses, so a legacy target without a base
 * URL has nothing to answer and the stage refuses rather than capturing nothing.
 */
async function attachLegacyReset(target: ScenarioTarget, databaseUrl: string | undefined): Promise<ScenarioTarget> {
  if (databaseUrl === undefined || databaseUrl.length === 0) return target;
  const reset = await snapshotLegacySeed(databaseUrl);
  return { ...target, reset };
}

function legacyCaptureTarget(legacy: { label: string; baseUrl?: string }): ScenarioTarget {
  if (legacy.baseUrl === undefined) {
    throw new PhoenixError(
      'CONFIG_INVALID',
      `legacy target "${legacy.label}" has no base URL configured (LEGACY_BASE_URL); characterization captures over HTTP`,
      { label: legacy.label },
    );
  }
  return { system: 'legacy', label: legacy.label, baseUrl: legacy.baseUrl };
}

export const CHARACTERIZATION_CONSTRAINTS = [
  {
    id: 'EXPECTATIONS_ARE_CAPTURED',
    statement:
      'You do not provide expected outputs. Phoenix runs every scenario against the live legacy system and freezes what it actually did as the assertions. The proposal schema has no field for an expected response, and none can be added.',
    enforcement: 'architectural',
  },
  {
    id: 'HTTP_AND_WAIT_ONLY',
    statement:
      'The capture target is the legacy REST API. Only "http" and "wait" steps can run here; "sql", "command", "reset" and "assert-db" steps error out and the scenario is skipped.',
    enforcement: 'architectural',
  },
  {
    id: 'EVERY_SCENARIO_TRACES',
    statement:
      'Every scenario must target at least one rule or invariant id that exists in the specification. A scenario that cannot say which discovered claim it probes is rejected.',
    enforcement: 'architectural',
  },
  {
    id: 'STATE_PERSISTS_BETWEEN_RUNS',
    statement:
      'Each scenario is executed at least twice in a row, and later once per system, with no state reset between executions. Prefer scenarios that leave state unchanged — reads and rejected operations — or whose responses do not depend on prior state. A scenario that succeeds at changing a balance will disagree with its own second execution.',
    enforcement: 'prompt',
  },
  {
    id: 'PROBE_THE_RULE_NOT_THE_CODE',
    statement:
      'Scenario steps act on the system from outside: requests a client could really send. Do not design steps that depend on reading source files or on internal identifiers no API returns.',
    enforcement: 'prompt',
  },
  {
    id: 'LEGACY_DEFECTS_ARE_IN_SCOPE',
    statement:
      'If the behavior legacy actually exhibits is a defect — an odd fee, a strange rounding, a wrong status code — it is still the contract. Characterize it faithfully; the modern system must match it or the difference must be surfaced.',
    enforcement: 'prompt',
  },
] as const;

export const CHARACTERIZATION_ACCEPTANCE_CRITERIA = [
  {
    id: 'suite-present',
    description: 'characterization/suite.json exists.',
    kind: 'artifact-present',
    artifactKind: 'characterization.suite',
  },
  {
    id: 'suite-schema-valid',
    description: 'The suite validates against characterizationSuiteSchema.',
    kind: 'artifact-schema-valid',
    artifactKind: 'characterization.suite',
  },
  {
    id: 'usable-cases-min',
    description: 'At least five scenarios were captured with assertions that legacy reproduced.',
    kind: 'min-item-count',
    artifactKind: 'characterization.suite',
    minCount: 5,
  },
  {
    id: 'suite-self-consistent',
    description:
      'Every case traces to the specification, carries assertions and a real baseline capture, reproduces legacy against itself, and carries recomputable statistics.',
    kind: 'custom-check',
    checkId: 'characterization-consistent',
  },
] as const;

export const CHARACTERIZATION_EXPECTATIONS: readonly ArtifactExpectation[] = [
  {
    kind: 'characterization.suite',
    schema: characterizationSuiteSchema,
    // Only cases with assertions count toward item-level criteria: a capture that produced nothing
    // assertable is not a case that can judge the modern system.
    items: (payload) =>
      characterizationSuiteSchema
        .parse(payload)
        .cases.filter((item) => item.assertions.length > 0)
        .map((item) => ({ id: item.caseId, evidence: [], status: item.status })),
  },
];

export interface CharacterizationBriefOptions {
  /** Rules rendered into the brief; the rest are counted only. Default 30. */
  maxRules?: number;
  /** Invariants rendered into the brief. Default 20. */
  maxInvariants?: number;
  /** API surface produced by deterministic discovery. */
  repositoryMap?: RepositoryMap;
  /** Hard cap on the whole brief. Default 24000. */
  maxChars?: number;
}

/**
 * What the Engineer is handed: the specification's claims plus the API surface independently
 * extracted during discovery. Routes are invocation facts, not expected outcomes; including them
 * prevents an invented 404 from being mistaken for the behavior of a rule.
 */
export function characterizationBrief(
  rules: BusinessRuleSet,
  invariants: InvariantSet,
  options: CharacterizationBriefOptions = {},
): string {
  const maxRules = options.maxRules ?? 30;
  const maxInvariants = options.maxInvariants ?? 20;
  const maxChars = options.maxChars ?? 24_000;

  const lines: string[] = [
    `Specification summary: ${rules.rules.length} business rule(s), ${invariants.invariants.length} invariant(s).`,
    '',
    '## Business rules',
  ];
  for (const rule of rules.rules.slice(0, maxRules)) {
    lines.push(
      `### ${rule.ruleId} — ${rule.title} [${rule.kind}, ${rule.epistemicStatus}, confidence ${rule.confidence.toFixed(2)}]`,
    );
    lines.push(`Observable: ${rule.observableBehavior}`);
  }
  if (rules.rules.length > maxRules) lines.push(`(${rules.rules.length - maxRules} further rules omitted)`);
  if (invariants.invariants.length > 0) lines.push('', '## Invariants');
  for (const invariant of invariants.invariants.slice(0, maxInvariants)) {
    lines.push(`### ${invariant.invariantId} [${invariant.kind}, ${invariant.criticality}, ${invariant.epistemicStatus}]`);
    lines.push(invariant.statement);
    lines.push(`Check: ${invariant.checkingStrategy.detail}`);
  }
  if (invariants.invariants.length > maxInvariants) {
    lines.push(`(${invariants.invariants.length - maxInvariants} further invariants omitted)`);
  }
  if (options.repositoryMap !== undefined) {
    lines.push('', '## Discovered public HTTP surface');
    for (const endpoint of options.repositoryMap.httpEndpoints) {
      lines.push(
        `- ${endpoint.method} ${endpoint.path}` +
          (endpoint.requestBodySchemaHint === undefined ? '' : ` — ${endpoint.requestBodySchemaHint}`) +
          ` [${endpoint.handler.path}:${endpoint.handler.startLine ?? '?'}]`,
      );
    }
  }

  const text = lines.join('\n');
  return text.length <= maxChars ? text : `${text.slice(0, maxChars - 20)}\n…(truncated)`;
}

function buildContext(rules: BusinessRuleSet, invariants: InvariantSet, brief: string, capturedFrom: string): string {
  return [
    `Specification under test: ${rules.rules.length} business rule(s), ${invariants.invariants.length} invariant(s).`,
    `Capture target: the legacy system at ${capturedFrom}.`,
    `A bounded brief of ${brief.length} characters follows in your instructions. It lists the claims your scenarios must probe.`,
    'You propose scenarios only. Phoenix executes them against the live system and derives the assertions from what it observes.',
  ].join('\n');
}

function toInput(artifact: GeneratedArtifact): TaskInputArtifact {
  return { artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath, role: 'input' };
}

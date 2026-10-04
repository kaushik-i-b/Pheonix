import type { ZodType, ZodTypeDef } from 'zod';
import {
  runAgentTask,
  evidenceExistsCheck,
  type AgentRun,
  type ArtifactExpectation,
  type CustomCheck,
  type OutputContext,
  type OutputContribution,
} from '@phoenix/agent-runtime';
import {
  DEFAULT_ROLE_PERMISSIONS,
  agentTaskSchema,
  businessRuleSetSchema,
  computeInvariantStatistics,
  computeRuleStatistics,
  invariantSetSchema,
  newTaskId,
  nowIso,
  type AgentResult,
  type AgentTask,
  type BusinessRuleSet,
  type DiscoveryFindings,
  type GeneratedArtifact,
  type InvariantSet,
  type RunId,
  type TaskBudget,
  type TaskId,
  type TaskInputArtifact,
} from '@phoenix/shared';
import type { RunRuntime } from '../runtime.js';
import { anchorSpecificationCitations } from './specification-evidence.js';
import {
  analystReportSchema,
  assertSpecificationIsUsable,
  specificationUnknownsOf,
  toBusinessRuleSet,
  toInvariantSet,
  toSpecificationFindings,
  type AnalystReport,
} from './specification-schema.js';

/**
 * SPECIFY.
 *
 * The Analyst turns what the Archaeologist observed into candidate business rules and invariants —
 * the assertions every later stage is graded against. Two properties make this safe to build on:
 * every rule carries citations that are re-verified against the repository after the model finishes,
 * and every rule leaves the stage as `candidate`. Confirmation is something an executed test against
 * the legacy system does to a rule later; it is not something the proposing agent can claim, and the
 * schema it is given has no field for it.
 */

export const SPECIFICATION_ROLE = 'business-rule-analyst';
export const SPECIFICATION_SYSTEM_PROMPT = 'analyst.system';
export const SPECIFICATION_USER_PROMPT = 'analyst.rules';

const DEFAULT_OBJECTIVE = [
  'Derive the behavioral specification of this legacy system from the archaeological findings and the source they cite.',
  'State each business rule as something observable from outside the system, with the evidence that proves it.',
  'State each invariant as a falsifiable sentence, with the strategy that would check it.',
  'Record what you could not establish as an unknown rather than as a low-confidence rule.',
].join(' ');

export interface SpecificationStageOptions {
  runId: RunId;
  runtime: RunRuntime;
  /** The Archaeologist's persisted findings: the Analyst starts from them and re-reads what they cite. */
  findings: DiscoveryFindings;
  /** Discovery artifacts to record as inputs, so the specification's provenance points back at them. */
  discoveryArtifacts?: readonly GeneratedArtifact[];
  taskId?: TaskId;
  brief?: BriefOptions;
  budget?: Partial<TaskBudget>;
  objective?: string;
  attempt?: number;
  repairIteration?: number;
  parentTaskId?: TaskId;
  signal?: AbortSignal;
}

export interface SpecificationArtifacts {
  /** Absent when the task failed before its output could be persisted. */
  businessRules?: GeneratedArtifact;
  invariants?: GeneratedArtifact;
}

export interface SpecificationOutcome {
  task: AgentTask;
  run: AgentRun<AnalystReport>;
  result: AgentResult;
  artifacts: SpecificationArtifacts;
  rules?: BusinessRuleSet;
  invariants?: InvariantSet;
  briefChars: number;
}

export async function runSpecificationStage(
  options: SpecificationStageOptions,
): Promise<SpecificationOutcome> {
  const { runtime, runId, findings } = options;
  const taskId = options.taskId ?? newTaskId();
  const brief = specificationBrief(findings, options.brief ?? {});
  const targetRoot = runtime.paths.legacyRoot;

  const inputs = (options.discoveryArtifacts ?? []).map(toInput);

  const task = agentTaskSchema.parse({
    taskId,
    runId,
    stage: 'SPECIFICATION',
    role: SPECIFICATION_ROLE,
    objective: options.objective ?? DEFAULT_OBJECTIVE,
    context: buildContext(findings, brief, targetRoot),
    inputArtifacts: inputs,
    allowedTools: DEFAULT_ROLE_PERMISSIONS[SPECIFICATION_ROLE].tools,
    permissions: runtime.permissionsFor(SPECIFICATION_ROLE),
    constraints: SPECIFICATION_CONSTRAINTS,
    acceptanceCriteria: SPECIFICATION_ACCEPTANCE_CRITERIA,
    expectedOutputs: ['specification.business-rules', 'specification.invariants'],
    budget: runtime.budgetFor(options.budget),
    createdAt: nowIso(),
    promptIds: [SPECIFICATION_SYSTEM_PROMPT, SPECIFICATION_USER_PROMPT],
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.repairIteration !== undefined ? { repairIteration: options.repairIteration } : {}),
    ...(options.parentTaskId !== undefined ? { parentTaskId: options.parentTaskId } : {}),
  });

  const run = await runAgentTask<AnalystReport>(
    {
      task,
      systemPromptId: SPECIFICATION_SYSTEM_PROMPT,
      userPromptId: SPECIFICATION_USER_PROMPT,
      promptVariables: {
        brief,
        briefChars: brief.length,
        repositoryRoot: targetRoot,
        findingCount: findings.findings.length,
        openQuestionCount: findings.openQuestions.length,
      },
      purpose: 'specification.analyst',
      outputSchema: analystReportSchema,
      // Fabricated citations are a repairable rejection inside the loop, not a failed task after it.
      evidenceSource: (report) =>
        toSpecificationFindings(report, {
          collectedAt: nowIso(),
          collectedBy: `citation-check:${taskId}`,
        }),
      rewriteCitations: anchorSpecificationCitations,
      expectations: SPECIFICATION_EXPECTATIONS,
      customChecks: {
        'specification-consistent': specificationConsistencyCheck(targetRoot),
        // A specification citation is a claim about the legacy repository and nothing else; the
        // run's own artifacts must never count as a place a quote can live.
        'evidence-exists': evidenceExistsCheck({ roots: [targetRoot] }),
      },
      persistOutput: createSpecificationPersister(targetRoot),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    runtime.agent,
  );

  const businessRulesArtifact = findOutput(
    run.result.generatedArtifacts,
    'specification.business-rules',
  );
  const invariantsArtifact = findOutput(run.result.generatedArtifacts, 'specification.invariants');
  const rules = readBack(runtime, runId, businessRulesArtifact, businessRuleSetSchema);
  const invariants = readBack(runtime, runId, invariantsArtifact, invariantSetSchema);

  return {
    task,
    run,
    result: run.result,
    artifacts: {
      ...(businessRulesArtifact !== undefined ? { businessRules: businessRulesArtifact } : {}),
      ...(invariantsArtifact !== undefined ? { invariants: invariantsArtifact } : {}),
    },
    ...(rules !== undefined ? { rules } : {}),
    ...(invariants !== undefined ? { invariants } : {}),
    briefChars: brief.length,
  };
}

function findOutput(
  artifacts: readonly GeneratedArtifact[],
  kind: 'specification.business-rules' | 'specification.invariants',
): GeneratedArtifact | undefined {
  return artifacts.find((artifact) => artifact.kind === kind);
}

/**
 * Re-reads a persisted specification through its schema instead of trusting the in-memory value the
 * persister produced. What downstream stages consume is the bytes on disk, so those are what the
 * outcome reports.
 */
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

export const SPECIFICATION_CONSTRAINTS = [
  {
    id: 'LEGACY_IS_READ_ONLY',
    statement:
      'The legacy repository is evidence and must not be modified. write_file and apply_patch are not in your tool set, so no request to change it can succeed.',
    enforcement: 'architectural',
  },
  {
    id: 'CITATIONS_ARE_VERIFIED',
    statement:
      'Every rule, invariant and edge case must quote text that really appears in the file it cites, at a line that really exists. Citations are checked mechanically after you finish; one that does not resolve fails the task.',
    enforcement: 'architectural',
  },
  {
    id: 'RULES_LEAVE_AS_CANDIDATES',
    statement:
      'Everything you propose leaves this stage with lifecycleStatus "candidate". You cannot confirm a rule; only an executed test against the running legacy system can, and that happens in a later stage.',
    enforcement: 'architectural',
  },
  {
    id: 'REFERENCES_MUST_EXIST',
    statement:
      'A rule may only refer to rule and invariant ids present in the same report. A dangling reference fails the task rather than being silently dropped.',
    enforcement: 'architectural',
  },
  {
    id: 'STATE_BEHAVIOR_NOT_CODE',
    statement:
      'observableBehavior must describe what a caller can see — a status code, an amount, a row, an ordering — not how the code is written. It is what the tests will assert.',
    enforcement: 'prompt',
  },
  {
    id: 'SEPARATE_OBSERVATION_FROM_INFERENCE',
    statement:
      'Mark each rule and invariant OBSERVED, INFERRED or UNKNOWN, and say in confidenceBasis what would raise your confidence. Never present an inference as an observation.',
    enforcement: 'prompt',
  },
  {
    id: 'DOMAIN_NEUTRAL',
    statement:
      'Report the rules this system has, not the rules systems like it usually have. A rule you cannot trace to a file in this repository does not belong in the specification.',
    enforcement: 'prompt',
  },
  {
    id: 'RECORD_GAPS',
    statement:
      'Anything that cannot be settled by reading source — rounding observed only at runtime, ordering that depends on the database, retry behaviour under failure — goes into unknowns with the strategy that would resolve it.',
    enforcement: 'prompt',
  },
] as const;

export const SPECIFICATION_ACCEPTANCE_CRITERIA = [
  {
    id: 'business-rules-present',
    description: 'specification/business-rules.json exists.',
    kind: 'artifact-present',
    artifactKind: 'specification.business-rules',
  },
  {
    id: 'business-rules-schema-valid',
    description: 'The rule set validates against businessRuleSetSchema.',
    kind: 'artifact-schema-valid',
    artifactKind: 'specification.business-rules',
  },
  {
    id: 'invariants-present',
    description: 'specification/invariants.json exists.',
    kind: 'artifact-present',
    artifactKind: 'specification.invariants',
  },
  {
    id: 'invariants-schema-valid',
    description: 'The invariant set validates against invariantSetSchema.',
    kind: 'artifact-schema-valid',
    artifactKind: 'specification.invariants',
  },
  {
    id: 'rules-nonempty',
    description: 'At least one evidenced business rule was recorded.',
    kind: 'min-item-count',
    artifactKind: 'specification.business-rules',
    minCount: 1,
  },
  {
    id: 'invariants-nonempty',
    description: 'At least one evidenced invariant was recorded.',
    kind: 'min-item-count',
    artifactKind: 'specification.invariants',
    minCount: 1,
  },
  {
    id: 'every-rule-evidenced',
    description: 'No business rule is asserted without source evidence.',
    kind: 'every-item-has-evidence',
    artifactKind: 'specification.business-rules',
  },
  {
    id: 'every-invariant-evidenced',
    description: 'No invariant is asserted without source evidence.',
    kind: 'every-item-has-evidence',
    artifactKind: 'specification.invariants',
  },
  {
    id: 'citations-resolve',
    description: 'Every cited file, line and quotation exists in the repository as quoted.',
    kind: 'custom-check',
    checkId: 'evidence-exists',
  },
  {
    id: 'specification-self-consistent',
    description:
      'The persisted specification describes this repository, refers only to claims it contains, carries recomputable statistics, and confirms nothing itself.',
    kind: 'custom-check',
    checkId: 'specification-consistent',
  },
] as const;

export const SPECIFICATION_EXPECTATIONS: readonly ArtifactExpectation[] = [
  {
    kind: 'specification.business-rules',
    schema: businessRuleSetSchema,
    items: (payload) =>
      businessRuleSetSchema.parse(payload).rules.map((rule) => ({
        id: rule.ruleId,
        evidence: rule.sourceEvidence,
        status: rule.epistemicStatus,
      })),
  },
  {
    kind: 'specification.invariants',
    schema: invariantSetSchema,
    items: (payload) =>
      invariantSetSchema.parse(payload).invariants.map((invariant) => ({
        id: invariant.invariantId,
        evidence: invariant.sourceEvidence,
        status: invariant.epistemicStatus,
      })),
  },
];

/**
 * Re-derives what the persisted documents claim and compares. Statistics that do not match the rules
 * they describe, references to claims that are not there, a `targetRoot` that is not this
 * repository, or a rule that arrived already `confirmed` are all refused here rather than carried
 * into characterization, where they would silently decide what gets tested.
 */
export function specificationConsistencyCheck(targetRoot: string): CustomCheck {
  return (context) => {
    const rulesPayload = context.payloadOf('specification.business-rules');
    const invariantsPayload = context.payloadOf('specification.invariants');
    if (rulesPayload === undefined || invariantsPayload === undefined) {
      return {
        satisfied: false,
        reason:
          rulesPayload === undefined && invariantsPayload === undefined
            ? 'neither specification document could be read back'
            : 'only one of the two specification documents could be read back',
      };
    }

    let rules: BusinessRuleSet;
    let invariants: InvariantSet;
    try {
      rules = businessRuleSetSchema.parse(rulesPayload);
      invariants = invariantSetSchema.parse(invariantsPayload);
    } catch (error) {
      return {
        satisfied: false,
        reason: `the persisted specification does not validate: ${describe(error)}`,
      };
    }

    const problems: string[] = [];
    for (const document of [rules, invariants]) {
      if (document.targetRoot !== targetRoot) {
        problems.push(`targetRoot is ${document.targetRoot}, but this run analysed ${targetRoot}`);
      }
    }
    if (rules.statistics === undefined) {
      problems.push('the rule set carries no statistics');
    } else if (
      JSON.stringify(rules.statistics) !== JSON.stringify(computeRuleStatistics(rules.rules))
    ) {
      problems.push('the rule statistics do not match the rules they describe');
    }
    if (invariants.statistics === undefined) {
      problems.push('the invariant set carries no statistics');
    } else if (
      JSON.stringify(invariants.statistics) !==
      JSON.stringify(computeInvariantStatistics(invariants.invariants))
    ) {
      problems.push('the invariant statistics do not match the invariants they describe');
    }

    const ruleIds = new Set(rules.rules.map((rule) => rule.ruleId));
    const invariantIds = new Set(invariants.invariants.map((invariant) => invariant.invariantId));
    for (const rule of rules.rules) {
      if (rule.contradictsRuleIds.some((id) => !ruleIds.has(id))) {
        problems.push(`${rule.ruleId} contradicts a rule that is not in the specification`);
      }
      if (rule.derivedFromInvariantIds.some((id) => !invariantIds.has(id))) {
        problems.push(`${rule.ruleId} derives from an invariant that is not in the specification`);
      }
      if (rule.lifecycleStatus !== 'candidate') {
        problems.push(
          `${rule.ruleId} arrived as "${rule.lifecycleStatus}"; only an executed test may confirm a rule`,
        );
      }
      if (rule.confirmation !== undefined) {
        problems.push(
          `${rule.ruleId} carries a confirmation, which no agent may write for its own rule`,
        );
      }
      if (rule.epistemicStatus === 'OBSERVED' && !citesALine(rule.sourceEvidence)) {
        problems.push(`${rule.ruleId} is OBSERVED but cites no line or symbol`);
      }
    }
    for (const invariant of invariants.invariants) {
      if (invariant.derivedFromRuleIds.some((id) => !ruleIds.has(id))) {
        problems.push(
          `${invariant.invariantId} derives from a rule that is not in the specification`,
        );
      }
      if (invariant.lifecycleStatus !== 'candidate') {
        problems.push(
          `${invariant.invariantId} arrived as "${invariant.lifecycleStatus}"; only an executed check may confirm it`,
        );
      }
      if (invariant.epistemicStatus === 'OBSERVED' && !citesALine(invariant.sourceEvidence)) {
        problems.push(`${invariant.invariantId} is OBSERVED but cites no line or symbol`);
      }
    }

    if (problems.length > 0) {
      return {
        satisfied: false,
        reason: `${problems.length} consistency problem(s): ${problems.slice(0, 8).join('; ')}`,
        observed: problems.join(' | '),
      };
    }
    return {
      satisfied: true,
      observed: `${rules.rules.length} rule(s) and ${invariants.invariants.length} invariant(s), all candidate, statistics recomputed and matching`,
    };
  };
}

function citesALine(
  evidence: readonly { location?: { startLine?: number; symbol?: string } }[],
): boolean {
  return evidence.some(
    (item) => item.location?.startLine !== undefined || item.location?.symbol !== undefined,
  );
}

/**
 * Runs in host code, after the report has been validated: identity, timestamps, attribution and
 * statistics are stamped here, and a report that would produce an unusable specification is refused
 * instead of being written out as a success.
 */
export function createSpecificationPersister(
  targetRoot: string,
): (report: AnalystReport, context: OutputContext) => OutputContribution {
  return (report, context) => {
    assertSpecificationIsUsable(report);
    const attribution = {
      generatedAt: nowIso(),
      generatedBy: `${context.task.role}:${context.task.taskId}`,
      targetRoot,
    };
    const ruleSet = toBusinessRuleSet(report, attribution);
    const invariantSet = toInvariantSet(report, attribution);
    const title = (count: number, noun: string) =>
      `${count} ${noun}${count === 1 ? '' : 's'} (${report.unknowns.length} recorded unknown(s))`;

    const businessRules = context.writer.writeJson(
      'specification.business-rules',
      ruleSet,
      businessRuleSetSchema,
      {
        title: title(ruleSet.rules.length, 'business rule'),
        tags: ['specification', 'business-rules', 'structured'],
        inputs: context.inputs,
      },
    );
    const invariants = context.writer.writeJson(
      'specification.invariants',
      invariantSet,
      invariantSetSchema,
      {
        title: title(invariantSet.invariants.length, 'invariant'),
        tags: ['specification', 'invariants', 'structured'],
        inputs: context.inputs,
      },
    );

    return {
      artifacts: [businessRules, invariants],
      findings: toSpecificationFindings(report, {
        collectedAt: attribution.generatedAt,
        collectedBy: attribution.generatedBy,
      }),
      unresolvedUnknowns: specificationUnknownsOf(report),
      narrative: report.summary,
    };
  };
}

export interface BriefOptions {
  /** Findings rendered into the brief; the rest are named by id only. Default 40. */
  maxFindings?: number;
  /** Hard cap on the whole brief, so it cannot crowd out the model's own tool budget. Default 24000. */
  maxChars?: number;
}

/**
 * What the Analyst is handed: the Archaeologist's claims with their citations, and nothing else.
 * The report's prose sections are left out on purpose — the Analyst should form its own reading of
 * the files, and a summary of a summary is how a mistake becomes a rule. The quoted text of each
 * citation is left out for the same reason: a brief that carried it would let the Analyst write a
 * rule about code it never opened, and every citation it then produced would fail the
 * read-before-you-cite check.
 */
export function specificationBrief(
  findings: DiscoveryFindings,
  options: BriefOptions = {},
): string {
  const maxFindings = options.maxFindings ?? 40;
  const maxChars = options.maxChars ?? 24_000;

  const lines: string[] = [`Archaeological summary: ${findings.summary}`, ''];
  for (const finding of findings.findings.slice(0, maxFindings)) {
    lines.push(
      `## ${finding.id} — ${finding.summary} [${finding.kind}, ${finding.epistemicStatus}, confidence ${finding.confidence.toFixed(2)}${
        finding.severity !== undefined ? `, ${finding.severity}` : ''
      }]`,
    );
    if (finding.detail !== undefined) lines.push(finding.detail);
    if (finding.affectedComponents.length > 0)
      lines.push(`Components: ${finding.affectedComponents.join(', ')}`);
    for (const item of finding.evidence) {
      const where = [
        item.location?.path ?? '(no path)',
        item.location?.startLine !== undefined
          ? `:${item.location.startLine}${item.location.endLine !== undefined ? `-${item.location.endLine}` : ''}`
          : '',
        item.location?.symbol !== undefined ? ` (${item.location.symbol})` : '',
      ].join('');
      lines.push(`  evidence ${item.id}: ${where}${withheldOf(item)}`);
      if (item.note !== undefined) lines.push(`    note: ${clip(item.note, 300)}`);
    }
    lines.push('');
  }
  if (findings.findings.length > maxFindings) {
    lines.push(
      `${findings.findings.length - maxFindings} further finding(s) were omitted from this brief; they are in discovery/findings.json and their ids are: ${findings.findings
        .slice(maxFindings)
        .map((finding) => finding.id)
        .join(', ')}`,
      '',
    );
  }
  if (findings.openQuestions.length > 0) {
    lines.push('## Open questions left by discovery');
    for (const question of findings.openQuestions) {
      lines.push(
        `- ${question.id} [${question.resolutionStrategy}]: ${question.question}${
          question.whyItMatters !== undefined ? ` — ${clip(question.whyItMatters, 300)}` : ''
        }`,
      );
    }
    lines.push('');
  }

  const brief = lines.join('\n');
  if (brief.length <= maxChars) return brief;
  // Say so rather than letting the model believe it saw everything: a truncated brief that looks
  // complete is how a rule gets proposed from evidence nobody read.
  return `${brief.slice(0, maxChars)}\n\n[brief truncated at ${maxChars} characters of ${brief.length}; findings beyond this point were not shown — read discovery/findings.json for the rest]`;
}

function toInput(artifact: GeneratedArtifact): TaskInputArtifact {
  return {
    artifactId: artifact.artifactId,
    kind: artifact.kind,
    relativePath: artifact.relativePath,
    role: 'input',
  };
}

type EvidenceItem = DiscoveryFindings['findings'][number]['evidence'][number];

/**
 * How much text the citation holds, without holding it. The Analyst learns there is something to go
 * and read; reading it is the only way the evidence becomes usable in its own report.
 */
function withheldOf(item: EvidenceItem): string {
  const parts: string[] = [];
  if (item.quote !== undefined && item.quote.trim().length > 0)
    parts.push(`${item.quote.length} characters quoted`);
  if (item.observation !== undefined && item.observation.trim().length > 0)
    parts.push(`${item.observation.length} characters observed`);
  if (parts.length === 0) return '';
  return ` — ${parts.join(', ')} in discovery/findings.json, text withheld here: open the file`;
}

function buildContext(findings: DiscoveryFindings, brief: string, targetRoot: string): string {
  return [
    `Repository under specification: ${targetRoot}`,
    `Upstream discovery recorded ${findings.findings.length} finding(s) and ${findings.openQuestions.length} open question(s).`,
    `A ${brief.length}-character brief of those findings and their citations follows in your instructions. Citations are locations, not text: open every file you intend to rely on with your tools and read the surrounding code before you turn an observation into a rule.`,
    'Discovery may itself have been wrong. Where the code contradicts a finding, specify what the code says and record the contradiction.',
  ].join('\n');
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { createArtifactWriter, evidenceExistsCheck, runAgentTask, type AgentRun, type ArtifactExpectation, type OutputContext, type OutputContribution } from '@phoenix/agent-runtime';
import { ANALYSIS_GENERATOR, analyzeRepository, type RepositoryAnalysis } from '@phoenix/legacy-analysis';
import {
  DEFAULT_ROLE_PERMISSIONS,
  agentTaskSchema,
  dataFlowSchema,
  dependencyMapSchema,
  discoveryFindingsSchema,
  newTaskId,
  nowIso,
  renderDiscoveryFindingsMarkdown,
  repositoryMapSchema,
  type AgentResult,
  type AgentTask,
  type DataFlow,
  type DependencyMap,
  type DiscoveryFindings,
  type GeneratedArtifact,
  type RepositoryMap,
  type RunId,
  type TaskBudget,
  type TaskId,
  type TaskInputArtifact,
} from '@phoenix/shared';
import type { RunRuntime } from '../runtime.js';
import { discoveryConsistencyCheck, discoveryDigest, type DigestOptions } from './discovery-digest.js';
import { anchorReportCitations } from './discovery-evidence.js';
import {
  archaeologistReportSchema,
  assertReportIsUsable,
  toDiscoveryFindings,
  toFindings,
  unresolvedUnknownsOf,
  type ArchaeologistReport,
} from './discovery-schema.js';

/**
 * DISCOVER.
 *
 * Two producers, one stage. Static analysis writes the structural artifacts — repository map,
 * dependency map, data flow — deterministically, before any model is called; they are facts about
 * bytes on disk and they are reproducible. The Archaeologist then reads the real files through its
 * tools and contributes interpretation, which is persisted only after its citations have been
 * checked against those same bytes. Neither producer grades itself: acceptance is evaluated by the
 * runtime against the artifacts that ended up on disk.
 */

export const DISCOVERY_ROLE = 'archaeologist';
export const DISCOVERY_SYSTEM_PROMPT = 'archaeologist.system';
export const DISCOVERY_USER_PROMPT = 'archaeologist.findings';

const DEFAULT_OBJECTIVE = [
  'Establish what this legacy system actually does, from its code and schema alone.',
  'Report the behaviour you can prove, the behaviour you can only infer, and what you could not determine.',
  'Every finding must quote the file and lines it came from.',
].join(' ');

export interface DiscoveryStageOptions {
  runId: RunId;
  runtime: RunRuntime;
  /** Supply to resume or re-run a specific task identity. */
  taskId?: TaskId;
  /** Reuse an analysis already performed; otherwise the repository is walked here. */
  analysis?: RepositoryAnalysis;
  analysisLimits?: { maxFiles?: number; maxContentBytes?: number };
  digest?: DigestOptions;
  budget?: Partial<TaskBudget>;
  objective?: string;
  attempt?: number;
  repairIteration?: number;
  parentTaskId?: TaskId;
  signal?: AbortSignal;
}

export interface DiscoveryArtifacts {
  repositoryMap: GeneratedArtifact;
  dependencyMap: GeneratedArtifact;
  dataFlow: GeneratedArtifact;
  /** Absent when the task failed before its report could be persisted. */
  findingsMarkdown?: GeneratedArtifact;
  findingsJson?: GeneratedArtifact;
}

export interface DiscoveryOutcome {
  task: AgentTask;
  run: AgentRun<ArchaeologistReport>;
  result: AgentResult;
  analysis: RepositoryAnalysis;
  artifacts: DiscoveryArtifacts;
  /** The persisted structured findings, when the stage got that far. */
  findings?: DiscoveryFindings;
  digestChars: number;
}

export async function runDiscoveryStage(options: DiscoveryStageOptions): Promise<DiscoveryOutcome> {
  const { runtime, runId } = options;
  const taskId = options.taskId ?? newTaskId();

  const analysis =
    options.analysis ??
    analyzeRepository({
      root: runtime.paths.legacyRoot,
      generator: ANALYSIS_GENERATOR,
      ...(options.analysisLimits?.maxFiles !== undefined ? { maxFiles: options.analysisLimits.maxFiles } : {}),
      ...(options.analysisLimits?.maxContentBytes !== undefined
        ? { maxContentBytes: options.analysisLimits.maxContentBytes }
        : {}),
    });

  const writer = createArtifactWriter({
    store: runtime.artifacts,
    events: runtime.events,
    run: { runId, stage: 'DISCOVERY', role: DISCOVERY_ROLE, taskId },
    generator: ANALYSIS_GENERATOR,
  });

  const repositoryMap = writer.writeJson('discovery.repository-map', analysis.repositoryMap, repositoryMapSchema, {
    title: `repository map (${analysis.repositoryMap.fileCount} files)`,
    tags: ['discovery', 'deterministic'],
  });
  const dependencyMap = writer.writeJson('discovery.dependency-map', analysis.dependencyMap, dependencyMapSchema, {
    title: `dependency map (${analysis.dependencyMap.nodes.length} nodes)`,
    tags: ['discovery', 'deterministic'],
  });
  const dataFlow = writer.writeJson('discovery.data-flow', analysis.dataFlow, dataFlowSchema, {
    title: `data flow (${analysis.dataFlow.flows.length} flows)`,
    tags: ['discovery', 'deterministic'],
  });

  const digest = discoveryDigest(analysis, options.digest ?? {});
  const precomputed = [repositoryMap, dependencyMap, dataFlow];

  const task = agentTaskSchema.parse({
    taskId,
    runId,
    stage: 'DISCOVERY',
    role: DISCOVERY_ROLE,
    objective: options.objective ?? DEFAULT_OBJECTIVE,
    context: buildContext(analysis, digest),
    inputArtifacts: precomputed.map(toInput),
    allowedTools: DEFAULT_ROLE_PERMISSIONS[DISCOVERY_ROLE].tools,
    permissions: runtime.permissionsFor(DISCOVERY_ROLE),
    constraints: DISCOVERY_CONSTRAINTS,
    acceptanceCriteria: DISCOVERY_ACCEPTANCE_CRITERIA,
    expectedOutputs: ['discovery.findings'],
    budget: runtime.budgetFor(options.budget),
    createdAt: nowIso(),
    promptIds: [DISCOVERY_SYSTEM_PROMPT, DISCOVERY_USER_PROMPT],
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.repairIteration !== undefined ? { repairIteration: options.repairIteration } : {}),
    ...(options.parentTaskId !== undefined ? { parentTaskId: options.parentTaskId } : {}),
  });

  const run = await runAgentTask<ArchaeologistReport>(
    {
      task,
      systemPromptId: DISCOVERY_SYSTEM_PROMPT,
      userPromptId: DISCOVERY_USER_PROMPT,
      promptVariables: {
        digest,
        digestChars: digest.length,
        repositoryRoot: runtime.paths.legacyRoot,
        analysisTruncated: analysis.truncated,
        endpointCount: analysis.repositoryMap.httpEndpoints.length,
        databaseObjectCount: analysis.repositoryMap.databaseObjects.length,
        migrationCount: analysis.repositoryMap.migrations.length,
        scheduledJobCount: analysis.repositoryMap.scheduledJobs.length,
        suspiciousCount: analysis.repositoryMap.suspiciousBehaviors.length,
      },
      purpose: 'discovery.archaeologist',
      outputSchema: archaeologistReportSchema,
      // Citations are checked here, inside the loop, so a fabricated path is a repairable rejection
      // rather than a failed task; the acceptance check re-verifies the persisted artifact below.
      evidenceSource: (report) => toFindings(report, { collectedAt: nowIso(), collectedBy: `citation-check:${taskId}` }),
      // Last-resort host repair for quotes the model paraphrased: the host locates them in the real
      // bytes and rewrites the evidence, on the last attempt demoting unanchorable findings to open
      // questions. The rewritten report is re-parsed and re-checked by the loop before acceptance.
      rewriteCitations: anchorReportCitations,
      precomputedArtifacts: precomputed,
      expectations: DISCOVERY_EXPECTATIONS,
      customChecks: {
        'discovery-consistent': discoveryConsistencyCheck(analysis),
        // Confined to the repository under analysis: every citation here is a claim about where code
        // lives, and only that repository may vouch for one.
        'evidence-exists': evidenceExistsCheck({ roots: [runtime.paths.legacyRoot] }),
      },
      persistOutput: persistDiscoveryOutput,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    runtime.agent,
  );

  const findingsArtifact = run.result.generatedArtifacts.find(
    (artifact) => artifact.kind === 'discovery.findings' && artifact.relativePath === 'discovery/findings.json',
  );
  const findingsMarkdown = run.result.generatedArtifacts.find(
    (artifact) => artifact.kind === 'discovery.findings' && artifact.relativePath === 'discovery/findings.md',
  );
  const findingsMeta =
    findingsArtifact === undefined ? undefined : runtime.artifacts.find(runId, findingsArtifact.artifactId);
  const findings =
    findingsMeta === undefined
      ? undefined
      : discoveryFindingsSchema.parse(runtime.artifacts.readJson(findingsMeta, discoveryFindingsSchema));

  return {
    task,
    run,
    result: run.result,
    analysis,
    artifacts: {
      repositoryMap,
      dependencyMap,
      dataFlow,
      ...(findingsMarkdown !== undefined ? { findingsMarkdown } : {}),
      ...(findingsArtifact !== undefined ? { findingsJson: findingsArtifact } : {}),
    },
    ...(findings !== undefined ? { findings } : {}),
    digestChars: digest.length,
  };
}

export const DISCOVERY_CONSTRAINTS = [
  {
    id: 'LEGACY_IS_READ_ONLY',
    statement:
      'The legacy repository is evidence and must not be modified. write_file and apply_patch are not in your tool set, so no request to change it can succeed.',
    enforcement: 'architectural',
  },
  {
    id: 'NO_SHELL',
    statement:
      'You cannot execute commands. run_command and run_tests are not granted to this role; anything you need must be read from a file or queried from the database.',
    enforcement: 'architectural',
  },
  {
    id: 'DATABASE_READ_ONLY',
    statement: 'Database access is read-only and limited to the "legacy" target; writes and other targets are refused by the tool layer.',
    enforcement: 'architectural',
  },
  {
    id: 'CITATIONS_ARE_VERIFIED',
    statement:
      'Every finding must quote text that really appears in the file it cites, at a line that really exists. Citations are checked mechanically after you finish; a citation that does not resolve fails the task.',
    enforcement: 'architectural',
  },
  {
    id: 'SEPARATE_OBSERVATION_FROM_INFERENCE',
    statement:
      'Mark each finding OBSERVED, INFERRED or UNKNOWN. Never present an inference as an observation, and never fill a gap with a plausible guess.',
    enforcement: 'prompt',
  },
  {
    id: 'DO_NOT_INVENT_INTENT',
    statement:
      'If the code does not show why a rule exists, record it as an open question with a resolution strategy instead of inventing a business rationale.',
    enforcement: 'prompt',
  },
  {
    id: 'REPORT_THE_UGLINESS',
    statement:
      'Swallowed exceptions, magic numbers, duplicated calculations that disagree, database-side behaviour and time dependence are findings, not noise. Report them.',
    enforcement: 'prompt',
  },
] as const;

export const DISCOVERY_ACCEPTANCE_CRITERIA = [
  {
    id: 'repository-map-present',
    description: 'The deterministic repository map was persisted for this run.',
    kind: 'artifact-present',
    artifactKind: 'discovery.repository-map',
  },
  {
    id: 'dependency-map-present',
    description: 'The deterministic dependency map was persisted for this run.',
    kind: 'artifact-present',
    artifactKind: 'discovery.dependency-map',
  },
  {
    id: 'data-flow-present',
    description: 'The deterministic data-flow document was persisted for this run.',
    kind: 'artifact-present',
    artifactKind: 'discovery.data-flow',
  },
  {
    id: 'findings-present',
    description: 'discovery/findings.json exists.',
    kind: 'artifact-present',
    artifactKind: 'discovery.findings',
  },
  {
    id: 'findings-schema-valid',
    description: 'The findings document validates against discoveryFindingsSchema.',
    kind: 'artifact-schema-valid',
    artifactKind: 'discovery.findings',
  },
  {
    id: 'findings-nonempty',
    description: 'At least one evidenced finding was recorded.',
    kind: 'min-item-count',
    artifactKind: 'discovery.findings',
    minCount: 1,
  },
  {
    id: 'every-finding-evidenced',
    description: 'No finding is asserted without evidence.',
    kind: 'every-item-has-evidence',
    artifactKind: 'discovery.findings',
  },
  {
    id: 'citations-resolve',
    description: 'Every cited file, line and quotation exists in the repository as quoted.',
    kind: 'custom-check',
    checkId: 'evidence-exists',
  },
  {
    id: 'analysis-self-consistent',
    description: 'The deterministic analysis refers only to files, nodes and stores it actually found.',
    kind: 'custom-check',
    checkId: 'discovery-consistent',
  },
] as const;

export const DISCOVERY_EXPECTATIONS: readonly ArtifactExpectation[] = [
  { kind: 'discovery.repository-map', schema: repositoryMapSchema },
  { kind: 'discovery.dependency-map', schema: dependencyMapSchema },
  { kind: 'discovery.data-flow', schema: dataFlowSchema },
  {
    kind: 'discovery.findings',
    relativePath: 'discovery/findings.json',
    schema: discoveryFindingsSchema,
    items: (payload) =>
      discoveryFindingsSchema.parse(payload).findings.map((finding) => ({
        id: finding.id,
        evidence: finding.evidence,
        status: finding.epistemicStatus,
      })),
  },
];

/**
 * Turns a validated report into artifacts. Runs in host code: identity, timestamps and attribution
 * are stamped here rather than accepted from the model, and a report that claims nothing is refused
 * instead of being written out as an empty success.
 */
export function persistDiscoveryOutput(report: ArchaeologistReport, context: OutputContext): OutputContribution {
  assertReportIsUsable(report);
  const document = toDiscoveryFindings(report, {
    collectedAt: nowIso(),
    collectedBy: `${context.task.role}:${context.task.taskId}`,
  });
  // Markdown first: `latest('discovery.findings')` must resolve to the JSON document, which is the
  // one every downstream stage parses.
  const markdown = context.writer.writeText('discovery.findings', renderDiscoveryFindingsMarkdown(document), {
    title: `discovery findings (${document.findings.length} finding(s), ${document.openQuestions.length} open question(s))`,
    tags: ['discovery', 'findings'],
    format: 'markdown',
    inputs: context.inputs,
  });
  const json = context.writer.writeJson('discovery.findings', document, discoveryFindingsSchema, {
    slug: 'findings.json',
    title: `discovery findings (${document.findings.length} finding(s), ${document.openQuestions.length} open question(s))`,
    tags: ['discovery', 'findings', 'structured'],
    inputs: context.inputs,
  });
  return {
    artifacts: [markdown, json],
    findings: document.findings,
    unresolvedUnknowns: unresolvedUnknownsOf(report),
    narrative: report.summary,
  };
}

function toInput(artifact: GeneratedArtifact): TaskInputArtifact {
  return { artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath, role: 'input' };
}

function buildContext(analysis: RepositoryAnalysis, digest: string): string {
  const map: RepositoryMap = analysis.repositoryMap;
  const graph: DependencyMap = analysis.dependencyMap;
  const flows: DataFlow = analysis.dataFlow;
  return [
    `Repository under investigation: ${map.rootPath}`,
    `Inventory: ${map.fileCount} files, ${map.totalBytes} bytes, primary language ${map.primaryLanguage ?? 'undetermined'}.`,
    analysis.truncated
      ? 'THE INVENTORY IS TRUNCATED. Files exist that you have not been shown; say so rather than assuming completeness.'
      : 'The inventory is complete for this repository.',
    `Structure: ${map.httpEndpoints.length} HTTP endpoint(s), ${map.databaseObjects.length} database object(s), ${map.migrations.length} migration(s), ${map.scheduledJobs.length} scheduled job(s), ${graph.nodes.length} call-graph node(s), ${flows.flows.length} traced flow(s).`,
    `Flagged by static analysis: ${map.suspiciousBehaviors.length} suspicious construct(s), ${map.duplicationClusters.length} duplication cluster(s).`,
    `A bounded orientation digest of ${digest.length} characters follows in your instructions. It is an index, not a substitute: open the real files with your tools before you assert anything about them.`,
  ].join('\n');
}

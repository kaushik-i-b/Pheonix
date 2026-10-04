import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import type { ZodType, ZodTypeDef } from 'zod';
import {
  runAgentTask,
  type AgentRun,
  type ArtifactExpectation,
  type CustomCheck,
  type OutputContext,
  type OutputContribution,
} from '@phoenix/agent-runtime';
import {
  PhoenixError,
  READ_ONLY_TOOLS,
  agentTaskSchema,
  canonicalizePath,
  newTaskId,
  nowIso,
  pathIsInsideAny,
  type AgentResult,
  type AgentTask,
  type BusinessRuleSet,
  type GeneratedArtifact,
  type InvariantSet,
  type RunId,
  type Scenario,
  type TaskBudget,
  type TaskId,
  type TaskInputArtifact,
} from '@phoenix/shared';
import type { RunRuntime } from '../runtime.js';
import {
  assertModernizationIsUsable,
  modernizationChangeReportSchema,
  modernizationReportSchema,
  modernizationScenarioBrief,
  modernizationSpecBrief,
  type ModernizationChangeReport,
  type ModernizationReport,
} from './modernization-schema.js';

/**
 * MODERNIZE.
 *
 * The Modernizer returns the smallest implementation the specification supports, as file contents in
 * its structured answer. It has no write tools and no field to claim correctness: the host writes
 * the files, and the differential harness — not the Modernizer — decides whether the code matches
 * legacy. Everything the host writes is hashed into the change report, and the acceptance check
 * re-reads the disk to confirm the report describes what is really there.
 */

export const MODERNIZATION_ROLE = 'modernizer';
export const MODERNIZATION_SYSTEM_PROMPT = 'modernizer.system';
export const MODERNIZATION_USER_PROMPT = 'modernizer.implementation';

const DEFAULT_OBJECTIVE = [
  'Implement the modern replacement for the legacy system specified below.',
  'Reproduce the observable behavior of every business rule and every characterization scenario, deriving the details from the legacy source itself.',
  'Return the complete files in your answer; the host writes them and the differential harness judges them.',
].join(' ');

export interface ModernizationStageOptions {
  runId: RunId;
  runtime: RunRuntime;
  rules: BusinessRuleSet;
  invariants: InvariantSet;
  /** Characterization scenarios whose requests the implementation must handle. */
  scenarios: readonly Scenario[];
  /** Specification and suite artifacts, recorded as inputs for provenance. */
  inputArtifacts?: readonly GeneratedArtifact[];
  taskId?: TaskId;
  budget?: Partial<TaskBudget>;
  objective?: string;
  /** Rendered differential failures on a repair iteration; defaults to "none yet" on the first pass. */
  failureReport?: string;
  attempt?: number;
  repairIteration?: number;
  parentTaskId?: TaskId;
  signal?: AbortSignal;
}

export interface ModernizationArtifacts {
  /** Absent when the task failed before its output could be persisted. */
  changeReport?: GeneratedArtifact;
}

export interface ModernizationOutcome {
  task: AgentTask;
  run: AgentRun<ModernizationReport>;
  result: AgentResult;
  artifacts: ModernizationArtifacts;
  /** The persisted change report, re-read from disk through its schema. */
  report?: ModernizationChangeReport;
  specChars: number;
  scenarioChars: number;
}

export async function runModernizationStage(options: ModernizationStageOptions): Promise<ModernizationOutcome> {
  const { runtime, runId } = options;
  const taskId = options.taskId ?? newTaskId();
  const specBrief = modernizationSpecBrief(options.rules, options.invariants);
  const scenarioBrief = modernizationScenarioBrief(options.scenarios);
  const failureReport =
    options.failureReport ?? 'None. This is the first implementation; there are no differential failures to address yet.';
  const modernRoot = runtime.paths.modernRoot;

  const inputs = (options.inputArtifacts ?? []).map(toInput);

  const task = agentTaskSchema.parse({
    taskId,
    runId,
    stage: 'IMPLEMENTATION',
    role: MODERNIZATION_ROLE,
    objective: options.objective ?? DEFAULT_OBJECTIVE,
    context: buildContext(runtime, options.rules, options.invariants, options.scenarios.length, failureReport),
    inputArtifacts: inputs,
    allowedTools: [...READ_ONLY_TOOLS],
    permissions: runtime.permissionsFor(MODERNIZATION_ROLE),
    constraints: MODERNIZATION_CONSTRAINTS,
    acceptanceCriteria: MODERNIZATION_ACCEPTANCE_CRITERIA,
    expectedOutputs: ['implementation.change-report'],
    budget: runtime.budgetFor(options.budget),
    createdAt: nowIso(),
    promptIds: [MODERNIZATION_SYSTEM_PROMPT, MODERNIZATION_USER_PROMPT],
    ...(options.attempt !== undefined ? { attempt: options.attempt } : {}),
    ...(options.repairIteration !== undefined ? { repairIteration: options.repairIteration } : {}),
    ...(options.parentTaskId !== undefined ? { parentTaskId: options.parentTaskId } : {}),
  });

  const run = await runAgentTask<ModernizationReport>(
    {
      task,
      systemPromptId: MODERNIZATION_SYSTEM_PROMPT,
      userPromptId: MODERNIZATION_USER_PROMPT,
      promptVariables: {
        specBrief,
        scenarioBrief,
        failureReport,
        repositoryRoot: runtime.paths.legacyRoot,
        modernRoot,
        port: runtime.config.modern.port,
      },
      purpose: 'modernization.implementer',
      outputSchema: modernizationReportSchema,
      // No evidenceSource on purpose: the report cites rule ids, not files. Its truth is checked by
      // executing the result against legacy, which is the next stage's whole job.
      expectations: MODERNIZATION_EXPECTATIONS,
      customChecks: {
        'implementation-consistent': modernizationConsistencyCheck(
          modernRoot,
          options.rules.rules.map((rule) => rule.ruleId),
          options.invariants.invariants.map((invariant) => invariant.invariantId),
        ),
      },
      persistOutput: createModernizationPersister(runtime, options.repairIteration ?? 0),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    },
    runtime.agent,
  );

  const changeReportArtifact = run.result.generatedArtifacts.find((artifact) => artifact.kind === 'implementation.change-report');
  const report = readBack(runtime, runId, changeReportArtifact, modernizationChangeReportSchema);

  return {
    task,
    run,
    result: run.result,
    artifacts: { ...(changeReportArtifact !== undefined ? { changeReport: changeReportArtifact } : {}) },
    ...(report !== undefined ? { report } : {}),
    specChars: specBrief.length,
    scenarioChars: scenarioBrief.length,
  };
}

function toInput(artifact: GeneratedArtifact): TaskInputArtifact {
  return { artifactId: artifact.artifactId, kind: artifact.kind, relativePath: artifact.relativePath, role: 'input' };
}

function buildContext(
  runtime: RunRuntime,
  rules: BusinessRuleSet,
  invariants: InvariantSet,
  scenarioCount: number,
  failureReport: string,
): string {
  return [
    `Legacy repository (read-only reference): ${runtime.paths.legacyRoot}`,
    `Modern workspace (the host writes your returned files here): ${runtime.paths.modernRoot}`,
    `The server must listen on the port in the PORT environment variable; it defaults to ${runtime.config.modern.port}.`,
    `The specification above carries ${rules.rules.length} business rule(s) and ${invariants.invariants.length} invariant(s); the scenario list carries ${scenarioCount} scenario(s) whose requests the implementation must handle.`,
    'Scenario responses are withheld: derive what each request returns from the rules and from the legacy code, not from any recorded output.',
    failureReport.startsWith('None')
      ? 'No differential failures exist yet: this is the first implementation.'
      : 'Differential failures exist and are rendered in your instructions; your task is to regenerate the implementation so those scenarios pass, changing nothing on the legacy side.',
  ].join('\n');
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

export const MODERNIZATION_CONSTRAINTS = [
  {
    id: 'MODERN_SIDE_ONLY',
    statement:
      'You build a new system under the modern workspace. The legacy repository is read-only reference, and you have no write tools at all: you return file contents in your answer, and the host writes them.',
    enforcement: 'architectural',
  },
  {
    id: 'NO_SELF_VERDICT',
    statement:
      'Your answer has no field for correctness. Whether the implementation matches legacy is decided only by executing differential scenarios against both systems after your task ends.',
    enforcement: 'architectural',
  },
  {
    id: 'NODE_BUILTINS_ONLY',
    statement:
      'The implementation runs on Node.js with tsx and nothing else. No package is installed at any point: import only Node built-in modules and your own files.',
    enforcement: 'architectural',
  },
  {
    id: 'PORT_FROM_ENV',
    statement: 'The server must listen on the port named by the PORT environment variable.',
    enforcement: 'prompt',
  },
  {
    id: 'HEALTH_AND_RESET',
    statement:
      'GET /health must return HTTP 200 once the server is ready, and POST to the resetPath you declare must return every piece of state to a clean startup condition.',
    enforcement: 'prompt',
  },
  {
    id: 'DETERMINISTIC_RESPONSES',
    statement:
      'Responses must be deterministic: no random values, nothing that depends on the current wall-clock time, stable field order. Identical requests produce identical responses.',
    enforcement: 'prompt',
  },
  {
    id: 'IMPLEMENT_THE_SPEC',
    statement:
      'Implement the observable behavior in the rules and exercised by the scenarios — exact amounts, rounding, status codes and edge cases. Where a scenario has no rule behind it, read the legacy handler for that route and reproduce it exactly.',
    enforcement: 'prompt',
  },
  {
    id: 'READ_BEFORE_YOU_WRITE',
    statement:
      'Open the legacy files your rules cite before implementing. The specification summarizes the code; the code is the ground truth, and details dropped by summaries are exactly the ones the differential tests catch.',
    enforcement: 'prompt',
  },
] as const;

export const MODERNIZATION_ACCEPTANCE_CRITERIA = [
  {
    id: 'change-report-present',
    description:
      'A change report exists under implementation/ — change-report.json, or change-report-r<n>.json on repair iteration n.',
    kind: 'artifact-present',
    artifactKind: 'implementation.change-report',
  },
  {
    id: 'change-report-schema-valid',
    description: 'The change report validates against modernizationChangeReportSchema.',
    kind: 'artifact-schema-valid',
    artifactKind: 'implementation.change-report',
  },
  {
    id: 'implementation-consistent',
    description:
      'Every file in the change report exists on disk with the exact bytes hashed into it, and every claimed rule and invariant id is in the specification.',
    kind: 'custom-check',
    checkId: 'implementation-consistent',
  },
] as const;

export const MODERNIZATION_EXPECTATIONS: readonly ArtifactExpectation[] = [
  { kind: 'implementation.change-report', schema: modernizationChangeReportSchema },
];

/**
 * Verifies the change report against the disk and the specification. This is the check that keeps
 * the report honest: a file the report claims but the host never wrote, a byte that drifted, or a
 * rule id the specification never contained all fail here, after the model has finished talking.
 */
export function modernizationConsistencyCheck(
  modernRoot: string,
  knownRuleIds: readonly string[],
  knownInvariantIds: readonly string[],
): CustomCheck {
  return (context) => {
    const payload = context.payloadOf('implementation.change-report');
    if (payload === undefined) {
      return { satisfied: false, reason: 'the implementation change report could not be read back' };
    }
    let report: ModernizationChangeReport;
    try {
      report = modernizationChangeReportSchema.parse(payload);
    } catch (error) {
      return { satisfied: false, reason: `the persisted change report does not validate: ${describe(error)}` };
    }

    const problems: string[] = [];
    const rules = new Set(knownRuleIds);
    for (const id of report.ruleIdsImplemented) {
      if (!rules.has(id)) problems.push(`ruleIdsImplemented names ${id}, which is not in the specification`);
    }
    const invariants = new Set(knownInvariantIds);
    for (const id of report.invariantIdsAddressed) {
      if (!invariants.has(id)) problems.push(`invariantIdsAddressed names ${id}, which is not in the specification`);
    }

    for (const file of report.files) {
      const absolutePath = resolve(modernRoot, file.path);
      if (!pathIsInsideAny(canonicalizePath(absolutePath), [canonicalizePath(modernRoot)])) {
        problems.push(`${file.path} resolves outside the modern workspace`);
        continue;
      }
      let bytes: Buffer;
      try {
        bytes = readFileSync(absolutePath);
      } catch {
        problems.push(`${file.path} was not written to disk`);
        continue;
      }
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== file.sha256) {
        problems.push(`${file.path} on disk does not match the sha256 recorded in the change report`);
      } else if (bytes.byteLength !== file.bytes) {
        problems.push(`${file.path} is ${bytes.byteLength} bytes on disk but the report claims ${file.bytes}`);
      }
    }

    if (problems.length > 0) {
      return {
        satisfied: false,
        reason: `${problems.length} implementation problem(s): ${problems.slice(0, 8).join('; ')}`,
        observed: problems.join(' | '),
      };
    }
    return {
      satisfied: true,
      observed: `${report.files.length} file(s) on disk match the change report; ${report.ruleIdsImplemented.length} rule(s) and ${report.invariantIdsAddressed.length} invariant(s) claimed, all in the specification`,
    };
  };
}

/**
 * Runs in host code, after the report has been validated: wipes the modern workspace, writes the
 * returned files verbatim, adds the host-owned launcher, and records what landed as a hashed change
 * report. The workspace is Phoenix's own generated output — regenerating it from scratch on every
 * pass is what makes a repair iteration a clean replacement rather than a patch of unknown state.
 *
 * Each repair iteration writes its change report under a distinct slug: an artifact path is
 * immutable inside a run, and a repair's report must sit beside the one it supersedes rather than
 * overwrite it.
 */
export function createModernizationPersister(
  runtime: RunRuntime,
  repairIteration = 0,
): (report: ModernizationReport, context: OutputContext) => OutputContribution {
  const modernRoot = runtime.paths.modernRoot;
  return (report, context) => {
    assertModernizationIsUsable(report);

    const written: ModernizationChangeReport['files'] = report.files.map((file) => ({
      path: file.path,
      bytes: Buffer.byteLength(file.content, 'utf8'),
      sha256: createHash('sha256').update(file.content, 'utf8').digest('hex'),
      ...(file.description !== undefined ? { description: file.description } : {}),
    }));

    rmSync(modernRoot, { recursive: true, force: true });
    mkdirSync(modernRoot, { recursive: true });
    for (const file of report.files) {
      const resolved = resolve(modernRoot, file.path);
      if (!pathIsInsideAny(canonicalizePath(resolved), [canonicalizePath(modernRoot)])) {
        throw new PhoenixError(
          'ARTIFACT_WRITE_FAILED',
          `implementation file ${file.path} resolves outside the modern workspace`,
          { path: file.path },
        );
      }
      mkdirSync(dirname(resolved), { recursive: true });
      writeFileSync(resolved, file.content, 'utf8');
    }

    const tsxBin = resolve(runtime.config.paths.repoRoot, 'node_modules', '.bin', 'tsx');
    if (!existsSync(tsxBin)) {
      throw new PhoenixError('INTERNAL', `the run.sh launcher needs tsx at ${tsxBin}, which does not exist`, { tsxBin });
    }
    const entryAbsolute = resolve(modernRoot, report.entryPoint);
    const runSh = [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'cd "$(dirname "$0")"',
      `PORT="\${PORT:-${runtime.config.modern.port}}"`,
      'export PORT',
      `exec "${tsxBin}" "${entryAbsolute}"`,
      '',
    ].join('\n');
    writeFileSync(resolve(modernRoot, 'run.sh'), runSh, { mode: 0o755 });
    written.push({
      path: 'run.sh',
      bytes: Buffer.byteLength(runSh, 'utf8'),
      sha256: createHash('sha256').update(runSh, 'utf8').digest('hex'),
      description: 'Host-owned launcher: the model does not write it and the harness starts the server with it.',
    });

    const changeReport = modernizationChangeReportSchema.parse({
      schemaVersion: 1,
      generatedAt: nowIso(),
      generatedBy: `${context.task.role}:${context.task.taskId}`,
      summary: report.summary,
      entryPoint: report.entryPoint,
      resetPath: report.resetPath,
      files: written,
      ruleIdsImplemented: report.ruleIdsImplemented,
      invariantIdsAddressed: report.invariantIdsAddressed,
      assumptions: report.assumptions,
    });

    const slugSuffix = repairIteration > 0 ? `-r${repairIteration}` : '';
    const artifact = context.writer.writeJson('implementation.change-report', changeReport, modernizationChangeReportSchema, {
      ...(slugSuffix !== '' ? { slug: `change-report${slugSuffix}` } : {}),
      title: `modern implementation (${written.length} file(s), entry ${report.entryPoint}, iteration ${repairIteration})`,
      tags: ['implementation', 'modern', 'structured', `iteration-${repairIteration}`],
      inputs: context.inputs,
    });
    return { artifacts: [artifact], narrative: report.summary };
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

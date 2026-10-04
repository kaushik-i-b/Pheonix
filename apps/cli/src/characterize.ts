import { resolve } from 'node:path';
import { FileArtifactStore } from '@phoenix/artifact-store';
import { loadConfig } from '@phoenix/config';
import {
  CHARACTERIZATION_ROLE,
  createRunRuntime,
  runCharacterizationStage,
} from '@phoenix/orchestrator';
import {
  PhoenixError,
  businessRuleSetSchema,
  invariantSetSchema,
  repositoryMapSchema,
  type GeneratedArtifact,
  type RunId,
} from '@phoenix/shared';
import { readLatest, requireExplicitRunId, requireSuccessfulPredecessor } from './runs.js';

/**
 * `phoenix characterize` — the CHARACTERIZE stage on its own.
 *
 * It reads the specification a previous `phoenix specify` persisted, has the Characterization
 * Engineer propose 5-10 HTTP scenarios against it, and executes every proposal twice against the
 * live legacy system. What legacy actually did is frozen into `artifacts/<run>/characterization/`
 * as the suite the modern implementation will later be judged against. The run exits non-zero
 * unless every acceptance criterion held — including the one that re-reads the captured suite and
 * re-derives its statistics and coverage.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

interface Options {
  runId?: string;
  maxSteps?: number;
  json: boolean;
}

export const CHARACTERIZE_USAGE = [
  'usage: phoenix characterize --run-id <id> [--max-steps <n>] [--json]',
  '',
  '  --run-id              required run whose successful specification will be characterized',
  '  --max-steps           cap on model round-trips for this stage',
  '  --json                print the machine-readable outcome instead of the summary',
].join('\n');

export async function characterizeCommand(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const runId = requireExplicitRunId(options.runId, 'phoenix characterize', CHARACTERIZE_USAGE);
  const { config } = loadConfig({ cwd: REPO_ROOT });
  const store = new FileArtifactStore(config.paths.artifactRoot);
  requireSuccessfulPredecessor(store, runId, 'SPECIFICATION', [
    'specification.business-rules',
    'specification.invariants',
  ]);
  const { payload: rules } = readLatest(store, runId, 'specification.business-rules', businessRuleSetSchema);
  const { payload: invariants } = readLatest(store, runId, 'specification.invariants', invariantSetSchema);
  const { payload: repositoryMap } = readLatest(store, runId, 'discovery.repository-map', repositoryMapSchema);

  const runtime = createRunRuntime({ config, runId });
  try {
    const outcome = await runCharacterizationStage({
      runId,
      runtime,
      rules,
      invariants,
      repositoryMap,
      specificationArtifacts: specificationInputs(store, runId),
      ...(options.maxSteps !== undefined ? { budget: { maxSteps: options.maxSteps } } : {}),
    });
    const result = outcome.result;

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === 'SUCCEEDED' ? 0 : 1;
    }

    const statusCounts = new Map<string, number>();
    const lines: string[] = [
      `run ${runId} — CHARACTERIZATION / ${CHARACTERIZATION_ROLE}`,
      `capture at   ${config.legacy.label} (${config.legacy.baseUrl})`,
      `status       ${result.status}${result.errorCode === undefined ? '' : ` (${result.errorCode})`}`,
      `duration     ${(result.durationMs / 1000).toFixed(1)}s across ${result.llmCalls} model call(s), ${result.toolCalls} tool call(s), ${result.toolCallsDenied} denied`,
      `tokens       ${result.tokenUsage.promptTokens} prompt + ${result.tokenUsage.completionTokens} completion = ${result.tokenUsage.totalTokens}`,
      `upstream     ${rules.rules.length} rule(s), ${invariants.invariants.length} invariant(s), ${outcome.briefChars} characters of brief`,
      `acceptance   ${result.acceptance.filter((item) => item.satisfied).length}/${result.acceptance.length} criteria satisfied`,
    ];
    if (result.errorMessage !== undefined) lines.push(`error        ${result.errorMessage}`);
    for (const item of result.acceptance) {
      lines.push(`  ${item.satisfied ? 'PASS' : 'FAIL'}  ${item.criterionId} — ${item.observed ?? item.reason ?? 'unmet'}`);
      if (!item.satisfied && item.reason !== undefined) lines.push(`        ${item.reason}`);
    }
    if (outcome.suite !== undefined) {
      for (const item of outcome.suite.cases) {
        statusCounts.set(item.status, (statusCounts.get(item.status) ?? 0) + 1);
      }
      const assertions = outcome.suite.cases.reduce((total, item) => total + item.assertions.length, 0);
      const counts = [...statusCounts.entries()].map(([status, count]) => `${count} ${status}`).join(', ');
      lines.push(
        `[CHARACTERIZE] ${outcome.capturedCount} behavioral scenario(s) generated, ` +
          `${outcome.capturedCount} legacy baselines captured ✓ — ${assertions} assertion(s): ${counts}`,
      );
      for (const item of outcome.suite.cases) {
        lines.push(
          `  ${item.status.padEnd(24)} ${item.caseId} — ${item.title} ` +
            `[${item.assertions.length} assertion(s), ${item.scenario.category}, → ${formatTargets(item.targetRuleIds, item.targetInvariantIds)}]`,
        );
      }
      for (const skip of outcome.skipped) {
        lines.push(`  SKIPPED                    ${skip.caseId} — ${skip.reason}`);
      }
      lines.push(`coverage     ${outcome.suite.coverage.ruleIdsCovered.length}/${rules.rules.length} rule(s), ${outcome.suite.coverage.invariantIdsCovered.length}/${invariants.invariants.length} invariant(s)`);
    }
    for (const artifact of result.generatedArtifacts) {
      lines.push(`artifact     ${artifact.relativePath}  (${artifact.artifactId})`);
    }
    if (result.nextRecommendedAction !== undefined) {
      lines.push(
        `next         ${result.nextRecommendedAction.kind}${
          result.nextRecommendedAction.detail === undefined ? '' : `: ${result.nextRecommendedAction.detail}`
        }`,
      );
    }
    lines.push(`events       ${resolve(config.paths.artifactRoot, runId, 'run', 'events.jsonl')}`);
    process.stdout.write(`${lines.join('\n')}\n`);
    return result.status === 'SUCCEEDED' ? 0 : 1;
  } finally {
    await runtime.close();
  }
}

function formatTargets(ruleIds: readonly string[], invariantIds: readonly string[]): string {
  return [...ruleIds, ...invariantIds].join(', ');
}

/** The specification and discovered API map the suite is derived from. */
function specificationInputs(store: FileArtifactStore, runId: RunId): GeneratedArtifact[] {
  return store
    .list(runId, {
      kinds: ['specification.business-rules', 'specification.invariants', 'discovery.repository-map'],
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
      case '--json':
        options.json = true;
        break;
      default:
        throw new PhoenixError('CONFIG_INVALID', `unknown argument "${flag}" for characterize`, {
          usage: CHARACTERIZE_USAGE,
        });
    }
  }
  return options;
}

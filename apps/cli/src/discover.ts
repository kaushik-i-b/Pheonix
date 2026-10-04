import { resolve } from 'node:path';
import { loadConfig } from '@phoenix/config';
import { createRunRuntime, runDiscoveryStage } from '@phoenix/orchestrator';
import { PhoenixError, newRunId } from '@phoenix/shared';

/**
 * `phoenix discover` — the DISCOVER stage on its own.
 *
 * Discovery runs first because everything downstream treats its output as fact, and because it is
 * the one stage a human reviewer can check by hand: open `artifacts/<run>/discovery/` next to the
 * repository and see whether the claims hold. This command exists before the full pipeline so the
 * stage can be exercised against a real repository with a real model, repeatedly, without running
 * anything else.
 *
 * The exit status is the stage verdict. A run whose citations did not resolve, or whose report
 * established nothing, exits non-zero and prints why — the artifacts stay on disk either way,
 * because a rejection is evidence too.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

interface Options {
  legacy?: string;
  runId?: string;
  digestMaxChars?: number;
  maxSteps?: number;
  json: boolean;
}

export const DISCOVER_USAGE = [
  'usage: phoenix discover [--legacy <path>] [--run-id <id>] [--digest-max-chars <n>]',
  '                        [--max-steps <n>] [--json]',
  '',
  '  --legacy              repository to investigate (default: LEGACY_ROOT from configuration)',
  '  --run-id              resume or label a run explicitly (default: a fresh id)',
  '  --digest-max-chars    cap on the orientation digest handed to the model (default: 60000)',
  '  --max-steps           cap on model round-trips for this stage',
  '  --json                print the machine-readable outcome instead of the summary',
].join('\n');

export async function discoverCommand(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const overrides: Record<string, string> = {};
  if (options.legacy !== undefined) overrides.LEGACY_ROOT = resolve(process.cwd(), options.legacy);

  const { config } = loadConfig({ cwd: REPO_ROOT, overrides });
  const runId = options.runId ?? newRunId();
  const runtime = createRunRuntime({ config, runId });

  try {
    const outcome = await runDiscoveryStage({
      runId,
      runtime,
      ...(options.digestMaxChars !== undefined ? { digest: { maxChars: options.digestMaxChars } } : {}),
      ...(options.maxSteps !== undefined ? { budget: { maxSteps: options.maxSteps } } : {}),
    });
    const result = outcome.result;

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === 'SUCCEEDED' ? 0 : 1;
    }

    const lines: string[] = [
      `run ${runId} — DISCOVERY / archaeologist`,
      `repository   ${outcome.analysis.repositoryMap.rootPath}`,
      `status       ${result.status}${result.errorCode === undefined ? '' : ` (${result.errorCode})`}`,
      `duration     ${(result.durationMs / 1000).toFixed(1)}s across ${result.llmCalls} model call(s), ${result.toolCalls} tool call(s), ${result.toolCallsDenied} denied`,
      `tokens       ${result.tokenUsage.promptTokens} prompt + ${result.tokenUsage.completionTokens} completion = ${result.tokenUsage.totalTokens}`,
      `digest       ${outcome.digestChars} characters of orientation over ${outcome.analysis.repositoryMap.fileCount} file(s)`,
      `acceptance   ${result.acceptance.filter((item) => item.satisfied).length}/${result.acceptance.length} criteria satisfied`,
    ];
    if (result.errorMessage !== undefined) lines.push(`error        ${result.errorMessage}`);
    for (const item of result.acceptance) {
      lines.push(`  ${item.satisfied ? 'PASS' : 'FAIL'}  ${item.criterionId} — ${item.observed ?? item.reason ?? 'unmet'}`);
      if (!item.satisfied && item.reason !== undefined) lines.push(`        ${item.reason}`);
    }
    for (const artifact of result.generatedArtifacts) {
      lines.push(`artifact     ${artifact.relativePath}  (${artifact.artifactId})`);
    }
    if (outcome.findings !== undefined) {
      lines.push(
        `findings     ${outcome.findings.findings.length} finding(s), ${outcome.findings.openQuestions.length} open question(s)`,
      );
      for (const finding of outcome.findings.findings) {
        lines.push(
          `  ${finding.epistemicStatus.padEnd(8)} ${finding.id} — ${finding.summary} [${finding.evidence.length} citation(s)]`,
        );
      }
      for (const question of outcome.findings.openQuestions) {
        lines.push(`  UNRESOLVED ${question.id} — ${question.question} (${question.resolutionStrategy})`);
      }
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
    const count = (): number => {
      const parsed = Number(next());
      if (!Number.isInteger(parsed) || parsed <= 0) {
        throw new PhoenixError('CONFIG_INVALID', `${flag} must be a positive integer`, { flag });
      }
      return parsed;
    };
    switch (flag) {
      case '--legacy':
        options.legacy = next();
        break;
      case '--run-id':
        options.runId = next();
        break;
      case '--digest-max-chars':
        options.digestMaxChars = count();
        break;
      case '--max-steps':
        options.maxSteps = count();
        break;
      case '--json':
        options.json = true;
        break;
      default:
        throw new PhoenixError('CONFIG_INVALID', `unknown argument "${flag}" for discover`, { usage: DISCOVER_USAGE });
    }
  }
  return options;
}

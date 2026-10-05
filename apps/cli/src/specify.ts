import { resolve } from 'node:path';
import { FileArtifactStore } from '@phoenix/artifact-store';
import { loadConfig } from '@phoenix/config';
import { SPECIFICATION_ROLE, createRunRuntime, runSpecificationStage } from '@phoenix/orchestrator';
import {
  PhoenixError,
  discoveryFindingsSchema,
  type DiscoveryFindings,
  type GeneratedArtifact,
  type RunId,
} from '@phoenix/shared';
import { readLatest, requireExplicitRunId, requireSuccessfulPredecessor } from './runs.js';

/**
 * `phoenix specify` — the SPECIFY stage on its own.
 *
 * It reads the discovery findings a previous `phoenix discover` persisted, and turns them into
 * candidate business rules and invariants. Both documents are written under
 * `artifacts/<run>/specification/`, and the run exits non-zero unless every acceptance criterion held
 * — including the one that re-reads each cited file and searches it for the quoted text.
 */

const REPO_ROOT = resolve(import.meta.dirname, '../../..');

interface Options {
  legacy?: string;
  runId?: string;
  briefMaxChars?: number;
  maxSteps?: number;
  json: boolean;
}

export const SPECIFY_USAGE = [
  'usage: phoenix specify --run-id <id> [--legacy <path>] [--brief-max-chars <n>]',
  '                       [--max-steps <n>] [--json]',
  '',
  '  --run-id              required run whose successful discovery output will be specified',
  '  --legacy              repository the citations are checked against (default: LEGACY_ROOT from configuration)',
  '  --brief-max-chars     cap on the findings brief handed to the model (default: 24000)',
  '  --max-steps           cap on model round-trips for this stage',
  '  --json                print the machine-readable outcome instead of the summary',
].join('\n');

export async function specifyCommand(argv: readonly string[]): Promise<number> {
  const options = parseArguments(argv);
  const runId = requireExplicitRunId(options.runId, 'phoenix specify', SPECIFY_USAGE);
  const overrides: Record<string, string> = {};
  if (options.legacy !== undefined) overrides.LEGACY_ROOT = resolve(process.cwd(), options.legacy);

  const { config } = loadConfig({ cwd: REPO_ROOT, overrides });
  const store = new FileArtifactStore(config.paths.artifactRoot);
  requireSuccessfulPredecessor(store, runId, 'DISCOVERY', [
    'discovery.repository-map',
    'discovery.dependency-map',
    'discovery.data-flow',
    'discovery.findings',
  ]);
  const { payload: findings } = readLatest<DiscoveryFindings>(
    store,
    runId,
    'discovery.findings',
    discoveryFindingsSchema,
  );

  const runtime = createRunRuntime({ config, runId });
  // The loop's own deadline is only consulted between steps, so a single slow model call could
  // outlast it. This aborts the in-flight request itself and still leaves a terminal result record.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), config.limits.stageTimeoutMs);
  try {
    const outcome = await runSpecificationStage({
      runId,
      runtime,
      findings,
      discoveryArtifacts: discoveryInputs(store, runId),
      signal: deadline.signal,
      ...(options.briefMaxChars !== undefined ? { brief: { maxChars: options.briefMaxChars } } : {}),
      ...(options.maxSteps !== undefined ? { budget: { maxSteps: options.maxSteps } } : {}),
    });
    const result = outcome.result;

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      return result.status === 'SUCCEEDED' ? 0 : 1;
    }

    const lines: string[] = [
      `run ${runId} — SPECIFICATION / ${SPECIFICATION_ROLE}`,
      `repository   ${runtime.paths.legacyRoot}`,
      `status       ${result.status}${result.errorCode === undefined ? '' : ` (${result.errorCode})`}`,
      `duration     ${(result.durationMs / 1000).toFixed(1)}s across ${result.llmCalls} model call(s), ${result.toolCalls} tool call(s), ${result.toolCallsDenied} denied`,
      `tokens       ${result.tokenUsage.promptTokens} prompt + ${result.tokenUsage.completionTokens} completion = ${result.tokenUsage.totalTokens}`,
      `upstream     ${findings.findings.length} discovery finding(s), ${outcome.briefChars} characters of brief`,
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
    if (outcome.rules !== undefined) {
      const statistics = outcome.rules.statistics;
      lines.push(
        `rules        ${outcome.rules.rules.length} candidate rule(s)` +
          `${statistics === undefined ? '' : `, ${statistics.observed} observed, average confidence ${statistics.averageConfidence.toFixed(2)}`}`,
      );
      for (const rule of outcome.rules.rules) {
        lines.push(
          `  ${rule.epistemicStatus.padEnd(8)} ${rule.ruleId} — ${rule.title} [${rule.sourceEvidence.length} citation(s), confidence ${rule.confidence.toFixed(2)}]`,
        );
      }
      lines.push(`unknowns     ${outcome.rules.unknowns.length} recorded`);
      for (const unknown of outcome.rules.unknowns) {
        lines.push(`  UNRESOLVED ${unknown.id} — ${unknown.question} (${unknown.resolutionStrategy})`);
      }
    }
    if (outcome.invariants !== undefined) {
      lines.push(`invariants   ${outcome.invariants.invariants.length} candidate invariant(s)`);
      for (const invariant of outcome.invariants.invariants) {
        lines.push(
          `  ${invariant.epistemicStatus.padEnd(8)} ${invariant.invariantId} [${invariant.kind}, ${invariant.criticality}] — ${invariant.statement}`,
        );
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
    clearTimeout(timer);
    await runtime.close();
  }
}

/** Discovery's own artifacts, recorded as the inputs the specification was derived from. */
function discoveryInputs(store: FileArtifactStore, runId: RunId): GeneratedArtifact[] {
  return store
    .list(runId, {
      kinds: ['discovery.findings', 'discovery.repository-map', 'discovery.dependency-map', 'discovery.data-flow'],
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
      case '--legacy':
        options.legacy = next();
        break;
      case '--run-id':
        options.runId = next();
        break;
      case '--brief-max-chars':
      case '--max-steps': {
        const parsed = Number(next());
        if (!Number.isInteger(parsed) || parsed <= 0) {
          throw new PhoenixError('CONFIG_INVALID', `${flag} must be a positive integer`, { flag });
        }
        if (flag === '--brief-max-chars') options.briefMaxChars = parsed;
        else options.maxSteps = parsed;
        break;
      }
      case '--json':
        options.json = true;
        break;
      default:
        throw new PhoenixError('CONFIG_INVALID', `unknown argument "${flag}" for specify`, { usage: SPECIFY_USAGE });
    }
  }
  return options;
}

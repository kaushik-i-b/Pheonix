import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockLlmProvider, jsonResponse } from '@phoenix/llm/testing';
import { analyzeRepository, type RepositoryAnalysis } from '@phoenix/legacy-analysis';
import { EventSequencer, InMemoryEventSink, discoveryFindingsSchema, newRunId } from '@phoenix/shared';
import type { GeneratedArtifact, RunId, SuspiciousBehavior, ArtifactMeta } from '@phoenix/shared';
import {
  DISCOVERY_ACCEPTANCE_CRITERIA,
  createRunRuntime,
  discoveryDigest,
  runDiscoveryStage,
  type RunRuntime,
} from '../src/index.js';
import { REPO_ROOT, cleanupTemporaryDirectories, fixtureConfig, silentLogger, tempDirectory } from './support.js';

/**
 * DISCOVER against the real demo system, with a scripted model.
 *
 * `discovery.test.ts` proves the stage's contract on a miniature fixture. This proves it survives
 * contact with `examples/legacy-bank` — 33 files, 16 endpoints, 50 suspicious constructs, a build
 * directory that must not be mistaken for source. The citations below are harvested from the
 * analyzer's own output and re-read from disk, so the evidence check passes for the same reason it
 * would pass in production: the quoted bytes are really there.
 */

const LEGACY_BANK = join(REPO_ROOT, 'examples/legacy-bank');
const GENERATED_AT = '2026-09-30T00:00:00.000Z';

let analysis: RepositoryAnalysis;

beforeAll(() => {
  analysis = analyzeRepository({ root: LEGACY_BANK, generatedAt: GENERATED_AT });
});

afterAll(() => {
  cleanupTemporaryDirectories();
});

function lineAt(relativePath: string, line: number): string {
  const lines = readFileSync(join(LEGACY_BANK, relativePath), 'utf8').split('\n');
  const value = lines[line - 1];
  if (value === undefined) throw new Error(`${relativePath} has no line ${line}`);
  return value.trim();
}

/** A citation whose quote is read from the file at the moment the test builds it. */
function cite(relativePath: string, startLine: number): { path: string; startLine: number; quote: string } {
  return { path: relativePath, startLine, quote: lineAt(relativePath, startLine) };
}

function behavior(category: SuspiciousBehavior['category'], index = 0): SuspiciousBehavior {
  const matches = analysis.repositoryMap.suspiciousBehaviors.filter(
    (item) => item.category === category && item.location.startLine !== undefined,
  );
  const found = matches[index];
  if (found === undefined) throw new Error(`the legacy bank no longer yields a ${category} finding`);
  return found;
}

/** A specific construct, selected by how the analyzer describes it rather than by line number. */
function behaviorDescribedAs(category: SuspiciousBehavior['category'], prefix: string): SuspiciousBehavior {
  const found = analysis.repositoryMap.suspiciousBehaviors.find(
    (item) => item.category === category && item.location.startLine !== undefined && item.description.startsWith(prefix),
  );
  if (found === undefined) throw new Error(`the legacy bank no longer yields a ${category} described as "${prefix}…"`);
  return found;
}

function citeBehavior(item: SuspiciousBehavior): { path: string; startLine: number; quote: string } {
  return cite(item.location.path, item.location.startLine ?? 1);
}

/** A stage that reports an artifact it never indexed is a broken stage, not a missing test input. */
function metaOf(runtime: RunRuntime, runId: RunId, generated: GeneratedArtifact | undefined): ArtifactMeta {
  if (generated === undefined) throw new Error('the discovery stage did not produce an expected artifact');
  const meta = runtime.artifacts.find(runId, generated.artifactId);
  if (meta === undefined) throw new Error(`artifact ${generated.artifactId} is not in the run index`);
  return meta;
}

describe('discovery against examples/legacy-bank', () => {
  it('describes a repository the size of the demo system without exceeding the prompt budget', () => {
    const { repositoryMap } = analysis;
    expect(repositoryMap.fileCount).toBeGreaterThan(20);
    expect(repositoryMap.httpEndpoints.length).toBeGreaterThan(5);
    expect(repositoryMap.suspiciousBehaviors.length).toBeGreaterThan(20);
    expect(repositoryMap.migrations.some((migration) => migration.appliesDatabaseBehavior)).toBe(true);

    // `target/` is build output. If it were inventoried, the digest would be mostly compiled noise
    // and the model would cite class files as evidence.
    expect(repositoryMap.ignoredPaths).toContain('target');
    expect(repositoryMap.files.filter((file) => file.path.startsWith('target/'))).toEqual([]);

    const digest = discoveryDigest(analysis);
    expect(digest.length).toBeLessThan(60_000);
    expect(digest).toContain(`## HTTP endpoints (${repositoryMap.httpEndpoints.length})`);
    expect(digest).toContain(`## Suspicious constructs (${repositoryMap.suspiciousBehaviors.length})`);
    expect(digest).toContain('APPLIES DATABASE-SIDE BEHAVIOR');
    expect(digest).not.toContain('target/classes');
  });

  it('masks the configured database password in everything the model is shown', () => {
    const digest = discoveryDigest(analysis);
    const properties = analysis.repositoryMap.configuration.find((source) =>
      source.path.endsWith('application.properties'),
    );
    expect(properties?.keys.some((key) => key.secret)).toBe(true);
    expect(digest).toContain('spring.datasource.password=<secret>');
    expect(digest).not.toContain('spring.datasource.password=legacy');
  });

  it('indexes the legacy bank without quoting it', () => {
    const digest = discoveryDigest(analysis);

    // Harvested from the analyzer's own capture of the repository rather than written down here, so
    // a future analyzer that starts recording a new kind of source text is caught without this test
    // being edited. The digest is what the model reads: if any of these bytes reached it, the model
    // could cite the repository without opening a file, and the read-before-you-cite gate would then
    // reject an accurate report.
    const quoted: string[] = [];
    for (const item of analysis.repositoryMap.suspiciousBehaviors) {
      const snippet = item.location.snippet?.replace(/\s+/g, ' ').trim();
      if (snippet !== undefined && snippet.length > 20) quoted.push(snippet);
    }
    for (const object of analysis.repositoryMap.databaseObjects) {
      const body = object.behavior?.replace(/\s+/g, ' ').trim();
      if (body !== undefined && body.length > 20) quoted.push(body.slice(0, 120));
    }
    for (const access of analysis.repositoryMap.databaseAccess) {
      for (const statement of access.statements) {
        const raw = statement.raw.replace(/\s+/g, ' ').trim();
        if (raw.length > 20) quoted.push(raw.slice(0, 120));
      }
    }
    expect(quoted.length).toBeGreaterThan(20);

    const flat = digest.replace(/\s+/g, ' ');
    for (const fragment of quoted) {
      expect(flat, `the digest quoted source text: ${JSON.stringify(fragment.slice(0, 80))}`).not.toContain(fragment);
    }

    // Withholding the text must not mean withholding the pointer.
    expect(digest).toContain('DATABASE-SIDE BEHAVIOR');
    expect(digest).toContain('SQL text withheld');
  });

  it('runs the stage end to end and accepts findings whose citations are genuine', async () => {
    const drift = analysis.repositoryMap.duplicationClusters.find((cluster) => cluster.drifted);
    expect(drift).toBeDefined();
    const members = drift?.members ?? [];
    const feeRule = behavior('db-side-behavior');
    const immutabilityTrigger = behaviorDescribedAs('db-side-behavior', 'trigger');
    const swallowed = behavior('swallowed-exception');
    const unguardedRetry = behavior('retry-without-idempotency');

    // The loop refuses a source-code citation to a file the agent never opened, so the scripted model
    // has to read everything the report below quotes before it is allowed to say anything about it.
    const citedPaths = [
      ...new Set([
        ...[feeRule, immutabilityTrigger, swallowed, unguardedRetry].map((item) => item.location.path),
        ...members.slice(0, 3).map((member) => member.path),
      ]),
    ];
    const readCitedSources = {
      toolCalls: citedPaths.map((path, index) => ({
        id: `read-${index}`,
        name: 'read_file' as const,
        arguments: { path },
      })),
    };

    const report = {
      summary:
        'A Spring Boot core-banking service whose fee calculation, ledger immutability and settlement ' +
        'behaviour are split between Java and PostgreSQL. Three fee code paths disagree, and the ' +
        'transfer ledger is protected by a trigger rather than by the application.',
      sections: [
        {
          heading: 'What the system does',
          body:
            'Accounts, ledger entries, transfers, fees, settlement, reconciliation and history are ' +
            'served over 16 HTTP endpoints backed by JdbcTemplate against PostgreSQL.',
        },
        {
          heading: 'Where behaviour hides',
          body:
            'calc_transfer_fee and ledger_immutable_fn run inside the database, so a rewrite that only ' +
            'reads Java loses the fee schedule and the immutability rule.',
        },
        {
          heading: 'Migration hazards',
          body:
            'Duplicated fee calculations that have drifted apart, swallowed exceptions on the write ' +
            'path, and batch work retried with no visible idempotency guard.',
        },
      ],
      findings: [
        {
          id: 'F-FEE-RULE-LIVES-IN-THE-DATABASE',
          kind: 'invariant-candidate',
          summary: 'Transfer fees are computed by a stored function, so the pricing rule is not in the Java source at all.',
          epistemicStatus: 'OBSERVED',
          confidence: 0.9,
          severity: 'CRITICAL',
          affectedComponents: [feeRule.location.path],
          evidence: [citeBehavior(feeRule)],
        },
        {
          id: 'F-LEDGER-IMMUTABILITY-IS-A-TRIGGER',
          kind: 'invariant-candidate',
          summary: 'Posted ledger entries are made immutable by a database trigger rather than by application code.',
          epistemicStatus: 'OBSERVED',
          confidence: 0.85,
          severity: 'CRITICAL',
          affectedComponents: [immutabilityTrigger.location.path],
          evidence: [citeBehavior(immutabilityTrigger)],
        },
        {
          id: 'F-FEE-CALCULATION-HAS-DRIFTED',
          kind: 'duplication',
          summary: 'Several methods compute a fee with the same shape and different literals, so they no longer agree.',
          epistemicStatus: 'OBSERVED',
          confidence: 0.8,
          severity: 'MAJOR',
          affectedComponents: members.map((member) => member.path),
          evidence: members.slice(0, 3).map((member) => cite(member.path, member.startLine ?? 1)),
        },
        {
          id: 'F-WRITE-PATH-SWALLOWS-FAILURES',
          kind: 'suspicious-behavior',
          summary: 'A catch block on the write path logs and continues, so a failed posting can look like a success.',
          epistemicStatus: 'INFERRED',
          confidence: 0.7,
          severity: 'MAJOR',
          affectedComponents: [swallowed.location.path],
          evidence: [citeBehavior(swallowed)],
        },
        {
          id: 'F-BATCH-RETRY-HAS-NO-IDEMPOTENCY-GUARD',
          kind: 'risk',
          summary: 'Settlement work is retried with no visible idempotency guard, so a rerun may post twice.',
          epistemicStatus: 'INFERRED',
          confidence: 0.6,
          severity: 'MAJOR',
          affectedComponents: [unguardedRetry.location.path],
          evidence: [citeBehavior(unguardedRetry)],
        },
      ],
      openQuestions: [
        {
          id: 'Q-SETTLEMENT-RERUN',
          question: 'Can the settlement batch be re-run for the same business day without posting an entry twice?',
          whyItMatters: 'A differential scenario that runs the batch twice will not compare like with like if it cannot.',
          resolutionStrategy: 'runtime-probe',
        },
        {
          id: 'Q-FEE-PATH-PRECEDENCE',
          question: 'Which of the duplicated fee calculations does the live transfer path actually call?',
          whyItMatters: 'Characterizing the wrong copy would freeze behaviour nobody executes.',
          resolutionStrategy: 'characterization-test',
        },
      ],
    };

    const provider = new MockLlmProvider({
      responses: [readCitedSources, jsonResponse(report)],
    });
    const sink = new InMemoryEventSink();
    const runId = newRunId();
    const artifactRoot = tempDirectory('phoenix-legacy-bank-artifacts-');
    const runtime = createRunRuntime({
      config: fixtureConfig({
        root: LEGACY_BANK,
        artifactRoot,
        workspaceRoot: tempDirectory('phoenix-legacy-bank-workspace-'),
        modernRoot: tempDirectory('phoenix-legacy-bank-modern-'),
      }),
      runId,
      provider,
      events: new EventSequencer([sink], (_name, error) => {
        throw error;
      }),
      logger: silentLogger(),
    });

    try {
      // No `analysis` argument: the stage walks the legacy root itself, as it does in production.
      const outcome = await runDiscoveryStage({ runId, runtime });

      expect(outcome.result.status, outcome.result.errorMessage ?? '').toBe('SUCCEEDED');
      expect(outcome.result.errorCode).toBeUndefined();
      expect(outcome.result.acceptance).toHaveLength(DISCOVERY_ACCEPTANCE_CRITERIA.length);
      expect(outcome.result.acceptance.filter((item) => !item.satisfied)).toEqual([]);
      expect(outcome.digestChars).toBeGreaterThan(5_000);
      expect(outcome.digestChars).toBeLessThan(60_000);

      expect(outcome.artifacts.repositoryMap.relativePath).toBe('discovery/repository-map.json');
      expect(outcome.artifacts.findingsJson?.relativePath).toBe('discovery/findings.json');
      expect(outcome.artifacts.findingsMarkdown?.relativePath).toBe('discovery/findings.md');

      const document = discoveryFindingsSchema.parse(
        runtime.artifacts.readJson(metaOf(runtime, runId, outcome.artifacts.findingsJson), discoveryFindingsSchema),
      );
      expect(document.findings.length).toBeGreaterThanOrEqual(3);

      // Re-verify every quotation independently of the runtime's own check: the artifact on disk
      // must contain text that is really in the repository at the cited line.
      for (const finding of document.findings) {
        expect(finding.evidence.length).toBeGreaterThan(0);
        for (const item of finding.evidence) {
          const location = item.location;
          expect(location?.path).toBeTruthy();
          const cited = item.quote ?? '';
          expect(cited.length).toBeGreaterThan(0);
          const lines = readFileSync(join(LEGACY_BANK, location?.path ?? ''), 'utf8').split('\n');
          const line = lines[(location?.startLine ?? 1) - 1];
          expect(line, `${location?.path}:${location?.startLine} should carry the quote`).toContain(
            cited.slice(0, Math.min(cited.length, 40)),
          );
        }
      }

      const prompt = readFileSync(
        join(runtime.paths.artifactRoot, 'run', `prompt-${outcome.task.taskId}-user.txt`),
        'utf8',
      );
      expect(prompt).toContain('## Database objects');
      expect(prompt).not.toContain('spring.datasource.password=legacy');

      const findingsMarkdown = runtime.artifacts.readText(
        metaOf(runtime, runId, outcome.artifacts.findingsMarkdown),
      );
      expect(findingsMarkdown).toContain('F-FEE-RULE-LIVES-IN-THE-DATABASE');
      expect(outcome.result.unresolvedUnknowns.join(' ')).toContain('Q-FEE-PATH-PRECEDENCE');
    } finally {
      await runtime.close();
    }
  }, 60_000);
});

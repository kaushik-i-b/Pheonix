import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MockLlmProvider, jsonResponse, type MockResponse } from '@phoenix/llm/testing';
import {
  EventSequencer,
  InMemoryEventSink,
  discoveryFindingsSchema,
  newRunId,
  toolInvocationLogSchema,
  type RunId,
} from '@phoenix/shared';
import {
  DISCOVERY_ACCEPTANCE_CRITERIA,
  archaeologistReportSchema,
  assertReportIsUsable,
  createRunRuntime,
  digestSectionTitles,
  discoveryConsistencyCheck,
  discoveryDigest,
  eventMirrorPath,
  readEventMirror,
  runDiscoveryStage,
  toDiscoveryFindings,
  type ArchaeologistReport,
  type RunRuntime,
} from '../src/index.js';
import {
  BATCH_FEE_PATH,
  FEE_SERVICE_PATH,
  REPO_ROOT,
  TRIGGER_PATH,
  checkContext,
  cleanupTemporaryDirectories,
  createLegacyFixture,
  fixtureCitation,
  fixtureConfig,
  silentLogger,
  type LegacyFixture,
} from './support.js';

/**
 * DISCOVER, tested without a model.
 *
 * Two things are being verified here. First, that the deterministic half — analysis, digest,
 * consistency check — is bounded and self-checking, because everything downstream treats its output
 * as fact. Second, that the model's half cannot become an artifact unless its citations survive
 * mechanical verification: a fabricated quote, an empty report and an unverifiable claim each have
 * to produce a recorded failure rather than a green stage.
 */

let fixture: LegacyFixture;

beforeAll(() => {
  fixture = createLegacyFixture();
});

afterAll(() => {
  cleanupTemporaryDirectories();
});

const CORE_SECTIONS = [
  'Languages',
  'Build systems',
  'Frameworks',
  'Entry points',
  'HTTP endpoints',
  'Database objects',
  'Migrations',
  'Database access from code',
  'Scheduled jobs',
  'Configuration',
  'External dependencies',
  'Duplicated logic',
  'Suspicious constructs',
  'Call graph',
  'Data flows',
];

/** What the model is allowed to send back, before host code validates and re-stamps it. */
interface ReportDraft {
  summary: string;
  sections: { heading: string; body: string }[];
  findings: {
    id: string;
    kind: string;
    summary: string;
    epistemicStatus: string;
    confidence: number;
    severity?: string;
    affectedComponents: string[];
    evidence: { path: string; startLine: number; quote: string; symbol?: string }[];
  }[];
  openQuestions: { id: string; question: string; whyItMatters: string; resolutionStrategy: string }[];
}

/** The report the Archaeologist is expected to produce about the fixture, with real citations. */
function evidenceBasedReport(): ReportDraft {
  return {
    summary:
      'A small bank whose pricing rules disagree with themselves: the online path rounds fees HALF_UP and the batch path rounds them HALF_EVEN. The prohibition on negative balances is not in Java at all — it is a database trigger.',
    sections: [
      {
        heading: 'What the system does',
        body: 'Transfers are accepted over HTTP, priced by FeeService, and written to ledger_entries.',
      },
      {
        heading: 'Where behaviour hides',
        body: 'A BEFORE UPDATE trigger rejects negative balances, and a nightly cron job flips transfers to settled.',
      },
      {
        heading: 'Migration hazards',
        body: 'Two fee calculators with different rounding modes, and a ledger insert whose failure is swallowed.',
      },
    ],
    findings: [
      {
        id: 'F-FEE-ROUNDING-DRIFT',
        kind: 'duplication',
        summary: 'The online and batch fee calculators round differently: HALF_UP against HALF_EVEN.',
        epistemicStatus: 'OBSERVED',
        confidence: 0.95,
        severity: 'MAJOR',
        affectedComponents: [FEE_SERVICE_PATH, BATCH_FEE_PATH],
        evidence: [
          {
            ...fixtureCitation(fixture.root, FEE_SERVICE_PATH, 'RoundingMode.HALF_UP'),
            symbol: 'FeeService#onlineFee',
          },
          {
            ...fixtureCitation(fixture.root, BATCH_FEE_PATH, 'RoundingMode.HALF_EVEN'),
            symbol: 'BatchFeeCalculator#batchFee',
          },
        ],
      },
      {
        id: 'F-OVERDRAFT-RULE-IS-IN-THE-DATABASE',
        kind: 'invariant-candidate',
        summary: 'Negative balances are refused by a trigger, so a rewrite that only reads Java loses the rule.',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        severity: 'CRITICAL',
        affectedComponents: [TRIGGER_PATH],
        evidence: [
          {
            ...fixtureCitation(fixture.root, TRIGGER_PATH, 'RAISE EXCEPTION'),
            symbol: 'accounts_no_overdraft',
          },
        ],
      },
      {
        id: 'F-LEDGER-FAILURE-IS-SWALLOWED',
        kind: 'suspicious-behavior',
        summary: 'A failed ledger insert is caught and discarded, so a transfer can be priced without being recorded.',
        epistemicStatus: 'INFERRED',
        confidence: 0.7,
        severity: 'MAJOR',
        affectedComponents: [FEE_SERVICE_PATH],
        evidence: [
          {
            ...fixtureCitation(fixture.root, FEE_SERVICE_PATH, 'catch (RuntimeException e)'),
            symbol: 'FeeService#record',
          },
        ],
      },
    ],
    openQuestions: [
      {
        id: 'Q-SETTLEMENT-RERUN',
        question: 'Can the nightly settlement job be re-run for the same day without settling a transfer twice?',
        whyItMatters: 'If it cannot, a differential scenario that runs it twice will not compare like with like.',
        resolutionStrategy: 'runtime-probe',
      },
    ],
  };
}

/** A reply whose first citation points at a file that does not exist — the failure mode the loop must catch. */
function driftOneCitation(report: ReportDraft): ReportDraft {
  const drifted = structuredClone(report);
  const finding = defined(drifted.findings[0], 'a finding');
  finding.evidence[0] = {
    ...defined(finding.evidence[0], 'a citation'),
    path: 'src/main/java/com/example/fee/FeeTables.java',
    quote: 'ROUND_HALF_EVEN_ON_BATCH_PATH',
  };
  return drifted;
}

/**
 * The reads a genuine Archaeologist performs before answering. The fixture report cites all three
 * sources, and the runtime refuses a source-code citation to a file the agent never opened, so any
 * test that expects that report to be accepted has to script the reads that justify it.
 */
const readFixtureSources = {
  toolCalls: [FEE_SERVICE_PATH, BATCH_FEE_PATH, TRIGGER_PATH].map((path, index) => ({
    id: `read-${index}`,
    name: 'read_file' as const,
    arguments: { path },
  })),
};

interface RuntimeScope {
  runtime: RunRuntime;
  provider: MockLlmProvider;
  sink: InMemoryEventSink;
  runId: RunId;
}

/** Builds a run runtime over the fixture with a scripted provider, and tears it down again. */
async function withRuntime(
  responses: readonly MockResponse[],
  body: (scope: RuntimeScope) => Promise<void>,
  options: { configOverrides?: Record<string, string>; mirrorEvents?: boolean } = {},
): Promise<void> {
  const provider = new MockLlmProvider({ responses });
  const sink = new InMemoryEventSink();
  const runId = newRunId();
  const runtime = createRunRuntime({
    config: fixtureConfig(fixture, options.configOverrides),
    runId,
    provider,
    ...(options.mirrorEvents === true
      ? { mirrorEvents: true }
      : { events: new EventSequencer([sink], (_name, error) => {
          throw error;
        }) }),
    logger: silentLogger(),
  });
  try {
    await body({ runtime, provider, sink, runId });
  } finally {
    await runtime.close();
  }
}

describe('discoveryDigest', () => {
  it('covers every section of the analysis, with the true count next to each excerpt', () => {
    const digest = discoveryDigest(fixture.analysis);
    expect(digestSectionTitles(digest).slice(0, CORE_SECTIONS.length)).toEqual(CORE_SECTIONS);
    expect(digest.startsWith(`# Discovery digest for ${fixture.analysis.repositoryMap.rootPath}`)).toBe(true);
    expect(digest).toContain(`## HTTP endpoints (${fixture.analysis.repositoryMap.httpEndpoints.length})`);
    expect(digest).toContain('## Database objects (5)');
    expect(digest).toContain('APPLIES DATABASE-SIDE BEHAVIOR');
    expect(digest).toContain('idempotent: UNKNOWN');
    expect(digest).toContain('DRIFTED — the copies disagree');
  });

  it('stays inside the character budget and says so when it has to cut', () => {
    const digest = discoveryDigest(fixture.analysis, { maxChars: 900 });
    expect(digest.length).toBeLessThan(1200);
    expect(digest).toContain('digest truncated at 900 characters');
    expect(digest).not.toContain('## Data flows');
    expect(discoveryDigest(fixture.analysis).length).toBeGreaterThan(900);
  });

  it('caps entries per section and reports how many were held back', () => {
    const digest = discoveryDigest(fixture.analysis, { maxEntriesPerSection: 1 });
    expect(digest).toContain('## Languages (4)');
    expect(digest).toContain('… 3 more not shown …');
  });

  it('quotes no source text: the digest indexes the repository instead of copying it', () => {
    const digest = discoveryDigest(fixture.analysis);
    // Every one of these is a real line in the fixture. Handing any of them to the model would let
    // it quote the repository without opening a file, and the read-before-you-cite gate would then
    // reject the report no matter how accurate it was.
    for (const needle of [
      'INSERT INTO ledger_entries',
      'FROM accounts WHERE account_number',
      'RAISE EXCEPTION',
      'setScale(2, RoundingMode.HALF_UP)',
      'UPDATE transfers SET settled',
      'tiny.fee.rate=0.005',
      'hunter2',
    ]) {
      expect(digest, `the digest leaked ${JSON.stringify(needle)}`).not.toContain(needle);
    }
    // Withholding the text must not mean withholding the pointer.
    expect(digest).toContain(FEE_SERVICE_PATH);
    expect(digest).toContain(TRIGGER_PATH);
    expect(digest).toContain('tiny.fee.rate');
    expect(digest).toContain('spring.datasource.password=<secret>');
    expect(digest).toContain('DATABASE-SIDE BEHAVIOR');
    expect(digest).toContain('SQL text withheld');
  });

  it('never prints a configured secret', () => {
    const digest = discoveryDigest(fixture.analysis);
    expect(digest).not.toContain('hunter2');
    expect(digest).toContain('spring.datasource.password=<secret>');
  });
});

describe('discoveryConsistencyCheck', () => {
  it('accepts the deterministic analysis of the fixture', async () => {
    const result = await discoveryConsistencyCheck(fixture.analysis)(checkContext(fixture.artifactRoot));
    expect(result.satisfied).toBe(true);
    expect(result.observed).toContain('self-consistent');
  });

  it('rejects a call-graph edge that starts at a node the analyzer never produced', async () => {
    const existing = defined(fixture.analysis.dependencyMap.edges[0], 'a dependency edge');
    const doctored = {
      ...fixture.analysis,
      dependencyMap: {
        ...fixture.analysis.dependencyMap,
        edges: [...fixture.analysis.dependencyMap.edges, { ...existing, from: 'method:com.example.Ghost#gone' }],
      },
    };
    const result = await discoveryConsistencyCheck(doctored)(checkContext(fixture.artifactRoot));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('starts at an unknown node');
  });

  it('rejects a flow that claims a store no schema or statement mentions', async () => {
    const first = defined(fixture.analysis.dataFlow.flows[0], 'a traced data flow');
    const doctored = {
      ...fixture.analysis,
      dataFlow: {
        ...fixture.analysis.dataFlow,
        flows: [{ ...first, dataStores: [...first.dataStores, 'vault_ledger'] }],
      },
    };
    const result = await discoveryConsistencyCheck(doctored)(checkContext(fixture.artifactRoot));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('vault_ledger');
  });
});

describe('archaeologistReportSchema', () => {
  const promptPath = join(REPO_ROOT, 'prompts/archaeologist/findings.md');

  function promptExample(): unknown {
    const fence = /```json\r?\n([\s\S]*?)\r?\n```/.exec(readFileSync(promptPath, 'utf8'));
    expect(fence?.[1]).toBeDefined();
    // The example deliberately uses self-invalidating `<YOUR-...-SLUG>` placeholders so a model
    // cannot submit it as-is; filling them in must still yield a schema-valid shape.
    const text = (fence?.[1] ?? '')
      .replaceAll('<YOUR-FINDING-SLUG>', 'EXAMPLE-FINDING')
      .replaceAll('<YOUR-QUESTION-SLUG>', 'EXAMPLE-QUESTION');
    return JSON.parse(text);
  }

  it('accepts the example the task prompt shows the model', () => {
    const parsed = archaeologistReportSchema.safeParse(promptExample());
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it('rejects a report that reuses an identifier', () => {
    const draft = evidenceBasedReport();
    draft.findings.push({
      ...defined(draft.findings[0], 'a finding'),
      summary: 'A second claim wearing the first claim’s identifier, which would let one citation cover both.',
    });
    const parsed = archaeologistReportSchema.safeParse(draft);
    expect(parsed.success).toBe(false);
    expect(parsed.error?.message).toContain('used more than once');
  });

  it('accepts an id whose words are separated by underscores', () => {
    // A model names a finding after the symbol it read: F-CALC_TRANSFER_FEE, Q-PRODUCTION_ROUNDING_MODE.
    // Refusing that spelling costs a repair round on a cosmetic preference, and a round spent there is a
    // round the read-before-you-cite and quote-verification gates never get.
    const draft = evidenceBasedReport();
    draft.findings = draft.findings.map((finding, index) =>
      index === 0 ? { ...finding, id: 'F-CALC_TRANSFER_FEE' } : finding,
    );
    draft.openQuestions = draft.openQuestions.map((question, index) =>
      index === 0 ? { ...question, id: 'Q-PRODUCTION_ROUNDING_MODE' } : question,
    );
    const parsed = archaeologistReportSchema.safeParse(draft);
    expect(parsed.error?.issues).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it('stamps identity, time and attribution that the model is not allowed to supply', () => {
    const report = archaeologistReportSchema.parse(evidenceBasedReport());
    const document = toDiscoveryFindings(report, {
      collectedAt: '2026-09-30T12:00:00.000Z',
      collectedBy: 'archaeologist:task_fixture',
    });
    expect(document.generatedAt).toBe('2026-09-30T12:00:00.000Z');
    expect(document.findings.map((finding) => finding.id)).toEqual([
      'F-FEE-ROUNDING-DRIFT',
      'F-OVERDRAFT-RULE-IS-IN-THE-DATABASE',
      'F-LEDGER-FAILURE-IS-SWALLOWED',
    ]);
    const evidence = document.findings[0]?.evidence[0];
    expect(evidence?.id).toBe('F-FEE-ROUNDING-DRIFT-ev-1');
    expect(evidence?.kind).toBe('source-code');
    expect(evidence?.collectedBy).toBe('archaeologist:task_fixture');
    expect(document.findings.every((finding) => finding.relatedRuleIds.length === 0)).toBe(true);
  });

  it('refuses a report that claims nothing and asks nothing', () => {
    const empty = archaeologistReportSchema.parse({
      summary: 'This repository contains a Spring Boot application with a database schema and services.',
      sections: evidenceBasedReport().sections,
      findings: [],
      openQuestions: [],
    });
    expect(() => assertReportIsUsable(empty)).toThrowError(/claims nothing and asks nothing/);
  });

  it('refuses an OBSERVED finding that cites no line and no symbol', () => {
    const report: ArchaeologistReport = archaeologistReportSchema.parse({
      ...evidenceBasedReport(),
      findings: [
        {
          id: 'F-UNPINNED',
          kind: 'behavior',
          summary: 'Something happens somewhere in the fee calculation, allegedly.',
          epistemicStatus: 'OBSERVED',
          confidence: 0.5,
          evidence: [{ path: FEE_SERVICE_PATH, quote: 'BigDecimal' }],
        },
      ],
    });
    expect(() => assertReportIsUsable(report)).toThrowError(/cites no line or symbol/);
  });
});

describe('runDiscoveryStage', () => {
  it('writes the deterministic artifacts, then the evidenced findings, and satisfies every criterion', async () => {
    await withRuntime(
      [readFixtureSources, jsonResponse(evidenceBasedReport())],
      async ({ runtime, provider, sink, runId }) => {
        const outcome = await runDiscoveryStage({ runId, runtime, analysis: fixture.analysis });

        expect(outcome.result.status).toBe('SUCCEEDED');
        expect(outcome.result.errorCode).toBeUndefined();
        expect(outcome.result.acceptance).toHaveLength(DISCOVERY_ACCEPTANCE_CRITERIA.length);
        expect(outcome.result.acceptance.filter((item) => !item.satisfied)).toEqual([]);
        expect(outcome.run.acceptance.allSatisfied).toBe(true);

        expect(outcome.artifacts.repositoryMap.relativePath).toBe('discovery/repository-map.json');
        expect(outcome.artifacts.dependencyMap.relativePath).toBe('discovery/dependency-map.json');
        expect(outcome.artifacts.dataFlow.relativePath).toBe('discovery/data-flow.json');
        expect(outcome.artifacts.findingsJson?.relativePath).toBe('discovery/findings.json');
        expect(outcome.artifacts.findingsMarkdown?.relativePath).toBe('discovery/findings.md');

        // The task must be able to point at the analysis it was given, by artifact id.
        expect(outcome.task.inputArtifacts.map((input) => input.kind)).toEqual([
          'discovery.repository-map',
          'discovery.dependency-map',
          'discovery.data-flow',
        ]);
        expect(outcome.task.inputArtifacts.map((input) => input.artifactId)).toEqual([
          outcome.artifacts.repositoryMap.artifactId,
          outcome.artifacts.dependencyMap.artifactId,
          outcome.artifacts.dataFlow.artifactId,
        ]);

        const document = discoveryFindingsSchema.parse(
          runtime.artifacts.readJson(
            defined(runtime.artifacts.latest(runId, 'discovery.findings'), 'the findings artifact'),
            discoveryFindingsSchema,
          ),
        );
        expect(document.findings).toHaveLength(3);
        expect(document.findings[0]?.evidence[0]?.quote).toContain('RoundingMode.HALF_UP');
        expect(outcome.findings?.openQuestions.map((question) => question.id)).toEqual(['Q-SETTLEMENT-RERUN']);
        expect(outcome.result.unresolvedUnknowns.join(' ')).toContain('Q-SETTLEMENT-RERUN');
        expect(outcome.result.narrative).toContain('HALF_EVEN');

        // Static analysis is on disk before the first model call: the digest is built from artifacts,
        // not the other way around.
        const firstArtifact = sink.events.findIndex((event) => event.type === 'artifact.created');
        const firstCompletion = sink.events.findIndex((event) => event.type === 'llm.completed');
        expect(firstArtifact).toBeGreaterThanOrEqual(0);
        expect(firstCompletion).toBeGreaterThan(firstArtifact);

        expect(provider.requests).toHaveLength(2);
        expect(provider.requests[0]?.messages[0]?.content).toContain('Cite or do not claim');
        expect(provider.requests[0]?.messages[1]?.content).toContain(
          `# Discovery digest for ${fixture.analysis.repositoryMap.rootPath}`,
        );
        expect(provider.requests[0]?.messages[1]?.content).toContain('## Scheduled jobs (1)');

        const toolLog = defined(runtime.artifacts.find(runId, outcome.run.toolLogArtifactId), 'the tool audit log');
        const invocations = toolInvocationLogSchema.parse(
          runtime.artifacts.readJson(toolLog, toolInvocationLogSchema),
        );
        expect(invocations.map((invocation) => [invocation.tool, invocation.outcome])).toEqual([
          ['read_file', 'ok'],
          ['read_file', 'ok'],
          ['read_file', 'ok'],
        ]);
        expect(invocations[0]?.durationMs).toBeGreaterThanOrEqual(0);

        const prompt = readFileSync(
          join(runtime.paths.artifactRoot, 'run', `prompt-${outcome.task.taskId}-user.txt`),
          'utf8',
        );
        expect(prompt).toContain('Establish what this legacy system actually does');
        expect(prompt).not.toContain('{{digest}}');
        expect(outcome.digestChars).toBeGreaterThan(1000);
        expect(outcome.digestChars).toBeLessThan(60_000);
      },
    );
  });

  it('mirrors the run events to disk so a finished run can be replayed', async () => {
    await withRuntime(
      [readFixtureSources, jsonResponse(evidenceBasedReport())],
      async ({ runtime, runId }) => {
        await runDiscoveryStage({ runId, runtime, analysis: fixture.analysis });
        const mirrored = readEventMirror(eventMirrorPath(runtime.config.paths.artifactRoot, runId));
        expect(mirrored.map((event) => event.type)).toContain('agent.finished');
        expect(mirrored.filter((event) => event.type === 'artifact.created').length).toBeGreaterThanOrEqual(5);
      },
      { configOverrides: { ENABLE_EVENT_MIRROR: 'true' }, mirrorEvents: true },
    );
  });

  it('gives the model a chance to repair a fabricated citation before persisting anything', async () => {
    const drifted = driftOneCitation(evidenceBasedReport());
    const good = evidenceBasedReport();

    await withRuntime(
      [readFixtureSources, jsonResponse(drifted), jsonResponse(good)],
      async ({ runtime, runId, provider }) => {
        const outcome = await runDiscoveryStage({ runId, runtime, analysis: fixture.analysis });

        expect(outcome.result.status).toBe('SUCCEEDED');
        expect(outcome.artifacts.findingsJson).toBeDefined();
        expect(outcome.findings?.findings.map((finding) => finding.id)).toContain('F-FEE-ROUNDING-DRIFT');

        // The rejection named the claim that failed to resolve, and only the corrected reply landed.
        expect(provider.callCount).toBe(3);
        const repair = defined(provider.requests[2]?.messages.at(-1), 'the repair prompt');
        expect(repair.content).toContain('citations that do not resolve');
        expect(repair.content).toContain('cited file does not exist');
        expect(repair.content).toContain('F-FEE-ROUNDING-DRIFT');
      },
    );
  });

  it('drops the citation no file can vouch for and keeps the finding that still has real evidence', async () => {
    // The escalation ladder, end to end. A fabricated citation buys the model three ghost-reading
    // rounds (the host names the path that cannot be opened), then two repair rounds that carry the
    // rejection back to it — and on the last attempt, when no repair remains, the host anchors what
    // it can against real bytes. The citation no file supports is dropped; the finding survives on
    // the evidence that did resolve; nothing unverifiable is persisted.
    const drifted = driftOneCitation(evidenceBasedReport());

    await withRuntime(
      [
        readFixtureSources,
        jsonResponse(drifted),
        jsonResponse(drifted),
        jsonResponse(drifted),
        jsonResponse(drifted),
        jsonResponse(drifted),
        jsonResponse(drifted),
      ],
      async ({ runtime, runId, provider }) => {
        const outcome = await runDiscoveryStage({ runId, runtime, analysis: fixture.analysis });

        expect(outcome.result.status).toBe('SUCCEEDED');
        expect(provider.callCount).toBe(7);
        expect(outcome.artifacts.findingsJson).toBeDefined();

        const finding = outcome.findings?.findings.find((item) => item.id === 'F-FEE-ROUNDING-DRIFT');
        expect(finding?.evidence).toHaveLength(1);
        expect(finding?.evidence[0]?.location?.path).toBe(BATCH_FEE_PATH);
        expect(finding?.evidence[0]?.quote).toContain('RoundingMode.HALF_EVEN');

        const warnings = outcome.run.warnings;
        // Three rounds named the path that could not be opened...
        expect(warnings.filter((warning) => warning.includes('none of the cited paths could be opened'))).toHaveLength(3);
        // ...two repair rounds carried the rejection back to the model...
        expect(warnings.filter((warning) => warning.startsWith('final answer rejected:'))).toHaveLength(2);
        // ...and the last attempt dropped exactly the citation no file could vouch for.
        expect(warnings.some((warning) => warning.includes('dropped citation F-FEE-ROUNDING-DRIFT/ev-1'))).toBe(true);
        expect(warnings).toContain('host anchored rejected citations to real repository bytes; answer accepted after re-check');
      },
    );
  });

  it('fails the stage when the reply never becomes a schema-valid report', async () => {
    // Reading files cannot fix a reply whose shape is wrong, so schema failures take the ordinary
    // repair path — and a model that never changes its answer runs out of attempts as a recorded
    // failure, transcript and all, rather than being quietly accepted.
    const shapeless = jsonResponse({ summary: 'a report without sections, findings or questions' });

    await withRuntime([readFixtureSources, shapeless, shapeless, shapeless], async ({ runtime, runId, provider }) => {
      const outcome = await runDiscoveryStage({ runId, runtime, analysis: fixture.analysis });

      expect(provider.callCount).toBe(4);
      expect(outcome.result.status).toBe('FAILED');
      expect(outcome.result.errorCode).toBe('LLM_INVALID_RESPONSE');
      expect(outcome.result.errorMessage).toContain('rejected after 3 attempt(s)');
      expect(outcome.result.errorMessage).toContain('sections');
      expect(outcome.findings).toBeUndefined();
      expect(outcome.artifacts.findingsJson).toBeUndefined();
      // The transcript survives the failure: this has to be inspectable afterwards.
      expect(runtime.artifacts.find(runId, outcome.run.transcriptArtifactId)).toBeDefined();
    });
  });

  it('fails the stage rather than persisting a report that establishes nothing', async () => {
    const vacuous = { ...evidenceBasedReport(), findings: [], openQuestions: [] };
    await withRuntime([readFixtureSources, jsonResponse(vacuous)], async ({ runtime, runId }) => {
      const outcome = await runDiscoveryStage({ runId, runtime, analysis: fixture.analysis });
      expect(outcome.result.status).toBe('FAILED');
      expect(outcome.result.errorMessage).toContain('claims nothing and asks nothing');
      expect(outcome.findings).toBeUndefined();
      expect(outcome.artifacts.findingsJson).toBeUndefined();
      expect(outcome.result.acceptance.find((item) => item.criterionId === 'findings-present')?.satisfied).toBe(false);
      // The transcript survives the failure: this has to be inspectable afterwards.
      expect(runtime.artifacts.find(runId, outcome.run.transcriptArtifactId)).toBeDefined();
      expect(runtime.artifacts.find(runId, outcome.run.resultArtifactId)).toBeDefined();
      expect(runtime.artifacts.list(runId, { kind: 'discovery.repository-map' })).toHaveLength(1);
    });
  });

  it('gives the archaeologist read-only tools and refuses it a write', async () => {
    await withRuntime(
      [
        { toolCalls: [{ id: 'overwrite', name: 'write_file', arguments: { path: FEE_SERVICE_PATH, content: 'class FeeService {}' } }] },
        readFixtureSources,
        jsonResponse(evidenceBasedReport()),
      ],
      async ({ runtime, runId }) => {
        const outcome = await runDiscoveryStage({ runId, runtime, analysis: fixture.analysis });
        expect(outcome.result.toolCallsDenied).toBe(1);
        expect(outcome.result.toolCalls).toBe(4);
        expect(outcome.result.status).toBe('SUCCEEDED');
        expect(outcome.task.permissions.tools).not.toContain('write_file');
        expect(outcome.task.permissions.commandPatterns).toEqual([]);
        expect(readFileSync(join(fixture.root, FEE_SERVICE_PATH), 'utf8')).toContain('RoundingMode.HALF_UP');
      },
    );
  });
});

/** Narrowing helper: a fixture that is missing a piece the test depends on is a broken test. */
function defined<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`expected ${what} to be present`);
  return value;
}

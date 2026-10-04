import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MockLlmProvider, jsonResponse } from '@phoenix/llm/testing';
import {
  PhoenixError,
  agentTranscriptSchema,
  evidenceRefSchema,
  findingSchema,
  nowIso,
  type ArtifactMeta,
  type Finding,
} from '@phoenix/shared';
import {
  evidenceExistsCheck,
  runAgentTask,
  type ArtifactExpectation,
  type OutputContext,
  type OutputContribution,
} from '../src/index.js';
import {
  FEE_SERVICE_LINE,
  FEE_SERVICE_PATH,
  buildTask,
  cleanupTemporaryDirectories,
  createFixture,
  readCall,
  writeSource,
} from './support.js';

/**
 * The loop's guarantees, tested without a model: what it lets an agent do, what it stops, and what
 * it refuses to call a success.
 */

const findingDocSchema = z.object({
  generatedAt: z.string().min(1),
  findings: z.array(findingSchema).default([]),
});

/** A second real file, so a test can distinguish "read nothing" from "read the wrong thing". */
const AUDIT_WRITER_PATH = 'src/main/java/legacy/fee/AuditWriter.java';
const AUDIT_WRITER_LINE = 'public void record(String table, String id, String reason) {';
const AUDIT_WRITER_SOURCE = `package legacy.fee;

public class AuditWriter {
    ${AUDIT_WRITER_LINE}
        // appends one row to the audit trail
    }
}
`;

const outputSchema = z.object({
  summary: z.string().min(5),
  findings: z.array(z.object({ id: z.string(), note: z.string() })).default([]),
});

const EXPECTATIONS: readonly ArtifactExpectation[] = [
  {
    kind: 'discovery.findings',
    relativePath: 'discovery/findings.json',
    schema: findingDocSchema,
    items: (payload) =>
      findingDocSchema.parse(payload).findings.map((finding) => ({
        id: finding.id,
        evidence: finding.evidence,
        status: finding.epistemicStatus,
      })),
  },
];

const CRITERIA = [
  {
    id: 'findings-present',
    description: 'discovery/findings.json exists',
    kind: 'artifact-present',
    artifactKind: 'discovery.findings',
  },
  {
    id: 'findings-schema-valid',
    description: 'the findings document validates',
    kind: 'artifact-schema-valid',
    artifactKind: 'discovery.findings',
  },
  {
    id: 'findings-nonempty',
    description: 'at least one finding',
    kind: 'min-item-count',
    artifactKind: 'discovery.findings',
    minCount: 1,
  },
  {
    id: 'every-finding-evidenced',
    description: 'no finding without evidence',
    kind: 'every-item-has-evidence',
    artifactKind: 'discovery.findings',
  },
  {
    id: 'citations-resolve',
    description: 'cited files, lines and quotations exist',
    kind: 'custom-check',
    checkId: 'evidence-exists',
  },
] as const;

function realFinding(): Finding {
  return findingSchema.parse({
    id: 'F-FEE-ROUNDING',
    kind: 'behavior',
    summary: 'transfer fees are rounded half-up to two decimal places',
    epistemicStatus: 'OBSERVED',
    confidence: 0.95,
    evidence: [
      evidenceRefSchema.parse({
        id: 'F-FEE-ROUNDING-ev-1',
        kind: 'source-code',
        collectedAt: nowIso(),
        collectedBy: 'archaeologist:test',
        location: { path: FEE_SERVICE_PATH, startLine: 10, symbol: 'FeeService.fee' },
        quote: FEE_SERVICE_LINE,
      }),
    ],
  });
}

function auditTrailFinding(): Finding {
  return findingSchema.parse({
    id: 'F-AUDIT-TRAIL',
    kind: 'behavior',
    summary: 'corrections write an audit-trail row',
    epistemicStatus: 'OBSERVED',
    confidence: 0.8,
    evidence: [
      evidenceRefSchema.parse({
        id: 'F-AUDIT-TRAIL-ev-1',
        kind: 'source-code',
        collectedAt: nowIso(),
        collectedBy: 'archaeologist:test',
        location: { path: AUDIT_WRITER_PATH, startLine: 4, symbol: 'AuditWriter.record' },
        quote: AUDIT_WRITER_LINE,
      }),
    ],
  });
}

function fabricatedFinding(): Finding {
  return findingSchema.parse({
    id: 'F-INVENTED',
    kind: 'behavior',
    summary: 'the fee engine consults a table that does not exist',
    epistemicStatus: 'OBSERVED',
    confidence: 0.9,
    evidence: [
      evidenceRefSchema.parse({
        id: 'F-INVENTED-ev-1',
        kind: 'source-code',
        collectedAt: nowIso(),
        collectedBy: 'archaeologist:test',
        location: { path: 'src/main/java/legacy/fee/FeeTables.java', startLine: 4 },
        quote: 'this text appears nowhere in the repository',
      }),
    ],
  });
}

function writeFindings(finding: Finding) {
  return (value: z.infer<typeof outputSchema>, context: OutputContext): OutputContribution => ({
    artifacts: [
      context.writer.writeJson(
        'discovery.findings',
        { generatedAt: nowIso(), findings: [finding] },
        findingDocSchema,
        { slug: 'findings.json' },
      ),
    ],
    findings: [finding],
    narrative: value.summary,
  });
}

function onlyMeta(list: ArtifactMeta[]): ArtifactMeta {
  if (list.length !== 1) throw new Error(`expected exactly one artifact, found ${list.length}`);
  const meta = list[0];
  if (meta === undefined) throw new Error('unreachable');
  return meta;
}

afterAll(cleanupTemporaryDirectories);

describe('runAgentTask', () => {
  it('executes tools, persists the audit trail and judges the answer against artifacts', async () => {
    const provider = new MockLlmProvider({
      responses: [
        { toolCalls: [readCall(FEE_SERVICE_PATH)] },
        jsonResponse({
          summary: 'fees round half-up',
          findings: [{ id: 'F-FEE-ROUNDING', note: 'observed' }],
        }),
      ],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, {
      acceptanceCriteria: [...CRITERIA],
      expectedOutputs: ['discovery.findings'],
    });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'start with the fee service' },
        outputSchema,
        expectations: EXPECTATIONS,
        customChecks: { 'evidence-exists': evidenceExistsCheck({ roots: [fixture.repoRoot] }) },
        persistOutput: writeFindings(realFinding()),
      },
      fixture.runtime,
    );

    expect(provider.requests[0]?.responseFormat).toBe('json');
    expect(provider.requests[0]?.expectedSchema).toMatchObject({
      type: 'object',
      required: ['summary'],
      properties: { summary: { type: 'string', minLength: 5 } },
    });
    expect(run.result.status).toBe('SUCCEEDED');
    expect(run.result.toolCalls).toBe(1);
    expect(run.result.llmCalls).toBe(2);
    expect(run.result.tokenUsage.totalTokens).toBe(60);
    expect(run.acceptance.allSatisfied).toBe(true);
    expect(run.result.acceptance.map((outcome) => outcome.criterionId)).toEqual(
      CRITERIA.map((entry) => entry.id),
    );
    expect(run.result.evidence.map((entry) => entry.id)).toContain('F-FEE-ROUNDING-ev-1');
    expect(run.warnings).toEqual([]);

    expect(fixture.store.list(fixture.runId, { kind: 'run.prompt' })).toHaveLength(2);
    expect(fixture.store.list(fixture.runId, { kind: 'agent.task' })).toHaveLength(1);
    expect(fixture.store.list(fixture.runId, { kind: 'agent.transcript' })).toHaveLength(1);
    expect(fixture.store.list(fixture.runId, { kind: 'agent.result' })).toHaveLength(1);

    const logged = z
      .array(
        z.object({
          tool: z.string(),
          outcome: z.string(),
          durationMs: z.number().int().nonnegative(),
          argumentsSummary: z.string(),
          outputBytes: z.number().int().nonnegative(),
        }),
      )
      .parse(
        fixture.store.readJson(
          onlyMeta(fixture.store.list(fixture.runId, { kind: 'agent.tool-log' })),
          z.unknown(),
        ),
      );
    expect(logged).toEqual([expect.objectContaining({ tool: 'read_file', outcome: 'ok' })]);

    const types = fixture.sink.events.map((event) => event.type);
    for (const expected of [
      'agent.started',
      'prompt.rendered',
      'llm.completed',
      'tool.invoked',
      'artifact.created',
      'agent.step',
      'agent.finished',
    ]) {
      expect(types).toContain(expected);
    }
    expect(fixture.sink.ofType('agent.failed')).toHaveLength(0);
    expect(fixture.sink.ofType('agent.finished')[0]?.status).toBe('SUCCEEDED');
    expect(provider.purposes()).toEqual(['discovery.archaeologist', 'discovery.archaeologist']);
  });

  it('denies a tool the role profile never granted, even when the task asks for it', async () => {
    const provider = new MockLlmProvider({
      responses: [
        {
          toolCalls: [
            { id: 'c1', name: 'write_file', arguments: { path: 'X.java', content: 'class X {}' } },
          ],
        },
        jsonResponse({ summary: 'cannot write, so I read instead' }),
      ],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { allowedTools: ['read_file', 'write_file'] });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'write something' },
        outputSchema,
      },
      fixture.runtime,
    );

    expect(run.warnings.join('\n')).toContain('write_file');
    expect(run.result.toolCallsDenied).toBe(1);
    expect(fixture.sink.ofType('tool.denied')).toHaveLength(1);
    const offered = provider.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(offered).not.toContain('write_file');
    expect(offered).toContain('read_file');
  });

  it('stops at the tool budget instead of looping', async () => {
    const provider = new MockLlmProvider({
      responder: (_request, index) => ({ toolCalls: [readCall(FEE_SERVICE_PATH, `c${index}`)] }),
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { budget: { maxSteps: 20, maxToolCalls: 2 } });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'loop' },
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('FAILED');
    expect(run.result.errorCode).toBe('AGENT_BUDGET_EXCEEDED');
    expect(run.result.toolCalls).toBe(2);
    expect(run.result.nextRecommendedAction?.kind).toBe('collect-more-evidence');
    expect(fixture.sink.ofType('agent.failed')).toHaveLength(1);
  });

  it('stops at the step limit when the model never answers', async () => {
    const provider = new MockLlmProvider({
      responder: (_request, index) =>
        index < 2
          ? { toolCalls: [readCall(FEE_SERVICE_PATH, `c${index}`)] }
          : jsonResponse({ summary: 'too late' }),
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { budget: { maxSteps: 2, maxToolCalls: 10 } });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'loop' },
        outputSchema,
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('FAILED');
    expect(run.result.errorCode).toBe('AGENT_STEP_LIMIT');
    expect(run.value).toBeUndefined();
  });

  it('stops when the wall-clock budget is exhausted', async () => {
    const provider = new MockLlmProvider({
      responder: (_request, index) => ({ toolCalls: [readCall(FEE_SERVICE_PATH, `c${index}`)] }),
      latencyMs: 15,
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { budget: { maxSteps: 50, maxToolCalls: 50, timeoutMs: 1 } });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'slow' },
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('TIMEOUT');
    expect(run.result.errorCode).toBe('AGENT_TIMEOUT');
  });

  it('stops when the token ceiling is reached', async () => {
    const provider = new MockLlmProvider({
      responder: (_request, index) => ({
        toolCalls: [readCall(FEE_SERVICE_PATH, `c${index}`)],
        usage: { promptTokens: 500, completionTokens: 500, totalTokens: 1000 },
      }),
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, {
      budget: { maxSteps: 20, maxToolCalls: 20, maxTokens: 1000 },
    });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'expensive' },
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('FAILED');
    expect(run.result.errorCode).toBe('AGENT_BUDGET_EXCEEDED');
    expect(run.result.tokenUsage.totalTokens).toBe(1000);
  });

  it('repairs a malformed final answer instead of accepting it', async () => {
    const provider = new MockLlmProvider({
      responses: [
        'I looked at the code and it rounds fees.',
        jsonResponse({ summary: 'fees round half-up to two decimals' }),
      ],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'answer in json' },
        outputSchema,
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(run.value?.summary).toContain('half-up');
    expect(run.warnings.join('\n')).toContain('final answer rejected');
    const repair = provider.requests[1]?.messages.at(-1);
    expect(repair?.role).toBe('user');
    expect(repair?.content).toContain('ONLY the corrected JSON value');
  });

  it('feeds a fabricated citation back as a repairable rejection inside the loop', async () => {
    const provider = new MockLlmProvider({
      responses: [
        { toolCalls: [readCall(FEE_SERVICE_PATH)] },
        jsonResponse({
          summary: 'done and dusted',
          findings: [{ id: 'F-INVENTED', note: 'observed' }],
        }),
        jsonResponse({
          summary: 'done and dusted',
          findings: [{ id: 'F-FEE-ROUNDING', note: 'observed' }],
        }),
      ],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { acceptanceCriteria: [...CRITERIA] });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        expectations: EXPECTATIONS,
        customChecks: { 'evidence-exists': evidenceExistsCheck({ roots: [fixture.repoRoot] }) },
        persistOutput: writeFindings(realFinding()),
        evidenceSource: (value) =>
          value.findings.map((finding) =>
            finding.id === 'F-FEE-ROUNDING' ? realFinding() : fabricatedFinding(),
          ),
      },
      fixture.runtime,
    );

    // The first answer is schema-valid, so only the citation check can reject it. The host attempts
    // the exact evidence path, reports that it does not exist, and accepts only the corrected reply.
    expect(run.result.status).toBe('SUCCEEDED');
    expect(run.value?.findings[0]?.id).toBe('F-FEE-ROUNDING');
    expect(run.warnings.join('\n')).toContain('none of the cited paths could be opened');
    expect(run.acceptance.allSatisfied).toBe(true);
    const repair = provider.requests[2]?.messages.at(-1);
    expect(repair?.role).toBe('user');
    expect(repair?.content).toContain('F-INVENTED');
    expect(repair?.content).toContain('cited file does not exist');
    expect(repair?.content).toContain('NOT OPENED');
    expect(provider.callCount).toBe(3);
  });

  it('rejects a verbatim-correct citation to a file the agent never opened', async () => {
    // The answer below quotes the fixture source exactly. It is still refused: the agent opened a
    // different file, so this quote can only have come from the brief or from memory. Reading the file
    // it cites is what makes the same answer acceptable, and the rejection is what makes it read.
    const answer = jsonResponse({
      summary: 'done and dusted',
      findings: [{ id: 'F-FEE-ROUNDING', note: 'observed' }],
    });
    const provider = new MockLlmProvider({
      responses: [
        { toolCalls: [readCall(AUDIT_WRITER_PATH)] },
        answer,
        { toolCalls: [readCall(FEE_SERVICE_PATH)] },
        answer,
      ],
    });
    const fixture = createFixture({ provider });
    writeSource(
      fixture.repoRoot,
      AUDIT_WRITER_PATH,
      'package legacy.fee;\n\npublic class AuditWriter {}\n',
    );
    const task = buildTask(fixture, {
      acceptanceCriteria: [...CRITERIA],
      budget: { maxSteps: 12, maxToolCalls: 5 },
    });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        expectations: EXPECTATIONS,
        customChecks: { 'evidence-exists': evidenceExistsCheck({ roots: [fixture.repoRoot] }) },
        persistOutput: writeFindings(realFinding()),
        evidenceSource: () => [realFinding()],
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(4);
    const repair = provider.requests[2]?.messages.at(-1);
    expect(repair?.content).toContain('was never opened with read_file');
    expect(repair?.content).toContain(FEE_SERVICE_PATH);
  });

  it('clips a long rejection note for the event mirror and keeps the whole note in the transcript', async () => {
    // A rejection quotes every problem it found, so it routinely exceeds the 2000 characters the step
    // event allows. The mirror is clipped; the transcript is not. An unclipped summary would throw
    // inside the loop and turn a repairable rejection into a dead run with no report at all.
    const verboseSchema = z.object({ summary: z.string().min(5) }).superRefine((value, ctx) => {
      if (value.summary.includes('evidenced')) return;
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['summary'],
        message:
          `a summary must say what was evidenced. ${'this rejection explains at length why that matters. '.repeat(60)}`.trim(),
      });
    });
    const provider = new MockLlmProvider({
      responses: [
        jsonResponse({ summary: 'the fee service rounds half up' }),
        jsonResponse({ summary: 'evidenced by FeeService.java line 12' }),
      ],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'answer in json' },
        outputSchema: verboseSchema,
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(2);

    const summaries = fixture.sink.ofType('agent.step').map((event) => event.summary);
    for (const summary of summaries) expect(summary.length).toBeLessThanOrEqual(2_000);
    expect(summaries.some((summary) => summary.length === 2_000 && summary.endsWith('…'))).toBe(
      true,
    );

    const transcript = agentTranscriptSchema.parse(
      fixture.store.readJson(
        onlyMeta(fixture.store.list(fixture.runId, { kind: 'agent.transcript' })),
        z.unknown(),
      ),
    );
    const notes = transcript.steps.flatMap((step) => (step.note === undefined ? [] : [step.note]));
    expect(
      notes.some((note) => note.length > 2_000 && note.startsWith('final answer rejected')),
    ).toBe(true);
  });

  it('refuses an answer from an agent that opened no file, even when it cites none', async () => {
    // The citation gate judges the claims an answer makes, so an answer that claims nothing walks
    // straight through it. An evidence-backed stage that never read the repository has still produced
    // a report about code it has not seen, and the loop says so instead of accepting an empty answer.
    const answer = jsonResponse({ summary: 'done and dusted', findings: [] });
    const provider = new MockLlmProvider({
      responses: [answer, { toolCalls: [readCall(FEE_SERVICE_PATH)] }, answer],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        evidenceSource: () => [],
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(3);
    const repair = provider.requests[1]?.messages.at(-1);
    expect(repair?.content).toContain('without opening a single file');
    expect(repair?.content).toContain('read_file');
  });

  it('demands the reading even when the same answer also fails the schema', async () => {
    // A model that skips its tools usually gets the shape wrong as well. When the schema complaint
    // arrives alone, the spelling is the only thing it repairs, and the run dies on cosmetics while the
    // gate that actually matters — did you read anything — never got exercised. The answer names no
    // file, so there is nothing for the host to read on its behalf and the rejection is all it gets.
    const provider = new MockLlmProvider({
      responses: [
        jsonResponse({
          summary: 'fees',
          findings: [{ id: 'F-CALC_XFER_FEE', note: 'see the fee service' }],
        }),
        { toolCalls: [readCall(FEE_SERVICE_PATH)] },
        jsonResponse({ summary: 'the fee service rounds half up', findings: [] }),
      ],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        evidenceSource: () => [],
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(3);
    const repair = provider.requests[1]?.messages.at(-1);
    expect(repair?.content).toContain('without opening a single file');
    expect(repair?.content).toContain('Call read_file on the sources the task names');
    expect(repair?.content).toContain('at least 5 character');
  });

  it('reads the files a premature answer named and hands their real bytes back', async () => {
    // The model never calls a tool, and the server ignores `tool_choice`, so no prompt can make it read.
    // What it can do is name the files it thinks are relevant. The host turns that list into the reads
    // the model refused to make — through the same executor, so the permissions, the events and the
    // citation gate all see an ordinary read_file — and the answer is rebuilt from real bytes.
    const answer = jsonResponse({
      summary: 'the fee service rounds half up',
      findings: [{ id: 'F-FEE-ROUNDING', note: `see ${FEE_SERVICE_PATH}` }],
    });
    const provider = new MockLlmProvider({ responses: [answer, answer] });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        evidenceSource: () => [realFinding()],
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(2);

    const handed = provider.requests[1]?.messages.at(-1);
    expect(handed?.role).toBe('user');
    expect(handed?.content).toContain(`=== ${FEE_SERVICE_PATH} ===`);
    expect(handed?.content).toContain(FEE_SERVICE_LINE);
    expect(handed?.content).toContain('copy every `quote` exactly as it appears above');
    // The rejected answer is kept in the conversation, so the model can see what it is correcting.
    expect(provider.requests[1]?.messages.at(-2)?.role).toBe('assistant');

    expect(run.warnings.join('\n')).toContain('the host read 1 of the paths it cited');
    expect(fixture.sink.ofType('tool.invoked').map((event) => event.tool)).toEqual(['read_file']);
    const steps = run.steps.filter((step) => step.kind === 'tool-call');
    expect(steps).toHaveLength(1);
    expect(steps[0]?.note).toContain('host-initiated read');
  });

  it('opens the exact cited evidence when the model read a different file', async () => {
    // Reading an unrelated file does not satisfy read-before-cite. The host follows the structured
    // evidence path rather than unrelated path-like strings in the answer.
    const provider = new MockLlmProvider({
      responses: [
        { toolCalls: [readCall(AUDIT_WRITER_PATH)] },
        jsonResponse({
          summary: 'the fee service rounds half up',
          findings: [{ id: 'F-FEE-ROUNDING', note: 'observed' }],
        }),
        jsonResponse({ summary: 'the fee service rounds half up', findings: [] }),
      ],
    });
    const fixture = createFixture({ provider });
    writeSource(
      fixture.repoRoot,
      AUDIT_WRITER_PATH,
      'package legacy.fee;\n\npublic class AuditWriter {}\n',
    );
    const task = buildTask(fixture, { budget: { maxSteps: 12 } });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        evidenceSource: (value) => (value.findings.length > 0 ? [realFinding()] : []),
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    const repair = provider.requests[2]?.messages.at(-1);
    expect(repair?.content).toContain('citations that do not resolve');
    expect(repair?.content).toContain(`=== ${FEE_SERVICE_PATH} ===`);
    expect(repair?.content).toContain(FEE_SERVICE_LINE);
    expect(run.warnings.join('\n')).toContain(
      'the model cited files it never opened, so the host read 1 of the paths it cited',
    );
  });

  it('does not intervene for a task that requires no evidence', async () => {
    // A narrative task is allowed to answer from reasoning; the host reading files it never asked about
    // would spend its tool budget on material the task did not want.
    const provider = new MockLlmProvider({ responses: ['a plain prose answer', 'another one'] });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'narrate' },
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(1);
    expect(fixture.sink.ofType('tool.invoked')).toHaveLength(0);
  });

  it('names the paths it could not open, then stops when the read rounds run out', async () => {
    // An answer that cites nothing real leaves `openedFiles` empty, so an unbounded loop would spend
    // every remaining step rediscovering that. Three rounds, each naming the paths that could not be
    // opened, and then the ordinary rejection — which by then carries the work list built from the
    // paths the model keeps inventing.
    const answer = jsonResponse({
      summary: 'the fee service rounds half up',
      findings: [{ id: 'F-INVENTED', note: 'see src/main/java/legacy/fee/FeeTables.java' }],
    });
    const provider = new MockLlmProvider({ responses: [answer, answer, answer, answer] });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { budget: { maxSteps: 12 } });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        evidenceSource: () => [fabricatedFinding()],
        maxStructuredRepairs: 0,
      },
      fixture.runtime,
    );

    expect(provider.callCount).toBe(4);
    expect(run.result.status).toBe('FAILED');
    expect(run.result.errorMessage).toContain('you answered without opening a single file');
    expect(run.result.errorMessage).toContain(
      'read_file "src/main/java/legacy/fee/FeeTables.java"',
    );

    for (const attempt of [1, 2, 3]) {
      const handed = provider.requests[attempt]?.messages.at(-1);
      expect(handed?.content).toContain('NOT OPENED');
      expect(handed?.content).toContain('src/main/java/legacy/fee/FeeTables.java');
    }
    expect(run.warnings.join('\n')).toContain('none of the cited paths could be opened');

    const attempts = run.steps.filter((step) => step.kind === 'tool-call');
    expect(attempts).toHaveLength(3);
    expect(attempts.every((step) => step.toolResults[0]?.ok === false)).toBe(true);
  });

  it('opens the unread files behind a rejected citation and rebuilds the answer from their bytes', async () => {
    // Run 12's failure, in miniature: the model reads one file itself, then answers with a quote from a
    // file it never opened. Telling it what that file's real line says is useless when it has never seen
    // the file, so the host opens the cited-but-unread file and the next answer is built from those bytes.
    const answer = jsonResponse({
      summary: 'corrections write an audit-trail row',
      findings: [{ id: 'F-AUDIT-TRAIL', note: `recorded by ${AUDIT_WRITER_PATH}` }],
    });
    const provider = new MockLlmProvider({
      responses: [{ toolCalls: [readCall(FEE_SERVICE_PATH)] }, answer, answer],
    });
    const fixture = createFixture({ provider });
    writeSource(fixture.repoRoot, AUDIT_WRITER_PATH, AUDIT_WRITER_SOURCE);
    const task = buildTask(fixture, { budget: { maxSteps: 12 } });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        evidenceSource: () => [auditTrailFinding()],
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(3);

    const handed = provider.requests[2]?.messages.at(-1);
    expect(handed?.role).toBe('user');
    expect(handed?.content).toContain('citations that do not resolve');
    expect(handed?.content).toContain(`=== ${AUDIT_WRITER_PATH} ===`);
    expect(handed?.content).toContain(AUDIT_WRITER_LINE);

    expect(run.warnings.join('\n')).toContain(
      'the model cited files it never opened, so the host read 1 of the paths it cited',
    );
    expect(fixture.sink.ofType('tool.invoked').map((event) => event.tool)).toEqual([
      'read_file',
      'read_file',
    ]);
    const steps = run.steps.filter((step) => step.kind === 'tool-call');
    expect(steps).toHaveLength(2);
    expect(steps[1]?.note).toContain('host-initiated read: the model cited files it never opened');
  });

  it('replaces the citation list with the nothing-read rejection when no file was opened', async () => {
    // Every violation in that list has the same cause. Quoting eight of them reads as eight separate
    // complaints about spelling and invites the model to argue about its quotes instead of reading.
    const answer = jsonResponse({ summary: 'the fee service rounds half up', findings: [] });
    const provider = new MockLlmProvider({
      responses: [answer, { toolCalls: [readCall(FEE_SERVICE_PATH)] }, answer],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'cite carefully' },
        outputSchema,
        evidenceSource: () => [realFinding()],
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(provider.callCount).toBe(3);
    const first = provider.requests[1]?.messages.at(-1);
    expect(first?.content).toContain('without opening a single file');
    expect(first?.content).not.toContain('citations that do not resolve');
  });

  it('fails when the model cannot produce a schema-valid answer within the repair budget', async () => {
    const provider = new MockLlmProvider({ responder: () => 'prose, never json' });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { budget: { maxSteps: 10 } });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'answer in json' },
        outputSchema,
        maxStructuredRepairs: 1,
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('FAILED');
    expect(run.result.errorCode).toBe('LLM_INVALID_RESPONSE');
    expect(run.result.errorMessage).toContain('rejected after 2 attempt(s)');
    expect(provider.callCount).toBe(2);
  });

  it('hands persistOutput the parsed value, so schema defaults are applied', async () => {
    // The model omitted `findings`. The schema defaults it to an empty array, and that default has to
    // reach the host: a persister given the raw reply would have to guess which optional fields the
    // model happened to leave out, and a stage that iterates one crashes on `undefined`.
    const provider = new MockLlmProvider({
      responses: [jsonResponse({ summary: 'nothing to report' })],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);
    const persisted: unknown[] = [];

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
        outputSchema,
        persistOutput: (value) => {
          persisted.push(...value.findings);
          return { artifacts: [], narrative: value.summary };
        },
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('SUCCEEDED');
    expect(run.value?.findings).toEqual([]);
    expect(persisted).toEqual([]);
  });

  it('records a failure when the host cannot persist the answer, and keeps the transcript', async () => {
    const provider = new MockLlmProvider({ responses: [jsonResponse({ summary: 'plausible' })] });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
        outputSchema,
        persistOutput: () => {
          throw new PhoenixError(
            'SCHEMA_VALIDATION_FAILED',
            'the report claims nothing and asks nothing',
            {},
          );
        },
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('FAILED');
    expect(run.result.errorCode).toBe('SCHEMA_VALIDATION_FAILED');
    expect(run.result.errorMessage).toContain('claims nothing');
    expect(fixture.store.list(fixture.runId, { kind: 'agent.transcript' })).toHaveLength(1);
    expect(fixture.store.list(fixture.runId, { kind: 'agent.result' })).toHaveLength(1);
  });

  it('fails a criterion it cannot evaluate rather than passing it by default', async () => {
    const provider = new MockLlmProvider({
      responses: [jsonResponse({ summary: 'done and dusted' })],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, {
      acceptanceCriteria: [
        {
          id: 'mystery-check',
          description: 'a check nobody registered',
          kind: 'custom-check',
          checkId: 'does-not-exist',
        },
        {
          id: 'unprojected-items',
          description: 'item criteria against a kind with no registered projection',
          kind: 'every-item-has-evidence',
          artifactKind: 'discovery.findings',
        },
      ],
    });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
        outputSchema,
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('FAILED');
    const byId = new Map(run.result.acceptance.map((outcome) => [outcome.criterionId, outcome]));
    expect(byId.get('mystery-check')?.reason).toContain('no deterministic check is registered');
    expect(byId.get('unprojected-items')?.reason).toContain(
      'no schema registered for artifact kind',
    );
  });

  it('refuses to accept a finding whose citation does not exist', async () => {
    const provider = new MockLlmProvider({
      responses: [jsonResponse({ summary: 'done and dusted' })],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture, { acceptanceCriteria: [...CRITERIA] });

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
        outputSchema,
        expectations: EXPECTATIONS,
        customChecks: { 'evidence-exists': evidenceExistsCheck({ roots: [fixture.repoRoot] }) },
        persistOutput: writeFindings(fabricatedFinding()),
      },
      fixture.runtime,
    );

    // Artifacts exist and four criteria hold, but a false citation is enough to deny success.
    expect(run.result.status).toBe('PARTIAL');
    expect(run.result.nextRecommendedAction?.kind).toBe('collect-more-evidence');
    const citation = run.result.acceptance.find(
      (outcome) => outcome.criterionId === 'citations-resolve',
    );
    expect(citation?.satisfied).toBe(false);
    expect(citation?.reason).toContain('cited file does not exist');
  });

  it('reports success but says so plainly when a task declares no acceptance criteria', async () => {
    const provider = new MockLlmProvider({
      responses: [jsonResponse({ summary: 'done and dusted' })],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
        outputSchema,
      },
      fixture.runtime,
    );

    expect(run.result.acceptance).toEqual([]);
    expect(run.warnings.join('\n')).toContain('no acceptance criteria');
    expect(run.acceptance.summary).toBe('no acceptance criteria declared; nothing was verified');
  });

  it('stops immediately when the caller aborts', async () => {
    const provider = new MockLlmProvider({
      responder: () => jsonResponse({ summary: 'never reached' }),
    });
    const fixture = createFixture({ provider });
    const controller = new AbortController();
    controller.abort();
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
        outputSchema,
        signal: controller.signal,
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('CANCELLED');
    expect(run.result.errorCode).toBe('AGENT_CANCELLED');
    expect(provider.callCount).toBe(0);
  });

  it('records a provider failure as a typed error instead of throwing it away', async () => {
    const provider = new MockLlmProvider({
      responses: [{ error: new PhoenixError('LLM_RATE_LIMITED', 'slow down', { status: 429 }) }],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
      },
      fixture.runtime,
    );

    expect(run.result.status).toBe('FAILED');
    expect(run.result.errorCode).toBe('LLM_RATE_LIMITED');
    expect(run.steps.filter((step) => step.kind === 'llm-call')).toHaveLength(0);
    expect(run.result.generatedArtifacts).toEqual([]);
  });

  it('clips oversized tool output before handing it back to the model', async () => {
    const provider = new MockLlmProvider({
      responses: [
        { toolCalls: [readCall(FEE_SERVICE_PATH)] },
        jsonResponse({ summary: 'read it' }),
      ],
    });
    const fixture = createFixture({ provider });
    const task = buildTask(fixture);

    const run = await runAgentTask(
      {
        task,
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'go' },
        outputSchema,
        maxToolResultChars: 40,
      },
      fixture.runtime,
    );

    const toolMessage = provider.requests[1]?.messages.find((message) => message.role === 'tool');
    expect(toolMessage?.content).toContain('characters omitted');
    expect(toolMessage?.content.length).toBeLessThan(120);
    expect(run.result.status).toBe('SUCCEEDED');
  });

  it('persists the rendered prompt of every task separately, with its own context', async () => {
    const provider = new MockLlmProvider({
      responses: [
        jsonResponse({ summary: 'first task' }),
        jsonResponse({ summary: 'second task' }),
      ],
    });
    const fixture = createFixture({ provider });

    const first = await runAgentTask(
      {
        task: buildTask(fixture, { objective: 'first objective' }),
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'a' },
        outputSchema,
      },
      fixture.runtime,
    );
    const second = await runAgentTask(
      {
        task: buildTask(fixture, {
          objective: 'second objective',
          context: 'carried over from the first stage',
        }),
        systemPromptId: 'fixture.system',
        userPromptId: 'fixture.task',
        promptVariables: { hint: 'b' },
        outputSchema,
      },
      fixture.runtime,
    );

    expect(first.task.taskId).not.toBe(second.task.taskId);
    expect(fixture.store.list(fixture.runId, { kind: 'agent.result' })).toHaveLength(2);
    expect(fixture.store.list(fixture.runId, { kind: 'run.prompt' })).toHaveLength(4);

    const userPrompt = onlyMeta(
      fixture.store
        .list(fixture.runId, { kind: 'run.prompt' })
        .filter(
          (meta) =>
            meta.relativePath.includes(second.task.taskId) &&
            meta.relativePath.endsWith('-user.txt'),
        ),
    );
    const rendered = fixture.store.readText(userPrompt);
    expect(rendered).toContain('second objective');
    expect(rendered).toContain('Hint: b');
    expect(rendered).not.toContain('{{');

    // The stage context travels in the task record, which is what a later stage reads.
    const taskRecord = onlyMeta(
      fixture.store
        .list(fixture.runId, { kind: 'agent.task' })
        .filter((meta) => meta.relativePath.includes(second.task.taskId)),
    );
    expect(fixture.store.readJson(taskRecord, z.unknown())).toMatchObject({
      context: 'carried over from the first stage',
    });
  });
});

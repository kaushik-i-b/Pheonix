import { resolve } from 'node:path';
import type { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { FileArtifactStore } from '@phoenix/artifact-store';
import { tryExtractJson, type LlmProvider, type PromptRegistry } from '@phoenix/llm';
import {
  toolSpecsFor,
  type ToolContext,
  type ToolExecutor,
  type ToolOutcome,
  type ToolPaths,
} from '@phoenix/repository-tools';
import {
  addUsage,
  agentResultSchema,
  agentStepSchema,
  agentTranscriptSchema,
  canonicalizePath,
  describeError,
  estimateCost,
  findPricing,
  isRetryableCode,
  newStepId,
  nowIso,
  tokenUsageSchema,
  type AcceptanceOutcome,
  type AgentResult,
  type AgentStep,
  type AgentTask,
  type AgentTaskStatus,
  type ArtifactId,
  type ArtifactInputRef,
  type CompletionResult,
  type EventSequencer,
  type EvidenceRef,
  type Finding,
  type GeneratedArtifact,
  type JsonSchemaSpec,
  type LlmMessage,
  type LlmPricingTable,
  type Logger,
  type PhoenixErrorCode,
  type RolePermissions,
  type ToolCallRequest,
  type ToolInvocation,
  type NextAction,
  type TokenUsage,
} from '@phoenix/shared';
import {
  evaluateAcceptance,
  type AcceptanceReport,
  type ArtifactExpectation,
  type CustomCheck,
  type TestRunSummary,
} from './acceptance.js';
import { renderContractBlock } from './contract.js';
import { checkFindingEvidence, resolveCitedPath } from './evidence-check.js';
import { effectivePermissions } from './permissions.js';
import {
  AGENT_RUNTIME_GENERATOR,
  createArtifactWriter,
  persistResultRecord,
  persistTaskRecord,
  persistToolLog,
  persistTranscript,
  type ArtifactWriter,
} from './record.js';

/**
 * The agent loop.
 *
 * One task in, one judged result out. The loop owns four things that must not be left to the
 * model: which tools may be called, how much of them may be used, what counts as an acceptable
 * answer, and whether the answer is acceptable. The model contributes reasoning and structured
 * claims; deterministic code executes, persists, checks and decides. An agent that says "done"
 * has produced, at most, a candidate.
 */

/**
 * Builds the tool layer for one task. It is a factory rather than a shared instance because the
 * command allowlist and the working-directory roots are properties of the *role*: a single
 * executor built from the union of every profile would let any agent run any command.
 */
export type ToolExecutorFactory = (permissions: RolePermissions, task: AgentTask) => ToolExecutor;

export interface AgentRuntime {
  provider: LlmProvider;
  prompts: PromptRegistry;
  artifacts: FileArtifactStore;
  createTools: ToolExecutorFactory;
  events: EventSequencer;
  paths: ToolPaths;
  pricing?: LlmPricingTable;
  /** Deterministic checks referenced by `custom-check` acceptance criteria. */
  customChecks?: Readonly<Record<string, CustomCheck>>;
  logger?: Logger;
}

export interface OutputContext {
  task: AgentTask;
  writer: ArtifactWriter;
  inputs: readonly ArtifactInputRef[];
}

export interface OutputContribution {
  artifacts: readonly GeneratedArtifact[];
  findings?: readonly Finding[];
  unresolvedUnknowns?: readonly string[];
  narrative?: string;
}

/** The host-side read an anchoring policy may perform while rewriting rejected citations. */
export interface CitationReadOutcome {
  /** Complete real file bytes, or undefined when the read failed or was truncated. */
  text?: string;
  /** Why the read failed, clipped for inclusion in a rejection message. */
  problem?: string;
  /** True only when the host proved that no valid citation can be recovered from this path. */
  definitive?: boolean;
}

export interface CitationRewriteRequest<TValue> {
  /** The parsed answer whose citations did not resolve. */
  value: TValue;
  /** Reads through the same audited executor the model used: same permissions, same tool log entry. */
  read: (path: string) => Promise<CitationReadOutcome>;
  /** True on the last attempt: a citation that still cannot be anchored will never get another. */
  attemptsExhausted: boolean;
}

export interface CitationRewriteOutcome<TValue> {
  /** A rewritten answer, re-parsed and re-checked by the loop before it can be accepted. */
  value?: TValue;
  /** Loud record of what the rewrite did; each note lands in the run's warnings and step log. */
  notes?: readonly string[];
  /**
   * What the model has to change, appended to its rejection message when no rewritten answer came
   * back. `notes` describe what the host did; this carries what the host proved wrong from the real
   * bytes — the only part the model can act on, and the part the generic citation checker cannot
   * know, because it never tried to locate the quote.
   */
  feedback?: readonly string[];
}

export interface AgentInvocation<TValue> {
  task: AgentTask;
  /** Versioned prompt files: the role's system prompt and this task's user prompt. */
  systemPromptId: string;
  userPromptId: string;
  promptVariables?: Record<string, unknown>;
  /** Stable label for this call, reported in `llm.completed`. Defaults to `<stage>.<role>`. */
  purpose?: string;
  /** Schema the model's final answer must satisfy; without it the task yields only a narrative. */
  outputSchema?: z.ZodType<TValue, z.ZodTypeDef, unknown>;
  /**
   * Extracts the findings a validated answer claims. When set, the loop verifies every citation
   * against the real files before accepting the answer, and a citation that does not resolve is fed
   * back as a rejection the model can repair — the same failure is otherwise only discovered by the
   * acceptance check after the loop has ended, when it is too late to fix.
   */
  evidenceSource?: (value: TValue) => readonly Finding[];
  /**
   * Last-resort repair for citations that do not resolve. The host anchors the answer's quotes to the
   * repository's real bytes and hands back a rewritten value; the loop re-parses it and re-checks it
   * before accepting, so the model still never gets to declare its own evidence valid. Only the host
   * decides what the bytes say — the model decides which behaviour is worth reporting.
   */
  rewriteCitations?: (
    request: CitationRewriteRequest<TValue>,
  ) => Promise<CitationRewriteOutcome<TValue>>;
  /**
   * A shortfall in an answer that parsed cleanly and whose citations all resolved: the schema cannot
   * express it, but the stage's contract requires it. Reported to the model once, with the fix, and
   * then the answer is accepted whatever it says — a shortfall the acceptance criteria already grade
   * as PARTIAL is more useful than a hard failure that leaves the run with no artifact to diagnose.
   * The gap must never be closable by inventing content, so the returned message is expected to name
   * the honest alternative as well.
   */
  contractGap?: (value: TValue) => string | undefined;
  /** Turns the validated answer into artifacts. Runs in host code, never in the model. */
  persistOutput?: (
    value: TValue,
    context: OutputContext,
  ) => OutputContribution | Promise<OutputContribution>;
  /** Artifacts produced deterministically for this task, e.g. by static analysis. */
  precomputedArtifacts?: readonly GeneratedArtifact[];
  expectations?: readonly ArtifactExpectation[];
  testRuns?: readonly TestRunSummary[];
  customChecks?: Readonly<Record<string, CustomCheck>>;
  /** When true, source-code evidence without a startLine triggers the rewrite path. */
  requireStartLine?: boolean;
  /**
   * Where in-loop citation checks may resolve quotes. Defaults to the legacy repository only: a
   * citation is a claim about the system under analysis, and adding the run's own artifact root here
   * lets the elsewhere-hint point the model at its own previous answers in run/events.jsonl — the
   * exact text it invented last attempt — laundering fabrication into verified evidence.
   */
  evidenceRoots?: readonly string[];
  /** Additional structured-output repair rounds after the first attempt. */
  maxStructuredRepairs?: number;
  /** Cap on tool output handed back to the model, so one large file cannot end the run. */
  maxToolResultChars?: number;
  signal?: AbortSignal;
}

export interface AgentRun<TValue> {
  task: AgentTask;
  result: AgentResult;
  /** The validated structured answer, when the task asked for one. */
  value: TValue | undefined;
  steps: AgentStep[];
  invocations: ToolInvocation[];
  acceptance: AcceptanceReport;
  taskArtifactId: ArtifactId;
  transcriptArtifactId: ArtifactId;
  toolLogArtifactId: ArtifactId;
  resultArtifactId: ArtifactId;
  warnings: string[];
}

interface LoopFailure {
  /** A `PhoenixErrorCode`, or `AGENT_CANCELLED`, which is a runtime-only condition. */
  code: PhoenixErrorCode | 'AGENT_CANCELLED';
  message: string;
  retryable: boolean;
}

const DEFAULT_MAX_STRUCTURED_REPAIRS = 2;
/**
 * One objection per contract gap, never two. The gap is a shortfall the schema cannot express, so the
 * model cannot be shown a failing parse to learn from — it gets one round with the requirement spelled
 * out, and if it still cannot meet it the answer is accepted and the acceptance criteria grade it
 * PARTIAL. That grade is the honest outcome: a run with an artifact and a recorded limitation can be
 * diagnosed, and a run that hard-failed on a second identical objection cannot.
 */
const MAX_CONTRACT_ROUNDS = 1;
const DEFAULT_MAX_TOOL_RESULT_CHARS = 24_000;
const MAX_EVIDENCE_REFS = 200;
const MAX_ASSISTANT_TEXT = 20_000;
/** `agentStepEventSchema.summary` is capped at exactly this; a step note is capped at 4000. */
const STEP_EVENT_SUMMARY_LIMIT = 2_000;
const STEP_NOTE_LIMIT = 4_000;
/**
 * Anchoring diagnoses carried into a rejection message. Bounded for the same reason the host-read
 * rounds are: a repair message longer than the model's attention gets ignored rather than acted on,
 * and the citations that did not resolve are the ones worth the space.
 */
const CITATION_FEEDBACK_MAX = 8;

/**
 * Host-initiated reading, and why the host is allowed to do it.
 *
 * A model that never calls a tool cannot be argued into calling one. Three consecutive discovery runs
 * against qwen2.5-coder:7b-instruct produced the same 8571-character answer with the same invented
 * quotes on every attempt, and the server ignores `tool_choice` — both `'required'` and a named
 * function — so there is no way to force a call from the outside either. Prompt-only enforcement of
 * "read before you answer" therefore does not hold on a model this size.
 *
 * The premature answer is still useful: the paths it cites are a reading plan in the wrong format. So
 * the host performs those reads through the same executor the model was given — same permissions, same
 * clipping, same `tool.invoked` event, same entry in the task's tool log — and puts the repository's
 * real bytes in front of the model.
 *
 * This does not weaken the evidence gate. Quotes are still matched verbatim against the real files, and
 * a file the host did not open is still a file the model may not cite. What changes is who pressed the
 * button; the bytes being reasoned over are the repository's either way.
 *
 * The same reasoning applies a second time. A discovery run in which the host read three cited files
 * produced two verbatim-correct quotes — real trigger and fee-calculation SQL, copied character for
 * character — and three fabricated ones, all for files the round had not opened. Telling the model what
 * the real line says does not help when it has never seen the file; there is nothing to correct against.
 * So a round is also spent on the unread paths behind a rejected citation, for the same reason as the
 * first: the model cannot quote bytes nobody handed it.
 */
const HOST_READ_MAX_ROUNDS = 3;
const HOST_READ_MAX_FILES = 4;
/** Paths considered per round, including the ones that turn out not to exist. */
const HOST_READ_MAX_CITED = 8;
/**
 * Cumulative across every round, and sized against the context window rather than the repository. The
 * discovery prompt is ~13k tokens on a 32k-context model, each rejected answer it echoes back costs
 * another ~2k, and generation needs `LLM_MAX_TOKENS` of headroom on top; run 13 measured what happens
 * when that arithmetic is ignored — a 26k-token prompt plus 8k of reserved output overflowed the window,
 * forced context shifts, and the second model call ran past its 15-minute client timeout.
 *
 * A total rather than a per-round figure because rounds accumulate in the conversation: three rounds of
 * 40k each would be 30k tokens of source text alone, and the model would lose the system prompt and the
 * task brief off the front of its context — the two things it most needs to answer correctly.
 */
const HOST_READ_TOTAL_CHARS = 24_000;
/**
 * Floor on one file's share of that budget. Without it the last file in a round would be clipped to a
 * few hundred characters of no use to anyone, and the total can overshoot `HOST_READ_TOTAL_CHARS` by at
 * most this much.
 */
const HOST_READ_MIN_FILE_CHARS = 3_000;
/**
 * Cap on reads spent anchoring a rejected answer's citations, shared across every quote and attempt.
 * A discovery answer cites at most a handful of files; the bound exists so a malformed answer that
 * names a different nonexistent path for every evidence item cannot turn one rejection into an
 * unbounded file-scanning loop. The anchoring reads land in the same tool log as any other read.
 */
const MAX_CITATION_READS = 12;

/**
 * Rejection for an answer produced by a task that must cite sources, given by an agent that read none.
 *
 * A model that skips its tools answers from the brief and from prior training, which is exactly the
 * fabrication this loop exists to prevent. The gate fires on the shape of the reply, not on whether
 * it happened to parse: a small model that both skipped its tools and misspelled an id will otherwise
 * spend its whole repair budget on the spelling and never learn that reading is mandatory.
 *
 * The paths it is told to open are the paths its own rejected answer cited, so the instruction is a
 * work list rather than an abstraction.
 */
function nothingReadProblem(citedPaths: readonly string[]): string {
  const head =
    'you answered without opening a single file. Nothing here may be claimed from the task brief, from the digest, ' +
    'or from memory: every quote must be copied from bytes a read_file call returned in this task.';
  if (citedPaths.length === 0)
    return `${head} Call read_file on the sources the task names, then answer again.`;
  const plan = citedPaths.map((path, index) => `${index + 1}. read_file "${path}"`).join('\n');
  return `${head}\nYour answer cites these files. Open every one of them before answering again:\n${plan}`;
}

const PATH_LIKE =
  /(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+|\b[A-Za-z0-9_.-]+\.(?:java|sql|xml|properties|ya?ml|json|js|ts|sh|md|gradle|kt|py|go|rs)\b/g;

/**
 * File paths a rejected reply refers to, in order of first appearance, capped for a repair message.
 *
 * Walks the decoded JSON when there is one and falls back to the raw text, because the common failure
 * is a reply that is close enough to name real files and not close enough to parse. Only strings that
 * look like a path or a source filename are taken: placeholders (`<relative/path/…>`) and prose are
 * dropped, and the cap keeps the message inside the model's attention rather than burying the point.
 */
function citedPathsOf(value: unknown, max = 8): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const take = (text: string): void => {
    for (const match of text.matchAll(PATH_LIKE)) {
      const candidate = match[0];
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      found.push(candidate);
      if (found.length >= max) return;
    }
  };
  const walk = (node: unknown, depth: number): void => {
    if (found.length >= max || depth > 12) return;
    if (typeof node === 'string') {
      take(node);
    } else if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
    } else if (typeof node === 'object' && node !== null) {
      for (const item of Object.values(node as Record<string, unknown>)) walk(item, depth + 1);
    }
  };
  walk(value, 0);
  return found;
}

function evidencePathsOf<TValue>(
  value: TValue,
  source: (value: TValue) => readonly Finding[],
  max = 8,
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const finding of source(value)) {
    for (const evidence of finding.evidence) {
      const path = evidence.location?.path;
      if (path === undefined || seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
      if (paths.length >= max) return paths;
    }
  }
  return paths;
}

/** A zod `min(1)` failure on an evidence-backed claim, as `describeIssues` renders it. */
const EMPTY_EVIDENCE_ISSUE =
  /(rules|invariants|findings)\.(\d+)\.(sourceEvidence|evidence): Array must contain at least 1 element/g;

/** Repair bullets for a claim that arrived with an empty evidence list. */
function emptyEvidenceGuidance(problem: string, priorValue: unknown): string[] {
  const bullets: string[] = [];
  const seen = new Set<string>();
  for (const match of problem.matchAll(EMPTY_EVIDENCE_ISSUE)) {
    const collection = match[1];
    const rawIndex = match[2];
    const evidenceField = match[3];
    if (collection === undefined || rawIndex === undefined || evidenceField === undefined) continue;
    const index = Number(rawIndex);
    const claim = claimOf(priorValue, collection, index);
    const id = claimIdOf(claim, collection) ?? `the claim at ${collection}[${rawIndex}]`;
    if (seen.has(id)) continue;
    seen.add(id);
    const noun =
      collection === 'rules' ? 'rule' : collection === 'invariants' ? 'invariant' : 'finding';
    const unsupported =
      collection === 'findings'
        ? 'record the gap under openQuestions and drop the finding, so long as at least one evidenced finding remains.'
        : `record what is known about it under unknowns and drop it, so long as at least one evidenced ${noun} remains.`;
    bullets.push(
      `- ${id} (${noun} at ${collection}[${rawIndex}]) has an empty ${evidenceField} list; the schema requires at least one entry. ` +
        `Open the file that shows this behaviour with read_file and add an entry whose quote is copied verbatim from the bytes you saw. ` +
        `If the claim cannot be evidenced from this repository, stop asserting it as a ${noun}: ${unsupported}`,
    );
  }
  return bullets;
}

function claimOf(value: unknown, collection: string, index: number): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const list = (value as Record<string, unknown>)[collection];
  if (!Array.isArray(list)) return undefined;
  return list[index];
}

function claimIdOf(claim: unknown, collection: string): string | undefined {
  if (typeof claim !== 'object' || claim === null || Array.isArray(claim)) return undefined;
  const idField =
    collection === 'rules' ? 'ruleId' : collection === 'invariants' ? 'invariantId' : 'id';
  const id = (claim as Record<string, unknown>)[idField];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** One file the host opened on the model's behalf, or one it tried to and could not. */
interface HostRead {
  path: string;
  ok: boolean;
  content?: string;
  problem?: string;
}

/**
 * The message that replaces a rejected answer with the bytes that answer claimed to be based on.
 *
 * Deliberately not a rebuke. A model that resubmits the same answer is not being stubborn, it is being
 * given nothing to change: the previous rejection named files but did not contain them. This one does,
 * and states concretely what a re-answer may now be built from.
 *
 * `complaint` is the specific reason the answer was refused, so the model can see which of its habits
 * the bytes are meant to replace.
 */
function hostReadMessage(
  complaint: string,
  reads: readonly HostRead[],
  notOpened: readonly string[],
): string {
  const lines: string[] = [
    complaint,
    '',
    'Phoenix opened the files your answer named, using the same read_file tool you were given. Their real contents follow.',
    '',
  ];
  for (const read of reads) {
    lines.push(
      read.ok
        ? `=== ${read.path} ===`
        : `=== ${read.path} === NOT OPENED: ${read.problem ?? 'unknown reason'}`,
    );
    if (read.ok) lines.push(read.content ?? '');
    lines.push('');
  }
  if (notOpened.length > 0) {
    lines.push(
      `Not opened, because this round's read budget was already spent: ${notOpened.join(', ')}. Call read_file on them yourself if you need them.`,
      '',
    );
  }
  lines.push(
    'Answer again, using only these bytes:',
    '- copy every `quote` exactly as it appears above. A quote you remember from training is not a quote from this repository, and it will not match.',
    '- cite only files whose contents you can see here, or files you opened yourself with read_file.',
    '- anything these bytes do not settle is a gap to report, not a finding to invent.',
    'Reply with ONLY the corrected JSON value. No prose, no code fences, no commentary.',
  );
  return lines.join('\n');
}

/**
 * The message that opens the reserved final call.
 *
 * A model that only ever asks for tools never reaches an answer on its own: every call it is allowed
 * to make ends in tool calls, the loop runs out of steps, and the run is recorded as cut short with
 * nothing persisted. So the last permitted call is taken away from investigation — tools are
 * disabled at the provider — and this message says what to do with it instead. It forbids inventing
 * evidence for the same reason the rest of the loop does: an honest gap is usable downstream, a
 * fabricated citation is not.
 */
function finalCallInstruction(hasTools: boolean, structured: boolean): string {
  const lines: string[] = ['This is your final model call.'];
  if (hasTools) {
    lines.push(
      'Tool calls are disabled for it, so nothing you ask for here will be run and you cannot read or search anything else.',
    );
  }
  lines.push(
    'Produce your final answer now, from the evidence you have already collected in this conversation.',
    '- Support every claim from material that appears above: a file you opened, a tool result, or the task brief.',
    '- Put anything that material does not support into your unknowns, with the strategy that would settle it, and say plainly that you could not establish it.',
    '- Do not invent a path, a line number or a quote to make the answer look complete. A recorded gap is accepted; invented evidence is rejected and recorded against this task.',
  );
  lines.push(
    structured
      ? 'Reply with ONLY one complete JSON value, and nothing around it. A reply cut off by the token limit is rejected; a nested object inside an unfinished document is not a final answer. Prefer a short value that includes every required field over a longer one that does not finish.'
      : 'Reply with your final answer now.',
  );
  return lines.join('\n');
}

export async function runAgentTask<TValue>(
  invocation: AgentInvocation<TValue>,
  runtime: AgentRuntime,
): Promise<AgentRun<TValue>> {
  const task = invocation.task;
  const startedAtDate = new Date();
  const startedAt = nowIso(startedAtDate);
  const { permissions, ungrantedTools, maxToolCalls } = effectivePermissions(task);
  const specs = toolSpecsFor(permissions);
  const toolContext: ToolContext = {
    runId: task.runId,
    taskId: task.taskId,
    role: task.role,
    permissions,
    paths: runtime.paths,
  };
  const purpose = invocation.purpose ?? `${task.stage.toLowerCase()}.${task.role}`;
  const expectedSchema: JsonSchemaSpec | undefined =
    invocation.outputSchema === undefined
      ? undefined
      : (zodToJsonSchema(invocation.outputSchema, {
          target: 'jsonSchema7',
          $refStrategy: 'none',
          effectStrategy: 'input',
        }) as JsonSchemaSpec);
  const tools = runtime.createTools(permissions, task);

  const inputs: ArtifactInputRef[] = task.inputArtifacts.map((input) => ({
    artifactId: input.artifactId,
    kind: input.kind,
    role: input.role,
  }));
  const writer = createArtifactWriter({
    store: runtime.artifacts,
    events: runtime.events,
    run: { runId: task.runId, stage: task.stage, role: task.role, taskId: task.taskId },
    inputs,
  });
  const taskArtifact = persistTaskRecord(writer, task);

  runtime.events.next(task.runId, 'agent.started', {
    stage: task.stage,
    role: task.role,
    taskId: task.taskId,
    objective: task.objective.slice(0, 4000),
    allowedTools: permissions.tools,
  });

  const warnings: string[] = [];
  const steps: AgentStep[] = [];
  const recordStep = (step: Omit<AgentStep, 'stepId' | 'taskId' | 'index' | 'at'>): AgentStep => {
    const recorded = agentStepSchema.parse({
      ...step,
      // A note quotes whatever went wrong, and what went wrong can be long. Clip it here rather than
      // at every call site: a note that overruns its schema would throw inside the loop and abort the
      // task, and the full text still reaches the model in the repair message that carries it.
      ...(step.note === undefined ? {} : { note: clipTo(step.note, STEP_NOTE_LIMIT) }),
      stepId: newStepId(),
      taskId: task.taskId,
      index: steps.length,
      at: nowIso(),
    });
    steps.push(recorded);
    runtime.events.next(task.runId, 'agent.step', {
      stage: task.stage,
      role: task.role,
      taskId: task.taskId,
      stepId: recorded.stepId,
      index: recorded.index,
      kind: recorded.kind === 'acceptance-check' ? 'note' : recorded.kind,
      summary: clipTo(stepSummary(recorded), STEP_EVENT_SUMMARY_LIMIT),
    });
    return recorded;
  };

  if (ungrantedTools.length > 0) {
    const note = `task requested tools the role profile does not grant: ${ungrantedTools.join(', ')}`;
    warnings.push(note);
    recordStep({ kind: 'note', toolCalls: [], toolResults: [], note });
  }
  if (task.acceptanceCriteria.length === 0) {
    const note =
      'task declares no acceptance criteria; success will mean only that the loop completed';
    warnings.push(note);
    recordStep({ kind: 'note', toolCalls: [], toolResults: [], note });
  }

  const variables: Record<string, unknown> = {
    ...(invocation.promptVariables ?? {}),
    taskId: task.taskId,
    runId: task.runId,
    role: task.role,
    stage: task.stage,
    objective: task.objective,
    ...(task.context !== undefined ? { context: task.context } : {}),
    allowedTools: permissions.tools.join(', '),
  };
  const messages: LlmMessage[] = [];
  for (const entry of [
    { promptId: invocation.systemPromptId, slug: 'system' },
    { promptId: invocation.userPromptId, slug: 'user' },
  ]) {
    const rendered = runtime.prompts.render(entry.promptId, variables, { runId: task.runId });
    const artifact = writer.writeText('run.prompt', rendered.renderedText, {
      slug: `prompt-${task.taskId}-${entry.slug}`,
      title: `${rendered.promptId} v${rendered.promptVersion}`,
      tags: ['prompt', entry.slug],
      format: 'text',
    });
    runtime.events.next(task.runId, 'prompt.rendered', {
      stage: task.stage,
      role: task.role,
      taskId: task.taskId,
      promptId: rendered.promptId,
      promptVersion: rendered.promptVersion,
      promptHash: rendered.hash,
      purpose,
      artifactId: artifact.artifactId,
    });
    messages.push({
      role: entry.slug === 'system' ? 'system' : 'user',
      content:
        entry.slug === 'system'
          ? `${rendered.renderedText}\n\n${renderContractBlock(task, permissions)}`
          : rendered.renderedText,
      toolCalls: [],
    });
  }

  const budget = task.budget;
  const deadline = startedAtDate.getTime() + budget.timeoutMs;
  const maxToolResultChars = invocation.maxToolResultChars ?? DEFAULT_MAX_TOOL_RESULT_CHARS;
  const maxStructuredRepairs = invocation.maxStructuredRepairs ?? DEFAULT_MAX_STRUCTURED_REPAIRS;
  /** Kept in sync with the stage's `evidence-exists` check so the loop gate and the judge agree. */
  const evidenceRoots = invocation.evidenceRoots ?? [runtime.paths.legacyRoot];

  let usage: TokenUsage = tokenUsageSchema.parse({
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
  });
  let llmCalls = 0;
  let toolCallCount = 0;
  let deniedCalls = 0;
  let repairs = 0;
  let value: TValue | undefined;
  let finalText = '';
  let failure: LoopFailure | undefined;
  let answered = false;
  /** Absolute paths the agent really opened with `read_file`, used to refuse citations it never read. */
  const openedFiles = new Set<string>();
  /**
   * Absolute paths this invocation has already been told do not exist.
   *
   * `read_file` answers a missing path identically every time, so a second automatic read of one can only
   * repeat "file not found" — while costing the step the model needed to act on the correction the first
   * read already earned it. Only the definitive answer is remembered: a read that failed for another
   * reason may succeed on a later round, and forgetting that would be a silent downgrade of a real fault.
   */
  const missingPaths = new Set<string>();
  /**
   * Bounded because a round can fail without learning anything final — a denied path, or one left
   * unattempted when the read budget ran out — and an unbounded loop would spend every remaining step
   * retrying that. Paths that failed definitively are handled by `missingPaths`, not by this cap.
   */
  let hostReadRounds = 0;
  /** Characters already handed back across all rounds, against `HOST_READ_TOTAL_CHARS`. */
  let hostReadChars = 0;
  /** Contract objections already raised, against `MAX_CONTRACT_ROUNDS`. */
  let contractRounds = 0;

  /**
   * The stage's contract objection to an answer that is otherwise acceptable, or `undefined` when there
   * is none left to make. Called only at an accept point, so it never rejects an answer the schema or the
   * citation gate had already refused — and bounded, so an answer that cannot meet the contract is
   * accepted on the second pass and graded by the acceptance criteria instead of failing the run.
   */
  const contractGapOf = (candidate: TValue): string | undefined => {
    if (invocation.contractGap === undefined) return undefined;
    if (contractRounds >= MAX_CONTRACT_ROUNDS) return undefined;
    const gap = invocation.contractGap(candidate);
    if (gap === undefined) return undefined;
    contractRounds += 1;
    return gap;
  };

  /**
   * Runs one tool call and records it. Shared by the model's own calls and the host-initiated reads, so
   * a read is audited identically whichever side asked for it: same permission check, same clipping,
   * same event, same line in the task's tool log. `note` marks the host-initiated ones.
   */
  const performToolCall = async (call: ToolCallRequest, note?: string): Promise<ToolOutcome> => {
    const outcome = await tools.invoke(call, toolContext);
    toolCallCount += 1;
    if (call.name === 'read_file' && outcome.result.ok) {
      const readPath = outcome.result.meta.path;
      if (typeof readPath === 'string') openedFiles.add(canonicalizePath(readPath));
    }
    if (outcome.invocation.outcome === 'denied') {
      deniedCalls += 1;
      runtime.events.next(task.runId, 'tool.denied', {
        stage: task.stage,
        role: task.role,
        taskId: task.taskId,
        tool: call.name,
        reason: outcome.invocation.denialReason ?? 'denied by the tool layer',
        requested: outcome.invocation.argumentsSummary,
      });
    } else {
      runtime.events.next(task.runId, 'tool.invoked', {
        stage: task.stage,
        role: task.role,
        taskId: task.taskId,
        tool: call.name,
        argumentsSummary: outcome.invocation.argumentsSummary,
        ...(outcome.invocation.exitCode !== undefined
          ? { exitCode: outcome.invocation.exitCode }
          : {}),
        durationMs: outcome.invocation.durationMs,
        outputSummary: outcome.invocation.outputSummary.slice(0, 2000),
        outputBytes: outcome.invocation.outputBytes,
        truncated: outcome.invocation.truncated,
      });
    }
    recordStep({
      kind: 'tool-call',
      toolCalls: [{ id: call.id, name: call.name, arguments: call.arguments }],
      toolResults: [
        {
          id: outcome.result.id,
          name: outcome.result.name,
          ok: outcome.result.ok,
          content: clipForModel(outcome.result.content, maxToolResultChars),
          truncated: outcome.result.truncated,
          denied: outcome.result.denied,
          ...(outcome.result.denialReason !== undefined
            ? { denialReason: outcome.result.denialReason }
            : {}),
          meta: outcome.result.meta,
        },
      ],
      durationMs: outcome.invocation.durationMs,
      ...(note === undefined ? {} : { note }),
    });
    return outcome;
  };

  /**
   * One host-initiated reading round: open the paths the model named but never read, and replace its
   * rejected answer with the repository's actual bytes.
   *
   * Returns false when the round attempted nothing at all — the path list was empty, every path was
   * already reported missing, or every path was already past the read budget — so the caller falls
   * through to the ordinary rejection instead of sending a message that carries neither bytes nor names.
   * A round whose reads all failed is still worth sending: the `NOT OPENED` lines answer "why can't I
   * cite this file", which is how a model that invented a path learns the path is not there.
   */
  const hostReadRound = async (
    paths: readonly string[],
    complaint: string,
    note: string,
  ): Promise<boolean> => {
    const canonicalRoots = evidenceRoots.map((root) => canonicalizePath(resolve(root)));
    const candidates = paths.filter((path) => {
      const resolved = resolveCitedPath(path, canonicalRoots);
      return resolved === undefined || !missingPaths.has(resolved);
    });
    if (candidates.length === 0) return false;
    hostReadRounds += 1;
    const reads: HostRead[] = [];
    const notOpened: string[] = [];
    let slots = HOST_READ_MAX_FILES;
    for (const path of candidates) {
      if (slots === 0 || hostReadChars >= HOST_READ_TOTAL_CHARS || toolCallCount >= maxToolCalls) {
        notOpened.push(path);
        continue;
      }
      // A small file leaves its unused share to the larger ones behind it, so the budget is spent on bytes
      // instead of on an even split that clips the one file that carries the behaviour.
      const share = Math.max(
        HOST_READ_MIN_FILE_CHARS,
        Math.floor((HOST_READ_TOTAL_CHARS - hostReadChars) / slots),
      );
      const outcome = await performToolCall(
        {
          id: `host_read_${hostReadRounds}_${reads.length}`,
          name: 'read_file',
          arguments: { path },
        },
        `host-initiated read: ${note}`,
      );
      if (!outcome.result.ok) {
        // Costs a tool call but not one of the five read slots: a path that does not exist should buy the
        // model a correction, not shrink the material it gets to reason over.
        reads.push({ path, ok: false, problem: clipTo(outcome.result.content, 200) });
        if (outcome.result.content.startsWith('file not found:')) {
          const resolved = resolveCitedPath(path, canonicalRoots);
          if (resolved !== undefined) missingPaths.add(resolved);
        }
        continue;
      }
      slots -= 1;
      const content = clipForModel(outcome.result.content, share);
      hostReadChars += content.length;
      reads.push({ path, ok: true, content });
    }
    if (reads.length === 0) return false;
    const opened = reads.filter((read) => read.ok).length;
    const summary =
      opened === 0
        ? `${note}; none of the cited paths could be opened`
        : `${note}, so the host read ${opened} of the paths it cited`;
    warnings.push(summary);
    recordStep({ kind: 'note', toolCalls: [], toolResults: [], note: summary });
    messages.push({
      role: 'assistant',
      content: finalText.slice(0, MAX_ASSISTANT_TEXT),
      toolCalls: [],
    });
    messages.push({
      role: 'user',
      content: hostReadMessage(complaint, reads, notOpened),
      toolCalls: [],
    });
    return true;
  };

  /**
   * Host-initiated reads for citation anchoring, cached per resolved path so a second quote against the
   * same file is free. The reads go through `performToolCall` rather than raw filesystem access, for
   * the same reason the host reading round does: a file opened here is a file in `openedFiles`, in the
   * tool log, and in the run's events, or the answer that results from it would fail the very gate it
   * was meant to satisfy.
   */
  const hostAnchorReadCache = new Map<string, Promise<CitationReadOutcome>>();
  let citationReadCount = 0;
  const hostAnchorRead = async (path: string): Promise<CitationReadOutcome> => {
    const canonicalRoots = evidenceRoots.map((root) => canonicalizePath(resolve(root)));
    const resolved = resolveCitedPath(path, canonicalRoots);
    if (resolved === undefined) {
      return {
        problem: clipTo(`the cited path does not resolve inside the evidence roots: ${path}`, 300),
        definitive: true,
      };
    }
    const cached = hostAnchorReadCache.get(resolved);
    if (cached !== undefined) return cached;
    if (citationReadCount >= MAX_CITATION_READS || toolCallCount >= maxToolCalls) {
      return { problem: 'the host read budget for anchoring citations is exhausted' };
    }
    citationReadCount += 1;
    const pending = (async (): Promise<CitationReadOutcome> => {
      const outcome = await performToolCall(
        {
          id: `host_anchor_${citationReadCount}`,
          name: 'read_file',
          arguments: { path: resolved, maxBytes: 4_000_000 },
        },
        'host-initiated read: anchoring a rejected citation to real bytes',
      );
      if (!outcome.result.ok) {
        const definitive = outcome.result.content.startsWith('file not found:');
        if (definitive) missingPaths.add(resolved);
        return {
          problem: clipTo(outcome.result.content, 300),
          ...(definitive ? { definitive: true } : {}),
        };
      }
      if (outcome.result.truncated) {
        return {
          problem:
            'the cited file exceeds the complete-read limit, so its quotation could not be anchored safely',
        };
      }
      return { text: outcome.result.content };
    })();
    hostAnchorReadCache.set(resolved, pending);
    return pending;
  };

  for (let step = 0; step < budget.maxSteps; step += 1) {
    if (callerAborted(invocation.signal)) {
      failure = {
        code: 'AGENT_CANCELLED',
        message: 'task was cancelled by the caller',
        retryable: false,
      };
      break;
    }
    if (Date.now() > deadline) {
      failure = {
        code: 'AGENT_TIMEOUT',
        message: `task exceeded its ${budget.timeoutMs}ms budget after ${llmCalls} model call(s)`,
        retryable: false,
      };
      break;
    }
    if (budget.maxTokens !== undefined && usage.totalTokens >= budget.maxTokens) {
      failure = {
        code: 'AGENT_BUDGET_EXCEEDED',
        message: `token budget exhausted: ${usage.totalTokens} of ${budget.maxTokens}`,
        retryable: false,
      };
      break;
    }

    let completion: CompletionResult;
    const callStartedAt = Date.now();
    // The last permitted call is reserved for answering: tools are disabled at the provider, so a
    // model that has been investigating for every step so far still gets one call in which it can
    // only produce its final answer. Without this, a tool-seeking model spends the whole budget on
    // tools and dies at AGENT_STEP_LIMIT having persisted nothing.
    const reservedFinalCall = step === budget.maxSteps - 1;
    if (reservedFinalCall) {
      messages.push({
        role: 'user',
        content: finalCallInstruction(specs.length > 0, expectedSchema !== undefined),
        toolCalls: [],
      });
    }
    try {
      completion = await runtime.provider.complete(
        {
          purpose,
          messages,
          tools: specs,
          toolChoice: specs.length > 0 && !reservedFinalCall ? 'auto' : 'none',
          responseFormat: expectedSchema === undefined ? 'text' : 'json',
          ...(expectedSchema === undefined ? {} : { expectedSchema }),
        },
        {
          // The signal goes in options, not the request: `completionRequestSchema` has no `signal`
          // field and would strip it before the provider ever saw it.
          ...(invocation.signal !== undefined ? { signal: invocation.signal } : {}),
          onWarn: (message) => {
            warnings.push(message);
          },
        },
      );
    } catch (error) {
      // An abort surfaces as a failed fetch. Reporting it as a provider outage would make the
      // deadline look retryable when the same deadline would recur.
      if (callerAborted(invocation.signal)) {
        failure = {
          code: 'AGENT_CANCELLED',
          message: `task was cancelled by the caller after ${llmCalls} model call(s)`,
          retryable: false,
        };
        runtime.logger?.error('agent llm call aborted', { taskId: task.taskId });
        break;
      }
      const described = describeError(error);
      failure = {
        code: described.code,
        message: described.message,
        retryable: isRetryableCode(described.code),
      };
      runtime.logger?.error('agent llm call failed', { taskId: task.taskId, ...described });
      break;
    }

    llmCalls += 1;
    usage = addUsage(usage, completion.usage);
    const cost =
      completion.cost ??
      estimateCost(completion.usage, findPricing(runtime.pricing, completion.model));
    // The transcript field is capped by its schema. Parsing and acceptance below use
    // `completion.text` itself, so a display cap cannot turn a long reply into a different value.
    const recordedAssistantText = completion.text.slice(0, MAX_ASSISTANT_TEXT);
    if (completion.text.length > recordedAssistantText.length) {
      warnings.push(
        `transcript stores ${recordedAssistantText.length} of ${completion.text.length} assistant characters; validation uses the full reply`,
      );
    }
    recordStep({
      kind: 'llm-call',
      promptHash: completion.promptHash,
      model: completion.model,
      assistantText: recordedAssistantText,
      toolCalls: completion.toolCalls.map((call) => ({
        id: call.id,
        name: call.name,
        arguments: call.arguments,
      })),
      toolResults: [],
      usage: completion.usage,
      durationMs: Date.now() - callStartedAt,
    });
    runtime.events.next(task.runId, 'llm.completed', {
      stage: task.stage,
      role: task.role,
      taskId: task.taskId,
      providerId: completion.providerId,
      model: completion.model,
      purpose,
      promptHash: completion.promptHash,
      durationMs: completion.latencyMs,
      retries: Math.max(0, completion.attempts - 1),
      usage: completion.usage,
      ...(cost !== undefined ? { cost } : {}),
      ...(completion.finishReason !== undefined ? { finishReason: completion.finishReason } : {}),
      structured: invocation.outputSchema !== undefined,
      validationRepairs: repairs,
    });

    if (completion.toolCalls.length > 0) {
      messages.push({
        role: 'assistant',
        content: completion.text,
        toolCalls: completion.toolCalls.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          ...(call.rawArguments !== undefined ? { rawArguments: call.rawArguments } : {}),
        })),
      });
      let budgetHit = false;
      for (const call of completion.toolCalls) {
        if (toolCallCount >= maxToolCalls) {
          budgetHit = true;
          break;
        }
        const outcome = await performToolCall({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
        messages.push({
          role: 'tool',
          content: clipForModel(outcome.result.content, maxToolResultChars),
          name: call.name,
          toolCallId: call.id,
          toolCalls: [],
        });
      }
      if (budgetHit) {
        failure = {
          code: 'AGENT_BUDGET_EXCEEDED',
          message: `tool budget exhausted after ${toolCallCount} call(s)`,
          retryable: false,
        };
        break;
      }
      continue;
    }

    finalText = completion.text;
    const truncated = truncatedAnswerFailure(
      purpose,
      completion,
      finalText,
      invocation.outputSchema !== undefined,
    );
    if (truncated !== undefined) {
      failure = truncated;
      warnings.push(truncated.message);
      recordStep({
        kind: 'note',
        toolCalls: [],
        toolResults: [],
        note: truncated.message,
      });
      break;
    }
    if (invocation.outputSchema === undefined) {
      answered = true;
      break;
    }

    const extracted = tryExtractJson(finalText);
    const parsed =
      extracted === undefined ? undefined : invocation.outputSchema.safeParse(extracted.value);
    const citedPaths =
      parsed?.success === true && invocation.evidenceSource !== undefined
        ? evidencePathsOf(parsed.data, invocation.evidenceSource, HOST_READ_MAX_CITED)
        : citedPathsOf(extracted?.value ?? finalText, HOST_READ_MAX_CITED);

    if (
      invocation.evidenceSource !== undefined &&
      openedFiles.size === 0 &&
      hostReadRounds < HOST_READ_MAX_ROUNDS &&
      toolCallCount < maxToolCalls
    ) {
      const handed = await hostReadRound(
        citedPaths,
        'Your answer was not accepted. You produced it without opening a single file, so nothing in it was read from this repository and none of its quotes were verified.',
        'the model answered without opening a file',
      );
      if (handed) continue;
    }

    let problem =
      extracted === undefined
        ? 'the reply contained no JSON value'
        : parsed?.success === false
          ? describeIssues(parsed.error)
          : undefined;
    /** Set only when the answer parsed and its citations were actually checked: the anchoring trigger. */
    let citationProblem: string | undefined;
    /**
     * Set when the answer is schema-valid and fully cited but misses part of the stage's contract. Kept
     * apart from `problem` because it changes what the rejection says: the citation-specific guidance and
     * the unread-files round both describe a defect this answer does not have.
     */
    let contractProblem: string | undefined;
    if (invocation.evidenceSource !== undefined && openedFiles.size === 0) {
      // Nothing-read outranks citation violations, because every one of them has that same cause and a
      // list of them reads as eight separate complaints about spelling. It does not outrank a schema
      // failure: that is an independent problem the model still has to fix on the next attempt.
      const unread = nothingReadProblem(citedPaths);
      problem = problem === undefined ? unread : `${unread}\n${problem}`;
    } else if (parsed?.success === true && invocation.evidenceSource !== undefined) {
      citationProblem = citationProblems(
        parsed.data,
        invocation.evidenceSource,
        evidenceRoots,
        openedFiles,
        invocation.requireStartLine === true,
      );
      problem = citationProblem;
    }

    if (
      citationProblem !== undefined &&
      parsed?.success === true &&
      invocation.evidenceSource !== undefined &&
      invocation.outputSchema !== undefined &&
      invocation.rewriteCitations !== undefined
    ) {
      // The host's last resort before rejecting: locate the answer's quotes in the repository's real
      // bytes and rebuild the answer from them. Runs before the unread-files round so an answer that
      // only needed anchoring is not sent back for a model round-trip; a rewrite that leaves residual
      // problems still falls through to that round and to the ordinary repair path.
      const rewrite = await invocation.rewriteCitations({
        value: parsed.data,
        read: hostAnchorRead,
        attemptsExhausted: repairs >= maxStructuredRepairs,
      });
      for (const note of (rewrite.notes ?? []).slice(0, 12)) {
        warnings.push(note);
        recordStep({
          kind: 'note',
          toolCalls: [],
          toolResults: [],
          note: clipTo(note, STEP_NOTE_LIMIT),
        });
      }
      if (rewrite.value === undefined) {
        // No rewritten answer, so the model gets another attempt. Telling it only that a quote "does
        // not appear" leaves it guessing which of the three causes applies — paraphrase, fusion of
        // two places, or invention — and a model that guesses wrong resubmits the same quote. The
        // host has already read the bytes and worked out which one it was.
        problem = appendCitationFeedback(problem, rewrite.feedback);
      } else {
        const reParsed = invocation.outputSchema.safeParse(rewrite.value);
        if (reParsed.success) {
          const rechecked = citationProblems(
            reParsed.data,
            invocation.evidenceSource,
            evidenceRoots,
            openedFiles,
            invocation.requireStartLine === true,
          );
          if (rechecked === undefined) {
            const gap = contractGapOf(reParsed.data);
            if (gap === undefined) {
              value = reParsed.data;
              answered = true;
              warnings.push(
                'host anchored rejected citations to real repository bytes; answer accepted after re-check',
              );
              recordStep({
                kind: 'note',
                toolCalls: [],
                toolResults: [],
                note: 'citation rewrite accepted: every surviving quote resolves to repository bytes',
              });
              break;
            }
            // Anchoring fixed every quote, so the citation complaint is spent; what is left is the part
            // of the contract the anchored answer still does not meet.
            contractProblem = gap;
            problem = gap;
          } else {
            problem = rechecked;
          }
        } else {
          problem = describeIssues(reParsed.error);
        }
      }
    }

    if (
      parsed?.success === true &&
      problem !== undefined &&
      contractProblem === undefined &&
      invocation.evidenceSource !== undefined &&
      hostReadRounds < HOST_READ_MAX_ROUNDS &&
      toolCallCount < maxToolCalls
    ) {
      // The rejected citations name files, and the ones the model never opened are the ones it could not
      // have quoted honestly: telling it what the real line says does not help when it has never seen the
      // file. The same three-file round that turned run 12's fabrications into verbatim quotes is spent on
      // the unread paths behind the violations, and the next attempt is built from bytes.
      const canonicalRoots = evidenceRoots.map((root) => canonicalizePath(resolve(root)));
      const unread = evidencePathsOf(
        parsed.data,
        invocation.evidenceSource,
        HOST_READ_MAX_CITED,
      ).filter((path) => {
        const resolved = resolveCitedPath(path, canonicalRoots);
        return resolved !== undefined && !openedFiles.has(resolved);
      });
      if (unread.length > 0) {
        const handed = await hostReadRound(
          unread,
          `Your answer was not accepted. Some of its quotes do not appear in the files they cite:\n${problem}`,
          'the model cited files it never opened',
        );
        if (handed) continue;
      }
    }

    if (parsed?.success === true && problem === undefined) {
      // The parsed value, not the raw JSON: defaults and refinements are part of the contract, and a
      // `persistOutput` that receives the model's literal reply has to guess which optional arrays
      // the model happened to omit.
      const gap = contractGapOf(parsed.data);
      if (gap === undefined) {
        value = parsed.data;
        answered = true;
        break;
      }
      contractProblem = gap;
      problem = gap;
    }

    // The reserved final call has no following step, so a repair message queued here would never be
    // sent and the task would be recorded as AGENT_STEP_LIMIT. Name the rejection instead.
    if (reservedFinalCall || (repairs >= maxStructuredRepairs && contractProblem === undefined)) {
      failure = {
        code: 'LLM_INVALID_RESPONSE',
        message: `final answer for "${purpose}" was rejected after ${repairs + 1} attempt(s): ${problem ?? 'unknown problem'}`,
        retryable: false,
      };
      warnings.push(`final answer rejected: ${problem ?? 'unknown problem'}`);
      recordStep({
        kind: 'note',
        toolCalls: [],
        toolResults: [],
        note: `final answer rejected: ${problem ?? 'unknown'}`,
      });
      break;
    }
    // A contract objection spends its own single allowance rather than a citation repair: the answer it
    // refuses has no citation defect, so charging the citation budget for it would leave a later, real
    // citation repair unable to run.
    if (contractProblem === undefined) repairs += 1;
    warnings.push(`final answer rejected: ${problem ?? 'unknown problem'}`);
    messages.push({
      role: 'assistant',
      content: finalText.slice(0, MAX_ASSISTANT_TEXT),
      toolCalls: [],
    });
    messages.push({
      role: 'user',
      content: [
        contractProblem === undefined
          ? 'Your final answer was rejected.'
          : 'Your final answer parsed and every quote in it resolved, but it is incomplete: it does not meet this task’s contract.',
        problem !== undefined && problem.includes('\n')
          ? `Problems:\n${problem}`
          : `Problems: ${problem ?? 'unknown problem'}`,
        'Fix every problem before answering again:',
        ...emptyEvidenceGuidance(problem ?? '', extracted?.value),
        '- Open with read_file every file you cite, and copy each quote exactly from the bytes you see. Never quote from memory or from the task brief.',
        ...(contractProblem === undefined
          ? [
              '- If a problem names a file where the text actually appears, cite that file and quote its exact text.',
              '- If the text exists nowhere you can find, drop that evidence and record the gap instead of inventing it.',
              'Do not resubmit your previous answer unchanged: identical citations are rejected identically.',
            ]
          : [
              '- Keep everything you already produced and add only what is missing.',
              '- If you cannot support the missing part from this repository, record it under unknowns with the strategy that would settle it, and say plainly that you could not establish it.',
            ]),
        'You may call your read and search tools again to fix these problems.',
        'When you are done, reply with ONLY the corrected JSON value. No prose, no code fences, no commentary.',
      ].join('\n'),
      toolCalls: [],
    });
    recordStep({
      kind: 'note',
      toolCalls: [],
      toolResults: [],
      note: `final answer rejected: ${problem ?? 'unknown'}`,
    });
  }

  if (failure === undefined && !answered) {
    failure = {
      code: 'AGENT_STEP_LIMIT',
      message: `task stopped after ${budget.maxSteps} steps without producing a final answer`,
      retryable: true,
    };
  }

  let contribution: OutputContribution = { artifacts: [] };
  if (value !== undefined && invocation.persistOutput !== undefined) {
    try {
      contribution = await invocation.persistOutput(value, { task, writer, inputs });
    } catch (error) {
      // The answer was produced but could not be turned into artifacts. That is a failure of the
      // task, and it is recorded as one — with the transcript — rather than thrown away.
      const described = describeError(error);
      failure = {
        code: described.code,
        message: `persisting the task output failed: ${described.message}`.slice(0, 4000),
        retryable: false,
      };
      warnings.push(failure.message);
      runtime.logger?.error('agent output persistence failed', {
        taskId: task.taskId,
        ...described,
      });
    }
  }

  const generated: GeneratedArtifact[] = [
    ...(invocation.precomputedArtifacts ?? []),
    ...contribution.artifacts,
  ];
  const findings: Finding[] = [...(contribution.findings ?? [])];

  const report = await evaluateAcceptance({
    runId: task.runId,
    artifacts: runtime.artifacts,
    criteria: task.acceptanceCriteria,
    generated,
    findings,
    ...(invocation.expectations !== undefined ? { expectations: invocation.expectations } : {}),
    ...(invocation.testRuns !== undefined ? { testRuns: invocation.testRuns } : {}),
    customChecks: { ...(runtime.customChecks ?? {}), ...(invocation.customChecks ?? {}) },
  });
  recordStep({ kind: 'acceptance-check', toolCalls: [], toolResults: [], note: report.summary });

  const satisfied = report.outcomes.filter((outcome) => outcome.satisfied).length;
  const status = resolveStatus(failure, report.outcomes, satisfied);
  const finishedAtDate = new Date();
  const finishedAt = nowIso(finishedAtDate);

  const narrative = (contribution.narrative ?? finalText).trim().slice(0, 8000);
  const result = agentResultSchema.parse({
    taskId: task.taskId,
    runId: task.runId,
    role: task.role,
    stage: task.stage,
    status,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, finishedAtDate.getTime() - startedAtDate.getTime()),
    generatedArtifacts: generated,
    findings,
    evidence: collectEvidence(findings, generated, task, startedAt),
    acceptance: report.outcomes,
    nextRecommendedAction: recommend(status, report, failure),
    tokenUsage: usage,
    llmCalls,
    toolCalls: toolCallCount,
    toolCallsDenied: deniedCalls,
    ...(narrative.length > 0 ? { narrative } : {}),
    unresolvedUnknowns: [...(contribution.unresolvedUnknowns ?? [])],
    ...(failure !== undefined
      ? { errorCode: failure.code, errorMessage: failure.message.slice(0, 4000) }
      : {}),
  });

  const transcriptArtifact = persistTranscript(
    writer,
    agentTranscriptSchema.parse({ taskId: task.taskId, runId: task.runId, role: task.role, steps }),
  );
  const invocations = tools.invocationsFor(task.taskId);
  const toolLogArtifact = persistToolLog(writer, task.taskId, invocations);
  const resultArtifact = persistResultRecord(writer, result);

  if (failure !== undefined) {
    runtime.events.next(task.runId, 'agent.failed', {
      stage: task.stage,
      role: task.role,
      taskId: task.taskId,
      errorCode: failure.code,
      message: failure.message.slice(0, 4000),
      retryable: failure.retryable,
    });
  }
  runtime.events.next(task.runId, 'agent.finished', {
    stage: task.stage,
    role: task.role,
    taskId: task.taskId,
    status: status === 'SUCCEEDED' ? 'SUCCEEDED' : status === 'PARTIAL' ? 'PARTIAL' : 'FAILED',
    durationMs: result.durationMs,
    artifactIds: [
      taskArtifact.artifactId,
      ...generated.map((entry) => entry.artifactId),
      transcriptArtifact.artifactId,
      resultArtifact.artifactId,
    ],
    findingsCount: findings.length,
    nextRecommendedAction: report.summary.slice(0, 2000),
  });

  return {
    task,
    result,
    value,
    steps,
    invocations,
    acceptance: report,
    taskArtifactId: taskArtifact.artifactId,
    transcriptArtifactId: transcriptArtifact.artifactId,
    toolLogArtifactId: toolLogArtifact.artifactId,
    resultArtifactId: resultArtifact.artifactId,
    warnings,
  };
}

/**
 * Only a fully satisfied contract is a success. PARTIAL means the agent delivered artifacts and
 * some criteria held while others did not — never a pass, and the orchestrator treats it as one.
 */
function resolveStatus(
  failure: LoopFailure | undefined,
  outcomes: readonly AcceptanceOutcome[],
  satisfied: number,
): AgentTaskStatus {
  if (failure !== undefined) {
    if (failure.code === 'AGENT_TIMEOUT') return 'TIMEOUT';
    if (failure.code === 'AGENT_CANCELLED') return 'CANCELLED';
    return 'FAILED';
  }
  if (outcomes.length === 0 || satisfied === outcomes.length) return 'SUCCEEDED';
  return satisfied === 0 ? 'FAILED' : 'PARTIAL';
}

/**
 * Reads the live abort state through a call boundary. `AbortSignal.aborted` is readonly, so an inline
 * `signal?.aborted === true` gets narrowed to `false` for the rest of the block — and a signal that
 * fires *during* an awaited model call would then read as never aborted.
 */
function callerAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function recommend(
  status: AgentTaskStatus,
  report: AcceptanceReport,
  failure: LoopFailure | undefined,
): NextAction {
  if (status === 'SUCCEEDED')
    return { kind: 'proceed', detail: report.summary.slice(0, 2000), mismatchIds: [] };
  if (failure !== undefined) {
    return {
      kind: 'collect-more-evidence',
      detail: `${failure.code}: ${failure.message}`.slice(0, 2000),
      mismatchIds: [],
    };
  }
  const unmet = report.outcomes
    .filter((outcome) => !outcome.satisfied)
    .map((outcome) => `${outcome.criterionId}: ${outcome.reason ?? outcome.observed ?? 'unmet'}`)
    .join('; ');
  return { kind: 'collect-more-evidence', detail: unmet.slice(0, 2000), mismatchIds: [] };
}

function collectEvidence(
  findings: readonly Finding[],
  generated: readonly GeneratedArtifact[],
  task: AgentTask,
  collectedAt: string,
): EvidenceRef[] {
  const collectedBy = `${AGENT_RUNTIME_GENERATOR}:${task.role}`;
  const seen = new Set<string>();
  const evidence: EvidenceRef[] = [];
  for (const finding of findings) {
    for (const reference of finding.evidence) {
      if (seen.has(reference.id) || evidence.length >= MAX_EVIDENCE_REFS) continue;
      seen.add(reference.id);
      evidence.push(reference);
    }
  }
  for (const artifact of generated) {
    if (evidence.length >= MAX_EVIDENCE_REFS) break;
    const id = `artifact-${artifact.artifactId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    evidence.push({
      id,
      kind: 'artifact',
      collectedAt,
      collectedBy,
      artifactId: artifact.artifactId,
      note: artifact.relativePath,
    });
  }
  return evidence;
}

/**
 * A structured reply the provider cut off, or whose only parseable value is a child of an
 * unclosed document. Either one is incomplete output. Schema-checking the child reports a missing
 * field on the wrong object and, on the last step, the loop then records a step-limit failure.
 */
function truncatedAnswerFailure(
  purpose: string,
  completion: CompletionResult,
  text: string,
  structured: boolean,
): LoopFailure | undefined {
  const extracted = structured ? tryExtractJson(text) : undefined;
  const lengthCut = completion.finishReason === 'length';
  const nested = extracted?.nestedFragment === true;
  if (!lengthCut && !nested) return undefined;
  const reason = lengthCut
    ? `finish_reason=length after ${completion.usage.completionTokens} completion token(s)`
    : 'the JSON document never closed';
  const fragment = nested
    ? ' A balanced nested JSON fragment was present and was not accepted as the report.'
    : '';
  return {
    code: 'LLM_OUTPUT_TRUNCATED',
    message:
      `model output for "${purpose}" is incomplete (${reason}, ${text.length} character(s)). ` +
      `The reply was cut off before a complete answer.${fragment}`,
    retryable: false,
  };
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 12)
    .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/** The rejection text for a validated answer whose citations do not resolve, or undefined when they all do. */
function citationProblems<TValue>(
  value: TValue,
  source: (value: TValue) => readonly Finding[],
  roots: readonly string[],
  openedFiles: ReadonlySet<string>,
  requireStartLine = false,
): string | undefined {
  const violations = checkFindingEvidence(source(value), {
    roots,
    openedPaths: [...openedFiles],
    maxViolations: 8,
    requireStartLine,
  });
  if (violations.length === 0) return undefined;
  // One problem per line, numbered: the rejection is read by a model deciding what to change, and
  // a wall of semicolon-joined text makes it likelier to resubmit the same answer than to repair.
  return `citations that do not resolve:\n${violations
    .map(
      (violation, index) =>
        `${index + 1}. ${violation.claimId}/${violation.evidenceId}: ${violation.problem}`,
    )
    .join('\n')}`;
}

/**
 * The host's anchoring diagnosis, appended to the rejection the model reads.
 *
 * The checker above can only say a quote is absent; it never tried to locate it. The anchorer did, and
 * its verdict distinguishes the repairs that matter — a paraphrase needs re-extraction, a fusion needs
 * splitting into one citation per place, an invention needs the claim demoted to an unknown. Without
 * that distinction a rejected model resubmits the same quote with different line numbers.
 */
function appendCitationFeedback(
  problem: string | undefined,
  feedback: readonly string[] | undefined,
): string | undefined {
  if (feedback === undefined || feedback.length === 0) return problem;
  const lines = feedback
    .slice(0, CITATION_FEEDBACK_MAX)
    .map((line, index) => `${index + 1}. ${line}`)
    .join('\n');
  const overflow = feedback.length - CITATION_FEEDBACK_MAX;
  const block = `the host read the cited files itself and could not locate these quotes in them:\n${lines}${
    overflow > 0 ? `\n(+${overflow} more)` : ''
  }`;
  return problem === undefined ? block : `${problem}\n${block}`;
}

/**
 * At most `max` characters, marker included. Every call site feeds a schema field capped at exactly
 * `max`, so an overshoot of one character would throw where the text was merely being recorded.
 */
function clipTo(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function stepSummary(step: AgentStep): string {
  switch (step.kind) {
    case 'llm-call':
      return step.toolCalls.length > 0
        ? `model requested ${step.toolCalls.length} tool call(s): ${step.toolCalls.map((call) => call.name).join(', ')}`
        : `model replied with ${step.assistantText?.length ?? 0} character(s)`;
    case 'tool-call': {
      const call = step.toolCalls[0];
      const result = step.toolResults[0];
      return `${call?.name ?? 'tool'} → ${result === undefined ? 'no result' : result.ok ? 'ok' : result.denied ? 'denied' : 'error'}`;
    }
    case 'acceptance-check':
      return step.note ?? 'acceptance checked';
    default:
      return step.note ?? step.kind;
  }
}

/** Keeps the head and the tail: the tail of a build log is where the failure is. */
function clipForModel(content: string, max: number): string {
  if (content.length <= max) return content;
  const head = Math.floor(max * 0.6);
  const tail = max - head;
  return `${content.slice(0, head)}\n…[${content.length - max} characters omitted]…\n${content.slice(content.length - tail)}`;
}

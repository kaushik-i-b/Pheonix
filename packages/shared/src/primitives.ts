import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';

/**
 * Identity, time, evidence and hashing primitives shared by every Phoenix contract.
 * Nothing in this module may depend on another Phoenix package.
 */

export const ISO_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const isoTimestampSchema = z
  .string()
  .regex(ISO_TIMESTAMP_PATTERN, 'expected an ISO-8601 timestamp such as 2026-09-30T12:00:00.000Z');
export type IsoTimestamp = z.infer<typeof isoTimestampSchema>;

export function nowIso(date: Date = new Date()): IsoTimestamp {
  return isoTimestampSchema.parse(date.toISOString());
}

export const durationMsSchema = z.number().int().nonnegative();
export type DurationMs = z.infer<typeof durationMsSchema>;

export const RUN_ID_PATTERN = /^run_[0-9a-z]{32}$/;
export const TASK_ID_PATTERN = /^task_[0-9a-z]{32}$/;
export const STEP_ID_PATTERN = /^step_[0-9a-z]{32}$/;
export const SCENARIO_ID_PATTERN = /^scn_[0-9a-z-]{6,40}$/;
export const RULE_ID_PATTERN = /^BR-[A-Z0-9-]{1,40}$/;
export const INVARIANT_ID_PATTERN = /^INV-[A-Z0-9-]{1,40}$/;
export const CASE_ID_PATTERN = /^CHR-[A-Z0-9-]{1,40}$/;
export const ARTIFACT_ID_PATTERN = /^art_[0-9a-f]{64}$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

export const runIdSchema = z.string().regex(RUN_ID_PATTERN, 'expected run_<32 lowercase alphanumerics>');
export const taskIdSchema = z.string().regex(TASK_ID_PATTERN);
export const stepIdSchema = z.string().regex(STEP_ID_PATTERN);
export const scenarioIdSchema = z.string().regex(SCENARIO_ID_PATTERN);
export const ruleIdSchema = z.string().regex(RULE_ID_PATTERN);
export const invariantIdSchema = z.string().regex(INVARIANT_ID_PATTERN);
export const caseIdSchema = z.string().regex(CASE_ID_PATTERN);
export const artifactIdSchema = z.string().regex(ARTIFACT_ID_PATTERN);
export const sha256HexSchema = z.string().regex(SHA256_HEX_PATTERN);

export type RunId = z.infer<typeof runIdSchema>;
export type TaskId = z.infer<typeof taskIdSchema>;
export type StepId = z.infer<typeof stepIdSchema>;
export type ScenarioId = z.infer<typeof scenarioIdSchema>;
export type RuleId = z.infer<typeof ruleIdSchema>;
export type InvariantId = z.infer<typeof invariantIdSchema>;
export type CaseId = z.infer<typeof caseIdSchema>;
export type ArtifactId = z.infer<typeof artifactIdSchema>;
export type Sha256Hex = z.infer<typeof sha256HexSchema>;

function newSuffixedId(prefix: string): string {
  return `${prefix}${randomUUID().replaceAll('-', '').toLowerCase()}`;
}

export function newRunId(): RunId {
  return runIdSchema.parse(newSuffixedId('run_'));
}

export function newTaskId(): TaskId {
  return taskIdSchema.parse(newSuffixedId('task_'));
}

export function newStepId(): StepId {
  return stepIdSchema.parse(newSuffixedId('step_'));
}

export function newScenarioId(): ScenarioId {
  return scenarioIdSchema.parse(newSuffixedId('scn_'));
}

export function sha256Hex(input: string | Uint8Array): Sha256Hex {
  const hash = createHash('sha256');
  hash.update(typeof input === 'string' ? Buffer.from(input, 'utf8') : Buffer.from(input));
  return sha256HexSchema.parse(hash.digest('hex'));
}

export function artifactIdFromContent(content: string | Uint8Array): ArtifactId {
  return artifactIdSchema.parse(`art_${sha256Hex(content)}`);
}

/**
 * Deterministic JSON serialization. Object keys are sorted at every depth so that
 * semantically identical artifacts hash identically regardless of construction order.
 * Array order is preserved because it is always meaningful in Phoenix contracts.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(normalizeForHash(value));
}

function normalizeForHash(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeForHash);
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()]
        .map(([key, entry]) => [String(key), normalizeForHash(entry)] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  }
  if (value instanceof Set) return [...value].map(normalizeForHash);
  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const entry = record[key];
    if (entry === undefined) continue;
    sorted[key] = normalizeForHash(entry);
  }
  return sorted;
}

export function hashStable(value: unknown): Sha256Hex {
  return sha256Hex(stableStringify(value));
}

/** How a piece of evidence was obtained. Mirrors the discovery channels Phoenix is allowed to use. */
export const evidenceKindSchema = z.enum([
  'source-code',
  'runtime-observation',
  'test-result',
  'database-inspection',
  'execution-trace',
  'configuration',
  'artifact',
  'llm-reasoning',
  'human-input',
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const sourceLocationSchema = z.object({
  path: z.string().min(1),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbol: z.string().min(1).optional(),
  snippet: z.string().max(8000).optional(),
  revision: z.string().min(1).optional(),
});
export type SourceLocation = z.infer<typeof sourceLocationSchema>;

/**
 * A single unit of proof. Every claim Phoenix makes (rule, invariant, mismatch, decision)
 * must carry at least one of these, otherwise the claim is rejected at the schema level.
 */
export const evidenceRefSchema = z
  .object({
    id: z.string().min(1),
    kind: evidenceKindSchema,
    collectedAt: isoTimestampSchema,
    collectedBy: z.string().min(1),
    location: sourceLocationSchema.optional(),
    artifactId: artifactIdSchema.optional(),
    quote: z.string().max(8000).optional(),
    observation: z.string().max(8000).optional(),
    note: z.string().max(2000).optional(),
  })
  .superRefine((value, ctx) => {
    const hasSubstance =
      value.location !== undefined ||
      value.artifactId !== undefined ||
      (value.quote !== undefined && value.quote.trim().length > 0) ||
      (value.observation !== undefined && value.observation.trim().length > 0);
    if (!hasSubstance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'evidence must point at something concrete: a source location, an artifact id, a quote, or an observation',
      });
    }
  });
export type EvidenceRef = z.infer<typeof evidenceRefSchema>;

export const severitySchema = z.enum(['CRITICAL', 'MAJOR', 'MINOR', 'INFO']);
export type Severity = z.infer<typeof severitySchema>;

/** Ordered so that `severityRank(a) >= severityRank(b)` means "a is at least as severe as b". */
export const SEVERITY_RANK: Record<Severity, number> = {
  INFO: 0,
  MINOR: 1,
  MAJOR: 2,
  CRITICAL: 3,
};

export function severityRank(severity: Severity): number {
  return SEVERITY_RANK[severity];
}

export function maxSeverity(values: readonly Severity[]): Severity {
  let current: Severity = 'INFO';
  for (const value of values) {
    if (severityRank(value) > severityRank(current)) current = value;
  }
  return current;
}

/**
 * Epistemic status of a claim. Phoenix must never present an inference as an observation.
 * OBSERVED = directly witnessed (source text, runtime response, DB row).
 * INFERRED = derived by reasoning from evidence.
 * UNKNOWN  = explicitly not known; recorded so gaps are visible instead of silently filled.
 */
export const epistemicStatusSchema = z.enum(['OBSERVED', 'INFERRED', 'UNKNOWN']);
export type EpistemicStatus = z.infer<typeof epistemicStatusSchema>;

export const confidenceSchema = z.number().min(0).max(1);
export type Confidence = z.infer<typeof confidenceSchema>;

export const confidenceBandSchema = z.enum(['HIGH', 'MEDIUM', 'LOW', 'NONE']);
export type ConfidenceBand = z.infer<typeof confidenceBandSchema>;

export function confidenceBand(confidence: Confidence): ConfidenceBand {
  if (confidence >= 0.85) return 'HIGH';
  if (confidence >= 0.6) return 'MEDIUM';
  if (confidence > 0) return 'LOW';
  return 'NONE';
}

export const tokenUsageSchema = z.object({
  promptTokens: z.number().int().nonnegative().default(0),
  completionTokens: z.number().int().nonnegative().default(0),
  totalTokens: z.number().int().nonnegative().default(0),
});
export type TokenUsage = z.infer<typeof tokenUsageSchema>;

export const costSchema = z.object({
  currency: z.string().length(3).default('USD'),
  amount: z.number().nonnegative(),
  /** Null when no pricing configuration exists — Phoenix reports "unknown", never a guess. */
  estimated: z.boolean().default(true),
});
export type Cost = z.infer<typeof costSchema>;

export const nonEmptyStringSchema = z.string().min(1);
export const boundedTextSchema = (max: number) => z.string().min(1).max(max);

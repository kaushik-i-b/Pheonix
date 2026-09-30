import { z } from 'zod';
import {
  artifactIdSchema,
  isoTimestampSchema,
  runIdSchema,
  sha256HexSchema,
  taskIdSchema,
} from './primitives.js';
import { agentRoleSchema } from './roles.js';

/**
 * Artifact identity, provenance and addressing.
 *
 * Every stage of the pipeline communicates exclusively through artifacts. An artifact is
 * content-addressed (its id is derived from its bytes), so a run can be resumed by comparing
 * input hashes, and any claim can be traced back to the exact bytes that produced it.
 */

export const ARTIFACT_SCHEMA_VERSION = 1;

export const artifactKindSchema = z.enum([
  'discovery.repository-map',
  'discovery.dependency-map',
  'discovery.data-flow',
  'discovery.findings',
  'specification.business-rules',
  'specification.invariants',
  'specification.evidence-graph',
  'characterization.suite',
  'characterization.execution-report',
  'design.architecture',
  'design.migration-plan',
  'design.risk-register',
  'implementation.change-report',
  'adversarial.scenarios',
  'adversarial.report',
  'verification.differential-report',
  'verification.verdict',
  'release.decision',
  'release.report',
  'diagnosis.report',
  'agent.task',
  'agent.result',
  'agent.transcript',
  'run.record',
  'run.events',
  'run.prompt',
  'raw.file',
  'raw.command-output',
  'raw.database-snapshot',
  'raw.http-exchange',
]);
export type ArtifactKind = z.infer<typeof artifactKindSchema>;

/** Top-level artifact directory for a kind, i.e. `artifacts/<runId>/<stage-dir>/...`. */
export const ARTIFACT_STAGE_DIRECTORY: Record<ArtifactKind, string> = {
  'discovery.repository-map': 'discovery',
  'discovery.dependency-map': 'discovery',
  'discovery.data-flow': 'discovery',
  'discovery.findings': 'discovery',
  'specification.business-rules': 'specification',
  'specification.invariants': 'specification',
  'specification.evidence-graph': 'specification',
  'characterization.suite': 'characterization',
  'characterization.execution-report': 'characterization',
  'design.architecture': 'design',
  'design.migration-plan': 'design',
  'design.risk-register': 'design',
  'implementation.change-report': 'implementation',
  'adversarial.scenarios': 'adversarial',
  'adversarial.report': 'adversarial',
  'verification.differential-report': 'verification',
  'verification.verdict': 'verification',
  'release.decision': 'release',
  'release.report': 'release',
  'diagnosis.report': 'diagnosis',
  'agent.task': 'agent',
  'agent.result': 'agent',
  'agent.transcript': 'agent',
  'run.record': 'run',
  'run.events': 'run',
  'run.prompt': 'run',
  'raw.file': 'raw',
  'raw.command-output': 'raw',
  'raw.database-snapshot': 'raw',
  'raw.http-exchange': 'raw',
};

export const artifactFormatSchema = z.enum(['json', 'markdown', 'text', 'typescript', 'sql', 'binary']);
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>;

export const artifactProducerSchema = z.object({
  role: agentRoleSchema,
  taskId: taskIdSchema.optional(),
  /** Deterministic producers record the code path that created the artifact. */
  generator: z.string().min(1).optional(),
});
export type ArtifactProducer = z.infer<typeof artifactProducerSchema>;

export const artifactInputRefSchema = z.object({
  artifactId: artifactIdSchema,
  kind: artifactKindSchema,
  role: z.enum(['input', 'reference']).default('input'),
});
export type ArtifactInputRef = z.infer<typeof artifactInputRefSchema>;

/** Metadata persisted alongside (and inside) every artifact. */
export const artifactMetaSchema = z.object({
  id: artifactIdSchema,
  kind: artifactKindSchema,
  format: artifactFormatSchema,
  runId: runIdSchema,
  /** Path relative to `artifacts/<runId>/`. */
  relativePath: z.string().min(1),
  sha256: sha256HexSchema,
  bytes: z.number().int().nonnegative(),
  createdAt: isoTimestampSchema,
  schemaVersion: z.number().int().default(ARTIFACT_SCHEMA_VERSION),
  producedBy: artifactProducerSchema,
  inputs: z.array(artifactInputRefSchema).default([]),
  /** Hash of the canonical form of all inputs; enables idempotent stage resumption. */
  inputsHash: sha256HexSchema.optional(),
  title: z.string().max(300).optional(),
  tags: z.array(z.string().min(1)).default([]),
});
export type ArtifactMeta = z.infer<typeof artifactMetaSchema>;

/**
 * JSON artifacts are wrapped in an envelope so provenance travels with the payload even if
 * the file is copied out of the artifact tree.
 */
export function artifactEnvelopeSchema<TPayload extends z.ZodTypeAny>(payloadSchema: TPayload) {
  return z.object({
    envelopeVersion: z.literal(ARTIFACT_SCHEMA_VERSION),
    kind: artifactKindSchema,
    runId: runIdSchema,
    createdAt: isoTimestampSchema,
    producedBy: artifactProducerSchema,
    inputs: z.array(artifactInputRefSchema).default([]),
    payload: payloadSchema,
  });
}

export type ArtifactEnvelope<TPayload> = {
  envelopeVersion: typeof ARTIFACT_SCHEMA_VERSION;
  kind: ArtifactKind;
  runId: z.infer<typeof runIdSchema>;
  createdAt: z.infer<typeof isoTimestampSchema>;
  producedBy: ArtifactProducer;
  inputs: ArtifactInputRef[];
  payload: TPayload;
};

/** Canonical file name for singleton artifacts of a kind (multi-instance kinds pass a slug). */
export const ARTIFACT_BASENAME: Partial<Record<ArtifactKind, string>> = {
  'discovery.repository-map': 'repository-map.json',
  'discovery.dependency-map': 'dependency-map.json',
  'discovery.data-flow': 'data-flow.json',
  'discovery.findings': 'findings.md',
  'specification.business-rules': 'business-rules.json',
  'specification.invariants': 'invariants.json',
  'specification.evidence-graph': 'evidence-graph.json',
  'characterization.suite': 'suite.json',
  'characterization.execution-report': 'execution-report.json',
  'design.architecture': 'architecture.md',
  'design.migration-plan': 'migration-plan.md',
  'design.risk-register': 'risk-register.json',
  'implementation.change-report': 'change-report.md',
  'adversarial.scenarios': 'scenarios.json',
  'adversarial.report': 'report.json',
  'verification.differential-report': 'differential-report.json',
  'verification.verdict': 'verdict.json',
  'release.decision': 'decision.json',
  'release.report': 'report.md',
  'diagnosis.report': 'diagnosis.json',
  'run.record': 'record.json',
  'run.events': 'events.jsonl',
};

const EXTENSION_BY_FORMAT: Record<ArtifactFormat, string> = {
  json: '.json',
  markdown: '.md',
  text: '.txt',
  typescript: '.ts',
  sql: '.sql',
  binary: '.bin',
};

export function defaultRelativePath(kind: ArtifactKind, slug?: string, format?: ArtifactFormat): string {
  const directory = ARTIFACT_STAGE_DIRECTORY[kind];
  const base = slug ?? ARTIFACT_BASENAME[kind];
  if (base === undefined) {
    throw new Error(`no default file name for artifact kind "${kind}"; pass an explicit slug`);
  }
  const safeBase = slug === undefined ? base : `${sanitizeSlug(slug)}${extensionOf(kind, base, format)}`;
  return `${directory}/${safeBase}`;
}

function extensionOf(kind: ArtifactKind, base: string, format?: ArtifactFormat): string {
  if (base.includes('.')) return base.slice(base.lastIndexOf('.'));
  if (format !== undefined) return EXTENSION_BY_FORMAT[format];
  return kind.startsWith('raw.') ? '.txt' : '.json';
}

export function sanitizeSlug(slug: string): string {
  const trimmed = slug.trim();
  if (trimmed.length === 0) throw new Error('artifact slug is empty');
  // Reject suspicious input loudly instead of silently rewriting it into something plausible.
  if (trimmed.includes('..') || trimmed.startsWith('/') || trimmed.startsWith('\\')) {
    throw new Error(`unsafe artifact slug: ${slug}`);
  }
  const cleaned = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (cleaned.length === 0) throw new Error(`artifact slug sanitized to nothing: ${slug}`);
  return cleaned.slice(0, 120);
}

import { z } from 'zod';
import {
  confidenceSchema,
  epistemicStatusSchema,
  evidenceRefSchema,
  isoTimestampSchema,
  sourceLocationSchema,
} from './primitives.js';
import { findingSchema } from './agent.js';

/**
 * Discovery artifacts.
 *
 * The structural parts of these documents are produced by **deterministic** static analysis
 * (`@phoenix/legacy-analysis`): file trees, language detection, endpoints, SQL, cron entries.
 * The Archaeologist agent adds interpretation, and every interpretation must cite evidence and
 * carry an epistemic status. Inference is never allowed to masquerade as observation.
 */

export const languageSchema = z.object({
  name: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  extensions: z.array(z.string().min(1)).default([]),
  /** Language level / edition declared by the build, when detectable (e.g. Java 8, ES5). */
  declaredLevel: z.string().max(64).optional(),
});
export type Language = z.infer<typeof languageSchema>;

export const frameworkSchema = z.object({
  name: z.string().min(1),
  version: z.string().max(64).optional(),
  evidence: z.array(evidenceRefSchema).min(1),
});
export type Framework = z.infer<typeof frameworkSchema>;

export const buildSystemSchema = z.object({
  kind: z.enum(['maven', 'gradle', 'npm', 'pnpm', 'yarn', 'pip', 'cargo', 'go', 'make', 'ant', 'unknown']),
  manifestPath: z.string().min(1),
  commands: z.object({
    build: z.string().min(1).optional(),
    test: z.string().min(1).optional(),
    run: z.string().min(1).optional(),
  }).default({}),
  dependencies: z
    .array(z.object({ name: z.string().min(1), version: z.string().max(64).optional(), scope: z.string().max(32).optional() }))
    .default([]),
});
export type BuildSystem = z.infer<typeof buildSystemSchema>;

export const fileCategorySchema = z.enum([
  'source',
  'test',
  'configuration',
  'build',
  'migration',
  'schema',
  'documentation',
  'script',
  'asset',
  'generated',
  'other',
]);
export type FileCategory = z.infer<typeof fileCategorySchema>;

export const fileEntrySchema = z.object({
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  lines: z.number().int().nonnegative().optional(),
  language: z.string().min(1).optional(),
  category: fileCategorySchema,
  /** Deterministic signals used to prioritize what an agent should read. */
  signals: z
    .object({
      hasSql: z.boolean().default(false),
      hasHttpAnnotation: z.boolean().default(false),
      hasScheduleAnnotation: z.boolean().default(false),
      hasTransactionAnnotation: z.boolean().default(false),
      hasCatchSwallow: z.boolean().default(false),
      hasStaticMutableState: z.boolean().default(false),
      hasRoundingCall: z.boolean().default(false),
      hasMagicNumbers: z.boolean().default(false),
      cyclomaticEstimate: z.number().int().nonnegative().optional(),
    })
    .default({}),
});
export type FileEntry = z.infer<typeof fileEntrySchema>;

export const entryPointSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['http', 'cli', 'scheduled', 'queue-consumer', 'rpc', 'startup', 'db-object', 'other']),
  label: z.string().min(1),
  location: sourceLocationSchema,
  epistemicStatus: epistemicStatusSchema.default('OBSERVED'),
  notes: z.string().max(2000).optional(),
});
export type EntryPoint = z.infer<typeof entryPointSchema>;

export const httpEndpointSchema = z.object({
  id: z.string().min(1),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']),
  path: z.string().min(1),
  handler: sourceLocationSchema,
  requestBodySchemaHint: z.string().max(2000).optional(),
  responseSchemaHint: z.string().max(2000).optional(),
  /** Anything structurally odd: non-standard status codes, query-param style, duplicated routes. */
  anomalies: z.array(z.string().max(500)).default([]),
  epistemicStatus: epistemicStatusSchema.default('OBSERVED'),
});
export type HttpEndpoint = z.infer<typeof httpEndpointSchema>;

export const sqlStatementKindSchema = z.enum([
  'select',
  'insert',
  'update',
  'delete',
  'ddl',
  'function',
  'trigger',
  'procedure',
  'unknown',
]);
export type SqlStatementKind = z.infer<typeof sqlStatementKindSchema>;

export const sqlStatementSchema = z.object({
  id: z.string().min(1),
  kind: sqlStatementKindSchema,
  raw: z.string().min(1).max(20_000),
  location: sourceLocationSchema,
  tables: z.array(z.string().min(1)).default([]),
  writes: z.boolean().default(false),
  /** Deterministic hints: ROUND()/setScale-equivalents, ORDER BY, string-concatenated parameters. */
  signals: z
    .object({
      hasRounding: z.boolean().default(false),
      hasOrderBy: z.boolean().default(false),
      hasAggregate: z.boolean().default(false),
      hasStringConcatenation: z.boolean().default(false),
      hasTransactionControl: z.boolean().default(false),
    })
    .default({}),
});
export type SqlStatement = z.infer<typeof sqlStatementSchema>;

export const databaseAccessSchema = z.object({
  id: z.string().min(1),
  mechanism: z.enum(['orm', 'jdbc-template', 'raw-sql', 'native-query', 'stored-procedure', 'trigger', 'function', 'migration', 'other']),
  location: sourceLocationSchema,
  statements: z.array(sqlStatementSchema).default([]),
  tables: z.array(z.string().min(1)).default([]),
});
export type DatabaseAccess = z.infer<typeof databaseAccessSchema>;

export const databaseObjectSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['table', 'view', 'index', 'sequence', 'function', 'trigger', 'constraint']),
  definedIn: sourceLocationSchema.optional(),
  columns: z
    .array(z.object({ name: z.string().min(1), type: z.string().min(1), nullable: z.boolean().optional(), precision: z.string().max(32).optional() }))
    .default([]),
  /** Database-side behavior is a first-class discovery target: it survives naive rewrites badly. */
  behavior: z.string().max(4000).optional(),
});
export type DatabaseObject = z.infer<typeof databaseObjectSchema>;

export const migrationSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  description: z.string().max(500).optional(),
  path: z.string().min(1),
  tool: z.enum(['flyway', 'liquibase', 'alembic', 'django', 'knex', 'prisma', 'drizzle', 'manual', 'unknown']),
  objectsTouched: z.array(z.string().min(1)).default([]),
  appliesDatabaseBehavior: z.boolean().default(false),
});
export type Migration = z.infer<typeof migrationSchema>;

export const scheduledJobSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  location: sourceLocationSchema,
  schedule: z.string().min(1),
  scheduleKind: z.enum(['cron', 'fixed-rate', 'fixed-delay', 'systemd-timer', 'k8s-cronjob', 'unknown']),
  idempotent: z.boolean().optional(),
  idempotencyEpistemicStatus: epistemicStatusSchema.default('UNKNOWN'),
  notes: z.string().max(2000).optional(),
});
export type ScheduledJob = z.infer<typeof scheduledJobSchema>;

export const configurationSourceSchema = z.object({
  path: z.string().min(1),
  format: z.enum(['properties', 'yaml', 'json', 'toml', 'ini', 'env', 'xml', 'other']),
  keys: z.array(z.object({ key: z.string().min(1), value: z.string().max(500).optional(), secret: z.boolean().default(false) })).default([]),
  environmentOverrides: z.array(z.string().min(1)).default([]),
});
export type ConfigurationSource = z.infer<typeof configurationSourceSchema>;

export const externalDependencySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  kind: z.enum(['library', 'service', 'database', 'queue', 'filesystem', 'clock', 'random', 'network']),
  version: z.string().max(64).optional(),
  usedBy: z.array(sourceLocationSchema).default([]),
  /** Time, randomness and external services are the usual sources of nondeterminism. */
  nondeterministic: z.boolean().default(false),
});
export type ExternalDependency = z.infer<typeof externalDependencySchema>;

export const duplicationClusterSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1).max(2000),
  members: z.array(sourceLocationSchema).min(2),
  /** True when the members are *not* byte-identical — the interesting case, where they drift. */
  drifted: z.boolean().default(false),
  driftEvidence: z.array(evidenceRefSchema).default([]),
  similarity: confidenceSchema.optional(),
});
export type DuplicationCluster = z.infer<typeof duplicationClusterSchema>;

export const suspiciousBehaviorSchema = z.object({
  id: z.string().min(1),
  category: z.enum([
    'swallowed-exception',
    'static-mutable-state',
    'magic-number',
    'dead-code',
    'misleading-comment',
    'duplicated-calculation',
    'transaction-boundary-anomaly',
    'retry-without-idempotency',
    'time-dependence',
    'db-side-behavior',
    'authorization-gap',
    'unchecked-cast',
    'other',
  ]),
  description: z.string().min(1).max(2000),
  location: sourceLocationSchema,
  epistemicStatus: epistemicStatusSchema.default('OBSERVED'),
  /** What Phoenix should do about it: probe at runtime, ask a question, or record as a risk. */
  recommendedAction: z.enum(['runtime-probe', 'differential-scenario', 'characterize', 'record-risk', 'ignore']).default('runtime-probe'),
});
export type SuspiciousBehavior = z.infer<typeof suspiciousBehaviorSchema>;

export const repositoryMapSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  rootPath: z.string().min(1),
  generatedAt: isoTimestampSchema,
  generator: z.string().min(1),
  fileCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  languages: z.array(languageSchema).default([]),
  primaryLanguage: z.string().min(1).optional(),
  frameworks: z.array(frameworkSchema).default([]),
  buildSystems: z.array(buildSystemSchema).default([]),
  files: z.array(fileEntrySchema).default([]),
  directories: z
    .array(z.object({ path: z.string().min(1), fileCount: z.number().int().nonnegative(), purpose: z.string().max(500).optional() }))
    .default([]),
  entryPoints: z.array(entryPointSchema).default([]),
  httpEndpoints: z.array(httpEndpointSchema).default([]),
  databaseAccess: z.array(databaseAccessSchema).default([]),
  databaseObjects: z.array(databaseObjectSchema).default([]),
  migrations: z.array(migrationSchema).default([]),
  scheduledJobs: z.array(scheduledJobSchema).default([]),
  configuration: z.array(configurationSourceSchema).default([]),
  externalDependencies: z.array(externalDependencySchema).default([]),
  duplicationClusters: z.array(duplicationClusterSchema).default([]),
  suspiciousBehaviors: z.array(suspiciousBehaviorSchema).default([]),
  ignoredPaths: z.array(z.string().min(1)).default([]),
});
export type RepositoryMap = z.infer<typeof repositoryMapSchema>;

export const dependencyNodeSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['module', 'class', 'function', 'package', 'service', 'table', 'external', 'endpoint', 'job']),
  label: z.string().min(1),
  location: sourceLocationSchema.optional(),
});
export type DependencyNode = z.infer<typeof dependencyNodeSchema>;

export const dependencyEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(['imports', 'calls', 'reads', 'writes', 'http', 'sql', 'triggers', 'configures', 'extends']),
  evidence: z.array(evidenceRefSchema).default([]),
});
export type DependencyEdge = z.infer<typeof dependencyEdgeSchema>;

export const dependencyMapSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generator: z.string().min(1),
  nodes: z.array(dependencyNodeSchema).default([]),
  edges: z.array(dependencyEdgeSchema).default([]),
  /** Deterministically computed: components whose behavior many others depend on. */
  hotspots: z.array(z.object({ id: z.string().min(1), inbound: z.number().int().nonnegative(), outbound: z.number().int().nonnegative() })).default([]),
  cycles: z.array(z.array(z.string().min(1))).default([]),
});
export type DependencyMap = z.infer<typeof dependencyMapSchema>;

export const dataFlowStepSchema = z.object({
  component: z.string().min(1),
  action: z.string().min(1).max(1000),
  location: sourceLocationSchema.optional(),
  reads: z.array(z.string().min(1)).default([]),
  writes: z.array(z.string().min(1)).default([]),
});
export type DataFlowStep = z.infer<typeof dataFlowStepSchema>;

export const dataFlowSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generator: z.string().min(1),
  flows: z
    .array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        trigger: z.string().min(1).max(500),
        steps: z.array(dataFlowStepSchema).min(1),
        dataStores: z.array(z.string().min(1)).default([]),
        epistemicStatus: epistemicStatusSchema.default('INFERRED'),
        confidence: confidenceSchema,
        evidence: z.array(evidenceRefSchema).min(1),
        notes: z.string().max(4000).optional(),
      }),
    )
    .default([]),
});
export type DataFlow = z.infer<typeof dataFlowSchema>;

/** Structured form of `discovery/findings.md`; a renderer turns it into the markdown artifact. */
export const discoveryFindingsSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  summary: z.string().min(1).max(4000),
  sections: z
    .array(z.object({ heading: z.string().min(1).max(200), body: z.string().min(1).max(20_000) }))
    .default([]),
  findings: z.array(findingSchema).default([]),
  openQuestions: z
    .array(z.object({ id: z.string().min(1), question: z.string().min(1).max(1000), whyItMatters: z.string().max(2000).optional(), resolutionStrategy: z.enum(['runtime-probe', 'characterization-test', 'differential-scenario', 'human-input', 'unresolvable']) }))
    .default([]),
});
export type DiscoveryFindings = z.infer<typeof discoveryFindingsSchema>;

export function renderDiscoveryFindingsMarkdown(document: DiscoveryFindings): string {
  const lines: string[] = ['# Discovery findings', '', document.summary, ''];
  for (const section of document.sections) {
    lines.push(`## ${section.heading}`, '', section.body, '');
  }
  if (document.findings.length > 0) {
    lines.push('## Findings', '');
    lines.push('| ID | Kind | Status | Confidence | Summary |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const finding of document.findings) {
      lines.push(
        `| ${finding.id} | ${finding.kind} | ${finding.epistemicStatus} | ${finding.confidence.toFixed(2)} | ${escapeCell(finding.summary)} |`,
      );
    }
    lines.push('');
  }
  if (document.openQuestions.length > 0) {
    lines.push('## Open questions', '');
    for (const question of document.openQuestions) {
      lines.push(`- **${question.id}** (${question.resolutionStrategy}): ${question.question}`);
      if (question.whyItMatters) lines.push(`  - why it matters: ${question.whyItMatters}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

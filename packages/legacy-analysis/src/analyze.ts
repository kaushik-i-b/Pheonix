import {
  nowIso,
  repositoryMapSchema,
  dependencyMapSchema,
  dataFlowSchema,
  type DataFlow,
  type DatabaseAccess,
  type DatabaseObject,
  type DependencyMap,
  type EntryPoint,
  type ExternalDependency,
  type FileEntry,
  type HttpEndpoint,
  type Language,
  type RepositoryMap,
  type ScheduledJob,
  type SqlStatement,
} from '@phoenix/shared';
import { canonicalizePath } from '@phoenix/shared';
import { analyzeJavaFile, type JavaFile } from './java.js';
import { analyzeSqlFile, type SqlFileAnalysis } from './sql.js';
import { looksLikeSql, sqlSignals, sqlVerbOf, tablesOf } from './sql-text.js';
import { detectBuildSystems, declaredLanguageLevel, detectConfiguration, detectFrameworks, detectMigrations } from './build.js';
import { extractWebLayer, findDuplicateRoutes, type ExtractedEndpoint, type ExtractedEntryPoint } from './http-endpoints.js';
import { buildDependencyMap, trivialAccessorIds } from './graph.js';
import { detectDuplication, detectSuspicious } from './suspicious.js';
import { ANALYSIS_GENERATOR, evidenceId, sourceEvidence } from './evidence.js';
import { lineAt } from './scanner.js';
import { extensionOf, walkRepository, type WalkedFile, type WalkResult } from './walk.js';

/**
 * Deterministic repository analysis.
 *
 * This is the "never ask the LLM to do what code can do reliably" half of discovery: file inventory,
 * language and build detection, routes, SQL, schema objects, migrations, configuration, scheduled
 * jobs, duplication, dependency graph and cycles. Everything it reports cites a file and line.
 * The Archaeologist agent consumes this digest and adds interpretation on top — it does not
 * re-derive any of it.
 */

export interface AnalyzeOptions {
  /** Absolute path of the legacy repository. */
  root: string;
  generatedAt?: string;
  generator?: string;
  maxFiles?: number;
  maxContentBytes?: number;
}

export interface RepositoryAnalysis {
  repositoryMap: RepositoryMap;
  dependencyMap: DependencyMap;
  dataFlow: DataFlow;
  javaFiles: readonly JavaFile[];
  sqlFiles: readonly SqlFileAnalysis[];
  endpoints: readonly ExtractedEndpoint[];
  /** True when the walk hit `maxFiles`; the inventory is then explicitly incomplete. */
  truncated: boolean;
}

export function analyzeRepository(options: AnalyzeOptions): RepositoryAnalysis {
  const root = canonicalizePath(options.root);
  const generatedAt = options.generatedAt ?? nowIso();
  const generator = options.generator ?? ANALYSIS_GENERATOR;
  const walk: WalkResult = walkRepository({
    root,
    ...(options.maxFiles !== undefined ? { maxFiles: options.maxFiles } : {}),
    ...(options.maxContentBytes !== undefined ? { maxContentBytes: options.maxContentBytes } : {}),
  });

  const javaFiles: JavaFile[] = [];
  const sqlFiles: SqlFileAnalysis[] = [];
  const endpoints: ExtractedEndpoint[] = [];
  const entryPoints: ExtractedEntryPoint[] = [];
  const databaseAccess: DatabaseAccess[] = [];

  for (const file of walk.files) {
    if (file.text === undefined) continue;
    if (file.language === 'Java' && file.category !== 'test') {
      const analyzed = analyzeJavaFile(file.relativePath, file.text);
      javaFiles.push(analyzed);
      const web = extractWebLayer(analyzed);
      endpoints.push(...web.endpoints);
      entryPoints.push(...web.entryPoints);
      const access = databaseAccessFor(analyzed);
      if (access !== undefined) databaseAccess.push(access);
    } else if (extensionOf(file.relativePath) === '.sql') {
      const analyzedSql = analyzeSqlFile(file.relativePath, file.text);
      sqlFiles.push(analyzedSql);
    }
  }

  const duplicateRoutes = findDuplicateRoutes(endpoints);
  const httpEndpoints: HttpEndpoint[] = endpoints.map((endpoint) => ({
    id: endpoint.id,
    method: endpoint.method,
    path: endpoint.path,
    handler: endpoint.handler,
    ...(endpoint.requestBodySchemaHint !== undefined ? { requestBodySchemaHint: endpoint.requestBodySchemaHint } : {}),
    ...(endpoint.responseSchemaHint !== undefined ? { responseSchemaHint: endpoint.responseSchemaHint } : {}),
    anomalies: withRouteCollision(endpoint, duplicateRoutes),
    epistemicStatus: 'OBSERVED',
  }));

  const buildSystems = detectBuildSystems(walk.files);
  const declaredLevel = declaredLanguageLevel(walk.files);
  const languages = summarizeLanguages(walk.files, declaredLevel);
  const frameworks = detectFrameworks(walk.files, buildSystems, generatedAt, generator);
  const configuration = detectConfiguration(walk.files);
  const migrations = enrichMigrations(detectMigrations(walk.files), sqlFiles);
  const databaseObjects = mergeDatabaseObjects(sqlFiles);
  const scheduledJobs = scheduledJobsFor(javaFiles);

  for (const job of scheduledJobs) {
    entryPoints.push({
      id: `ep-job-${job.id}`,
      kind: 'scheduled',
      label: job.label,
      location: job.location,
      notes: `schedule: ${job.schedule} (${job.scheduleKind})`,
    });
  }
  for (const object of databaseObjects) {
    if (object.kind !== 'trigger' && object.kind !== 'function') continue;
    if (object.definedIn === undefined) continue;
    entryPoints.push({
      id: `ep-db-${object.kind}-${object.name}`,
      kind: 'db-object',
      label: `${object.kind} ${object.name}`,
      location: object.definedIn,
      // The body is already carried by `databaseObjects[].behavior`; repeating it here would put
      // SQL text where an index entry belongs, and the digest renders entry-point notes verbatim.
      ...(object.behavior !== undefined
        ? { notes: `carries ${object.behavior.length} characters of database-side logic; the body is not quoted here` }
        : {}),
    });
  }

  const duplicationClusters = detectDuplication(javaFiles, generatedAt);
  const suspiciousBehaviors = detectSuspicious({ javaFiles, sqlFiles, duplicationClusters });

  const repositoryMap = repositoryMapSchema.parse({
    schemaVersion: 1,
    rootPath: root,
    generatedAt,
    generator,
    fileCount: walk.files.length,
    totalBytes: walk.totalBytes,
    languages,
    ...(primaryLanguageOf(languages) !== undefined ? { primaryLanguage: primaryLanguageOf(languages) } : {}),
    frameworks,
    buildSystems,
    files: fileEntries(walk.files, javaFiles),
    directories: summarizeDirectories(walk.files),
    entryPoints: dedupeEntryPoints(entryPoints),
    httpEndpoints,
    databaseAccess,
    databaseObjects,
    migrations,
    scheduledJobs,
    configuration,
    externalDependencies: detectExternalDependencies(javaFiles, configuration),
    duplicationClusters,
    suspiciousBehaviors,
    ignoredPaths: walk.truncated ? [...walk.ignoredPaths, `(walk truncated at ${walk.files.length} files)`] : walk.ignoredPaths,
  });

  const dependencyMap = dependencyMapSchema.parse(
    buildDependencyMap({ javaFiles, sqlFiles, endpoints, generatedAt }),
  );

  const dataFlow = dataFlowSchema.parse(
    buildDataFlow({ httpEndpoints, dependencyMap, trivialAccessors: trivialAccessorIds(javaFiles), generatedAt }),
  );

  return { repositoryMap, dependencyMap, dataFlow, javaFiles, sqlFiles, endpoints, truncated: walk.truncated };
}

function withRouteCollision(endpoint: ExtractedEndpoint, duplicates: Map<string, ExtractedEndpoint[]>): string[] {
  const key = `${endpoint.method} ${endpoint.path}`;
  const group = duplicates.get(key);
  if (group === undefined) return endpoint.anomalies;
  const others = group.filter((entry) => entry.id !== endpoint.id);
  if (others.length === 0) return endpoint.anomalies;
  return [
    ...endpoint.anomalies,
    `route collides with ${others.map((other) => `${other.handler.path}:${other.handler.startLine ?? '?'}`).join(', ')}`,
  ];
}

function summarizeLanguages(files: readonly WalkedFile[], declaredLevel: string | undefined): Language[] {
  const byLanguage = new Map<string, { fileCount: number; bytes: number; extensions: Set<string> }>();
  for (const file of files) {
    if (file.language === undefined) continue;
    const entry = byLanguage.get(file.language) ?? { fileCount: 0, bytes: 0, extensions: new Set<string>() };
    entry.fileCount += 1;
    entry.bytes += file.bytes;
    const extension = extensionOf(file.relativePath);
    if (extension.length > 0) entry.extensions.add(extension);
    byLanguage.set(file.language, entry);
  }
  return [...byLanguage.entries()]
    .map(([name, entry]) => ({
      name,
      fileCount: entry.fileCount,
      bytes: entry.bytes,
      extensions: [...entry.extensions].sort(),
      ...(declaredLevel !== undefined && name.startsWith('Java') ? { declaredLevel } : {}),
    }))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

function primaryLanguageOf(languages: readonly Language[]): string | undefined {
  const source = languages.find((language) => language.name === 'Java') ?? languages[0];
  return source?.name;
}

function fileEntries(files: readonly WalkedFile[], javaFiles: readonly JavaFile[]): FileEntry[] {
  const javaByPath = new Map(javaFiles.map((file) => [file.relativePath, file]));
  return files.map((file) => {
    const analyzed = javaByPath.get(file.relativePath);
    const signals = analyzed?.signals;
    return {
      path: file.relativePath,
      bytes: file.bytes,
      ...(file.lines !== undefined ? { lines: file.lines } : {}),
      ...(file.language !== undefined ? { language: file.language } : {}),
      category: file.category,
      signals: {
        hasSql: signals?.hasSql ?? extensionOf(file.relativePath) === '.sql',
        hasHttpAnnotation: signals?.hasHttpAnnotation ?? false,
        hasScheduleAnnotation: signals?.hasScheduleAnnotation ?? false,
        hasTransactionAnnotation: signals?.hasTransactionAnnotation ?? false,
        hasCatchSwallow: signals?.hasCatchSwallow ?? false,
        hasStaticMutableState: signals?.hasStaticMutableState ?? false,
        hasRoundingCall: signals?.hasRoundingCall ?? false,
        hasMagicNumbers: signals?.hasMagicNumbers ?? false,
        ...(signals?.cyclomaticEstimate !== undefined ? { cyclomaticEstimate: signals.cyclomaticEstimate } : {}),
      },
    };
  });
}

const DIRECTORY_PURPOSE: readonly { pattern: RegExp; purpose: string }[] = [
  { pattern: /(?:^|\/)src\/main\/java\//, purpose: 'application source' },
  { pattern: /(?:^|\/)src\/main\/resources\/db\/migration\//, purpose: 'database migrations (applied at startup)' },
  { pattern: /(?:^|\/)src\/main\/resources\//, purpose: 'runtime configuration and resources' },
  { pattern: /(?:^|\/)src\/test\//, purpose: 'tests written by the original authors' },
  { pattern: /(?:^|\/)db\//, purpose: 'database scripts' },
  { pattern: /(?:^|\/)scripts?\//, purpose: 'operational scripts' },
  { pattern: /(?:^|\/)docs?\//, purpose: 'documentation' },
];

function summarizeDirectories(files: readonly WalkedFile[]): RepositoryMap['directories'] {
  const counts = new Map<string, number>();
  for (const file of files) {
    const directory = file.relativePath.includes('/') ? file.relativePath.slice(0, file.relativePath.lastIndexOf('/')) : '.';
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, fileCount]) => ({
      path,
      fileCount,
      ...(purposeOf(path) !== undefined ? { purpose: purposeOf(path) } : {}),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function purposeOf(directory: string): string | undefined {
  const withTrailing = `${directory}/`;
  for (const entry of DIRECTORY_PURPOSE) {
    if (entry.pattern.test(withTrailing)) return entry.purpose;
  }
  return undefined;
}

function databaseAccessFor(file: JavaFile): DatabaseAccess | undefined {
  const statements: SqlStatement[] = [];
  const tables = new Set<string>();
  let mechanism: DatabaseAccess['mechanism'] | undefined;

  const usesJdbcTemplate = /\b(?:JdbcTemplate|NamedParameterJdbcTemplate)\b/.test(file.scanned.masked);
  const usesEntityManager = /\bEntityManager\b|\bcreateNativeQuery\b|\bcreateQuery\b/.test(file.scanned.masked);
  const usesRawJdbc = /\b(?:Statement|PreparedStatement|Connection|DriverManager)\b/.test(file.scanned.masked);
  const usesOrm = file.types.some((type) =>
    type.annotations.some((annotation) => ['Entity', 'Table', 'Repository'].includes(annotation.name)),
  ) || file.imports.some((imported) => /org\.springframework\.data\.jpa/.test(imported));

  for (const literal of file.literals) {
    if (!looksLikeSql(literal.value)) continue;
    const kind = sqlVerbOf(literal.value);
    const location = { path: file.relativePath, startLine: literal.line };
    statements.push({
      id: evidenceId('sql', file.relativePath, literal.line),
      kind,
      raw: literal.value.slice(0, 20_000),
      location,
      tables: tablesOf(literal.value),
      writes: kind === 'insert' || kind === 'update' || kind === 'delete',
      signals: sqlSignals(literal.value),
    });
    for (const table of tablesOf(literal.value)) tables.add(table);
  }

  const nativeQueryAnnotations = file.methods.some((method) =>
    method.annotations.some((annotation) => /nativeQuery\s*=\s*true/.test(annotation.arguments)),
  );

  if (nativeQueryAnnotations || (usesEntityManager && statements.length > 0)) mechanism = 'native-query';
  else if (usesJdbcTemplate) mechanism = 'jdbc-template';
  else if (usesRawJdbc) mechanism = 'raw-sql';
  else if (usesOrm) mechanism = 'orm';

  if (mechanism === undefined && statements.length === 0) return undefined;

  const firstTypeLine = file.types[0]?.line;
  return {
    id: `db-access-${file.relativePath}`,
    mechanism: mechanism ?? (statements.length > 0 ? 'raw-sql' : 'orm'),
    location: { path: file.relativePath, ...(firstTypeLine !== undefined ? { startLine: firstTypeLine } : {}) },
    statements,
    tables: [...tables].sort(),
  };
}

function mergeDatabaseObjects(sqlFiles: readonly SqlFileAnalysis[]): DatabaseObject[] {
  const merged = new Map<string, DatabaseObject>();
  for (const file of sqlFiles) {
    for (const object of file.objects) {
      const key = `${object.kind}:${object.name}`;
      const existing = merged.get(key);
      const columns = existing === undefined ? object.columns : existing.columns;
      merged.set(key, {
        name: object.name,
        kind: object.kind,
        definedIn: { path: file.relativePath, startLine: object.line, symbol: object.name },
        columns,
        ...(object.behavior !== undefined ? { behavior: object.behavior } : {}),
      });
    }
  }
  return [...merged.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

function enrichMigrations(migrations: ReturnType<typeof detectMigrations>, sqlFiles: readonly SqlFileAnalysis[]): ReturnType<typeof detectMigrations> {
  return migrations.map((migration) => {
    const analyzed = sqlFiles.find((file) => file.relativePath === migration.path);
    if (analyzed === undefined) return migration;
    const objects = new Set<string>();
    for (const object of analyzed.objects) objects.add(object.name);
    for (const statement of analyzed.statements) {
      for (const table of statement.tables) objects.add(table);
    }
    return {
      ...migration,
      objectsTouched: [...objects].sort(),
      appliesDatabaseBehavior: analyzed.appliesDatabaseBehavior,
    };
  });
}

function scheduledJobsFor(javaFiles: readonly JavaFile[]): ScheduledJob[] {
  const jobs: ScheduledJob[] = [];
  for (const file of javaFiles) {
    for (const method of file.methods) {
      const scheduled = method.annotations.find((annotation) => annotation.name === 'Scheduled');
      if (scheduled === undefined) continue;
      const cron = /cron\s*=\s*"([^"]*)"/.exec(scheduled.arguments)?.[1];
      const fixedRate = /fixedRate(?:String)?\s*=\s*([^,)]+)/.exec(scheduled.arguments)?.[1];
      const fixedDelay = /fixedDelay(?:String)?\s*=\s*([^,)]+)/.exec(scheduled.arguments)?.[1];
      jobs.push({
        id: evidenceId('job', file.relativePath, method.line),
        label: `${method.declaringType ?? file.relativePath}#${method.name}`,
        location: { path: file.relativePath, startLine: method.line, endLine: method.endLine, symbol: method.name },
        schedule: (cron ?? fixedRate ?? fixedDelay ?? scheduled.arguments).trim(),
        scheduleKind: cron !== undefined ? 'cron' : fixedRate !== undefined ? 'fixed-rate' : fixedDelay !== undefined ? 'fixed-delay' : 'unknown',
        // Whether a batch job is idempotent is a behavioural question; the source rarely answers it.
        idempotencyEpistemicStatus: 'UNKNOWN',
      });
    }
  }
  return jobs;
}

const EXTERNAL_SIGNATURES: readonly { name: string; kind: ExternalDependency['kind']; pattern: RegExp; nondeterministic: boolean }[] = [
  { name: 'system-clock', kind: 'clock', pattern: /\bSystem\s*\.\s*currentTimeMillis\b|\bnew\s+(?:java\.util\.)?Date\s*\(|\bLocal(?:Date|DateTime|Time)\s*\.\s*now\b|\bInstant\s*\.\s*now\b|\bCalendar\s*\.\s*getInstance\b/, nondeterministic: true },
  { name: 'random', kind: 'random', pattern: /\bnew\s+Random\b|\bMath\s*\.\s*random\b|\bThreadLocalRandom\b/, nondeterministic: true },
  { name: 'uuid', kind: 'random', pattern: /\bUUID\s*\.\s*randomUUID\b/, nondeterministic: true },
  { name: 'http-client', kind: 'network', pattern: /\bRestTemplate\b|\bWebClient\b|\bHttpClient\b|\bOkHttpClient\b|\bHttpURLConnection\b/, nondeterministic: true },
  { name: 'jdbc', kind: 'database', pattern: /\bDriverManager\b|\bDataSource\b|\bJdbcTemplate\b|\bjava\.sql\./, nondeterministic: false },
  { name: 'jpa', kind: 'database', pattern: /\bEntityManager\b|\borg\.springframework\.data\.jpa\b/, nondeterministic: false },
  { name: 'filesystem', kind: 'filesystem', pattern: /\bjava\.nio\.file\.Files\b|\bnew\s+File\s*\(|\bFileWriter\b|\bFileInputStream\b/, nondeterministic: false },
  { name: 'message-queue', kind: 'queue', pattern: /\bKafkaTemplate\b|\bRabbitTemplate\b|\bJmsTemplate\b|\b@KafkaListener\b|\b@RabbitListener\b/, nondeterministic: true },
];

function detectExternalDependencies(
  javaFiles: readonly JavaFile[],
  configuration: ReturnType<typeof detectConfiguration>,
): ExternalDependency[] {
  const found = new Map<string, { kind: ExternalDependency['kind']; nondeterministic: boolean; usedBy: ExternalDependency['usedBy'] }>();

  for (const file of javaFiles) {
    const masked = file.scanned.masked;
    for (const signature of EXTERNAL_SIGNATURES) {
      const match = signature.pattern.exec(masked);
      if (match === null) continue;
      const entry = found.get(signature.name) ?? { kind: signature.kind, nondeterministic: signature.nondeterministic, usedBy: [] };
      if (entry.usedBy.length < 8) {
        entry.usedBy.push({
          path: file.relativePath,
          startLine: lineAt(file.scanned.lineStarts, match.index),
        });
      }
      found.set(signature.name, entry);
    }
  }

  for (const source of configuration) {
    for (const entry of source.keys) {
      const value = entry.value ?? '';
      if (/^jdbc:/.test(value)) {
        const existing = found.get('jdbc-url') ?? { kind: 'database' as const, nondeterministic: false, usedBy: [] };
        if (existing.usedBy.length < 4) existing.usedBy.push({ path: source.path, symbol: entry.key });
        found.set('jdbc-url', existing);
      }
      if (/^https?:\/\//.test(value) && !/localhost|127\.0\.0\.1/.test(value)) {
        const existing = found.get('external-http-service') ?? { kind: 'network' as const, nondeterministic: true, usedBy: [] };
        if (existing.usedBy.length < 4) existing.usedBy.push({ path: source.path, symbol: entry.key });
        found.set('external-http-service', existing);
      }
    }
  }

  return [...found.entries()]
    .map(([name, entry]) => ({
      id: `ext-${name}`,
      name,
      kind: entry.kind,
      usedBy: entry.usedBy,
      nondeterministic: entry.nondeterministic,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function dedupeEntryPoints(entryPoints: readonly ExtractedEntryPoint[]): EntryPoint[] {
  const seen = new Set<string>();
  const result: EntryPoint[] = [];
  for (const entry of entryPoints) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    result.push({
      id: entry.id,
      kind: entry.kind,
      label: entry.label,
      location: entry.location,
      epistemicStatus: 'OBSERVED',
      ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
    });
  }
  return result.sort((a, b) => a.id.localeCompare(b.id));
}

interface DataFlowInput {
  httpEndpoints: readonly HttpEndpoint[];
  dependencyMap: DependencyMap;
  /** Method nodes that are pure getters/setters; omitted from flows, kept in the graph. */
  trivialAccessors: ReadonlySet<string>;
  generatedAt: string;
}

/**
 * Data flows are chains the graph already proves: route → handler method → methods it calls → the
 * tables each of them reads or writes. They are marked INFERRED because the chain is assembled from
 * call references in the source, not from an execution trace, and the confidence drops when no
 * table could be resolved at all.
 */
function buildDataFlow(input: DataFlowInput): DataFlow {
  const flows: DataFlow['flows'] = [];
  const outbound = new Map<string, { to: string; kind: string }[]>();
  for (const edge of input.dependencyMap.edges) {
    const list = outbound.get(edge.from) ?? [];
    list.push({ to: edge.to, kind: edge.kind });
    outbound.set(edge.from, list);
  }
  const nodeById = new Map(input.dependencyMap.nodes.map((node) => [node.id, node]));

  for (const endpoint of input.httpEndpoints) {
    const routeId = `endpoint:${endpoint.method} ${endpoint.path}`;
    const handlerId = (outbound.get(routeId) ?? []).find((edge) => edge.kind === 'http')?.to;
    if (handlerId === undefined) continue;

    const chain: DataFlow['flows'][number]['steps'] = [];
    const dataStores = new Set<string>();
    const visited = new Set<string>([handlerId]);
    const queue: { id: string; depth: number }[] = [{ id: handlerId, depth: 0 }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined || current.depth > MAX_FLOW_DEPTH) continue;
      const out = outbound.get(current.id) ?? [];
      if (!input.trivialAccessors.has(current.id)) {
        const node = nodeById.get(current.id);
        const reads = tablesForKind(out, 'reads');
        const writes = tablesForKind(out, 'writes');
        for (const table of [...reads, ...writes]) dataStores.add(table);
        chain.push({
          component: current.id,
          action: describeRole(node?.label, writes, reads),
          ...(node?.location !== undefined ? { location: node.location } : {}),
          reads,
          writes,
        });
      }
      for (const edge of out) {
        if (edge.kind !== 'calls' || visited.has(edge.to)) continue;
        visited.add(edge.to);
        queue.push({ id: edge.to, depth: current.depth + 1 });
      }
    }

    if (chain.length === 0) continue;
    const steps: DataFlow['flows'][number]['steps'] = [
      {
        component: routeId,
        action: `${endpoint.method} ${endpoint.path} is handled by ${endpoint.handler.symbol ?? handlerId}`,
        location: endpoint.handler,
        reads: [],
        writes: [],
      },
      ...chain,
    ];
    flows.push({
      // Two handlers can share a route — a real legacy hazard, reported as an endpoint anomaly. The
      // handler line keeps their flow ids distinct so neither shadows the other.
      id: `flow-${endpoint.method.toLowerCase()}-${endpoint.path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '')}-${endpoint.handler.startLine ?? 0}`.slice(0, 120),
      name: `${endpoint.method} ${endpoint.path}`,
      trigger: `HTTP ${endpoint.method} ${endpoint.path}`,
      steps,
      dataStores: [...dataStores].sort(),
      epistemicStatus: 'INFERRED',
      confidence: dataStores.size > 0 ? 0.75 : 0.5,
      evidence: [
        sourceEvidence(evidenceId('flow', routeId), endpoint.handler.path, {
          ...(endpoint.handler.startLine !== undefined ? { line: endpoint.handler.startLine } : {}),
          ...(endpoint.handler.symbol !== undefined ? { symbol: endpoint.handler.symbol } : {}),
          collectedAt: input.generatedAt,
          quote: `${endpoint.method} ${endpoint.path}`,
        }),
      ],
      ...(dataStores.size > 0 ? {} : { notes: 'handler reached, but no SQL target was resolved from source' }),
    });
  }

  return { schemaVersion: 1, generatedAt: input.generatedAt, generator: ANALYSIS_GENERATOR, flows };
}

const MAX_FLOW_DEPTH = 4;

function tablesForKind(edges: readonly { to: string; kind: string }[], kind: string): string[] {
  return edges
    .filter((edge) => edge.kind === kind && edge.to.startsWith('table:'))
    .map((edge) => edge.to.slice('table:'.length))
    .sort();
}

function describeRole(label: string | undefined, writes: string[], reads: string[]): string {
  const parts: string[] = [];
  if (reads.length > 0) parts.push(`reads ${reads.join(', ')}`);
  if (writes.length > 0) parts.push(`writes ${writes.join(', ')}`);
  const name = label ?? 'component';
  return parts.length === 0 ? `${name} participates in the chain` : `${name} ${parts.join(' and ')}`;
}

export type { JavaFile };

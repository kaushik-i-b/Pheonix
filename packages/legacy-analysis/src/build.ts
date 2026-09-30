import type { BuildSystem, ConfigurationSource, Framework, Migration } from '@phoenix/shared';
import type { EvidenceRef } from '@phoenix/shared';
import { evidenceFor } from './evidence.js';
import type { WalkedFile } from './walk.js';

/**
 * Build systems, frameworks, configuration and migrations.
 *
 * Manifests are read as text with targeted regular expressions rather than an XML/YAML parser:
 * adding a parser dependency for three fields is not worth it, and a malformed manifest should
 * degrade to "not detected" instead of aborting discovery.
 */

const SECRET_KEY_PATTERN = /(password|passwd|secret|token|api[-_.]?key|credential|private[-_.]?key|access[-_.]?key)/i;

export function detectBuildSystems(files: readonly WalkedFile[]): BuildSystem[] {
  const systems: BuildSystem[] = [];
  for (const file of files) {
    if (file.text === undefined) continue;
    const base = file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1);
    if (base === 'pom.xml') {
      const parsed = parsePom(file.text);
      if (parsed !== undefined) systems.push(parsed(file.relativePath));
    } else if (base === 'package.json') {
      const parsed = parsePackageJson(file.text);
      if (parsed !== undefined) systems.push(parsed(file.relativePath));
    } else if (base === 'build.gradle' || base === 'build.gradle.kts') {
      systems.push({
        kind: 'gradle',
        manifestPath: file.relativePath,
        commands: { build: './gradlew build', test: './gradlew test', run: './gradlew bootRun' },
        dependencies: gradleDependencies(file.text),
      });
    } else if (base === 'requirements.txt') {
      systems.push({
        kind: 'pip',
        manifestPath: file.relativePath,
        commands: { build: 'pip install -r requirements.txt', test: 'pytest', run: 'python -m app' },
        dependencies: file.text
          .split('\n')
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && !line.startsWith('#'))
          .map((line) => {
            const [name, version] = line.split(/[=<>!~]/);
            return { name: (name ?? line).trim(), ...(version !== undefined ? { version: version.trim() } : {}) };
          }),
      });
    } else if (base === 'Makefile') {
      systems.push({
        kind: 'make',
        manifestPath: file.relativePath,
        commands: { build: 'make', test: 'make test', run: 'make run' },
        dependencies: [],
      });
    }
  }
  return systems;
}

function parsePom(text: string): ((path: string) => BuildSystem) | undefined {
  const dependencies: BuildSystem['dependencies'] = [];
  for (const match of text.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = match[1] ?? '';
    const groupId = tag(block, 'groupId');
    const artifactId = tag(block, 'artifactId');
    if (artifactId === undefined) continue;
    dependencies.push({
      name: groupId === undefined ? artifactId : `${groupId}:${artifactId}`,
      ...(tag(block, 'version') !== undefined ? { version: tag(block, 'version') } : {}),
      ...(tag(block, 'scope') !== undefined ? { scope: tag(block, 'scope') } : {}),
    });
  }
  if (dependencies.length === 0 && !/<project/.test(text)) return undefined;
  return (path) => ({
    kind: 'maven',
    manifestPath: path,
    commands: { build: 'mvn -DskipTests package', test: 'mvn test', run: 'java -jar target/*.jar' },
    dependencies,
  });
}

function parsePackageJson(text: string): ((path: string) => BuildSystem) | undefined {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const dependencies: BuildSystem['dependencies'] = [];
  for (const group of ['dependencies', 'devDependencies'] as const) {
    const entries = parsed[group];
    if (entries === undefined || entries === null || typeof entries !== 'object') continue;
    for (const [name, version] of Object.entries(entries as Record<string, unknown>)) {
      dependencies.push({
        name,
        ...(typeof version === 'string' ? { version } : {}),
        scope: group === 'devDependencies' ? 'test' : 'compile',
      });
    }
  }
  const scripts = (parsed.scripts ?? {}) as Record<string, unknown>;
  return (path) => ({
    kind: text.includes('"packageManager": "pnpm') ? 'pnpm' : 'npm',
    manifestPath: path,
    commands: {
      ...(typeof scripts.build === 'string' ? { build: 'npm run build' } : {}),
      ...(typeof scripts.test === 'string' ? { test: 'npm test' } : {}),
      ...(typeof scripts.start === 'string' ? { run: 'npm start' } : {}),
      ...(typeof scripts.dev === 'string' ? { run: 'npm run dev' } : {}),
    },
    dependencies,
  });
}

function gradleDependencies(text: string): BuildSystem['dependencies'] {
  const dependencies: BuildSystem['dependencies'] = [];
  for (const match of text.matchAll(/(implementation|api|compileOnly|runtimeOnly|testImplementation)[\s(]+['"]([^'"]+)['"]/g)) {
    const scope = match[1];
    const coordinate = match[2];
    if (coordinate === undefined) continue;
    const parts = coordinate.split(':');
    dependencies.push({
      name: parts.length >= 2 ? `${parts[0]}:${parts[1]}` : coordinate,
      ...(parts[2] !== undefined ? { version: parts[2] } : {}),
      ...(scope !== undefined ? { scope } : {}),
    });
  }
  return dependencies;
}

function tag(block: string, name: string): string | undefined {
  const match = new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}

/** Framework detection is evidence-backed: each entry points at the file that revealed it. */
export function detectFrameworks(
  files: readonly WalkedFile[],
  buildSystems: readonly BuildSystem[],
  collectedAt: string,
  collectedBy: string,
): Framework[] {
  const found = new Map<string, { version: string | undefined; evidence: EvidenceRef[] }>();

  const record = (name: string, version: string | undefined, file: WalkedFile, quote: string): void => {
    const entry = found.get(name) ?? { version: undefined, evidence: [] };
    if (version !== undefined && entry.version === undefined) entry.version = version;
    if (entry.evidence.length < 3) {
      entry.evidence.push(
        evidenceFor({
          id: `ev-fw-${name}-${file.relativePath}`,
          kind: 'source-code',
          collectedAt,
          collectedBy,
          location: { path: file.relativePath },
          quote,
        }),
      );
    }
    found.set(name, entry);
  };

  for (const system of buildSystems) {
    for (const dependency of system.dependencies) {
      const name = dependency.name.toLowerCase();
      if (name.includes('spring-boot')) {
        const manifest = files.find((file) => file.relativePath === system.manifestPath);
        if (manifest !== undefined) {
          const parentVersion = manifest.text === undefined ? undefined : springBootParentVersion(manifest.text);
          record('spring-boot', dependency.version ?? parentVersion, manifest, dependency.name);
        }
      }
      if (name.includes('flyway')) record('flyway', dependency.version, fileFor(files, system.manifestPath), dependency.name);
      if (name.includes('liquibase')) record('liquibase', dependency.version, fileFor(files, system.manifestPath), dependency.name);
      if (name.includes('postgresql')) record('postgresql-driver', dependency.version, fileFor(files, system.manifestPath), dependency.name);
      if (name.includes('jackson')) record('jackson', dependency.version, fileFor(files, system.manifestPath), dependency.name);
      if (name === 'fastify' || name.startsWith('@fastify')) record('fastify', dependency.version, fileFor(files, system.manifestPath), dependency.name);
      if (name === 'next') record('next', dependency.version, fileFor(files, system.manifestPath), dependency.name);
      if (name === 'drizzle-orm') record('drizzle', dependency.version, fileFor(files, system.manifestPath), dependency.name);
    }
  }

  return [...found.entries()]
    .map(([name, entry]) => ({ name, ...(entry.version !== undefined ? { version: entry.version } : {}), evidence: entry.evidence }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function fileFor(files: readonly WalkedFile[], relativePath: string): WalkedFile {
  const found = files.find((file) => file.relativePath === relativePath);
  if (found !== undefined) return found;
  // A manifest we could not read still identifies itself; synthesise the minimum needed for evidence.
  return {
    absolutePath: relativePath,
    relativePath,
    bytes: 0,
    lines: undefined,
    language: undefined,
    category: 'build',
    text: undefined,
    contentRead: false,
  };
}

function springBootParentVersion(text: string): string | undefined {
  const parent = /<parent>([\s\S]*?)<\/parent>/.exec(text)?.[1];
  if (parent === undefined) return undefined;
  if (!/spring-boot-starter-parent/.test(parent)) return undefined;
  return tag(parent, 'version');
}

export function declaredLanguageLevel(files: readonly WalkedFile[]): string | undefined {
  for (const file of files) {
    if (file.text === undefined) continue;
    const base = file.relativePath.slice(file.relativePath.lastIndexOf('/') + 1);
    if (base === 'pom.xml') {
      const javaVersion = tag(file.text, 'java.version') ?? tag(file.text, 'maven.compiler.source');
      if (javaVersion !== undefined) return `Java ${javaVersion}`;
      const release = /<release>\s*([^<]+?)\s*<\/release>/.exec(file.text)?.[1];
      if (release !== undefined) return `Java ${release}`;
      const source = /<source>\s*([^<]+?)\s*<\/source>/.exec(file.text)?.[1];
      if (source !== undefined) return `Java ${source}`;
    }
    if (base === 'package.json') {
      try {
        const parsed = JSON.parse(file.text) as { engines?: { node?: string } };
        if (parsed.engines?.node !== undefined) return `Node ${parsed.engines.node}`;
      } catch {
        // A malformed manifest simply yields no declared level.
      }
    }
  }
  return undefined;
}

export function detectConfiguration(files: readonly WalkedFile[]): ConfigurationSource[] {
  const sources: ConfigurationSource[] = [];
  for (const file of files) {
    if (file.text === undefined) continue;
    if (file.category !== 'configuration') continue;
    const extension = file.relativePath.slice(file.relativePath.lastIndexOf('.'));
    const format: ConfigurationSource['format'] =
      extension === '.properties'
        ? 'properties'
        : extension === '.yaml' || extension === '.yml'
          ? 'yaml'
          : extension === '.json'
            ? 'json'
            : extension === '.toml'
              ? 'toml'
              : extension === '.ini' || extension === '.env'
                ? 'ini'
                : extension === '.xml'
                  ? 'xml'
                  : 'other';
    const keys = extractKeys(file.text, format);
    if (keys.length === 0) continue;
    sources.push({
      path: file.relativePath,
      format,
      keys,
      environmentOverrides: environmentOverrides(file.text),
    });
  }
  return sources;
}

function extractKeys(text: string, format: ConfigurationSource['format']): ConfigurationSource['keys'] {
  const keys: ConfigurationSource['keys'] = [];
  if (format === 'properties' || format === 'ini') {
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#') || trimmed.startsWith('!')) continue;
      const separator = trimmed.search(/[=:]/);
      if (separator <= 0) continue;
      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim();
      const secret = SECRET_KEY_PATTERN.test(key);
      keys.push({ key, ...(secret ? {} : { value: value.slice(0, 500) }), secret });
    }
    return keys;
  }
  if (format === 'yaml') {
    const stack: { indent: number; key: string }[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0 || line.trim().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line.trim());
      if (match === null) continue;
      while (stack.length > 0 && (stack[stack.length - 1]?.indent ?? 0) >= indent) stack.pop();
      const key = [...stack.map((entry) => entry.key), match[1] ?? ''].join('.');
      const value = (match[2] ?? '').trim();
      stack.push({ indent, key: match[1] ?? '' });
      if (value.length === 0) continue;
      const secret = SECRET_KEY_PATTERN.test(key);
      keys.push({ key, ...(secret ? {} : { value: value.replace(/^["']|["']$/g, '').slice(0, 500) }), secret });
    }
    return keys;
  }
  if (format === 'json') {
    try {
      const parsed: unknown = JSON.parse(text);
      flattenJson(parsed, '', keys);
    } catch {
      return [];
    }
    return keys;
  }
  return [];
}

function flattenJson(value: unknown, prefix: string, into: ConfigurationSource['keys']): void {
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (entry !== null && typeof entry === 'object') {
      flattenJson(entry, path, into);
      continue;
    }
    const secret = SECRET_KEY_PATTERN.test(path);
    const text = entry === undefined ? '' : String(entry);
    into.push({ key: path, ...(secret ? {} : { value: text.slice(0, 500) }), secret });
  }
}

function environmentOverrides(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/\$\{([A-Z0-9_]+)(?::[^}]*)?\}/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  for (const match of text.matchAll(/(?:process\.env\.|System\.getenv\()["']?([A-Z0-9_]+)/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found].sort();
}

const FLYWAY_PATTERN = /(?:^|\/)V(?<version>[\d.]+)__(?<description>[^/]+)\.sql$/;
const REPEATABLE_PATTERN = /(?:^|\/)R__(?<description>[^/]+)\.sql$/;

export function detectMigrations(files: readonly WalkedFile[]): Migration[] {
  const migrations: Migration[] = [];
  for (const file of files) {
    if (file.category !== 'migration' && !/\.sql$/.test(file.relativePath)) continue;
    const flyway = FLYWAY_PATTERN.exec(file.relativePath);
    if (flyway?.groups !== undefined) {
      migrations.push({
        id: `mig-${file.relativePath}`,
        version: flyway.groups.version ?? '0',
        description: (flyway.groups.description ?? '').replace(/_/g, ' ').slice(0, 500),
        path: file.relativePath,
        tool: 'flyway',
        objectsTouched: [],
        appliesDatabaseBehavior: false,
      });
      continue;
    }
    const repeatable = REPEATABLE_PATTERN.exec(file.relativePath);
    if (repeatable?.groups !== undefined) {
      migrations.push({
        id: `mig-${file.relativePath}`,
        version: 'repeatable',
        description: (repeatable.groups.description ?? '').replace(/_/g, ' ').slice(0, 500),
        path: file.relativePath,
        tool: 'flyway',
        objectsTouched: [],
        appliesDatabaseBehavior: false,
      });
      continue;
    }
    if (/liquibase/i.test(file.text ?? '') || /changeSet/i.test(file.text ?? '')) {
      migrations.push({
        id: `mig-${file.relativePath}`,
        version: 'liquibase',
        path: file.relativePath,
        tool: 'liquibase',
        objectsTouched: [],
        appliesDatabaseBehavior: false,
      });
      continue;
    }
    if (file.category === 'migration' || file.category === 'schema') {
      migrations.push({
        id: `mig-${file.relativePath}`,
        version: 'manual',
        path: file.relativePath,
        tool: 'manual',
        objectsTouched: [],
        appliesDatabaseBehavior: false,
      });
    }
  }
  return migrations;
}

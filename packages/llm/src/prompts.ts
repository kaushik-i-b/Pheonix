import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  PhoenixError,
  nowIso,
  promptDefinitionSchema,
  promptRenderSchema,
  sha256Hex,
  stableStringify,
  type AgentRole,
  type PromptDefinition,
  type PromptRender,
} from '@phoenix/shared';

/**
 * Versioned prompts.
 *
 * Prompts are files, not string literals scattered through the code: they are reviewed, versioned
 * and persisted with every run so a decision made months ago can be reproduced exactly. The
 * registry refuses to render a prompt with a missing variable rather than emitting a hole.
 */

const VARIABLE_PATTERN = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

export interface FrontMatter {
  id?: string;
  version?: string;
  description?: string;
  audience?: string;
  outputSchemaId?: string;
  requiredVariables?: string[];
}

export function parsePromptFile(content: string, sourcePath: string): PromptDefinition {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (match === null) {
    throw new PhoenixError('PROMPT_NOT_FOUND', `prompt file has no front matter: ${sourcePath}`, {
      sourcePath,
    });
  }
  const frontMatter = parseFrontMatter(match[1] ?? '', sourcePath);
  const template = (match[2] ?? '').trim();
  if (template.length === 0) {
    throw new PhoenixError('PROMPT_NOT_FOUND', `prompt file has an empty template: ${sourcePath}`, {
      sourcePath,
    });
  }
  const promptId = frontMatter.id ?? deriveIdFromPath(sourcePath);
  return promptDefinitionSchema.parse({
    promptId,
    version: frontMatter.version ?? '0.0.0',
    description: frontMatter.description ?? promptId,
    audience: frontMatter.audience ?? 'orchestrator',
    template,
    requiredVariables: frontMatter.requiredVariables ?? [...referencedVariables(template)],
    ...(frontMatter.outputSchemaId !== undefined ? { outputSchemaId: frontMatter.outputSchemaId } : {}),
    sourcePath,
  });
}

function parseFrontMatter(text: string, sourcePath: string): FrontMatter {
  const result: FrontMatter = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    switch (key) {
      case 'id':
        result.id = value;
        break;
      case 'version':
        result.version = value;
        break;
      case 'description':
        result.description = value;
        break;
      case 'audience':
        result.audience = value as AgentRole;
        break;
      case 'outputSchemaId':
        result.outputSchemaId = value;
        break;
      case 'requiredVariables':
        result.requiredVariables = value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0);
        break;
      default:
        break;
    }
  }
  if (result.id === undefined) {
    throw new PhoenixError('PROMPT_NOT_FOUND', `prompt front matter is missing "id": ${sourcePath}`, {
      sourcePath,
    });
  }
  return result;
}

function deriveIdFromPath(sourcePath: string): string {
  return relative(process.cwd(), sourcePath).replaceAll('/', '.').replace(/\.md$/, '');
}

export function referencedVariables(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name !== undefined) found.add(name);
  }
  return [...found].sort();
}

export class PromptRegistry {
  private readonly definitions = new Map<string, PromptDefinition>();

  private constructor(definitions: readonly PromptDefinition[]) {
    for (const definition of definitions) {
      const existing = this.definitions.get(definition.promptId);
      if (existing !== undefined && existing.version !== definition.version) {
        throw new PhoenixError(
          'PROMPT_NOT_FOUND',
          `duplicate prompt id "${definition.promptId}" with conflicting versions ${existing.version} and ${definition.version}`,
          { promptId: definition.promptId },
        );
      }
      this.definitions.set(definition.promptId, definition);
    }
  }

  static fromDefinitions(definitions: readonly PromptDefinition[]): PromptRegistry {
    return new PromptRegistry(definitions.map((definition) => promptDefinitionSchema.parse(definition)));
  }

  /** Recursively loads every `*.md` prompt file under the given directories. */
  static fromDirectories(directories: readonly string[]): PromptRegistry {
    const definitions: PromptDefinition[] = [];
    for (const directory of directories) {
      for (const path of collectMarkdownFiles(directory)) {
        definitions.push(parsePromptFile(readFileSync(path, 'utf8'), path));
      }
    }
    return new PromptRegistry(definitions);
  }

  has(promptId: string): boolean {
    return this.definitions.has(promptId);
  }

  get(promptId: string): PromptDefinition {
    const definition = this.definitions.get(promptId);
    if (definition === undefined) {
      throw new PhoenixError('PROMPT_NOT_FOUND', `unknown prompt "${promptId}"`, {
        promptId,
        known: [...this.definitions.keys()].sort(),
      });
    }
    return definition;
  }

  list(): PromptDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.promptId.localeCompare(b.promptId));
  }

  /**
   * Renders a prompt and records exactly what was sent. The returned hash is what appears in
   * `llm.completed` and `prompt.rendered` events, tying every model call back to its prompt.
   */
  render(
    promptId: string,
    variables: Record<string, unknown>,
    options: { runId?: string } = {},
  ): PromptRender {
    const definition = this.get(promptId);
    const missing = [
      ...new Set([...definition.requiredVariables, ...referencedVariables(definition.template)]),
    ].filter((name) => variables[name] === undefined);
    if (missing.length > 0) {
      throw new PhoenixError(
        'PROMPT_VARIABLE_MISSING',
        `prompt "${promptId}" is missing variables: ${missing.join(', ')}`,
        { promptId, missing },
      );
    }
    const renderedText = definition.template.replaceAll(
      VARIABLE_PATTERN,
      (_match, name: string) => formatVariable(variables[name]),
    );
    return promptRenderSchema.parse({
      promptId: definition.promptId,
      promptVersion: definition.version,
      renderedAt: nowIso(),
      ...(options.runId !== undefined ? { runId: options.runId } : {}),
      variables,
      renderedText,
      hash: sha256Hex(stableStringify({ promptId, version: definition.version, variables })),
    });
  }
}

function formatVariable(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value, null, 2);
}

function collectMarkdownFiles(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries.sort()) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      files.push(...collectMarkdownFiles(path));
    } else if (entry.endsWith('.md')) {
      files.push(path);
    }
  }
  return files;
}

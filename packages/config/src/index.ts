import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import {
  DEFAULT_ROLE_PERMISSIONS,
  PATH_TOKEN_ARTIFACTS,
  PATH_TOKEN_LEGACY,
  PATH_TOKEN_MODERN,
  PATH_TOKEN_WORKSPACE,
  PhoenixError,
  runLimitsSchema,
  sha256Hex,
  type AgentRole,
  type LlmRunConfig,
  type RolePermissions,
  type RunLimits,
  rolePermissionsSchema,
} from '@phoenix/shared';
import { loadEnv, type LoadedEnv } from './env.js';

/**
 * Single source of truth for configuration. Every process (cli, api, worker) loads through here,
 * so limits, provider settings and security policy cannot drift between them.
 */

export const logLevelSettingSchema = z.enum(['debug', 'info', 'warn', 'error', 'silent']);

export const llmSettingsSchema = z.object({
  providerId: z.string().min(1).default('openai-compatible'),
  baseUrl: z.string().url(),
  /** Never persisted into artifacts or events; only its hash is recorded. */
  apiKey: z.string().optional(),
  model: z.string().min(1),
  temperature: z.number().min(0).max(2).default(0.1),
  maxTokens: z.number().int().positive().default(4096),
  timeoutMs: z.number().int().positive().default(180_000),
  maxRetries: z.number().int().nonnegative().default(3),
  concurrency: z.number().int().positive().default(2),
  /** Optional path to a pricing table; without it cost is reported as unknown. */
  pricingPath: z.string().min(1).optional(),
  /**
   * Backend-specific request fields, e.g. `{"options":{"num_ctx":32768}}` for Ollama. Phoenix talks
   * to any OpenAI-compatible endpoint with one client, so the knobs only one backend understands
   * belong in configuration rather than in code.
   */
  extraBody: z.record(z.string(), z.unknown()).optional(),
});
export type LlmSettings = z.infer<typeof llmSettingsSchema>;

export const databaseSettingsSchema = z.object({
  url: z.string().min(1),
  migrate: z.boolean().default(true),
  poolSize: z.number().int().positive().default(5),
});
export type DatabaseSettings = z.infer<typeof databaseSettingsSchema>;

export const pathSettingsSchema = z.object({
  repoRoot: z.string().min(1),
  artifactRoot: z.string().min(1),
  workspaceRoot: z.string().min(1),
});
export type PathSettings = z.infer<typeof pathSettingsSchema>;

export const sandboxSettingsSchema = z.object({
  allowNetwork: z.boolean().default(false),
  defaultTimeoutMs: z.number().int().positive().default(120_000),
  maxOutputBytes: z.number().int().positive().default(1_048_576),
  /** Only these variables reach a spawned command; everything else is scrubbed. */
  envAllowlist: z.array(z.string().min(1)).default(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'JAVA_HOME', 'TMPDIR']),
  /** Extra variables injected into every sandboxed command (e.g. JAVA_HOME for the legacy bank). */
  env: z.record(z.string(), z.string()).default({}),
  killSignal: z.enum(['SIGTERM', 'SIGKILL']).default('SIGTERM'),
});
export type SandboxSettings = z.infer<typeof sandboxSettingsSchema>;

export const loggingSettingsSchema = z.object({
  level: logLevelSettingSchema.default('info'),
  format: z.enum(['json', 'pretty']).default('json'),
  mirrorEventsToFile: z.boolean().default(true),
});
export type LoggingSettings = z.infer<typeof loggingSettingsSchema>;

export const targetSettingsSchema = z.object({
  label: z.string().min(1),
  rootPath: z.string().min(1),
  runtimeKind: z.enum(['http', 'cli', 'library', 'none']).default('http'),
  baseUrl: z.string().url().optional(),
  port: z.number().int().positive().optional(),
  startCommand: z.string().min(1).optional(),
  stopCommand: z.string().min(1).optional(),
  healthPath: z.string().min(1).default('/health'),
  readyTimeoutMs: z.number().int().positive().default(120_000),
  databaseTarget: z.string().min(1).optional(),
});
export type TargetSettings = z.infer<typeof targetSettingsSchema>;

export const phoenixConfigSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  llm: llmSettingsSchema,
  database: databaseSettingsSchema,
  paths: pathSettingsSchema,
  sandbox: sandboxSettingsSchema.default({}),
  logging: loggingSettingsSchema.default({}),
  limits: runLimitsSchema.default({}),
  legacy: targetSettingsSchema,
  modern: targetSettingsSchema,
  /** Named database targets that tools may query, e.g. `{ legacy: 'postgres://...' }`. */
  databaseTargets: z.record(z.string(), z.string()).default({}),
  api: z.object({ port: z.number().int().positive().default(4100), host: z.string().default('127.0.0.1') }).default({}),
  web: z.object({ port: z.number().int().positive().default(4101) }).default({}),
});
export type PhoenixConfig = z.infer<typeof phoenixConfigSchema>;

function absolute(path: string, cwd: string): string {
  return isAbsolute(path) ? path : resolve(cwd, path);
}

function optionalString(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function number(env: Record<string, string | undefined>, key: string): number | undefined {
  const raw = optionalString(env, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new PhoenixError('CONFIG_INVALID', `${key} must be a number, got "${raw}"`, { key });
  }
  return parsed;
}

function bool(env: Record<string, string | undefined>, key: string): boolean | undefined {
  const raw = optionalString(env, key);
  if (raw === undefined) return undefined;
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase());
}

/** A JSON object from the environment, or a clear failure — never a half-parsed guess. */
function jsonObject(env: Record<string, string | undefined>, key: string): Record<string, unknown> | undefined {
  const raw = optionalString(env, key);
  if (raw === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PhoenixError(
      'CONFIG_INVALID',
      `${key} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
      { key },
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PhoenixError('CONFIG_INVALID', `${key} must be a JSON object`, { key });
  }
  return parsed as Record<string, unknown>;
}

export interface LoadConfigOptions {
  cwd?: string;
  envFiles?: string[];
  /** Overrides applied last; used by tests and by the API when a run customizes limits. */
  overrides?: Record<string, string>;
  /** Base environment; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface LoadedConfig {
  config: PhoenixConfig;
  env: LoadedEnv;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const cwd = options.cwd ?? process.cwd();
  const loaded = loadEnv({ cwd, files: options.envFiles ?? ['.env', '.env.local'], base: options.env ?? process.env });
  const env: Record<string, string | undefined> = { ...loaded.values, ...options.overrides };

  const baseUrl = optionalString(env, 'LLM_BASE_URL');
  const model = optionalString(env, 'LLM_MODEL');
  if (baseUrl === undefined || model === undefined) {
    throw new PhoenixError(
      'LLM_NOT_CONFIGURED',
      'LLM_BASE_URL and LLM_MODEL must be set. Phoenix talks to any OpenAI-compatible endpoint (hosted Qwen, vLLM, Ollama).',
      {
        missing: [baseUrl === undefined ? 'LLM_BASE_URL' : null, model === undefined ? 'LLM_MODEL' : null].filter(
          (entry): entry is string => entry !== null,
        ),
      },
    );
  }

  const legacyRoot = optionalString(env, 'LEGACY_ROOT') ?? './examples/legacy-bank';
  const modernRoot = optionalString(env, 'MODERN_ROOT') ?? './.phoenix-workspaces/modern';
  const legacyDbUrl =
    optionalString(env, 'LEGACY_BANK_DB_URL') ?? 'postgres://legacy:legacy@localhost:5432/legacy_bank';
  const modernDbUrl = optionalString(env, 'MODERN_BANK_DB_URL');
  const extraBody = jsonObject(env, 'LLM_EXTRA_BODY');

  const candidate = {
    llm: {
      providerId: optionalString(env, 'LLM_PROVIDER_ID') ?? 'openai-compatible',
      baseUrl,
      ...(optionalString(env, 'LLM_API_KEY') !== undefined ? { apiKey: optionalString(env, 'LLM_API_KEY') } : {}),
      model,
      temperature: number(env, 'LLM_TEMPERATURE') ?? 0.1,
      maxTokens: number(env, 'LLM_MAX_TOKENS') ?? 4096,
      timeoutMs: number(env, 'LLM_TIMEOUT_MS') ?? 180_000,
      maxRetries: number(env, 'LLM_MAX_RETRIES') ?? 3,
      concurrency: number(env, 'LLM_CONCURRENCY') ?? 2,
      ...(optionalString(env, 'LLM_PRICING_PATH') !== undefined
        ? { pricingPath: optionalString(env, 'LLM_PRICING_PATH') }
        : {}),
      ...(extraBody !== undefined ? { extraBody } : {}),
    },
    database: {
      url: optionalString(env, 'PHOENIX_DATABASE_URL') ?? 'postgres://phoenix:phoenix@localhost:5432/phoenix',
      migrate: bool(env, 'PHOENIX_DB_MIGRATE') ?? true,
      poolSize: number(env, 'PHOENIX_DB_POOL_SIZE') ?? 5,
    },
    paths: {
      repoRoot: cwd,
      artifactRoot: absolute(optionalString(env, 'PHOENIX_ARTIFACT_ROOT') ?? './artifacts', cwd),
      workspaceRoot: absolute(optionalString(env, 'PHOENIX_WORKSPACE_ROOT') ?? './.phoenix-workspaces', cwd),
    },
    sandbox: {
      allowNetwork: bool(env, 'SANDBOX_ALLOW_NETWORK') ?? false,
      defaultTimeoutMs: number(env, 'SANDBOX_DEFAULT_TIMEOUT_MS') ?? 120_000,
      maxOutputBytes: number(env, 'SANDBOX_MAX_OUTPUT_BYTES') ?? 1_048_576,
      envAllowlist: ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'JAVA_HOME', 'TMPDIR'],
      env: {
        ...(optionalString(env, 'JAVA_HOME') !== undefined ? { JAVA_HOME: optionalString(env, 'JAVA_HOME') as string } : {}),
      },
      killSignal: 'SIGTERM',
    },
    logging: {
      level: (optionalString(env, 'LOG_LEVEL') ?? 'info') as z.infer<typeof logLevelSettingSchema>,
      format: (optionalString(env, 'LOG_FORMAT') ?? 'json') as 'json' | 'pretty',
      mirrorEventsToFile: bool(env, 'ENABLE_EVENT_MIRROR') ?? true,
    },
    limits: {
      maxRepairIterations: number(env, 'MAX_REPAIR_ITERATIONS') ?? 3,
      maxAgentSteps: number(env, 'MAX_AGENT_STEPS') ?? 40,
      maxTotalToolCalls: number(env, 'MAX_TOTAL_TOOL_CALLS') ?? 1200,
      maxToolCallsPerAgent: number(env, 'MAX_TOOL_CALLS_PER_AGENT') ?? 150,
      stageTimeoutMs: number(env, 'STAGE_TIMEOUT_MS') ?? 1_800_000,
      toolCallTimeoutMs: number(env, 'SANDBOX_DEFAULT_TIMEOUT_MS') ?? 120_000,
      requireRepairProgress: bool(env, 'REQUIRE_REPAIR_PROGRESS') ?? true,
    },
    legacy: {
      label: optionalString(env, 'LEGACY_LABEL') ?? 'legacy-bank',
      rootPath: absolute(legacyRoot, cwd),
      runtimeKind: 'http',
      baseUrl: optionalString(env, 'LEGACY_BASE_URL') ?? `http://localhost:${number(env, 'LEGACY_BANK_PORT') ?? 8080}`,
      port: number(env, 'LEGACY_BANK_PORT') ?? 8080,
      startCommand: optionalString(env, 'LEGACY_START_COMMAND') ?? 'bash ./run.sh',
      stopCommand: optionalString(env, 'LEGACY_STOP_COMMAND') ?? 'bash ./stop.sh',
      healthPath: optionalString(env, 'LEGACY_HEALTH_PATH') ?? '/health',
      readyTimeoutMs: number(env, 'LEGACY_READY_TIMEOUT_MS') ?? 180_000,
      databaseTarget: 'legacy',
    },
    modern: {
      label: optionalString(env, 'MODERN_LABEL') ?? 'modern-bank',
      rootPath: absolute(modernRoot, cwd),
      runtimeKind: 'http',
      baseUrl: optionalString(env, 'MODERN_BASE_URL') ?? `http://localhost:${number(env, 'MODERN_BANK_PORT') ?? 8090}`,
      port: number(env, 'MODERN_BANK_PORT') ?? 8090,
      startCommand: optionalString(env, 'MODERN_START_COMMAND') ?? 'bash ./run.sh',
      stopCommand: optionalString(env, 'MODERN_STOP_COMMAND') ?? 'bash ./stop.sh',
      healthPath: optionalString(env, 'MODERN_HEALTH_PATH') ?? '/health',
      readyTimeoutMs: number(env, 'MODERN_READY_TIMEOUT_MS') ?? 120_000,
      databaseTarget: modernDbUrl !== undefined ? 'modern' : undefined,
    },
    databaseTargets: {
      legacy: legacyDbUrl,
      ...(modernDbUrl !== undefined ? { modern: modernDbUrl } : {}),
      ...(optionalString(env, 'PHOENIX_METADATA_DB_TARGET') !== undefined
        ? { phoenix: optionalString(env, 'PHOENIX_METADATA_DB_TARGET') as string }
        : {}),
    },
    api: {
      port: number(env, 'API_PORT') ?? 4100,
      host: optionalString(env, 'API_HOST') ?? '127.0.0.1',
    },
    web: { port: number(env, 'WEB_PORT') ?? 4101 },
  };

  const parsed = phoenixConfigSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new PhoenixError('CONFIG_INVALID', `invalid Phoenix configuration: ${parsed.error.message}`, {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return { config: parsed.data, env: loaded };
}

/** Per-run resolved paths; permission profiles are meaningless without them. */
export interface RunPaths {
  runId: string;
  artifactRoot: string;
  workspaceRoot: string;
  legacyRoot: string;
  modernRoot: string;
}

export function resolveRunPaths(config: PhoenixConfig, runId: string): RunPaths {
  return {
    runId,
    artifactRoot: resolve(config.paths.artifactRoot, runId),
    workspaceRoot: resolve(config.paths.workspaceRoot, runId),
    legacyRoot: config.legacy.rootPath,
    modernRoot: config.modern.rootPath,
  };
}

/**
 * Substitutes the path tokens in a default permission profile with concrete directories, so the
 * tool layer can enforce scope with plain prefix checks.
 */
export function resolvePermissions(
  profile: RolePermissions,
  paths: Pick<RunPaths, 'artifactRoot' | 'workspaceRoot' | 'legacyRoot' | 'modernRoot'>,
): RolePermissions {
  const substitute = (value: string): string =>
    value
      .replaceAll(PATH_TOKEN_LEGACY, paths.legacyRoot)
      .replaceAll(PATH_TOKEN_MODERN, paths.modernRoot)
      .replaceAll(PATH_TOKEN_ARTIFACTS, paths.artifactRoot)
      .replaceAll(PATH_TOKEN_WORKSPACE, paths.workspaceRoot);
  return rolePermissionsSchema.parse({
    ...profile,
    readRoots: profile.readRoots.map(substitute),
    writeRoots: profile.writeRoots.map(substitute),
  });
}

export function permissionsForRole(role: AgentRole, paths: Pick<RunPaths, 'artifactRoot' | 'workspaceRoot' | 'legacyRoot' | 'modernRoot'>): RolePermissions {
  return resolvePermissions(DEFAULT_ROLE_PERMISSIONS[role], paths);
}

/** The subset of configuration that is safe (and useful) to persist inside a run record. */
export function toRunLlmConfig(settings: LlmSettings): LlmRunConfig {
  return {
    providerId: settings.providerId,
    baseUrl: settings.baseUrl,
    model: settings.model,
    temperature: settings.temperature,
    maxTokens: settings.maxTokens,
    timeoutMs: settings.timeoutMs,
    maxRetries: settings.maxRetries,
    concurrency: settings.concurrency,
    ...(settings.apiKey !== undefined ? { apiKeyFingerprint: sha256Hex(settings.apiKey) } : {}),
    pricingConfigured: settings.pricingPath !== undefined,
  };
}

export function toRunLimits(limits: RunLimits): RunLimits {
  return runLimitsSchema.parse(limits);
}

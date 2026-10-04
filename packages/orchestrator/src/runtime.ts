import { resolve } from 'node:path';
import { FileArtifactStore } from '@phoenix/artifact-store';
import {
  evidenceExistsCheck,
  type AgentRuntime,
  type CustomCheck,
  type ToolExecutorFactory,
} from '@phoenix/agent-runtime';
import { resolvePermissions, resolveRunPaths, type PhoenixConfig, type RunPaths } from '@phoenix/config';
import { PromptRegistry, createLlmProvider, loadPricingTable, type LlmProvider } from '@phoenix/llm';
import { DatabaseGateway, ExecutionSandbox, ToolExecutor, type ToolPaths } from '@phoenix/repository-tools';
import {
  DEFAULT_ROLE_PERMISSIONS,
  EventSequencer,
  createLogger,
  taskBudgetSchema,
  type AgentRole,
  type EventSink,
  type Logger,
  type LlmPricingTable,
  type RolePermissions,
  type RunId,
  type TaskBudget,
} from '@phoenix/shared';
import { JsonlEventSink, eventMirrorPath } from './event-mirror.js';

/**
 * Everything a run needs, assembled once.
 *
 * The point of this module is that no stage constructs its own provider, store, sandbox or event
 * sink: they are built here from one configuration object, so the limits and the security policy
 * cannot drift between stages. Every dependency is injectable, which is what lets the orchestrator
 * tests run the real state machine against a mock provider instead of an LLM.
 */

export interface CreateRunRuntimeOptions {
  config: PhoenixConfig;
  runId: RunId;
  /** Injected in tests; defaults to the provider named by configuration. */
  provider?: LlmProvider;
  prompts?: PromptRegistry;
  /** Directories scanned for versioned prompt files, resolved against `config.paths.repoRoot`. */
  promptDirectories?: readonly string[];
  artifacts?: FileArtifactStore;
  events?: EventSequencer;
  logger?: Logger;
  databases?: DatabaseGateway;
  pricing?: LlmPricingTable;
  /** Extra deterministic checks available to every task's `custom-check` criteria. */
  customChecks?: Readonly<Record<string, CustomCheck>>;
  /** Set false to keep events in process only (tests). */
  mirrorEvents?: boolean;
}

export interface RunRuntime {
  readonly runId: RunId;
  readonly config: PhoenixConfig;
  readonly paths: RunPaths;
  readonly toolPaths: ToolPaths;
  readonly artifacts: FileArtifactStore;
  readonly events: EventSequencer;
  readonly logger: Logger;
  readonly databases: DatabaseGateway;
  /** The agent loop, ready to be handed a task. */
  readonly agent: AgentRuntime;
  /** The role's default profile with this run's concrete paths substituted in. */
  permissionsFor(role: AgentRole): RolePermissions;
  /** A budget derived from the configured run limits, narrowed by the stage. */
  budgetFor(overrides?: Partial<TaskBudget>): TaskBudget;
  close(): Promise<void>;
}

export function createRunRuntime(options: CreateRunRuntimeOptions): RunRuntime {
  const { config, runId } = options;
  const logger = options.logger ?? createLogger({ component: 'orchestrator', level: config.logging.level });
  const warn = (message: string, details?: Record<string, unknown>): void => {
    logger.warn(message, { runId, ...(details ?? {}) });
  };

  const paths = resolveRunPaths(config, runId);
  const toolPaths: ToolPaths = {
    legacyRoot: paths.legacyRoot,
    modernRoot: paths.modernRoot,
    artifactRoot: paths.artifactRoot,
    workspaceRoot: paths.workspaceRoot,
  };
  const artifacts = options.artifacts ?? new FileArtifactStore(config.paths.artifactRoot);

  const sinks: EventSink[] = [];
  if (options.mirrorEvents !== false && options.events === undefined && config.logging.mirrorEventsToFile) {
    sinks.push(new JsonlEventSink(eventMirrorPath(config.paths.artifactRoot, runId)));
  }
  const events =
    options.events ??
    new EventSequencer(sinks, (sink, error) =>
      warn(`event sink "${sink}" failed; the event is lost from the mirror but the run continues`, {
        sink,
        error: error instanceof Error ? error.message : String(error),
      }),
    );

  const provider = options.provider ?? createLlmProvider({ settings: config.llm, onWarn: warn });
  const prompts =
    options.prompts ??
    PromptRegistry.fromDirectories(
      (options.promptDirectories ?? ['prompts']).map((directory) => resolve(config.paths.repoRoot, directory)),
    );
  const databases =
    options.databases ??
    new DatabaseGateway(config.databaseTargets, {
      timeoutMs: config.limits.toolCallTimeoutMs,
      onWarn: warn,
    });
  const pricing = options.pricing ?? loadPricingTable(config.llm.pricingPath, { onWarn: warn });

  /**
   * A fresh executor per task, because the sandbox is built from *that* role's command patterns and
   * roots. Sharing one executor would enforce the union of every profile — which is how an agent
   * ends up able to run a command its role was never granted.
   */
  const createTools: ToolExecutorFactory = (permissions) =>
    new ToolExecutor({
      sandbox: new ExecutionSandbox({
        commandPatterns: permissions.commandPatterns,
        allowedCwdRoots: cwdRootsFor(permissions, toolPaths),
        envAllowlist: config.sandbox.envAllowlist,
        env: config.sandbox.env,
        defaultTimeoutMs: config.limits.toolCallTimeoutMs,
        maxOutputBytes: config.sandbox.maxOutputBytes,
        killSignal: config.sandbox.killSignal,
        allowNetwork: config.sandbox.allowNetwork,
        onExecution: (record) => {
          logger.debug('sandbox command', {
            runId,
            command: record.command.slice(0, 500),
            exitCode: record.exitCode,
            durationMs: record.durationMs,
          });
        },
      }),
      databases,
    });

  const customChecks: Readonly<Record<string, CustomCheck>> = {
    'evidence-exists': evidenceExistsCheck({
      roots: [paths.legacyRoot, paths.modernRoot, paths.artifactRoot, paths.workspaceRoot],
    }),
    ...(options.customChecks ?? {}),
  };

  const agent: AgentRuntime = {
    provider,
    prompts,
    artifacts,
    createTools,
    events,
    paths: toolPaths,
    customChecks,
    logger,
    ...(pricing !== undefined ? { pricing } : {}),
  };

  return {
    runId,
    config,
    paths,
    toolPaths,
    artifacts,
    events,
    logger,
    databases,
    agent,
    permissionsFor(role) {
      return resolvePermissions(DEFAULT_ROLE_PERMISSIONS[role], paths);
    },
    budgetFor(overrides = {}) {
      return taskBudgetSchema.parse({
        maxSteps: config.limits.maxAgentSteps,
        maxToolCalls: Math.min(config.limits.maxToolCallsPerAgent, config.limits.maxTotalToolCalls),
        timeoutMs: config.limits.stageTimeoutMs,
        ...overrides,
      });
    },
    async close() {
      await events.close();
      await databases.close();
    },
  };
}

function cwdRootsFor(permissions: RolePermissions, paths: ToolPaths): string[] {
  const roots = [...new Set([...permissions.readRoots, ...permissions.writeRoots])];
  return roots.length > 0 ? roots : [paths.workspaceRoot];
}

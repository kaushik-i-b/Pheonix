import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PromptRegistry, type LlmProvider } from '@phoenix/llm';
import { FileArtifactStore } from '@phoenix/artifact-store';
import { ExecutionSandbox, ToolExecutor, type ToolPaths } from '@phoenix/repository-tools';
import {
  EventSequencer,
  InMemoryEventSink,
  agentTaskSchema,
  newRunId,
  newTaskId,
  nowIso,
  rolePermissionsSchema,
  silentLogger,
  type AgentTask,
  type RolePermissions,
  type RunId,
} from '@phoenix/shared';
import type { AgentRuntime, CustomCheck } from '../src/index.js';

/**
 * A fixture that is deliberately small but structurally real: a fake legacy repository on disk, an
 * artifact store, an in-memory event sink and versioned prompt files. Everything the agent loop
 * touches is the production implementation — only the model is a mock.
 */

export const FEE_SERVICE_PATH = 'src/main/java/legacy/fee/FeeService.java';
export const FEE_SERVICE_LINE = 'return amount.multiply(FEE_RATE).setScale(2, RoundingMode.HALF_UP);';

const FEE_SERVICE_SOURCE = `package legacy.fee;

import java.math.BigDecimal;
import java.math.RoundingMode;

public class FeeService {
    private static final BigDecimal FEE_RATE = new BigDecimal("0.0015");

    public BigDecimal fee(BigDecimal amount) {
        ${FEE_SERVICE_LINE}
    }

    public BigDecimal waivedFee(BigDecimal amount) {
        try {
            return fee(amount);
        } catch (RuntimeException e) {
            return BigDecimal.ZERO;
        }
    }
}
`;

const SYSTEM_PROMPT = `---
id: fixture.system
version: 1.0.0
description: fixture system prompt
audience: archaeologist
---
You are a fixture agent. Use your tools, then answer.
`;

const USER_PROMPT = `---
id: fixture.task
version: 1.0.0
description: fixture user prompt
audience: archaeologist
requiredVariables: objective, hint
---
Objective: {{objective}}

Hint: {{hint}}
`;

export interface Fixture {
  runId: RunId;
  repoRoot: string;
  artifactRoot: string;
  workspaceRoot: string;
  paths: ToolPaths;
  store: FileArtifactStore;
  sink: InMemoryEventSink;
  events: EventSequencer;
  prompts: PromptRegistry;
  permissions: RolePermissions;
  runtime: AgentRuntime;
  cleanup(): void;
}

export interface FixtureOptions {
  provider: LlmProvider;
  /** Tools the role profile grants; the task may only ever narrow this. */
  tools?: readonly RolePermissions['tools'][number][];
  customChecks?: Readonly<Record<string, CustomCheck>>;
}

const temporaryDirectories: string[] = [];

export function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

export function cleanupTemporaryDirectories(): void {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop();
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true });
  }
}

export function createFixture(options: FixtureOptions): Fixture {
  const repoRoot = tempDirectory('phoenix-fixture-repo-');
  const artifactRoot = tempDirectory('phoenix-fixture-artifacts-');
  const workspaceRoot = tempDirectory('phoenix-fixture-workspace-');
  const promptRoot = tempDirectory('phoenix-fixture-prompts-');

  writeSource(repoRoot, FEE_SERVICE_PATH, FEE_SERVICE_SOURCE);
  writeSource(promptRoot, 'system.md', SYSTEM_PROMPT);
  writeSource(promptRoot, 'task.md', USER_PROMPT);

  const paths: ToolPaths = {
    legacyRoot: repoRoot,
    modernRoot: join(workspaceRoot, 'modern'),
    artifactRoot,
    workspaceRoot,
  };
  const store = new FileArtifactStore(artifactRoot);
  const sink = new InMemoryEventSink();
  const events = new EventSequencer([sink], (name, error) => {
    throw new Error(`event sink ${name} failed: ${String(error)}`);
  });
  const prompts = PromptRegistry.fromDirectories([promptRoot]);
  const tools = options.tools ?? ['read_file', 'list_files', 'search_repository'];
  const permissions = rolePermissionsSchema.parse({
    role: 'archaeologist',
    tools,
    readRoots: [repoRoot, artifactRoot],
    writeRoots: [],
    commandPatterns: [],
    httpTargets: [],
    databaseTargets: [],
    databaseReadOnly: true,
  });

  const runtime: AgentRuntime = {
    provider: options.provider,
    prompts,
    artifacts: store,
    events,
    paths,
    logger: silentLogger,
    createTools: (effective) =>
      new ToolExecutor({
        sandbox: new ExecutionSandbox({
          commandPatterns: effective.commandPatterns,
          allowedCwdRoots: [...effective.readRoots, ...effective.writeRoots],
        }),
      }),
    ...(options.customChecks !== undefined ? { customChecks: options.customChecks } : {}),
  };

  return {
    runId: newRunId(),
    repoRoot,
    artifactRoot,
    workspaceRoot,
    paths,
    store,
    sink,
    events,
    prompts,
    permissions,
    runtime,
    cleanup: cleanupTemporaryDirectories,
  };
}

export function writeSource(root: string, relativePath: string, content: string): string {
  const absolute = join(root, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, 'utf8');
  return absolute;
}

export interface TaskOverrides {
  runId?: RunId;
  objective?: string;
  context?: string;
  allowedTools?: AgentTask['allowedTools'];
  permissions?: RolePermissions;
  constraints?: AgentTask['constraints'];
  acceptanceCriteria?: AgentTask['acceptanceCriteria'];
  expectedOutputs?: AgentTask['expectedOutputs'];
  budget?: Partial<AgentTask['budget']>;
  promptIds?: string[];
  role?: AgentTask['role'];
  stage?: AgentTask['stage'];
}

export function buildTask(fixture: Fixture, overrides: TaskOverrides = {}): AgentTask {
  return agentTaskSchema.parse({
    taskId: newTaskId(),
    runId: overrides.runId ?? fixture.runId,
    stage: overrides.stage ?? 'DISCOVERY',
    role: overrides.role ?? 'archaeologist',
    objective: overrides.objective ?? 'establish what the fee service does, from the code',
    allowedTools: overrides.allowedTools ?? ['read_file', 'list_files', 'search_repository'],
    permissions: overrides.permissions ?? fixture.permissions,
    budget: { maxSteps: 6, maxToolCalls: 5, timeoutMs: 30_000, ...(overrides.budget ?? {}) },
    createdAt: nowIso(),
    promptIds: overrides.promptIds ?? ['fixture.system', 'fixture.task'],
    ...(overrides.context !== undefined ? { context: overrides.context } : {}),
    ...(overrides.constraints !== undefined ? { constraints: overrides.constraints } : {}),
    ...(overrides.acceptanceCriteria !== undefined ? { acceptanceCriteria: overrides.acceptanceCriteria } : {}),
    ...(overrides.expectedOutputs !== undefined ? { expectedOutputs: overrides.expectedOutputs } : {}),
  });
}

export function readCall(path: string, id = 'call_read') {
  return { id, name: 'read_file' as const, arguments: { path } };
}

import { z } from 'zod';

/**
 * Agent roles, the tool vocabulary, and the permission profiles that bind them.
 *
 * Permissions are declared here and *architecturally enforced* by
 * `@phoenix/repository-tools` and `@phoenix/execution-sandbox`: a tool call that a role is
 * not entitled to is rejected before it executes, regardless of what a prompt said.
 */

export const agentRoleSchema = z.enum([
  'archaeologist',
  'business-rule-analyst',
  'invariant-analyst',
  'characterization-engineer',
  'architect',
  'modernizer',
  'adversary',
  'differential-verifier',
  'diagnostician',
  'release-guardian',
  'orchestrator',
]);
export type AgentRole = z.infer<typeof agentRoleSchema>;

export const toolNameSchema = z.enum([
  'read_file',
  'list_files',
  'search_repository',
  'write_file',
  'apply_patch',
  'run_command',
  'run_tests',
  'query_database',
  'inspect_git_diff',
  // Addition to the brief's initial tool list: differential and characterization work must
  // exercise a *running* legacy system over HTTP, which no other tool can do.
  'http_request',
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const READ_ONLY_TOOLS: readonly ToolName[] = [
  'read_file',
  'list_files',
  'search_repository',
  'inspect_git_diff',
] as const;

export const MUTATING_TOOLS: readonly ToolName[] = ['write_file', 'apply_patch'] as const;

export const EXECUTING_TOOLS: readonly ToolName[] = [
  'run_command',
  'run_tests',
  'query_database',
  'http_request',
] as const;

/** An anchored regular expression matched against the full command line. */
export const commandPatternSchema = z.string().min(1);

export const rolePermissionsSchema = z.object({
  role: agentRoleSchema,
  tools: z.array(toolNameSchema),
  /** Absolute or run-relative directory roots this role may read. */
  readRoots: z.array(z.string().min(1)).default([]),
  /** Absolute or run-relative directory roots this role may write. */
  writeRoots: z.array(z.string().min(1)).default([]),
  /** Anchored regexes; a command must match at least one to execute. Empty means no commands. */
  commandPatterns: z.array(commandPatternSchema).default([]),
  /** Allowed URL prefixes for http_request. Empty means no network access. */
  httpTargets: z.array(z.string().min(1)).default([]),
  /** Named database targets this role may query (see config for the name -> URL mapping). */
  databaseTargets: z.array(z.string().min(1)).default([]),
  /** Read-only SQL enforcement for query_database. */
  databaseReadOnly: z.boolean().default(true),
  maxToolCalls: z.number().int().positive().optional(),
});
export type RolePermissions = z.infer<typeof rolePermissionsSchema>;

/** Placeholders substituted with concrete paths when a run is configured. */
export const PATH_TOKEN_LEGACY = '{legacyRoot}';
export const PATH_TOKEN_MODERN = '{modernRoot}';
export const PATH_TOKEN_ARTIFACTS = '{artifactRoot}';
export const PATH_TOKEN_WORKSPACE = '{workspaceRoot}';

export const PATH_TOKENS = [
  PATH_TOKEN_LEGACY,
  PATH_TOKEN_MODERN,
  PATH_TOKEN_ARTIFACTS,
  PATH_TOKEN_WORKSPACE,
] as const;

/** Read-only inspection of a repository: no writes, no arbitrary commands, no network. */
const readRepositoryRole = (
  role: AgentRole,
  extra: Partial<RolePermissions> = {},
): RolePermissions =>
  rolePermissionsSchema.parse({
    role,
    tools: [...READ_ONLY_TOOLS, 'query_database'],
    readRoots: [PATH_TOKEN_LEGACY, PATH_TOKEN_ARTIFACTS],
    writeRoots: [],
    commandPatterns: [],
    httpTargets: [],
    databaseTargets: ['legacy'],
    databaseReadOnly: true,
    ...extra,
  });

/**
 * Default permission profile per role. These encode the brief's rule that, for example, the
 * Release Guardian may read evidence and execute tests but must never write application code.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<AgentRole, RolePermissions> = {
  archaeologist: readRepositoryRole('archaeologist'),

  'business-rule-analyst': readRepositoryRole('business-rule-analyst'),

  'invariant-analyst': readRepositoryRole('invariant-analyst'),

  'characterization-engineer': rolePermissionsSchema.parse({
    role: 'characterization-engineer',
    tools: [...READ_ONLY_TOOLS, 'run_command', 'run_tests', 'query_database', 'http_request', 'write_file'],
    readRoots: [PATH_TOKEN_LEGACY, PATH_TOKEN_ARTIFACTS, PATH_TOKEN_WORKSPACE],
    writeRoots: [`${PATH_TOKEN_ARTIFACTS}/characterization`, `${PATH_TOKEN_WORKSPACE}/characterization`],
    commandPatterns: [
      '^mvn (-o )?(-q )?-DskipTests package$',
      '^(bash|sh) ./run\\.sh$',
      '^(bash|sh) ./stop\\.sh$',
      '^curl .+',
      '^node .+',
    ],
    httpTargets: ['http://localhost:8080/', 'http://127.0.0.1:8080/'],
    databaseTargets: ['legacy'],
    databaseReadOnly: false,
  }),

  architect: rolePermissionsSchema.parse({
    role: 'architect',
    tools: [...READ_ONLY_TOOLS, 'query_database', 'write_file'],
    readRoots: [PATH_TOKEN_LEGACY, PATH_TOKEN_ARTIFACTS],
    writeRoots: [`${PATH_TOKEN_ARTIFACTS}/design`],
    databaseTargets: ['legacy'],
    databaseReadOnly: true,
  }),

  modernizer: rolePermissionsSchema.parse({
    role: 'modernizer',
    tools: [
      ...READ_ONLY_TOOLS,
      'write_file',
      'apply_patch',
      'run_command',
      'run_tests',
      'query_database',
      'http_request',
    ],
    // The legacy repository is readable as a reference but is NEVER writable.
    readRoots: [PATH_TOKEN_LEGACY, PATH_TOKEN_ARTIFACTS, PATH_TOKEN_MODERN, PATH_TOKEN_WORKSPACE],
    writeRoots: [PATH_TOKEN_MODERN, `${PATH_TOKEN_ARTIFACTS}/implementation`],
    commandPatterns: ['^pnpm .+', '^npm .+', '^node .+', '^tsx .+', '^tsc .+', '^mvn .+', '^git (status|diff|log|add|commit) .+'],
    httpTargets: ['http://localhost:8080/', 'http://127.0.0.1:8080/', 'http://localhost:8090/', 'http://127.0.0.1:8090/'],
    databaseTargets: ['legacy', 'modern'],
    databaseReadOnly: false,
  }),

  adversary: rolePermissionsSchema.parse({
    role: 'adversary',
    tools: [...READ_ONLY_TOOLS, 'run_command', 'run_tests', 'query_database', 'http_request', 'write_file'],
    readRoots: [PATH_TOKEN_LEGACY, PATH_TOKEN_ARTIFACTS, PATH_TOKEN_MODERN, PATH_TOKEN_WORKSPACE],
    writeRoots: [`${PATH_TOKEN_ARTIFACTS}/adversarial`, `${PATH_TOKEN_WORKSPACE}/adversarial`],
    commandPatterns: ['^node .+', '^tsx .+', '^curl .+', '^(bash|sh) .+'],
    httpTargets: [
      'http://localhost:8080/',
      'http://127.0.0.1:8080/',
      'http://localhost:8090/',
      'http://127.0.0.1:8090/',
    ],
    databaseTargets: ['legacy', 'modern'],
    databaseReadOnly: false,
  }),

  'differential-verifier': rolePermissionsSchema.parse({
    role: 'differential-verifier',
    tools: [...READ_ONLY_TOOLS, 'run_command', 'run_tests', 'query_database', 'http_request', 'write_file'],
    readRoots: [PATH_TOKEN_LEGACY, PATH_TOKEN_ARTIFACTS, PATH_TOKEN_MODERN, PATH_TOKEN_WORKSPACE],
    writeRoots: [`${PATH_TOKEN_ARTIFACTS}/verification`, `${PATH_TOKEN_WORKSPACE}/verification`],
    commandPatterns: ['^node .+', '^tsx .+', '^curl .+', '^pnpm .+'],
    httpTargets: [
      'http://localhost:8080/',
      'http://127.0.0.1:8080/',
      'http://localhost:8090/',
      'http://127.0.0.1:8090/',
    ],
    databaseTargets: ['legacy', 'modern'],
    databaseReadOnly: true,
  }),

  diagnostician: rolePermissionsSchema.parse({
    role: 'diagnostician',
    tools: [...READ_ONLY_TOOLS, 'query_database', 'write_file'],
    readRoots: [PATH_TOKEN_LEGACY, PATH_TOKEN_ARTIFACTS, PATH_TOKEN_MODERN],
    writeRoots: [`${PATH_TOKEN_ARTIFACTS}/diagnosis`],
    databaseTargets: ['legacy', 'modern'],
    databaseReadOnly: true,
  }),

  'release-guardian': rolePermissionsSchema.parse({
    role: 'release-guardian',
    // Reads evidence and executes tests. Explicitly no write_file / apply_patch:
    // the agent that decides whether to release must be unable to change what it is judging.
    tools: [...READ_ONLY_TOOLS, 'run_tests', 'run_command', 'query_database'],
    readRoots: [PATH_TOKEN_ARTIFACTS, PATH_TOKEN_LEGACY, PATH_TOKEN_MODERN, PATH_TOKEN_WORKSPACE],
    writeRoots: [`${PATH_TOKEN_ARTIFACTS}/release`],
    commandPatterns: ['^pnpm (test|vitest) .*', '^node .+', '^tsx .+'],
    databaseTargets: ['legacy', 'modern'],
    databaseReadOnly: true,
  }),

  // The orchestrator is deterministic code: it holds no tools of its own.
  orchestrator: rolePermissionsSchema.parse({
    role: 'orchestrator',
    tools: [],
    readRoots: [],
    writeRoots: [],
    commandPatterns: [],
    httpTargets: [],
    databaseTargets: [],
    databaseReadOnly: true,
  }),
};

export const stageRoleSchema = z.object({
  role: agentRoleSchema,
  permissions: rolePermissionsSchema,
});
export type StageRole = z.infer<typeof stageRoleSchema>;

export function defaultPermissionsFor(role: AgentRole): RolePermissions {
  return DEFAULT_ROLE_PERMISSIONS[role];
}

import { rolePermissionsSchema, type AgentTask, type RolePermissions, type ToolName } from '@phoenix/shared';

/**
 * Effective permissions for one task.
 *
 * A task can only ever *narrow* its role profile: `allowedTools` is intersected with the tools the
 * role was granted, and the tool budget is the tighter of the task budget and the profile limit.
 * Anything a task asks for that its role does not have is reported back rather than dropped
 * silently, because a misconfigured stage should be visible in the transcript.
 */

export interface EffectivePermissions {
  permissions: RolePermissions;
  /** Tools the task listed but the role profile does not grant. Never executed. */
  ungrantedTools: ToolName[];
  /** The tool-call ceiling actually enforced by the tool layer for this task. */
  maxToolCalls: number;
}

export function effectivePermissions(task: AgentTask): EffectivePermissions {
  const granted = new Set(task.permissions.tools);
  const tools = task.allowedTools.filter((tool) => granted.has(tool));
  const ungrantedTools = task.allowedTools.filter((tool) => !granted.has(tool));
  const profileLimit = task.permissions.maxToolCalls;
  const maxToolCalls =
    profileLimit === undefined ? task.budget.maxToolCalls : Math.min(profileLimit, task.budget.maxToolCalls);

  const permissions = rolePermissionsSchema.parse({
    ...task.permissions,
    tools,
    maxToolCalls,
  });
  return { permissions, ungrantedTools, maxToolCalls };
}

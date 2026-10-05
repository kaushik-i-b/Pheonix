import { TOOL_SPECIFICATIONS } from '@phoenix/repository-tools';
import type { AgentTask, RolePermissions } from '@phoenix/shared';

/**
 * The part of the system message that is derived from the task rather than written in a prompt
 * file. Tools, budgets, constraints and acceptance criteria are facts about this execution, so
 * they are rendered from the task record: a prompt file that restated them could drift, and a
 * drifted contract is worse than no contract.
 */
export function renderContractBlock(task: AgentTask, permissions: RolePermissions): string {
  const lines: string[] = [];
  lines.push('## Operating contract');
  lines.push('');
  lines.push(
    `Task ${task.taskId} · run ${task.runId} · stage ${task.stage} · role ${task.role} · attempt ${task.attempt}` +
      (task.repairIteration > 0 ? ` · repair iteration ${task.repairIteration}` : ''),
  );
  lines.push('');

  lines.push('### Tools');
  if (permissions.tools.length === 0) {
    lines.push('You have no tools for this task. Reason from the material given to you and say what you cannot know.');
  } else {
    for (const tool of permissions.tools) {
      lines.push(`- \`${tool}\`: ${TOOL_SPECIFICATIONS[tool].description}`);
    }
    lines.push('');
    lines.push(
      'Tool calls are executed by a controlled layer. Anything outside this list, outside your permitted paths, ' +
        'or outside your command allowlist is refused, and the refusal is recorded against this task. Do not try to route around it.',
    );
  }
  lines.push('');

  lines.push('### Budget');
  lines.push(
    `- ${task.budget.maxSteps} model calls in total. Every reply you send is one of them, whether it asks for tools or answers.`,
  );
  lines.push(
    `- the last of those calls is reserved for your final answer: you will be told when it arrives, and you will not be able to use tools in it`,
  );
  lines.push(
    `- at most ${task.budget.maxToolCalls} tool calls, ${Math.round(task.budget.timeoutMs / 1000)} seconds`,
  );
  if (task.budget.maxTokens !== undefined) lines.push(`- at most ${task.budget.maxTokens} tokens`);
  lines.push('- a task that runs out of budget is recorded as cut short, not as finished');
  lines.push('');

  const hard = task.constraints.filter((constraint) => constraint.enforcement === 'architectural');
  const soft = task.constraints.filter((constraint) => constraint.enforcement === 'prompt');
  if (hard.length > 0) {
    lines.push('### Constraints enforced by the runtime');
    for (const constraint of hard) lines.push(`- ${constraint.statement}`);
    lines.push('');
  }
  if (soft.length > 0) {
    lines.push('### Constraints you are asked to honour');
    for (const constraint of soft) lines.push(`- ${constraint.statement}`);
    lines.push('');
  }

  if (task.acceptanceCriteria.length > 0) {
    lines.push('### How this task will be judged');
    lines.push(
      'Acceptance is evaluated by deterministic code over the artifacts and results you produce. ' +
        'You cannot approve your own work, and stating that a criterion is met has no effect on it.',
    );
    for (const criterion of task.acceptanceCriteria) {
      lines.push(`- ${criterion.id}: ${criterion.description}`);
    }
    lines.push('');
  }

  lines.push('### Evidence discipline');
  lines.push('- every claim carries at least one evidence reference: a source location, an artifact id, a quote, or an observation');
  lines.push('- a quote must be text that actually appears in the file you cite, because it is checked');
  lines.push('- label each claim OBSERVED (you read or ran it), INFERRED (you reasoned it out) or UNKNOWN (you could not establish it)');
  lines.push('- record what you could not establish instead of filling the gap with something plausible');
  lines.push('- never report success; the runtime computes the outcome from your artifacts');
  lines.push('');

  lines.push('### Finishing');
  lines.push(
    'Investigate with tools while you have calls left, and stop investigating before the reserved one: producing ' +
      'an answer takes a call, and a call spent on another tool cannot be spent answering. ' +
      'When you are done — or when the final-call instruction arrives — reply with ONLY the final JSON value ' +
      'described in the task. No prose before or after it, no code fences, no commentary. ' +
      'If your reply is rejected, you will be told exactly which fields failed validation.',
  );
  return lines.join('\n');
}

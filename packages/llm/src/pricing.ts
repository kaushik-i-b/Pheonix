import { readFileSync } from 'node:fs';
import {
  PhoenixError,
  llmPricingTableSchema,
  type LlmPricingTable,
} from '@phoenix/shared';

/**
 * Optional pricing table. When it is missing, Phoenix records token usage and reports cost as
 * unknown. Inventing a cost figure would be worse than admitting the gap.
 */
export function loadPricingTable(
  path: string | undefined,
  options: { onWarn?: (message: string, details?: Record<string, unknown>) => void } = {},
): LlmPricingTable | undefined {
  if (path === undefined) return undefined;
  let content: string;
  try {
    content = readFileSync(path, 'utf8');
  } catch (error) {
    options.onWarn?.(`pricing table not readable at ${path}; cost will be reported as unknown`, {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new PhoenixError('CONFIG_INVALID', `pricing table at ${path} is not valid JSON`, { path }, error);
  }
  const result = llmPricingTableSchema.safeParse(parsed);
  if (!result.success) {
    throw new PhoenixError('CONFIG_INVALID', `pricing table at ${path} is invalid: ${result.error.message}`, {
      path,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }
  return result.data;
}

import { PhoenixError } from '@phoenix/shared';

/**
 * Patch application.
 *
 * Deviation from the brief's wording, documented here and in docs/architecture.md: `apply_patch`
 * takes a list of exact find/replace operations rather than a unified diff. A unified-diff applier
 * is fragile against files an LLM has only partially seen, and "fuzzy" matching is exactly the kind
 * of silent approximation Phoenix must not do. Exact matching with an explicit occurrence count
 * fails loudly when the model's view of the file is stale, which is the correct outcome: the agent
 * must re-read the file instead of guessing.
 */

export interface PatchOperation {
  find: string;
  replace: string;
  /** Apply to every occurrence instead of requiring exactly one. */
  replaceAll?: boolean;
  /** Required number of occurrences; defaults to 1 unless `replaceAll` is set. */
  expectedCount?: number;
}

export interface PatchResult {
  content: string;
  operationsApplied: number;
  replacements: number;
}

/**
 * Literal replacement. `String.prototype.replace` would interpret `$&` and friends in the new text
 * as substitution patterns; patched source code is data, not a regex replacement template.
 */
export function replaceLiteral(content: string, find: string, replace: string, limit = Number.POSITIVE_INFINITY): string {
  let result = '';
  let cursor = 0;
  let replaced = 0;
  let index = find.length === 0 ? -1 : content.indexOf(find);
  while (index !== -1 && replaced < limit) {
    result += content.slice(cursor, index) + replace;
    cursor = index + find.length;
    replaced += 1;
    index = content.indexOf(find, cursor);
  }
  return result + content.slice(cursor);
}

export function countOccurrences(content: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = content.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = content.indexOf(needle, index + needle.length);
  }
  return count;
}

export function applyPatchOperations(content: string, operations: readonly PatchOperation[]): PatchResult {
  let current = content;
  let replacements = 0;
  let applied = 0;

  for (const [index, operation] of operations.entries()) {
    if (operation.find.length === 0) {
      throw new PhoenixError('TOOL_EXECUTION_FAILED', `patch operation ${index} has an empty "find"`, { index });
    }
    const found = countOccurrences(current, operation.find);
    if (operation.replaceAll === true) {
      if (found === 0) {
        throw new PhoenixError(
          'TOOL_EXECUTION_FAILED',
          `patch operation ${index} matched nothing; the file has changed since it was read`,
          { index, found: 0, find: operation.find.slice(0, 200) },
        );
      }
      current = replaceLiteral(current, operation.find, operation.replace);
      replacements += found;
      applied += 1;
      continue;
    }

    const expected = operation.expectedCount ?? 1;
    if (found !== expected) {
      throw new PhoenixError(
        'TOOL_EXECUTION_FAILED',
        `patch operation ${index} matched ${found} occurrence(s) but expected ${expected}; refusing to guess`,
        { index, found, expected, find: operation.find.slice(0, 200) },
      );
    }
    current = replaceLiteral(current, operation.find, operation.replace, expected);
    replacements += found;
    applied += 1;
  }

  return { content: current, operationsApplied: applied, replacements };
}

import { z } from 'zod';

/**
 * Typed failures. Phoenix never swallows exceptions: every failure that reaches a boundary is
 * converted into one of these codes so it can be persisted, displayed and reasoned about.
 */

export const phoenixErrorCodeSchema = z.enum([
  'CONFIG_INVALID',
  'SCHEMA_VALIDATION_FAILED',
  'LLM_NOT_CONFIGURED',
  'LLM_REQUEST_FAILED',
  'LLM_INVALID_RESPONSE',
  'LLM_TIMEOUT',
  'LLM_RATE_LIMITED',
  /**
   * The model reached its token budget before producing an answer — typical of reasoning models,
   * which spend the budget thinking. Deliberately absent from `retryableCodes`: the same request
   * with the same budget fails the same way, so retrying only burns wall-clock time.
   */
  'LLM_OUTPUT_TRUNCATED',
  'PROMPT_NOT_FOUND',
  'PROMPT_VARIABLE_MISSING',
  'TOOL_NOT_ALLOWED',
  'TOOL_PATH_OUT_OF_SCOPE',
  'TOOL_COMMAND_NOT_ALLOWED',
  'TOOL_TARGET_NOT_ALLOWED',
  'TOOL_EXECUTION_FAILED',
  'TOOL_TIMEOUT',
  'TOOL_BUDGET_EXCEEDED',
  'SANDBOX_COMMAND_DENIED',
  'SANDBOX_TIMEOUT',
  'SANDBOX_OUTPUT_TOO_LARGE',
  'ARTIFACT_NOT_FOUND',
  'ARTIFACT_SCHEMA_INVALID',
  'ARTIFACT_WRITE_FAILED',
  'ARTIFACT_TAMPERED',
  'SYSTEM_UNREACHABLE',
  'SCENARIO_EXECUTION_FAILED',
  'DATABASE_QUERY_FAILED',
  'AGENT_STEP_LIMIT',
  'AGENT_BUDGET_EXCEEDED',
  'AGENT_TIMEOUT',
  'STAGE_FAILED',
  'STAGE_TIMEOUT',
  'REPAIR_BUDGET_EXHAUSTED',
  'REPAIR_NO_PROGRESS',
  'VERIFICATION_INCONCLUSIVE',
  'EVIDENCE_INCOMPLETE',
  'RELEASE_REJECTED',
  'INTERNAL',
]);
export type PhoenixErrorCode = z.infer<typeof phoenixErrorCodeSchema>;

export interface PhoenixErrorDetail {
  [key: string]: unknown;
}

export class PhoenixError extends Error {
  override readonly name = 'PhoenixError';

  constructor(
    readonly code: PhoenixErrorCode,
    message: string,
    readonly details: PhoenixErrorDetail = {},
    override readonly cause?: unknown,
  ) {
    super(message);
  }

  toJSON(): { code: PhoenixErrorCode; message: string; details: PhoenixErrorDetail } {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function isPhoenixError(value: unknown): value is PhoenixError {
  return value instanceof PhoenixError;
}

export function toPhoenixError(value: unknown, fallbackCode: PhoenixErrorCode): PhoenixError {
  if (isPhoenixError(value)) return value;
  if (value instanceof Error) {
    return new PhoenixError(fallbackCode, value.message, { name: value.name, stack: value.stack }, value);
  }
  return new PhoenixError(fallbackCode, String(value), {}, value);
}

/** Serializes any thrown value into a bounded, persistable shape. */
export function describeError(value: unknown): {
  code: PhoenixErrorCode;
  message: string;
  details: PhoenixErrorDetail;
} {
  const error = toPhoenixError(value, 'INTERNAL');
  const message = error.message.slice(0, 4000);
  const details: PhoenixErrorDetail = {};
  for (const [key, entry] of Object.entries(error.details)) {
    details[key] = typeof entry === 'string' ? entry.slice(0, 4000) : entry;
  }
  return { code: error.code, message, details };
}

export const retryableCodes: readonly PhoenixErrorCode[] = [
  'LLM_REQUEST_FAILED',
  'LLM_TIMEOUT',
  'LLM_RATE_LIMITED',
  'LLM_INVALID_RESPONSE',
  'SYSTEM_UNREACHABLE',
  'TOOL_TIMEOUT',
  'TOOL_EXECUTION_FAILED',
] as const;

export function isRetryableCode(code: PhoenixErrorCode): boolean {
  return (retryableCodes as readonly string[]).includes(code);
}

import {
  PhoenixError,
  stableStringify,
  type AssertionResult,
  type CharacterizationAssertion,
  type ScenarioExecution,
  type StepOutcome,
} from '@phoenix/shared';
import { getByPath } from './template.js';

/**
 * Deciding whether a captured expectation still holds.
 *
 * One implementation judges both the legacy baseline — a self-check that the capture really is the
 * contract — and the modern execution, which is the differential verdict. "Equivalent" therefore
 * means the same thing whichever system produced the values, and there is no code path where the
 * modern system is compared more leniently than legacy was.
 *
 * Comparison is structural and exact. A normalized assertion is evaluated like any other; its
 * result is merely *labelled* normalized, so the caller can report the difference without counting
 * it as a failure and without losing the two values that differed. Nothing here rounds, coerces or
 * trims a value to make two systems agree: a tolerance has to have been recorded in the assertion.
 */

/** Deep equality over JSON-shaped values, keyed so `{a,b}` and `{b,a}` are equal. */
export function sameValue(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  return stableStringify(left) === stableStringify(right);
}

export interface CaseEvaluation {
  caseId: string;
  /** True when every assertion that host policy does not excuse was satisfied. */
  passed: boolean;
  results: AssertionResult[];
  /** Assertions that differed on a path host policy excused; reported, never counted as failures. */
  normalizedMismatches: AssertionResult[];
  /** Steps the execution never reached, so every assertion about them is unsatisfied. */
  missingStepIds: string[];
}

/**
 * The part of a case the evaluator needs. Kept structural so a case can be judged *before* it is
 * finalised — which is exactly when the capture self-check has to run.
 */
export interface EvaluableCase {
  caseId: string;
  assertions: readonly CharacterizationAssertion[];
}

export function evaluateAssertion(
  assertion: CharacterizationAssertion,
  execution: ScenarioExecution,
): AssertionResult {
  const outcome = execution.steps.find((step) => step.stepId === assertion.stepId);
  const base = {
    assertionId: assertion.assertionId,
    normalized: assertion.normalized,
    expected: assertion.expected,
    ...(assertion.path !== undefined ? { path: assertion.path } : {}),
  };

  if (outcome === undefined) {
    return {
      ...base,
      satisfied: false,
      message: `step ${assertion.stepId} did not run: the execution ended before reaching it`,
    };
  }

  const actual = actualValue(assertion, outcome);
  if (actual === MISSING) {
    return {
      ...base,
      satisfied: false,
      message: `${assertion.stepId}.${assertion.path ?? '<outcome>'} is absent from this execution`,
    };
  }

  const satisfied = compare(actual, assertion.expected, assertion.tolerance);
  return {
    ...base,
    actual,
    satisfied,
    ...(satisfied ? {} : { message: describeMismatch(assertion, actual) }),
  };
}

export function evaluateCase(
  item: EvaluableCase,
  execution: ScenarioExecution,
): CaseEvaluation {
  const outcomes = new Map(execution.steps.map((step) => [step.stepId, step]));
  const results = item.assertions.map((assertion) => evaluateAssertion(assertion, execution));
  const normalizedMismatches = results.filter((result) => result.normalized && !result.satisfied);
  const live = results.filter((result) => !result.normalized);
  return {
    caseId: item.caseId,
    passed: live.every((result) => result.satisfied),
    results,
    normalizedMismatches,
    missingStepIds: [...new Set(item.assertions.map((a) => a.stepId))].filter(
      (stepId) => !outcomes.has(stepId),
    ),
  };
}

/** Sentinel distinguishing "absent" from a captured `undefined`, which JSON cannot represent anyway. */
const MISSING = Symbol('missing');

function actualValue(
  assertion: CharacterizationAssertion,
  outcome: StepOutcome,
): unknown {
  switch (assertion.kind) {
    case 'http-status':
      return outcome.httpStatus === undefined ? MISSING : outcome.httpStatus;
    case 'row-count':
      return outcome.rowCount === undefined ? MISSING : outcome.rowCount;
    case 'exit-code':
      return outcome.exitCode === undefined ? MISSING : outcome.exitCode;
    case 'error-present':
      return outcome.status;
    case 'json-value':
    case 'text-value': {
      if (assertion.path === undefined) return MISSING;
      const value = getByPath(outcome, assertion.path);
      return value === undefined ? MISSING : value;
    }
    default:
      throw new PhoenixError(
        'INTERNAL',
        `assertion kind "${assertion.kind as string}" is not produced by capture and cannot be evaluated`,
        { assertionId: assertion.assertionId, kind: assertion.kind },
      );
  }
}

function compare(actual: unknown, expected: unknown, tolerance: number | undefined): boolean {
  if (tolerance !== undefined && typeof actual === 'number' && typeof expected === 'number') {
    return Math.abs(actual - expected) <= tolerance;
  }
  return sameValue(actual, expected);
}

function describeMismatch(assertion: CharacterizationAssertion, actual: unknown): string {
  if (assertion.tolerance !== undefined && typeof actual === 'number' && typeof assertion.expected === 'number') {
    return `${render(actual)} differs from ${render(assertion.expected)} by more than ±${assertion.tolerance}`;
  }
  return `${render(actual)} differs from captured ${render(assertion.expected)}`;
}

function render(value: unknown): string {
  if (value === MISSING || value === undefined) return 'absent';
  if (value === null) return 'null';
  const text = typeof value === 'string' ? `"${value}"` : stableStringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

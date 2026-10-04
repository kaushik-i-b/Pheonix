import type { z } from 'zod';
import {
  characterizationAssertionSchema,
  stableStringify,
  type CharacterizationAssertion,
  type ScenarioExecution,
} from '@phoenix/shared';
import { getByPath, leafPaths } from './template.js';
import { classifyVolatilePaths, isTransportHeader } from './nondeterminism.js';
import { sameValue } from './evaluate.js';

/**
 * Turning an execution into assertions.
 *
 * The suite is *captured*, never authored: every expected value in it is a value the legacy system
 * actually returned, read back out of the recorded execution. No agent supplies an expectation, and
 * nothing here invents one — a path the capture does not contain produces no assertion.
 *
 * Each scenario is executed twice. The first execution is the baseline; the second exists only to
 * find out which values legacy itself will not reproduce. Those are the only candidates for
 * normalization, and only the ones host policy recognises as identifiers, clock readings or
 * durations are actually excused. See `nondeterminism.ts` for why both conditions are required.
 */

export interface CaptureInput {
  caseId: string;
  /** The execution whose values become the expected values. */
  baseline: ScenarioExecution;
  /** A second execution of the same scenario, used only to detect volatility. */
  probe: ScenarioExecution;
  targetRuleIds: readonly string[];
  targetInvariantIds: readonly string[];
  /** Cap on assertions derived from one execution, so a large body cannot swamp the suite. */
  maxAssertions?: number;
}

export interface CaptureResult {
  assertions: CharacterizationAssertion[];
  /** Excused paths, with the policy reason and the two values that disagreed. */
  normalized: { path: string; stepId: string; reason: string; observedValues: [unknown, unknown] }[];
  /** Paths that varied but are still compared, because policy does not recognise them as noise. */
  unexplainedVolatility: string[];
  /** Assertions dropped because `maxAssertions` was reached. */
  truncated: number;
}

const DEFAULT_MAX_ASSERTIONS = 400;
/**
 * What the capture may supply. `assertionId` is minted here and the two `source*` lists come from the
 * case, so neither is a parameter of `add` — and `normalized` is only ever set by the volatility pass
 * below, never by a caller.
 */
type CapturedAssertion = Omit<
  z.input<typeof characterizationAssertionSchema>,
  'assertionId' | 'sourceRuleIds' | 'sourceInvariantIds' | 'normalized' | 'normalization'
>;

export function deriveAssertions(input: CaptureInput): CaptureResult {
  const max = input.maxAssertions ?? DEFAULT_MAX_ASSERTIONS;
  const assertions: CharacterizationAssertion[] = [];
  const normalized: CaptureResult['normalized'] = [];
  const volatilePaths = new Set<string>();
  const observed = new Map<string, [unknown, unknown]>();
  let truncated = 0;

  const probeSteps = new Map(input.probe.steps.map((step) => [step.stepId, step]));

  for (const step of input.baseline.steps) {
    const counterpart = probeSteps.get(step.stepId);
    const add = (assertion: CapturedAssertion): void => {
      if (assertions.length >= max) {
        truncated += 1;
        return;
      }
      assertions.push(
        characterizationAssertionSchema.parse({
          ...assertion,
          assertionId: `${input.caseId}-a${assertions.length + 1}`,
          sourceRuleIds: input.targetRuleIds,
          sourceInvariantIds: input.targetInvariantIds,
        }),
      );
    };

    if (step.httpStatus !== undefined) {
      const key = `${step.stepId}.httpStatus`;
      recordVolatility(key, step.httpStatus, counterpart?.httpStatus, volatilePaths, observed);
      add({
        description: `${step.stepId} responds with HTTP ${step.httpStatus}`,
        kind: 'http-status',
        stepId: step.stepId,
        path: 'httpStatus',
        expected: step.httpStatus,
      });
    }

    if (step.responseBody !== undefined) {
      const kind: CharacterizationAssertion['kind'] = isStructured(step.responseBody) ? 'json-value' : 'text-value';
      for (const leaf of leafPaths(step.responseBody, 'responseBody')) {
        const key = `${step.stepId}.${leaf}`;
        const value = getByPath(step, leaf);
        const other = counterpart === undefined ? MISSING : getByPath(counterpart, leaf);
        recordVolatility(key, value, other, volatilePaths, observed);
        add({
          description: `${step.stepId} returns ${trimPath(leaf)} = ${preview(value)}`,
          kind,
          stepId: step.stepId,
          path: leaf,
          expected: value,
        });
      }
    }

    for (const [header, value] of Object.entries(step.responseHeaders)) {
      if (isTransportHeader(header)) continue;
      const path = `responseHeaders.${header}`;
      const qualified = `${step.stepId}.${path}`;
      recordVolatility(qualified, value, counterpart?.responseHeaders[header], volatilePaths, observed);
      add({
        description: `${step.stepId} responds with header ${header}`,
        kind: 'text-value',
        stepId: step.stepId,
        path,
        expected: value,
      });
    }

    if (step.rowCount !== undefined) {
      const qualified = `${step.stepId}.rowCount`;
      recordVolatility(qualified, step.rowCount, counterpart?.rowCount, volatilePaths, observed);
      add({
        description: `${step.stepId} returns ${step.rowCount} row(s)`,
        kind: 'row-count',
        stepId: step.stepId,
        path: 'rowCount',
        expected: step.rowCount,
      });
    }

    if (step.exitCode !== undefined) {
      add({
        description: `${step.stepId} exits with ${step.exitCode}`,
        kind: 'exit-code',
        stepId: step.stepId,
        path: 'exitCode',
        expected: step.exitCode,
      });
    }

    if (step.status !== 'ok') {
      add({
        description: `${step.stepId} ends ${step.status}`,
        kind: 'error-present',
        stepId: step.stepId,
        path: 'status',
        expected: step.status,
      });
    }
  }

  const { normalizable, unexplained } = classifyVolatilePaths(volatilePaths);
  for (const assertion of assertions) {
    const qualified = `${assertion.stepId}.${assertion.path ?? ''}`;
    const reason = normalizable.get(qualified);
    if (reason === undefined) continue;
    const values = observed.get(qualified) ?? [assertion.expected, assertion.expected];
    assertion.normalized = true;
    assertion.normalization = {
      reason: 'varied-across-repeated-legacy-executions',
      policy: reason,
      observedValues: values,
    };
    normalized.push({ path: assertion.path ?? '', stepId: assertion.stepId, reason, observedValues: values });
  }

  return { assertions, normalized, unexplainedVolatility: unexplained, truncated };
}

/**
 * Sentinel for "the second execution had nothing here", which is itself a difference.
 *
 * Call sites that read an optional field off a counterpart step get `undefined` for both "the step
 * never ran" and "the step ran and had no such field". Treating those differently would let a
 * scenario that only half-executed the second time look stable at every path after the failure.
 */
const MISSING = Symbol('missing');

function recordVolatility(
  key: string,
  baseline: unknown,
  probe: unknown,
  volatilePaths: Set<string>,
  observed: Map<string, [unknown, unknown]>,
): void {
  const absent = probe === MISSING || (probe === undefined && baseline !== undefined);
  if (absent || !sameValue(baseline, probe)) {
    volatilePaths.add(key);
    observed.set(key, [baseline, absent ? null : probe]);
  }
}

function isStructured(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

/** `responseBody.accounts.3.balance` reads better in a report than the step-qualified internal key. */
function trimPath(path: string): string {
  return path.replace(/^responseBody\./, '').replace(/^responseBody$/, '<body>');
}

function preview(value: unknown): string {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  const text = typeof value === 'string' ? `"${value}"` : stableStringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The scenario's own record of which of its values legacy would not reproduce. */
export function normalizedPathsOf(result: CaptureResult): string[] {
  return result.normalized.map((entry) => entry.path);
}

import type { z } from 'zod';
import {
  PhoenixError,
  stepOutcomeSchema,
  type Scenario,
  type ScenarioExecution,
  type ScenarioStep,
  type StepOutcome,
  type SystemLabel,
} from '@phoenix/shared';
import { substitute } from './template.js';

/**
 * Running a scenario against one system and recording what actually happened.
 *
 * The executor is deliberately dumb. It does not know what a fee is, what a balance should be, or
 * whether the response it just received was correct — it performs the steps, records the raw
 * results, and reports transport-level failure separately from an answer the system gave. A `400`
 * with a JSON error body is a *completed* execution: that is legacy behavior, and characterizing it
 * is the whole point. Only a scenario that could not be performed at all — unreachable host,
 * timeout, a step kind this target has no runner for — is an `error`.
 *
 * Nothing here normalizes, filters or rounds. Capture first, compare later: a value that looks like
 * noise to one reader is the mismatch another reader was looking for.
 */

export interface ScenarioTarget {
  system: SystemLabel;
  label: string;
  /** Every http step's path is resolved against this, so one scenario runs on both systems. */
  baseUrl: string;
  /** Runner for `sql` and `assert-db` steps; without one those steps are recorded as errors. */
  query?: (statement: string, params: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
  /** Runner for `command` steps. */
  runCommand?: (argv: readonly string[], cwd: string | undefined, timeoutMs: number) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
  /** Runner for `reset` steps; a target that cannot be reset says so rather than pretending. */
  reset?: () => Promise<void>;
  /** Post-execution state used for invariant checks (balances, ledger sums, row counts). */
  snapshot?: () => Promise<Record<string, unknown>>;
}

export interface ExecutorOptions {
  defaultTimeoutMs?: number;
  signal?: AbortSignal;
  /** Called after each step so a long scenario can report progress into the event log. */
  onStep?: (outcome: StepOutcome) => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 4_000_000;
/** Mirrors `stepOutcomeSchema.shape.error`'s max; exceeding it would fail the parse in `finish`. */
const MAX_ERROR_CHARS = 4000;
/** The outcome a step may hand back before the schema fills in its defaults. */
type StepOutcomeInput = z.input<typeof stepOutcomeSchema>;

export async function executeScenario(
  scenario: Scenario,
  target: ScenarioTarget,
  options: ExecutorOptions = {},
): Promise<ScenarioExecution> {
  const startedAt = new Date();
  const captured: Record<string, unknown> = {};
  const outcomes: StepOutcome[] = [];
  let status: ScenarioExecution['status'] = 'completed';
  let failure: string | undefined;

  const phases: { phase: 'setup' | 'steps' | 'teardown'; steps: readonly ScenarioStep[] }[] = [
    { phase: 'setup', steps: scenario.setup },
    { phase: 'steps', steps: scenario.steps },
    { phase: 'teardown', steps: scenario.teardown },
  ];

  for (const { phase, steps } of phases) {
    for (const step of steps) {
      if (options.signal?.aborted) {
        status = 'timeout';
        failure = failure ?? `run aborted during ${phase}`;
        break;
      }
      const outcome = await runStep(step, target, captured, options);
      outcomes.push(outcome);
      options.onStep?.(outcome);
      if (outcome.status === 'ok') continue;
      // A step the scenario does not require may fail without ending the run; the failure is still
      // recorded, because what a system does with an optional step is also behavior.
      if (!step.required) continue;
      // A step the scenario depends on did not happen. The steps after it would be measuring
      // something the scenario never asked for, so the run stops here and says why.
      status = outcome.status === 'timeout' ? 'timeout' : outcome.status === 'unreachable' ? 'unreachable' : 'failed';
      failure = `${phase} step ${step.stepId} ended ${outcome.status}${
        outcome.error === undefined ? '' : `: ${outcome.error}`
      }`;
      break;
    }
    if (status !== 'completed') break;
  }

  let stateSnapshot: Record<string, unknown> = {};
  if (target.snapshot !== undefined && status !== 'unreachable') {
    try {
      stateSnapshot = await target.snapshot();
    } catch (error) {
      // The scenario ran; only the after-picture is missing. That is a gap in the evidence, not a
      // reason to throw away the behavior that was observed.
      stateSnapshot = { snapshotError: describe(error) };
    }
  }

  const finishedAt = new Date();
  return {
    scenarioId: scenario.scenarioId,
    system: target.system,
    baseUrl: target.baseUrl,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
    status,
    steps: outcomes,
    captured,
    stateSnapshot,
    ...(failure === undefined ? {} : { error: failure }),
  };
}

async function runStep(
  step: ScenarioStep,
  target: ScenarioTarget,
  captured: Record<string, unknown>,
  options: ExecutorOptions,
): Promise<StepOutcome> {
  const startedAt = new Date();
  const base = {
    stepId: step.stepId,
    kind: step.kind,
    startedAt: startedAt.toISOString(),
  };
  const finish = (
    partial: Omit<StepOutcomeInput, 'stepId' | 'kind' | 'status' | 'durationMs' | 'startedAt'> & {
      status: StepOutcome['status'];
    },
  ): StepOutcome => {
    // Parsed rather than asserted: this object is the evidence the whole differential verdict rests
    // on, so a step that would record something the schema cannot hold fails loudly here instead of
    // surfacing later as a capture nobody can trust.
    const outcome = stepOutcomeSchema.parse({
      ...base,
      ...partial,
      durationMs: Math.max(0, Date.now() - startedAt.getTime()),
    });
    if (step.captureAs !== undefined) captured[step.captureAs] = outcome;
    return outcome;
  };

  try {
    switch (step.kind) {
      case 'http':
        return finish(await runHttpStep(step, target, captured, options));
      case 'wait':
        await sleep(step.waitMs ?? 0, options.signal);
        return finish({ status: 'ok' });
      case 'reset':
        if (target.reset === undefined) {
          return finish({ status: 'error', error: `target ${target.label} has no reset runner configured` });
        }
        await target.reset();
        return finish({ status: 'ok' });
      case 'sql':
      case 'assert-db': {
        if (target.query === undefined || step.sql === undefined) {
          return finish({ status: 'error', error: `target ${target.label} has no database runner configured` });
        }
        const statement = substitute(step.sql.statement, captured);
        const params = step.sql.params.map((param) => substitute(param, captured));
        const result = await target.query(statement, params);
        return finish({ status: 'ok', rowCount: result.rowCount, rows: result.rows.slice(0, 200) });
      }
      case 'command': {
        if (target.runCommand === undefined || step.command === undefined) {
          return finish({ status: 'error', error: `target ${target.label} has no command runner configured` });
        }
        const argv = step.command.argv.map((arg) => substitute(arg, captured));
        const cwd = step.command.cwd === undefined ? undefined : substitute(step.command.cwd, captured);
        const timeoutMs = step.command.timeoutMs || (options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
        const result = await target.runCommand(argv, cwd, timeoutMs);
        return finish({
          status: result.exitCode === 0 ? 'ok' : 'failed',
          stdout: result.stdout.slice(0, 200_000),
          stderr: result.stderr.slice(0, 200_000),
          exitCode: result.exitCode,
        });
      }
    }
  } catch (error) {
    return finish({ status: 'error', error: describe(error) });
  }
}

async function runHttpStep(
  step: ScenarioStep,
  target: ScenarioTarget,
  captured: Record<string, unknown>,
  options: ExecutorOptions,
): Promise<Omit<StepOutcomeInput, 'stepId' | 'kind' | 'durationMs' | 'startedAt'>> {
  if (step.http === undefined) {
    // scenarioSchema's refinement already rejects an http step with no payload, so reaching this
    // means the scenario was built by hand and never parsed. Say that plainly rather than pretending
    // it is a runtime condition worth recovering from.
    throw new PhoenixError('INTERNAL', `step ${step.stepId} is http but carries no http payload`, {
      stepId: step.stepId,
    });
  }
  const request = step.http;
  const url = new URL(substitute(request.path, captured), target.baseUrl);
  for (const [key, value] of Object.entries(request.query)) {
    url.searchParams.set(key, String(substitute(value, captured)));
  }

  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) headers[key] = substitute(value, captured);
  let body: string | undefined;
  if (request.rawBody !== undefined) {
    body = substitute(request.rawBody, captured);
  } else if (request.body !== undefined) {
    body = JSON.stringify(substitute(request.body, captured));
    if (headers['content-type'] === undefined) headers['content-type'] = 'application/json';
  }

  const timeoutMs = request.timeoutMs || (options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  const abort = AbortSignal.any([
    AbortSignal.timeout(timeoutMs),
    ...(options.signal === undefined ? [] : [options.signal]),
  ]);

  let response: Response;
  try {
    response = await fetch(url, { method: request.method, headers, ...(body === undefined ? {} : { body }), signal: abort });
  } catch (error) {
    const timedOut = abort.reason instanceof Error && abort.reason.name === 'TimeoutError';
    return {
      status: timedOut ? 'timeout' : 'unreachable',
      error: timedOut ? `no response within ${timeoutMs}ms` : `${describe(error)} (url ${url.toString()})`,
    };
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });
  const raw = await readBody(response);
  return {
    status: 'ok',
    httpStatus: response.status,
    responseHeaders,
    responseBody: raw.json === undefined ? raw.text : raw.json,
  };
}

async function readBody(response: Response): Promise<{ json?: unknown; text: string }> {
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    return { text: `${text.slice(0, MAX_RESPONSE_BYTES)}[truncated ${text.length - MAX_RESPONSE_BYTES} bytes]` };
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('json')) return { text };
  try {
    return { json: JSON.parse(text) as unknown, text };
  } catch {
    // Advertised as JSON but not parseable. That is itself an observation worth recording verbatim.
    return { text };
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ms <= 0) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new PhoenixError('SCENARIO_EXECUTION_FAILED', `aborted while waiting ${ms}ms`, {}));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Bounded to what `stepOutcomeSchema` will hold, so a verbose transport error cannot fail the parse. */
function describe(error: unknown): string {
  const text =
    error instanceof PhoenixError
      ? error.message
      : error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
  return text.length > MAX_ERROR_CHARS ? `${text.slice(0, MAX_ERROR_CHARS)}...` : text;
}

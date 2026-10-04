import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { z } from 'zod';
import {
  scenarioExecutionSchema,
  scenarioSchema,
  scenarioStepSchema,
  stepOutcomeSchema,
  type HttpStep,
  type Scenario,
  type ScenarioExecution,
  type ScenarioStep,
  type StepOutcome,
} from '@phoenix/shared';

/**
 * A real HTTP server, not a stubbed fetch. The executor's whole job is talking to a legacy process
 * over the network, so the tests that judge it have to go over the network too.
 */

export interface TestServer {
  baseUrl: string;
  /** Number of requests the server has answered, so a handler can vary by call. */
  hits: () => number;
  close: () => Promise<void>;
}

export type Handler = (
  request: {
    method: string;
    url: string;
    body: string;
    /** Lower-cased, as node reports them — so a test asserting on a header looks up `'x-trace'`. */
    headers: Record<string, string | string[] | undefined>;
  },
  hits: number,
) => { status?: number; contentType?: string; body?: string; delayMs?: number } | void;

export async function startServer(handler: Handler): Promise<TestServer> {
  let hits = 0;
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      hits += 1;
      const outcome = handler(
        {
          method: request.method ?? 'GET',
          url: request.url ?? '/',
          body: Buffer.concat(chunks).toString('utf8'),
          headers: request.headers,
        },
        hits,
      );
      const reply = outcome ?? {};
      const send = (): void => {
        // The client may already have given up (that is what the timeout test asserts), and writing
        // into a destroyed socket would surface as a server error unrelated to the behavior under test.
        if (response.destroyed || response.writableEnded) return;
        response.writeHead(reply.status ?? 200, {
          'content-type': reply.contentType ?? 'application/json',
        });
        response.end(reply.body ?? '{}');
      };
      if (reply.delayMs === undefined || reply.delayMs <= 0) send();
      else setTimeout(send, reply.delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    hits: () => hits,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // The executor keeps its connections alive; without this, `close` waits for a keep-alive
        // socket that nothing will ever close and the test run hangs at teardown.
        server.closeAllConnections();
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      }),
  };
}

/** A port nothing is listening on, so "the legacy system is down" can be tested for real. */
export const UNREACHABLE_BASE_URL = 'http://127.0.0.1:1';

export function httpStep(stepId: string, path: string, init: Partial<HttpStep> = {}): ScenarioStep {
  return scenarioStepSchema.parse({
    stepId,
    description: `${init.method ?? 'GET'} ${path}`,
    kind: 'http',
    http: { method: 'GET', path, ...init },
  });
}

export function scenario(steps: readonly ScenarioStep[], overrides: Partial<Scenario> = {}): Scenario {
  return scenarioSchema.parse({
    scenarioId: 'scn_test-case',
    title: 'test scenario',
    description: 'A scenario built by a test.',
    category: 'normal-path',
    hypothesis: 'The system under test behaves as captured.',
    steps,
    provenance: { createdBy: 'characterization-engineer', origin: 'derived-from-rule' },
    ...overrides,
  });
}

/**
 * Builders for recorded executions. Capture and evaluation take an execution as their only evidence,
 * so the tests that judge them have to be able to state precisely what one contained — including the
 * "the two runs disagreed here" shape that decides normalization.
 */
export function outcome(stepId: string, init: Partial<Omit<StepOutcome, 'stepId'>> = {}): StepOutcome {
  return stepOutcomeSchema.parse({
    stepId,
    kind: 'http',
    status: 'ok',
    durationMs: 1,
    startedAt: '2026-01-01T00:00:00.000Z',
    ...init,
  });
}

const executionDefaults = {
  scenarioId: 'scn_test-case',
  system: 'legacy',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  durationMs: 1000,
  status: 'completed',
} satisfies z.input<typeof scenarioExecutionSchema>;

export function execution(steps: readonly StepOutcome[]): ScenarioExecution {
  return scenarioExecutionSchema.parse({ ...executionDefaults, steps });
}

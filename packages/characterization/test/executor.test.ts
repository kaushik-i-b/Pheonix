import { afterEach, describe, expect, it } from 'vitest';
import type { ScenarioTarget } from '../src/index.js';
import { executeScenario } from '../src/index.js';
import { UNREACHABLE_BASE_URL, httpStep, scenario, startServer, type TestServer } from './support.js';

/**
 * What the executor promises: it performs steps and records what happened, and it does not decide
 * whether what happened was right.
 */

const servers: TestServer[] = [];

afterEach(async () => {
  while (servers.length > 0) await servers.pop()?.close();
});

async function serve(handler: Parameters<typeof startServer>[0]): Promise<TestServer> {
  const server = await startServer(handler);
  servers.push(server);
  return server;
}

function target(baseUrl: string, extra: Partial<ScenarioTarget> = {}): ScenarioTarget {
  return { system: 'legacy', label: 'test-legacy', baseUrl, ...extra };
}

describe('executeScenario', () => {
  it('sends one content-type when the scenario already set Content-Type', async () => {
    let contentType: string | string[] | undefined;
    const server = await serve((request) => {
      contentType = request.headers['content-type'];
      return { body: '{"ok":true}' };
    });

    await executeScenario(
      scenario([
        httpStep('post', '/transfers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: { amount: 1 },
        }),
      ]),
      target(server.baseUrl),
    );

    expect(contentType).toBe('application/json');
  });

  it('records an HTTP error response as behavior rather than as a failure to execute', async () => {
    const server = await serve(() => ({
      status: 400,
      body: JSON.stringify({ error: 'BAD_REQUEST', message: 'amount must be positive' }),
    }));

    const execution = await executeScenario(scenario([httpStep('reject', '/transfers')]), target(server.baseUrl));

    expect(execution.status).toBe('completed');
    expect(execution.error).toBeUndefined();
    const step = execution.steps[0];
    expect(step?.status).toBe('ok');
    expect(step?.httpStatus).toBe(400);
    expect(step?.responseBody).toEqual({ error: 'BAD_REQUEST', message: 'amount must be positive' });
  });

  it('distinguishes a target that is not there from a target that answered', async () => {
    let snapshotted = false;
    const execution = await executeScenario(
      scenario([httpStep('missing', '/accounts')]),
      target(UNREACHABLE_BASE_URL, {
        snapshot: async () => {
          snapshotted = true;
          return {};
        },
      }),
    );

    expect(execution.status).toBe('unreachable');
    expect(execution.steps[0]?.status).toBe('unreachable');
    expect(execution.steps[0]?.error).toContain(UNREACHABLE_BASE_URL);
    expect(execution.error).toContain('missing');
    // There is no state to picture: asking for one would only add a second, confusing failure.
    expect(snapshotted).toBe(false);
  });

  it('stops at a required step that could not be performed and says which one', async () => {
    const server = await serve(() => ({ body: '{"reached":true}' }));
    const execution = await executeScenario(
      scenario([
        { stepId: 'setup', description: 'needs a reset runner this target does not have', kind: 'reset', required: true },
        httpStep('after', '/later'),
      ]),
      target(server.baseUrl),
    );

    expect(execution.status).toBe('failed');
    expect(execution.error).toContain('setup');
    expect(execution.error).toContain('no reset runner');
    // The steps after a required failure would be measuring something the scenario never asked for.
    expect(execution.steps.map((step) => step.stepId)).toEqual(['setup']);
    expect(server.hits()).toBe(0);
  });

  it('keeps going past an optional step that could not be performed, and still records the failure', async () => {
    const server = await serve(() => ({ body: '{"ok":true}' }));
    const execution = await executeScenario(
      scenario([
        httpStep('first', '/first'),
        { stepId: 'needs-runner', description: 'optional reset', kind: 'reset', required: false },
        httpStep('final', '/yes'),
      ]),
      target(server.baseUrl),
    );

    expect(execution.status).toBe('completed');
    expect(execution.steps).toHaveLength(3);
    expect(execution.steps[1]?.status).toBe('error');
    expect(execution.steps[1]?.error).toContain('no reset runner');
    expect(execution.steps[2]?.status).toBe('ok');
  });

  it('reports a step that never answered as a timeout, not as an answer', async () => {
    const server = await serve(() => ({ body: '{}', delayMs: 500 }));
    const execution = await executeScenario(
      scenario([httpStep('slow', '/slow', { timeoutMs: 60 })]),
      target(server.baseUrl),
    );

    expect(execution.status).toBe('timeout');
    expect(execution.steps[0]?.status).toBe('timeout');
    expect(execution.steps[0]?.error).toContain('60ms');
  });

  it('chains a captured identifier into a later request without turning it into a string', async () => {
    const bodies: string[] = [];
    const server = await serve((request) => {
      bodies.push(request.body);
      return request.url === '/accounts'
        ? { body: JSON.stringify({ accountId: 'acc-7', limit: 250 }) }
        : { body: '{"accepted":true}' };
    });

    const execution = await executeScenario(
      scenario([
        { ...httpStep('open', '/accounts'), captureAs: 'open' },
        httpStep('fund', '/transfers', {
          method: 'POST',
          body: { to: '{{open.responseBody.accountId}}', limit: '{{open.responseBody.limit}}' },
        }),
      ]),
      target(server.baseUrl),
    );

    expect(execution.status).toBe('completed');
    expect(execution.captured.open).toBeDefined();
    expect(JSON.parse(bodies[1] ?? '{}')).toEqual({ to: 'acc-7', limit: 250 });
  });

  it('fails loudly when a scenario references something no earlier step captured', async () => {
    const server = await serve(() => ({ body: '{}' }));
    const execution = await executeScenario(
      scenario([httpStep('ghost', '/x/{{never.captured}}')]),
      target(server.baseUrl),
    );

    expect(execution.status).toBe('failed');
    expect(execution.steps[0]?.status).toBe('error');
    expect(execution.steps[0]?.error).toContain('never.captured');
  });

  it('keeps a body that was advertised as JSON but is not, exactly as it arrived', async () => {
    const server = await serve(() => ({ body: '{"truncated":' }));
    const execution = await executeScenario(scenario([httpStep('bad', '/bad')]), target(server.baseUrl));

    expect(execution.steps[0]?.status).toBe('ok');
    expect(execution.steps[0]?.responseBody).toBe('{"truncated":');
  });

  it('keeps a non-JSON body as text', async () => {
    const server = await serve(() => ({ contentType: 'text/plain', body: 'SERVICE UNAVAILABLE' }));
    const execution = await executeScenario(scenario([httpStep('text', '/text')]), target(server.baseUrl));

    expect(execution.steps[0]?.responseBody).toBe('SERVICE UNAVAILABLE');
  });

  it('sends the query parameters and substituted headers the scenario asked for', async () => {
    const server = await serve((request) => ({
      // Echoing the request back is what makes substitution observable through the execution
      // record itself, rather than only through a variable this test happens to close over.
      body: JSON.stringify({ url: request.url, trace: request.headers['x-trace'] ?? null }),
    }));

    const execution = await executeScenario(
      scenario([
        { ...httpStep('open', '/accounts'), captureAs: 'open' },
        httpStep('page', '/accounts', {
          query: { page: 2, size: '10' },
          headers: { 'x-trace': '{{open.stepId}}' },
        }),
      ]),
      target(server.baseUrl),
    );

    expect(execution.status).toBe('completed');
    expect(execution.steps[0]?.responseBody).toEqual({ url: '/accounts', trace: null });
    expect(execution.steps[1]?.responseBody).toEqual({ url: '/accounts?page=2&size=10', trace: 'open' });
  });

  it('still records behavior when the after-picture cannot be taken', async () => {
    const server = await serve(() => ({ body: '{"balance":"10.00"}' }));
    const execution = await executeScenario(
      scenario([httpStep('read', '/balance')]),
      target(server.baseUrl, {
        snapshot: async () => {
          throw new Error('connection reset while counting ledger rows');
        },
      }),
    );

    expect(execution.status).toBe('completed');
    expect(execution.steps[0]?.responseBody).toEqual({ balance: '10.00' });
    expect(execution.stateSnapshot.snapshotError).toContain('connection reset');
  });

  it('reports every step it performed through onStep, in order', async () => {
    const server = await serve(() => ({ body: '{}' }));
    const seen: string[] = [];
    await executeScenario(
      scenario([httpStep('one', '/a'), httpStep('two', '/b')]),
      target(server.baseUrl),
      { onStep: (outcome) => seen.push(outcome.stepId) },
    );

    expect(seen).toEqual(['one', 'two']);
  });

  it('stops mid-scenario when the run is aborted', async () => {
    const server = await serve(() => ({ body: '{}' }));
    const controller = new AbortController();
    const execution = await executeScenario(
      scenario([httpStep('one', '/a'), { stepId: 'pause', description: 'wait', kind: 'wait', waitMs: 50, required: true }, httpStep('two', '/b')]),
      target(server.baseUrl),
      {
        signal: controller.signal,
        onStep: (outcome) => {
          if (outcome.stepId === 'one') controller.abort();
        },
      },
    );

    expect(execution.status).toBe('timeout');
    expect(execution.steps.map((step) => step.stepId)).toEqual(['one']);
    expect(execution.error).toContain('aborted');
  });
});

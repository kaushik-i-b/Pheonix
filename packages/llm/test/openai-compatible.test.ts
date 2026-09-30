import { describe, expect, it } from 'vitest';
import { llmSettingsSchema } from '@phoenix/config';
import { PhoenixError, completionRequestSchema, type CompletionRequest } from '@phoenix/shared';
import { createLlmProvider } from '../src/factory.js';
import { OpenAiCompatibleProvider, sumUsage, type OpenAiCompatibleOptions } from '../src/openai-compatible.js';
import type { LlmProvider } from '../src/provider.js';

interface RecordedCall {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

type Responder = (call: RecordedCall, index: number) => Response | Promise<Response>;

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function textResponse(text: string, status = 200): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain' } });
}

/** Records every request so assertions can be made about the wire format, not just the result. */
function recordingFetch(responder: Responder): { fetchImpl: typeof fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const rawBody = typeof init?.body === 'string' ? init.body : '';
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[key.toLowerCase()] = value;
    }
    const call: RecordedCall = {
      url,
      init: init ?? {},
      body: rawBody.length > 0 ? (JSON.parse(rawBody) as Record<string, unknown>) : {},
      headers,
    };
    calls.push(call);
    return responder(call, calls.length - 1);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function chatPayload(overrides: Record<string, unknown> = {}): unknown {
  return {
    model: 'qwen-max',
    choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
    ...overrides,
  };
}

function request(overrides: Partial<CompletionRequest> = {}): CompletionRequest {
  return completionRequestSchema.parse({
    purpose: 'discovery.summary',
    messages: [{ role: 'system', content: 'You are the Archaeologist.' }, { role: 'user', content: 'Go.' }],
    ...overrides,
  });
}

function provider(
  responder: Responder,
  overrides: Partial<OpenAiCompatibleOptions> = {},
): { provider: LlmProvider; calls: RecordedCall[] } {
  const { fetchImpl, calls } = recordingFetch(responder);
  return {
    provider: new OpenAiCompatibleProvider({
      baseUrl: 'https://llm.example.test/v1/',
      model: 'qwen-max',
      fetchImpl,
      maxRetries: 1,
      retryBaseDelayMs: 1,
      ...overrides,
    }),
    calls,
  };
}

describe('OpenAiCompatibleProvider', () => {
  it('posts an OpenAI-compatible chat completion and parses the reply', async () => {
    const { provider: client, calls } = provider(() => jsonResponse(chatPayload()));
    const result = await client.complete(request());

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://llm.example.test/v1/chat/completions');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.body.model).toBe('qwen-max');
    expect(calls[0]?.body.messages).toEqual([
      { role: 'system', content: 'You are the Archaeologist.' },
      { role: 'user', content: 'Go.' },
    ]);
    expect(calls[0]?.body.stream).toBe(false);
    expect(result.text).toBe('{"ok":true}');
    expect(result.finishReason).toBe('stop');
    expect(result.usage).toEqual({ promptTokens: 11, completionTokens: 22, totalTokens: 33 });
    expect(result.providerId).toBe('openai-compatible');
    expect(result.attempts).toBe(1);
  });

  it('sends response_format only for json requests and never a vendor-specific field', async () => {
    const { provider: client, calls } = provider(() => jsonResponse(chatPayload()));
    await client.complete(request({ responseFormat: 'json' }));
    await client.complete(request({ responseFormat: 'text' }));
    expect(calls[0]?.body.response_format).toEqual({ type: 'json_object' });
    expect(calls[1]?.body.response_format).toBeUndefined();
    expect(Object.keys(calls[0]?.body ?? {})).toEqual([
      'model',
      'messages',
      'temperature',
      'max_tokens',
      'stream',
      'response_format',
    ]);
  });

  it('sends tool specs and parses tool calls, keeping raw arguments for diagnosis', async () => {
    const { provider: client, calls } = provider(() =>
      jsonResponse(
        chatPayload({
          choices: [
            {
              message: {
                content: '',
                tool_calls: [
                  {
                    id: 'call_1',
                    type: 'function',
                    function: { name: 'read_file', arguments: '{"path":"src/Main.java"}' },
                  },
                  { id: 'call_2', type: 'function', function: { name: 'list_files', arguments: 'not json' } },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        }),
      ),
    );
    const warnings: string[] = [];
    const result = await client.complete(
      request({
        tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object' } }],
        toolChoice: 'required',
      }),
      { onWarn: (message) => warnings.push(message) },
    );

    expect(calls[0]?.body.tools).toEqual([
      { type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' } } },
    ]);
    expect(calls[0]?.body.tool_choice).toBe('required');
    expect(result.toolCalls[0]).toEqual({
      id: 'call_1',
      name: 'read_file',
      arguments: { path: 'src/Main.java' },
      rawArguments: '{"path":"src/Main.java"}',
    });
    expect(result.toolCalls[1]?.arguments).toEqual({ raw: 'not json' });
    expect(warnings.join('\n')).toContain('list_files arguments were not valid JSON');
  });

  it('authenticates with a bearer token only when one is configured', async () => {
    const withKey = provider(() => jsonResponse(chatPayload()), { apiKey: 'sk-secret' });
    await withKey.provider.complete(request());
    expect(withKey.calls[0]?.headers.authorization).toBe('Bearer sk-secret');

    const withoutKey = provider(() => jsonResponse(chatPayload()));
    await withoutKey.provider.complete(request());
    expect(withoutKey.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('drops response_format and retries when the endpoint rejects it', async () => {
    const warnings: string[] = [];
    const { provider: client, calls } = provider((_call, index) =>
      index === 0
        ? textResponse('400 Bad Request: response_format is not supported', 400)
        : jsonResponse(chatPayload()),
    );
    const result = await client.complete(request({ responseFormat: 'json' }), {
      onWarn: (message) => warnings.push(message),
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]?.body.response_format).toBeUndefined();
    expect(result.text).toBe('{"ok":true}');
    expect(warnings.join('\n')).toContain('retrying without it');
  });

  it('retries a 503 with exponential backoff and reports the attempt count', async () => {
    const warnings: { message: string; details?: Record<string, unknown> }[] = [];
    const { provider: client, calls } = provider(
      (_call, index) => (index === 0 ? textResponse('upstream unavailable', 503) : jsonResponse(chatPayload())),
      { retryBaseDelayMs: 3 },
    );
    const result = await client.complete(request(), {
      onWarn: (message, details) => warnings.push({ message, details }),
    });
    expect(calls).toHaveLength(2);
    expect(result.attempts).toBe(2);
    expect(warnings.map((entry) => entry.message).join('\n')).toContain(
      'retrying LLM call after LLM_REQUEST_FAILED',
    );
    expect(warnings[0]?.details?.backoffMs).toBe(3);
  });

  it('does not retry a client error that retrying cannot fix', async () => {
    const { provider: client, calls } = provider(() => textResponse('bad api key', 401));
    await expect(client.complete(request())).rejects.toThrow(/returned 401/);
    expect(calls).toHaveLength(1);
  });

  it('gives up after maxRetries with the last failure intact', async () => {
    const { provider: client, calls } = provider(() => textResponse('still down', 500));
    try {
      await client.complete(request());
      throw new Error('complete should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PhoenixError);
      expect((error as PhoenixError).code).toBe('LLM_REQUEST_FAILED');
      expect((error as PhoenixError).details.status).toBe(500);
    }
    expect(calls).toHaveLength(2);
  });

  it('maps 429 to a rate-limit failure', async () => {
    const { provider: client } = provider(() => textResponse('slow down', 429));
    await expect(client.complete(request())).rejects.toMatchObject({ code: 'LLM_RATE_LIMITED' });
  });

  it('records zero usage and warns when the provider reports none, rather than estimating', async () => {
    const warnings: string[] = [];
    const { provider: client } = provider(() =>
      jsonResponse(chatPayload({ usage: undefined })),
    );
    const result = await client.complete(request(), { onWarn: (message) => warnings.push(message) });
    expect(result.usage).toEqual({ promptTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(warnings.join('\n')).toContain('recorded as zero rather than estimated');
  });

  it('rejects a non-JSON body', async () => {
    const { provider: client } = provider(() => textResponse('<html>gateway</html>'));
    await expect(client.complete(request())).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('rejects a payload with no choices', async () => {
    const { provider: client } = provider(() => jsonResponse({ choices: [] }));
    await expect(client.complete(request())).rejects.toMatchObject({ code: 'LLM_INVALID_RESPONSE' });
  });

  it('surfaces an error field returned with a 200 status', async () => {
    const { provider: client } = provider(() =>
      jsonResponse({ error: { message: 'context length exceeded', type: 'invalid_request_error' } }),
    );
    await expect(client.complete(request())).rejects.toThrow(/context length exceeded/);
  });

  it('times out instead of hanging forever', async () => {
    const { provider: client } = provider(
      (_call) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = (_call.init.signal ?? undefined) as AbortSignal | undefined;
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      { timeoutMs: 5, maxRetries: 0 },
    );
    await expect(client.complete(request())).rejects.toMatchObject({ code: 'LLM_TIMEOUT' });
  });

  it('attaches an estimated cost only when a pricing entry matches the model', async () => {
    const { provider: client } = provider(() => jsonResponse(chatPayload()), {
      pricing: {
        currency: 'USD',
        entries: [{ model: 'qwen-*', currency: 'USD', inputPerMillionTokens: 1000, outputPerMillionTokens: 2000 }],
      },
    });
    const result = await client.complete(request());
    expect(result.cost).toEqual({ currency: 'USD', amount: 0.055, estimated: true });
  });

  it('sums usage across calls', async () => {
    const { provider: client } = provider(() => jsonResponse(chatPayload()));
    const results = [await client.complete(request()), await client.complete(request())];
    expect(sumUsage(results)).toEqual({ promptTokens: 22, completionTokens: 44, totalTokens: 66 });
  });
});

describe('createLlmProvider', () => {
  const settings = llmSettingsSchema.parse({
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5-coder:7b',
  });

  it('builds an OpenAI-compatible provider from configuration', () => {
    const client = createLlmProvider({ settings });
    expect(client.id).toBe('openai-compatible');
    expect(client.model).toBe('qwen2.5-coder:7b');
  });

  it('refuses an unknown provider id', () => {
    expect(() =>
      createLlmProvider({ settings: { ...settings, providerId: 'anthropic' } }),
    ).toThrowError(/unsupported LLM provider id/);
  });

  it('warns instead of failing when the optional pricing table is missing', () => {
    const warnings: string[] = [];
    const client = createLlmProvider({
      settings: { ...settings, pricingPath: '/nope/pricing.json' },
      onWarn: (message) => warnings.push(message),
    });
    expect(client.model).toBe('qwen2.5-coder:7b');
    expect(warnings.join('\n')).toContain('pricing table not readable');
  });
});

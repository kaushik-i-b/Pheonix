import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { PhoenixError, type CompletionRequest } from '@phoenix/shared';
import * as publicApi from '../src/index.js';
import { MockLlmProvider, jsonResponse } from '../src/mock.js';
import { completeForValue, completeStructured } from '../src/structured.js';

const ruleSchema = z.object({
  rules: z.array(
    z.object({
      id: z.string().min(1),
      confidence: z.number().min(0).max(1),
    }),
  ),
});

function request(purpose = 'rule-extraction'): CompletionRequest {
  return {
    purpose,
    messages: [{ role: 'user', content: 'Extract the rules.', toolCalls: [] }],
    responseFormat: 'text',
    tools: [],
  };
}

describe('completeStructured', () => {
  it('returns the validated value on the first attempt', async () => {
    const provider = new MockLlmProvider({
      responses: [jsonResponse({ rules: [{ id: 'BR-1', confidence: 0.9 }] })],
    });
    const completed = await completeStructured({ provider, schema: ruleSchema, request: request() });
    expect(completed.value).toEqual({ rules: [{ id: 'BR-1', confidence: 0.9 }] });
    expect(completed.validationRepairs).toBe(0);
    expect(completed.warnings).toEqual([]);
    expect(provider.callCount).toBe(1);
    expect(provider.requests[0]?.responseFormat).toBe('json');
  });

  it('hands the model its own rejected output plus the concrete problems', async () => {
    const provider = new MockLlmProvider({
      responses: [
        'Here are the rules you asked for:\n- money is conserved',
        jsonResponse({ rules: [{ id: 'BR-1', confidence: 0.5 }] }),
      ],
    });
    const completed = await completeStructured({ provider, schema: ruleSchema, request: request() });
    expect(completed.validationRepairs).toBe(1);
    expect(completed.warnings.join('\n')).toContain('no parseable JSON value');

    const retry = provider.requests[1];
    expect(retry?.messages).toHaveLength(3);
    expect(retry?.messages[1]?.content).toContain('money is conserved');
    expect(retry?.messages[2]?.content).toContain('ONLY the corrected JSON value');
    expect(completed.usage.promptTokens).toBe(20);
  });

  it('reports schema violations by field path so the model can fix them', async () => {
    const provider = new MockLlmProvider({
      responses: [
        jsonResponse({ rules: [{ id: 'BR-1', confidence: 4 }] }),
        jsonResponse({ rules: [{ id: 'BR-1', confidence: 0.4 }] }),
      ],
    });
    const completed = await completeStructured({ provider, schema: ruleSchema, request: request() });
    expect(completed.value.rules[0]?.confidence).toBe(0.4);
    expect(completed.warnings.join('\n')).toContain('rules.0.confidence');
  });

  it('fails loudly once repairs are exhausted instead of inventing a value', async () => {
    const provider = new MockLlmProvider({
      responses: [jsonResponse({ nope: true }), jsonResponse({ nope: true })],
    });
    await expect(
      completeStructured({ provider, schema: ruleSchema, request: request(), maxRepairs: 1 }),
    ).rejects.toThrow(/after 2 attempt\(s\)/);
    expect(provider.callCount).toBe(2);
  });

  it('surfaces the underlying provider failure without retrying it here', async () => {
    const provider = new MockLlmProvider({
      responses: [{ error: new PhoenixError('LLM_TIMEOUT', 'upstream timed out', {}) }],
    });
    await expect(completeForValue({ provider, schema: ruleSchema, request: request() })).rejects.toThrow(
      'upstream timed out',
    );
    expect(provider.callCount).toBe(1);
  });

  it('rejects a token-limit cut instead of schema-checking the nested fragment', async () => {
    // The nested object is itself schema-valid. Accepting it would report success for a document
    // the provider cut off before the outer value closed.
    const fragment = JSON.stringify({ rules: [{ id: 'BR-1', confidence: 0.5 }] });
    const text = `{"summary":"cut off","wrapped":${fragment}`;
    const provider = new MockLlmProvider({
      responses: [{ text, finishReason: 'length', usage: { completionTokens: 8192, promptTokens: 10, totalTokens: 8202 } }],
    });
    await expect(completeStructured({ provider, schema: ruleSchema, request: request() })).rejects.toMatchObject({
      code: 'LLM_OUTPUT_TRUNCATED',
      message: expect.stringContaining('nested JSON fragment'),
    });
    expect(provider.callCount).toBe(1);
  });

  it('notes when JSON was wrapped in prose but still usable', async () => {
    const provider = new MockLlmProvider({
      responses: ['```json\n{"rules":[]}\n```'],
    });
    const completed = await completeStructured({ provider, schema: ruleSchema, request: request() });
    expect(completed.value).toEqual({ rules: [] });
    expect(completed.validationRepairs).toBe(0);
  });
});

describe('MockLlmProvider', () => {
  it('is not reachable from the production entry point', () => {
    expect(Object.keys(publicApi)).not.toContain('MockLlmProvider');
  });

  it('refuses to guess a response it was not given', async () => {
    const provider = new MockLlmProvider({ responses: [jsonResponse({ rules: [] })] });
    await provider.complete(request('first'));
    await expect(provider.complete(request('second'))).rejects.toThrow(/no scripted response for call #1/);
    expect(provider.purposes()).toEqual(['first', 'second']);
  });

  it('supports a responder for request-dependent replies', async () => {
    const provider = new MockLlmProvider({
      responder: (incoming) => jsonResponse({ rules: [{ id: incoming.purpose, confidence: 1 }] }),
    });
    const value = await completeForValue({ provider, schema: ruleSchema, request: request('p1') });
    expect(value.rules[0]?.id).toBe('p1');
  });

  it('records usage so cost accounting has something real to add up', async () => {
    const provider = new MockLlmProvider({
      responses: [{ text: '{}', usage: { promptTokens: 5, completionTokens: 7 } }],
    });
    const result = await provider.complete(request());
    expect(result.usage).toEqual({ promptTokens: 5, completionTokens: 7, totalTokens: 12 });
    expect(result.promptHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

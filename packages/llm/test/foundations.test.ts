import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { PhoenixError} from '@phoenix/shared';
import { isPhoenixError } from '@phoenix/shared';
import { extractJson, stripCodeFences, tryExtractJson } from '../src/json.js';
import { loadPricingTable } from '../src/pricing.js';
import { PromptRegistry, parsePromptFile, referencedVariables } from '../src/prompts.js';

describe('json extraction', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });

  it('unwraps code fences', () => {
    expect(stripCodeFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it('extracts JSON surrounded by prose and reports the prose', () => {
    const extracted = tryExtractJson('Sure! Here you go:\n{"a":[1,2]}\nHope that helps.');
    expect(extracted?.value).toEqual({ a: [1, 2] });
    expect(extracted?.leadingText).toBe('Sure! Here you go:');
    expect(extracted?.trailingText).toBe('Hope that helps.');
  });

  it('does not treat braces inside strings as structure', () => {
    expect(extractJson('{"sql":"select * from t where j = \'{\'"}')).toEqual({
      sql: "select * from t where j = '{'",
    });
  });

  it('skips an unbalanced candidate and finds the real value', () => {
    expect(extractJson('broken {oops and then {"ok":true}')).toEqual({ ok: true });
  });

  it('fails loudly when there is no JSON at all', () => {
    try {
      extractJson('I cannot help with that.', 'rule-extraction');
      throw new Error('extractJson should have thrown');
    } catch (error) {
      expect(isPhoenixError(error)).toBe(true);
      expect((error as PhoenixError).code).toBe('LLM_INVALID_RESPONSE');
      expect((error as PhoenixError).details.purpose).toBe('rule-extraction');
    }
  });
});

describe('pricing table', () => {
  const directories: string[] = [];
  afterAll(() => {
    for (const directory of directories) rmSync(directory, { recursive: true, force: true });
  });

  function tempFile(name: string, content: string): string {
    const directory = mkdtempSync(join(tmpdir(), 'phoenix-pricing-'));
    directories.push(directory);
    const path = join(directory, name);
    writeFileSync(path, content, 'utf8');
    return path;
  }

  it('returns undefined when no path is configured', () => {
    expect(loadPricingTable(undefined)).toBeUndefined();
  });

  it('warns and returns undefined when the file is missing rather than inventing prices', () => {
    const warnings: string[] = [];
    const table = loadPricingTable('/definitely/not/here.json', {
      onWarn: (message) => warnings.push(message),
    });
    expect(table).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('cost will be reported as unknown');
  });

  it('loads a valid table', () => {
    const path = tempFile(
      'pricing.json',
      JSON.stringify({
        currency: 'USD',
        entries: [
          { model: 'qwen-max', inputPerMillionTokens: 2, outputPerMillionTokens: 6 },
          { model: 'qwen-*', inputPerMillionTokens: 1, outputPerMillionTokens: 3 },
        ],
      }),
    );
    const table = loadPricingTable(path);
    expect(table?.entries).toHaveLength(2);
  });

  it('throws on malformed JSON', () => {
    const path = tempFile('broken.json', '{not json');
    expect(() => loadPricingTable(path)).toThrowError(/not valid JSON/);
  });

  it('throws on a schema-invalid table', () => {
    const path = tempFile('bad.json', JSON.stringify({ entries: [{ model: 'x' }] }));
    try {
      loadPricingTable(path);
      throw new Error('loadPricingTable should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('CONFIG_INVALID');
    }
  });
});

describe('prompt registry', () => {
  const registry = PromptRegistry.fromDefinitions([
    parsePromptFile(
      [
        '---',
        'id: archaeologist.summarize',
        'version: 1.2.0',
        'description: Summarize a legacy repository from static evidence.',
        'audience: archaeologist',
        'outputSchemaId: discovery.findings',
        '---',
        'Repository root: {{root}}',
        'File budget: {{budget}}',
        'Evidence:',
        '{{evidence}}',
        '',
      ].join('\n'),
      '/prompts/archaeologist/summarize.md',
    ),
  ]);

  it('discovers referenced variables', () => {
    expect(referencedVariables('a {{one}} b {{ two }} c {{one}}')).toEqual(['one', 'two']);
  });

  it('renders and hashes deterministically', () => {
    const variables = { root: '/repo', budget: 40, evidence: [{ path: 'a.java' }] };
    const first = registry.render('archaeologist.summarize', variables, { runId: 'run_1' });
    const second = registry.render('archaeologist.summarize', variables);
    expect(first.renderedText).toContain('Repository root: /repo');
    expect(first.renderedText).toContain('File budget: 40');
    expect(first.renderedText).toContain('"path": "a.java"');
    expect(first.hash).toBe(second.hash);
    expect(first.promptVersion).toBe('1.2.0');
    expect(first.runId).toBe('run_1');
  });

  it('refuses to render with a hole in it', () => {
    try {
      registry.render('archaeologist.summarize', { root: '/repo' });
      throw new Error('render should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('PROMPT_VARIABLE_MISSING');
      expect((error as PhoenixError).details.missing).toEqual(['budget', 'evidence']);
    }
  });

  it('fails on an unknown prompt id and lists what exists', () => {
    try {
      registry.get('nope');
      throw new Error('get should have thrown');
    } catch (error) {
      expect((error as PhoenixError).code).toBe('PROMPT_NOT_FOUND');
      expect((error as PhoenixError).details.known).toEqual(['archaeologist.summarize']);
    }
  });

  it('rejects prompt files without front matter', () => {
    expect(() => parsePromptFile('no front matter here', '/prompts/bad.md')).toThrowError(/no front matter/);
  });

  it('parses an empty requiredVariables list as no variables', () => {
    const definition = parsePromptFile(
      '---\nid: empty.vars\nversion: 1.0.0\ndescription: d\naudience: modernizer\nrequiredVariables: []\n---\nNo variables here.\n',
      '/prompts/empty.md',
    );
    expect(definition.requiredVariables).toEqual([]);
    expect(() => PromptRegistry.fromDefinitions([definition]).render('empty.vars', {})).not.toThrow();
  });

  it('parses an inline requiredVariables list with brackets', () => {
    const definition = parsePromptFile(
      '---\nid: inline.vars\nversion: 1.0.0\ndescription: d\naudience: modernizer\nrequiredVariables: [alpha, beta]\n---\n{{alpha}} {{beta}}\n',
      '/prompts/inline.md',
    );
    expect(definition.requiredVariables).toEqual(['alpha', 'beta']);
  });

  it('rejects duplicate ids with conflicting versions', () => {
    const base = parsePromptFile(
      '---\nid: dup\nversion: 1.0.0\ndescription: d\naudience: orchestrator\n---\nhello\n',
      '/prompts/dup.md',
    );
    const conflicting = { ...base, version: '2.0.0' };
    expect(() => PromptRegistry.fromDefinitions([base, conflicting])).toThrowError(/conflicting versions/);
    expect(() => PromptRegistry.fromDefinitions([base, { ...base }])).not.toThrow();
  });

  it('loads prompt files recursively from directories', () => {
    const directory = mkdtempSync(join(tmpdir(), 'phoenix-prompts-'));
    writeFileSync(
      join(directory, 'nested.md'),
      '---\nid: nested.one\nversion: 0.1.0\ndescription: nested\naudience: adversary\n---\nAttack {{target}}\n',
      'utf8',
    );
    const loaded = PromptRegistry.fromDirectories([directory, '/does/not/exist']);
    expect(loaded.list().map((entry) => entry.promptId)).toEqual(['nested.one']);
    expect(loaded.render('nested.one', { target: 'settlement' }).renderedText).toBe('Attack settlement');
    rmSync(directory, { recursive: true, force: true });
  });
});

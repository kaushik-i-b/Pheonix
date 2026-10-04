import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_ROLE_PERMISSIONS, PATH_TOKEN_LEGACY } from '@phoenix/shared';
import { loadConfig, resolvePermissions, resolveRunPaths, toRunLlmConfig } from '../src/index.js';

/**
 * Configuration is where the limits and the security policy live, so it is validated here rather
 * than trusted: a missing endpoint must fail loudly, a malformed operator knob must not be silently
 * dropped, and the path tokens in a role profile must resolve to real directories before anything
 * enforces them.
 */

const directories: string[] = [];

function tempDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  directories.push(directory);
  return directory;
}

afterAll(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const MINIMAL = {
  LLM_BASE_URL: 'http://localhost:11434/v1',
  LLM_MODEL: 'qwen2.5-coder:7b',
};

describe('loadConfig', () => {
  it('refuses to start without an endpoint and a model', () => {
    expect(() => loadConfig({ cwd: tempDirectory('phoenix-config-'), envFiles: [], env: {} })).toThrowError(
      /LLM_BASE_URL and LLM_MODEL must be set/,
    );
  });

  it('reads .env from the working directory and lets process env win', () => {
    const cwd = tempDirectory('phoenix-config-');
    writeFileSync(join(cwd, '.env'), 'LLM_BASE_URL=http://file.example/v1\nLLM_MODEL=from-file\n', 'utf8');
    const fromFile = loadConfig({ cwd, env: {} });
    expect(fromFile.config.llm.model).toBe('from-file');

    const overridden = loadConfig({ cwd, env: { LLM_MODEL: 'from-process' } });
    expect(overridden.config.llm.baseUrl).toBe('http://file.example/v1');
    expect(overridden.config.llm.model).toBe('from-process');
  });

  it('applies overrides last, so a run can narrow its own limits', () => {
    const cwd = tempDirectory('phoenix-config-');
    const { config } = loadConfig({
      cwd,
      envFiles: [],
      env: {},
      overrides: { ...MINIMAL, MAX_AGENT_STEPS: '5', STAGE_TIMEOUT_MS: '1000' },
    });
    expect(config.limits.maxAgentSteps).toBe(5);
    expect(config.limits.stageTimeoutMs).toBe(1000);
  });

  it('rejects a number that is not a number', () => {
    expect(() =>
      loadConfig({ cwd: tempDirectory('phoenix-config-'), envFiles: [], env: {}, overrides: { ...MINIMAL, MAX_AGENT_STEPS: 'many' } }),
    ).toThrowError(/MAX_AGENT_STEPS must be a number/);
  });

  it('parses LLM_EXTRA_BODY into provider-specific request fields', () => {
    const { config } = loadConfig({
      cwd: tempDirectory('phoenix-config-'),
      envFiles: [],
      env: {},
      overrides: { ...MINIMAL, LLM_EXTRA_BODY: '{"options":{"num_ctx":32768}}' },
    });
    expect(config.llm.extraBody).toEqual({ options: { num_ctx: 32_768 } });
    expect(toRunLlmConfig(config.llm).model).toBe('qwen2.5-coder:7b');
  });

  it('fails on malformed LLM_EXTRA_BODY instead of ignoring it', () => {
    const cwd = tempDirectory('phoenix-config-');
    expect(() =>
      loadConfig({ cwd, envFiles: [], env: {}, overrides: { ...MINIMAL, LLM_EXTRA_BODY: 'not json' } }),
    ).toThrowError(/LLM_EXTRA_BODY must be a JSON object/);
    expect(() =>
      loadConfig({ cwd, envFiles: [], env: {}, overrides: { ...MINIMAL, LLM_EXTRA_BODY: '[1,2]' } }),
    ).toThrowError(/LLM_EXTRA_BODY must be a JSON object/);
  });

  it('never records the API key, only its fingerprint', () => {
    const { config } = loadConfig({
      cwd: tempDirectory('phoenix-config-'),
      envFiles: [],
      env: {},
      overrides: { ...MINIMAL, LLM_API_KEY: 'sk-secret-value' },
    });
    const recorded = toRunLlmConfig(config.llm);
    expect(JSON.stringify(recorded)).not.toContain('sk-secret-value');
    expect(recorded.apiKeyFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('resolves artifact and workspace roots to absolute paths under the working directory', () => {
    const cwd = tempDirectory('phoenix-config-');
    const { config } = loadConfig({ cwd, envFiles: [], env: {}, overrides: MINIMAL });
    expect(config.paths.artifactRoot).toBe(join(cwd, 'artifacts'));
    expect(config.paths.repoRoot).toBe(cwd);
  });
});

describe('resolveRunPaths and resolvePermissions', () => {
  it('gives each run its own artifact and workspace directory', () => {
    const cwd = tempDirectory('phoenix-config-');
    const { config } = loadConfig({ cwd, envFiles: [], env: {}, overrides: MINIMAL });
    const paths = resolveRunPaths(config, 'run_abc');
    expect(paths.artifactRoot).toBe(join(cwd, 'artifacts', 'run_abc'));
    expect(paths.workspaceRoot).toBe(join(cwd, '.phoenix-workspaces', 'run_abc'));
  });

  it('substitutes the path tokens in a role profile with this run’s directories', () => {
    const cwd = tempDirectory('phoenix-config-');
    const { config } = loadConfig({ cwd, envFiles: [], env: {}, overrides: MINIMAL });
    const paths = resolveRunPaths(config, 'run_abc');
    expect(DEFAULT_ROLE_PERMISSIONS.archaeologist.readRoots).toContain(PATH_TOKEN_LEGACY);

    const resolved = resolvePermissions(DEFAULT_ROLE_PERMISSIONS.archaeologist, paths);
    expect(resolved.readRoots).toContain(paths.legacyRoot);
    expect(JSON.stringify(resolved)).not.toContain(PATH_TOKEN_LEGACY);
    expect(resolved.tools).not.toContain('write_file');
    expect(resolved.commandPatterns).toEqual([]);
  });
});

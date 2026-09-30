import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal `.env` parser. Phoenix avoids a dotenv dependency because the format it needs is tiny
 * and because silent parsing surprises are worse than explicit failures.
 *
 * Supported: `KEY=value`, `KEY="quoted value"`, `KEY='single quoted'`, `#` comments, blank lines,
 * `export KEY=value`. Unsupported constructs are reported rather than ignored.
 */

export interface ParsedEnvFile {
  values: Record<string, string>;
  /** Lines that looked like assignments but could not be parsed. */
  problems: { line: number; text: string }[];
}

export function parseEnvFile(content: string): ParsedEnvFile {
  const values: Record<string, string> = {};
  const problems: { line: number; text: string }[] = [];
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) {
      problems.push({ line: index + 1, text: raw.slice(0, 200) });
      continue;
    }
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      problems.push({ line: index + 1, text: raw.slice(0, 200) });
      continue;
    }
    let value = withoutExport.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    values[key] = value;
  }
  return { values, problems };
}

export interface LoadEnvOptions {
  /** Files are read in order; later files do not override already-set values. */
  files?: string[];
  cwd?: string;
  /** Process env wins over file values, so operators can override without editing files. */
  base?: NodeJS.ProcessEnv;
}

export interface LoadedEnv {
  values: Record<string, string | undefined>;
  sources: { file: string; keys: string[]; problems: { line: number; text: string }[] }[];
}

export function loadEnv(options: LoadEnvOptions = {}): LoadedEnv {
  const cwd = options.cwd ?? process.cwd();
  const files = options.files ?? ['.env'];
  const base = options.base ?? process.env;
  const values: Record<string, string | undefined> = { ...base };
  const sources: LoadedEnv['sources'] = [];
  for (const file of files) {
    const path = resolve(cwd, file);
    let content: string;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      sources.push({ file: path, keys: [], problems: [] });
      continue;
    }
    const parsed = parseEnvFile(content);
    const keys: string[] = [];
    for (const [key, value] of Object.entries(parsed.values)) {
      if (values[key] === undefined || values[key] === '') {
        values[key] = value;
        keys.push(key);
      }
    }
    sources.push({ file: path, keys, problems: parsed.problems });
  }
  return { values, sources };
}

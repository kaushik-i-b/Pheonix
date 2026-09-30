import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { PhoenixError } from '@phoenix/shared';
import { shouldSkipDirectory } from './paths.js';

/**
 * Repository search.
 *
 * Deliberately a deterministic line search rather than an LLM-driven "find the interesting bits":
 * locating text in a repository is a mechanical problem, and the answer has to be reproducible
 * because it becomes evidence attached to a business rule.
 */

export interface SearchOptions {
  root: string;
  pattern: string;
  caseInsensitive?: boolean;
  /** Glob matched against the path relative to `root`, e.g. `**\/*.java`. */
  filePattern?: string;
  maxResults?: number;
  maxFileSizeBytes?: number;
  maxMatchesPerFile?: number;
  includeIgnoredDirectories?: boolean;
}

export interface SearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  pattern: string;
  matches: SearchMatch[];
  filesScanned: number;
  filesSkippedBinary: number;
  truncated: boolean;
}

const MAX_LINE_LENGTH = 1000;
const BINARY_PROBE_BYTES = 8000;

export function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] as string;
    if (char === '*') {
      if (glob[index + 1] === '*') {
        index += 1;
        // `**/` spans directories, including zero of them.
        if (glob[index + 1] === '/') {
          index += 1;
          source += '(?:[^/]*\\/)*';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const end = glob.indexOf('}', index);
      if (end === -1) {
        source += '\\{';
      } else {
        const alternatives = glob
          .slice(index + 1, end)
          .split(',')
          .map((alternative) => escapeRegExp(alternative.trim()));
        source += `(?:${alternatives.join('|')})`;
        index = end;
      }
    } else {
      source += escapeRegExp(char);
    }
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function searchFiles(options: SearchOptions): SearchResult {
  let regex: RegExp;
  try {
    regex = new RegExp(options.pattern, options.caseInsensitive === true ? 'i' : '');
  } catch (error) {
    throw new PhoenixError('TOOL_EXECUTION_FAILED', `search pattern is not a valid regex: ${options.pattern}`, {
      pattern: options.pattern,
    }, error);
  }
  const fileRegex = options.filePattern !== undefined ? globToRegExp(options.filePattern) : undefined;
  const maxResults = options.maxResults ?? 200;
  const maxFileSizeBytes = options.maxFileSizeBytes ?? 2_000_000;
  const maxMatchesPerFile = options.maxMatchesPerFile ?? 20;

  const matches: SearchMatch[] = [];
  let filesScanned = 0;
  let filesSkippedBinary = 0;
  let truncated = false;

  const walk = (directory: string): void => {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch {
      return;
    }
    for (const entry of entries.sort()) {
      if (truncated) return;
      const path = join(directory, entry);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        if (!options.includeIgnoredDirectories && shouldSkipDirectory(entry)) continue;
        walk(path);
        continue;
      }
      if (!stats.isFile()) continue;

      const relativePath = relative(options.root, path).split(sep).join('/');
      if (fileRegex !== undefined && !fileRegex.test(relativePath)) continue;
      if (stats.size > maxFileSizeBytes) continue;

      const bytes = readFileSync(path);
      if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) {
        filesSkippedBinary += 1;
        continue;
      }
      filesScanned += 1;

      let matchesInFile = 0;
      const lines = bytes.toString('utf8').split('\n');
      for (const [index, line] of lines.entries()) {
        if (regex.test(line)) {
          matches.push({
            path: relativePath,
            line: index + 1,
            text: line.trim().slice(0, MAX_LINE_LENGTH),
          });
          matchesInFile += 1;
          if (matches.length >= maxResults || matchesInFile >= maxMatchesPerFile) {
            truncated = true;
            return;
          }
        }
      }
    }
  };

  walk(options.root);
  return {
    pattern: options.pattern,
    matches,
    filesScanned,
    filesSkippedBinary,
    truncated,
  };
}

export interface FileListing {
  path: string;
  kind: 'file' | 'directory';
  bytes?: number;
}

export interface ListOptions {
  root: string;
  recursive?: boolean;
  limit?: number;
  includeIgnoredDirectories?: boolean;
}

export function listDirectory(options: ListOptions): { entries: FileListing[]; truncated: boolean } {
  const limit = options.limit ?? 500;
  const entries: FileListing[] = [];
  let truncated = false;

  const walk = (directory: string): void => {
    if (truncated) return;
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      throw new PhoenixError('TOOL_EXECUTION_FAILED', `cannot list directory ${directory}`, {
        path: directory,
      }, error);
    }
    for (const name of names.sort()) {
      if (truncated) return;
      const path = join(directory, name);
      let stats;
      try {
        stats = statSync(path);
      } catch {
        continue;
      }
      const relativePath = relative(options.root, path).split(sep).join('/');
      if (stats.isDirectory()) {
        if (!options.includeIgnoredDirectories && shouldSkipDirectory(name)) continue;
        entries.push({ path: `${relativePath}/`, kind: 'directory' });
        if (options.recursive === true) walk(path);
      } else if (stats.isFile()) {
        entries.push({ path: relativePath, kind: 'file', bytes: stats.size });
      }
      if (entries.length >= limit) {
        truncated = true;
        return;
      }
    }
  };

  walk(options.root);
  return { entries, truncated };
}

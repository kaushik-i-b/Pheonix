import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { shouldSkipDirectory, type FileCategory } from '@phoenix/shared';

/**
 * Repository walking and file classification.
 *
 * Deliberately deterministic and dependency-free: an unknown legacy tree has to be inventoried
 * before anything can reason about it, and inventories must be reproducible byte-for-byte so a
 * resumed run can compare input hashes.
 */

export const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.java': 'Java',
  '.kt': 'Kotlin',
  '.scala': 'Scala',
  '.groovy': 'Groovy',
  '.ts': 'TypeScript',
  '.tsx': 'TypeScript',
  '.js': 'JavaScript',
  '.jsx': 'JavaScript',
  '.mjs': 'JavaScript',
  '.cjs': 'JavaScript',
  '.py': 'Python',
  '.rb': 'Ruby',
  '.go': 'Go',
  '.rs': 'Rust',
  '.cs': 'C#',
  '.php': 'PHP',
  '.sql': 'SQL',
  '.sh': 'Shell',
  '.bash': 'Shell',
  '.xml': 'XML',
  '.yaml': 'YAML',
  '.yml': 'YAML',
  '.json': 'JSON',
  '.properties': 'Properties',
  '.toml': 'TOML',
  '.ini': 'INI',
  '.md': 'Markdown',
  '.txt': 'Text',
  '.gradle': 'Gradle',
  '.html': 'HTML',
  '.jsp': 'JSP',
  '.c': 'C',
  '.h': 'C',
  '.cpp': 'C++',
};

const SOURCE_LANGUAGES = new Set(['Java', 'Kotlin', 'Scala', 'Groovy', 'TypeScript', 'JavaScript', 'Python', 'Ruby', 'Go', 'Rust', 'C#', 'PHP', 'C', 'C++', 'JSP']);

const TEXT_EXTENSIONS = new Set([
  ...Object.keys(LANGUAGE_BY_EXTENSION),
  '.env',
  '.cfg',
  '.conf',
  '.csv',
  '.gitignore',
  '.editorconfig',
  '.pom',
  '.lock',
  '.tpl',
  '.vm',
]);

export interface WalkOptions {
  root: string;
  /** Safety valve for enormous trees; the walk reports truncation instead of silently stopping. */
  maxFiles?: number;
  /** Files larger than this are inventoried but their content is not read into memory. */
  maxContentBytes?: number;
  /** Extra directory names to skip beyond the shared ignore list. */
  extraIgnoredDirectories?: readonly string[];
}

export interface WalkedFile {
  absolutePath: string;
  /** POSIX-style path relative to the walk root — stable across platforms. */
  relativePath: string;
  bytes: number;
  lines: number | undefined;
  language: string | undefined;
  category: FileCategory;
  /** Present only for text files at or below `maxContentBytes`. */
  text: string | undefined;
  contentRead: boolean;
}

export interface WalkResult {
  files: WalkedFile[];
  ignoredPaths: string[];
  truncated: boolean;
  totalBytes: number;
}

export function walkRepository(options: WalkOptions): WalkResult {
  const maxFiles = options.maxFiles ?? 20_000;
  const maxContentBytes = options.maxContentBytes ?? 2 * 1024 * 1024;
  const ignoredNames = new Set(options.extraIgnoredDirectories ?? []);

  const files: WalkedFile[] = [];
  const ignoredPaths: string[] = [];
  let totalBytes = 0;
  let truncated = false;

  const visit = (directory: string): void => {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(directory);
    } catch (error) {
      // An unreadable directory is evidence about the repository, not a reason to abort the walk.
      ignoredPaths.push(`${toRelative(directory, options.root)} (unreadable: ${describe(error)})`);
      return;
    }
    for (const entry of entries.sort()) {
      if (truncated) return;
      const absolute = join(directory, entry);
      let stats;
      try {
        stats = statSync(absolute);
      } catch {
        ignoredPaths.push(toRelative(absolute, options.root));
        continue;
      }
      if (stats.isDirectory()) {
        if (shouldSkipDirectory(entry) || ignoredNames.has(entry)) {
          ignoredPaths.push(toRelative(absolute, options.root));
          continue;
        }
        visit(absolute);
        continue;
      }
      if (!stats.isFile()) {
        ignoredPaths.push(`${toRelative(absolute, options.root)} (not a regular file)`);
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      totalBytes += stats.size;
      files.push(readEntry(absolute, options.root, stats.size, maxContentBytes));
    }
  };

  visit(options.root);
  files.sort((a, b) => (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0));
  ignoredPaths.sort();
  return { files, ignoredPaths, truncated, totalBytes };
}

function readEntry(absolutePath: string, root: string, bytes: number, maxContentBytes: number): WalkedFile {
  const relativePath = toRelative(absolutePath, root);
  const extension = extensionOf(relativePath);
  const language = LANGUAGE_BY_EXTENSION[extension];
  const category = categorize(relativePath, extension, language);
  const wantsContent = bytes <= maxContentBytes && isProbablyText(extension, relativePath);
  if (!wantsContent) {
    return { absolutePath, relativePath, bytes, lines: undefined, language, category, text: undefined, contentRead: false };
  }
  try {
    const text = readFileSync(absolutePath, 'utf8');
    if (text.includes('\u0000')) {
      return { absolutePath, relativePath, bytes, lines: undefined, language, category, text: undefined, contentRead: false };
    }
    return {
      absolutePath,
      relativePath,
      bytes,
      lines: countLines(text),
      language,
      category,
      text,
      contentRead: true,
    };
  } catch {
    return { absolutePath, relativePath, bytes, lines: undefined, language, category, text: undefined, contentRead: false };
  }
}

export function extensionOf(relativePath: string): string {
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  const extension = extname(base).toLowerCase();
  if (extension.length > 0) return extension;
  if (base.startsWith('.')) return base.toLowerCase();
  if (base === 'Dockerfile' || base === 'Makefile' || base === 'Procfile') return `.${base.toLowerCase()}`;
  return '';
}

function isProbablyText(extension: string, relativePath: string): boolean {
  if (TEXT_EXTENSIONS.has(extension)) return true;
  const base = relativePath.slice(relativePath.lastIndexOf('/') + 1);
  return base === 'Dockerfile' || base === 'Makefile' || base === 'Procfile' || base === 'LICENSE';
}

export function categorize(relativePath: string, extension: string, language: string | undefined): FileCategory {
  const segments = relativePath.split('/');
  const base = segments[segments.length - 1] ?? relativePath;
  const lower = relativePath.toLowerCase();

  if (segments.includes('migration') || segments.includes('migrations') || /^v\d+__/.test(base)) return 'migration';
  if (extension === '.sql' && /schema|seed|ddl/i.test(base)) return 'schema';
  if (segments.includes('test') || segments.includes('tests') || segments.includes('__tests__') || /\.(test|spec)\.[a-z]+$/.test(base)) {
    return 'test';
  }
  if (extension === '.md' || extension === '.txt' || base === 'LICENSE') return 'documentation';
  if (base === 'pom.xml' || base === 'build.gradle' || base === 'package.json' || base === 'Makefile' || extension === '.gradle') {
    return 'build';
  }
  if (extension === '.sh' || extension === '.bash' || base === 'Dockerfile' || base === 'Procfile') return 'script';
  if (
    extension === '.properties' ||
    extension === '.yaml' ||
    extension === '.yml' ||
    extension === '.toml' ||
    extension === '.ini' ||
    extension === '.env' ||
    base === 'application.xml' ||
    lower.includes('/config/') ||
    lower.endsWith('.conf')
  ) {
    return 'configuration';
  }
  if (lower.includes('/generated/') || lower.includes('/target/') || lower.includes('/build/')) return 'generated';
  if (language !== undefined && SOURCE_LANGUAGES.has(language)) return 'source';
  if (extension === '.xml') return 'configuration';
  if (extension === '.json') return 'configuration';
  return 'other';
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') lines += 1;
  }
  // A trailing newline does not start a new line of content.
  return text.endsWith('\n') ? lines - 1 : lines;
}

function toRelative(absolutePath: string, root: string): string {
  const value = relative(root, absolutePath);
  return value.split(sep).join('/');
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

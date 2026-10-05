import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import {
  canonicalizePath,
  pathIsInsideAny,
  type ArtifactId,
  type EvidenceRef,
  type Finding,
  type RunId,
} from '@phoenix/shared';
import type { FileArtifactStore } from '@phoenix/artifact-store';
import type { CustomCheck } from './acceptance.js';

/**
 * Proof that cited evidence exists.
 *
 * A model can invent a plausible file path, a line number that is out of range, or a quote that
 * appears nowhere in the repository. None of that survives this check: every source-code citation
 * is resolved against the real tree, the quoted text is searched for in the real bytes, and every
 * artifact reference is looked up in the run index. This is how Phoenix rejects an agent's claims
 * without asking the agent, or another model, whether they are true.
 *
 * Callers that pass `openedPaths` get one more rule: the agent must have opened the file it cites.
 * A quote can be verbatim correct and still be a transcription of the task brief rather than of the
 * repository, and the brief's own quotations are summaries of summaries. Requiring the read is what
 * makes "genuinely analysed the repository" an enforced property instead of an instruction.
 *
 * A rejected quote that DOES exist somewhere else in the permitted roots says where: the usual
 * failure is a correct quotation attributed to the wrong file, and naming the file that actually
 * contains the text turns the rejection into something the model can repair honestly. The hint is
 * a plain substring search over the same bytes — it vouches for where text lives, never for what
 * it means.
 *
 * A rejected path that does not exist gets the same treatment from the other direction: the nearest
 * real directory is listed, because the name a model should have used is exactly the thing it could
 * not guess. Neither hint relaxes the check — the citation still has to resolve to real bytes.
 */

export interface EvidenceCheckOptions {
  /** Directories a cited path may resolve against: the legacy repository, artifacts, workspace. */
  roots: readonly string[];
  /**
   * Files the agent actually opened with `read_file` during this task. When supplied, a source-code
   * citation to any other file is a violation even if its quote is verbatim correct: a quotation the
   * agent never read is a transcription from the brief or from memory, which is exactly how invented
   * line numbers and paraphrased code enter the record. Existence is not enough — the agent has to
   * have looked.
   */
  openedPaths?: readonly string[];
  maxViolations?: number;
  /** Files larger than this are not read for quote matching; the citation is left unverified. */
  maxFileBytes?: number;
  /** Cap on files scanned for the "the same text appears elsewhere" repair hint. */
  maxHintScanFiles?: number;
  /** When true, source-code evidence without a startLine is a violation triggering rewrite. */
  requireStartLine?: boolean;
}

export interface EvidenceViolation {
  claimId: string;
  evidenceId: string;
  problem: string;
  path?: string;
}

const DEFAULT_MAX_VIOLATIONS = 25;
const DEFAULT_MAX_FILE_BYTES = 8_000_000;
const DEFAULT_MAX_HINT_SCAN_FILES = 2_000;
const HINT_MATCH_LIMIT = 3;
/** Never scanned for hints: version-control internals and dependency trees drown out real sources. */
const HINT_SKIPPED_DIRECTORIES = new Set(['.git', 'node_modules', 'dist']);
/** Cap on directory entries named in a missing-path hint: enough to reveal the real neighbour. */
const MISSING_PATH_HINT_LIMIT = 12;

/** Either the file's text, or the reason it could not be verified. Never neither. */
interface LoadedFile {
  text?: string;
  problem?: string;
}

export function checkFindingEvidence(
  findings: readonly Finding[],
  options: EvidenceCheckOptions,
): EvidenceViolation[] {
  const roots = options.roots.map((root) => canonicalizePath(resolve(root)));
  const opened =
    options.openedPaths === undefined
      ? undefined
      : new Set(options.openedPaths.map((path) => canonicalizePath(resolve(path))));
  const maxViolations = options.maxViolations ?? DEFAULT_MAX_VIOLATIONS;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const maxHintScanFiles = options.maxHintScanFiles ?? DEFAULT_MAX_HINT_SCAN_FILES;
  const requireStartLine = options.requireStartLine === true;
  const contents = new Map<string, LoadedFile>();
  const violations: EvidenceViolation[] = [];

  // Built on the first misattributed quote, then reused: a lazy index of every scannable file under
  // the permitted roots, so the repair hint can name where a quoted text actually lives.
  let elsewhere: { absolutePath: string; display: string; text: string }[] | undefined;
  const elsewhereHint = (quote: string, citedResolved: string): string => {
    if (elsewhere === undefined) {
      elsewhere = [];
      for (const candidate of filesUnderRoots(roots, maxHintScanFiles)) {
        const loaded = read(candidate.absolutePath);
        if (loaded.text === undefined) continue;
        elsewhere.push({
          absolutePath: candidate.absolutePath,
          display: candidate.display,
          text: normalizeWhitespace(loaded.text),
        });
      }
    }
    const matches: string[] = [];
    for (const entry of elsewhere) {
      if (entry.absolutePath === citedResolved) continue;
      if (entry.text.includes(quote)) {
        matches.push(entry.display);
        if (matches.length >= HINT_MATCH_LIMIT) break;
      }
    }
    return matches.length === 0 ? '' : ` (the same text appears in ${matches.join(', ')})`;
  };

  const push = (claimId: string, evidence: EvidenceRef, problem: string, path?: string): void => {
    if (violations.length >= maxViolations) return;
    violations.push({ claimId, evidenceId: evidence.id, problem, ...(path !== undefined ? { path } : {}) });
  };

  const read = (path: string): LoadedFile => {
    const cached = contents.get(path);
    if (cached !== undefined) return cached;
    let loaded: LoadedFile;
    try {
      const size = statSync(path).size;
      if (size > maxFileBytes) {
        loaded = { problem: `cited file is ${size} bytes, above the ${maxFileBytes}-byte verification limit, so its quotation could not be checked` };
      } else {
        loaded = { text: readFileSync(path, 'utf8') };
      }
    } catch (error) {
      loaded = { problem: `cited file could not be read: ${error instanceof Error ? error.message : String(error)}` };
    }
    contents.set(path, loaded);
    return loaded;
  };

  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      const location = evidence.location;
      if (evidence.kind === 'source-code' && location === undefined) {
        push(finding.id, evidence, 'source-code evidence must cite a file location');
        continue;
      }
      if (location === undefined) continue;

      const resolved = resolveCitedPath(location.path, roots);
      if (resolved === undefined) {
        push(
          finding.id,
          evidence,
          `cited path is not inside any permitted root (${roots.join(', ')})`,
          location.path,
        );
        continue;
      }
      if (!existsSync(resolved) || !statSync(resolved).isFile()) {
        push(
          finding.id,
          evidence,
          `cited file does not exist${missingPathHint(resolved, roots)}`,
          location.path,
        );
        continue;
      }
      if (opened !== undefined && evidence.kind === 'source-code' && !opened.has(resolved)) {
        push(
          finding.id,
          evidence,
          `cited file was never opened with read_file during this task: open ${location.path}, then copy the quote from the bytes it actually contains`,
          location.path,
        );
      }

      const loaded = read(resolved);
      if (loaded.text === undefined) {
        push(finding.id, evidence, loaded.problem ?? `cited file could not be verified`, location.path);
        continue;
      }
      const text = loaded.text;

      const lineCount = text.split('\n').length;
      if (location.startLine !== undefined && location.startLine > lineCount) {
        push(
          finding.id,
          evidence,
          `cited line ${location.startLine} is past the end of the file (${lineCount} lines)`,
          location.path,
        );
      }
      if (location.endLine !== undefined && location.endLine > lineCount) {
        push(
          finding.id,
          evidence,
          `cited line ${location.endLine} is past the end of the file (${lineCount} lines)`,
          location.path,
        );
      }

      if (requireStartLine && evidence.kind === 'source-code' && location.startLine === undefined) {
        push(
          finding.id,
          evidence,
          `source-code evidence for ${location.path} cites no line number; cite the startLine where the quoted text begins`,
          location.path,
        );
      }

      const haystack = normalizeWhitespace(text);
      const quote = normalizeWhitespace(evidence.quote ?? '');
      if (quote.length > 0 && !haystack.includes(quote)) {
        push(
          finding.id,
          evidence,
          `quoted text does not appear in ${location.path}: ${quote.slice(0, 160)}${elsewhereHint(quote, resolved)}; ${lineWindow(text, location.startLine)}`,
          location.path,
        );
      }

      const snippet = normalizeWhitespace(location.snippet ?? '');
      if (snippet.length > 0 && !haystack.includes(snippet)) {
        push(
          finding.id,
          evidence,
          `cited snippet does not appear in ${location.path}: ${snippet.slice(0, 160)}`,
          location.path,
        );
      }
    }
  }
  return violations;
}

/** Artifact references must point at artifacts this run actually produced. */
export function checkArtifactReferences(
  findings: readonly Finding[],
  runId: RunId,
  artifacts: FileArtifactStore,
  maxViolations = DEFAULT_MAX_VIOLATIONS,
): EvidenceViolation[] {
  const violations: EvidenceViolation[] = [];
  const seen = new Map<ArtifactId, boolean>();
  for (const finding of findings) {
    for (const evidence of finding.evidence) {
      const artifactId = evidence.artifactId;
      if (artifactId === undefined) continue;
      const known = seen.get(artifactId) ?? artifacts.find(runId, artifactId) !== undefined;
      seen.set(artifactId, known);
      if (known) continue;
      if (violations.length >= maxViolations) return violations;
      violations.push({
        claimId: finding.id,
        evidenceId: evidence.id,
        problem: `cited artifact ${artifactId} is not in the run index`,
      });
    }
  }
  return violations;
}

/**
 * A registered acceptance check: cited evidence must exist. Wiring it as a `custom-check` keeps the
 * rule declarative in the task and deterministic in the runtime.
 */
export function evidenceExistsCheck(options: EvidenceCheckOptions): CustomCheck {
  return (context) => {
    const violations = [
      ...checkFindingEvidence(context.findings, options),
      ...checkArtifactReferences(context.findings, context.runId, context.artifacts, options.maxViolations),
    ];
    if (violations.length === 0) {
      const citations = context.findings.reduce((total, finding) => total + finding.evidence.length, 0);
      if (citations === 0) {
        // "All zero citations resolve" is not verification. A criterion that cannot be evaluated —
        // here, because the task produced nothing to evaluate — is reported unsatisfied, so a run
        // that claimed nothing does not carry a check mark it never earned.
        return {
          satisfied: false,
          reason: `nothing was verified: ${context.findings.length} claim(s) carried ${citations} citation(s), so this check had nothing to evaluate`,
          observed: `${citations} evidence citation(s) across ${context.findings.length} claim(s)`,
        };
      }
      return {
        satisfied: true,
        observed: `${citations} evidence citation(s) across ${context.findings.length} claim(s) all resolve`,
      };
    }
    return {
      satisfied: false,
      reason: `${violations.length} evidence citation(s) do not hold up: ${violations
        .slice(0, 8)
        .map((violation) => `${violation.claimId} → ${violation.problem}`)
        .join('; ')}`,
      observed: violations.map((violation) => `${violation.claimId}/${violation.evidenceId}: ${violation.problem}`).join(' | '),
    };
  };
}

/**
 * Where a citation actually points, or `undefined` when it points nowhere the agent may read.
 *
 * Exported because the agent loop has to ask the same question the checker asks — "has this file been
 * opened?" — and the two must not disagree about what a cited path means. `roots` must already be
 * canonicalised, as `checkFindingEvidence` does once for all of its citations.
 */
export function resolveCitedPath(cited: string, roots: readonly string[]): string | undefined {
  const candidates = isAbsolute(cited) ? [canonicalizePath(resolve(cited))] : roots.map((root) => canonicalizePath(join(root, cited)));
  for (const candidate of candidates) {
    if (pathIsInsideAny(candidate, roots)) return candidate;
  }
  return undefined;
}

/**
 * What the repository really has where the model pointed.
 *
 * An invented path is the one failure a model cannot repair from the rejection alone: the name it
 * should have used is precisely what it could not guess. Listing the nearest real directory turns a
 * dead end into names it can copy. Grounding, not laundering — exactly like `elsewhereHint`, the
 * citation still has to resolve to real bytes before anything accepts it.
 *
 * Directories are listed alongside files, with a trailing slash. A model that abbreviates a package
 * name misses the directory, not just the file, and a hint that named only files would fall silent in
 * exactly the case it is needed most.
 */
function missingPathHint(resolved: string, roots: readonly string[]): string {
  const directory = nearestExistingDirectory(resolved, roots);
  if (directory === undefined) return '';
  let names: string[];
  try {
    names = readdirSync(directory, { withFileTypes: true })
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return '';
  }
  if (names.length === 0) return '';
  const root = roots.find((candidate) => !relative(candidate, directory).startsWith('..')) ?? directory;
  const listed = names.slice(0, MISSING_PATH_HINT_LIMIT);
  const overflow = names.length - listed.length;
  const where = relative(root, directory);
  return `; ${where === '' ? 'the repository root' : `${where}/`} really contains ${listed.join(', ')}${
    overflow > 0 ? ` (+${overflow} more)` : ''
  } — cite one of those, or record the claim under unknowns`;
}

/** The cited path itself if it is a directory, otherwise the closest ancestor that exists in a root. */
function nearestExistingDirectory(resolved: string, roots: readonly string[]): string | undefined {
  let directory = resolved;
  while (pathIsInsideAny(directory, roots)) {
    try {
      if (statSync(directory).isDirectory()) return directory;
    } catch {
      // Not there yet: keep climbing toward a directory that is.
    }
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/**
 * Every file under the permitted roots, deterministic order, bounded count — the universe the
 * "the same text appears elsewhere" hint searches. Directories that hold no source evidence
 * (`.git`, `node_modules`, build output) are never entered: they would exhaust the cap with files
 * no citation should point at.
 */
function filesUnderRoots(
  roots: readonly string[],
  maxFiles: number,
): { absolutePath: string; display: string }[] {
  const found: { absolutePath: string; display: string }[] = [];
  const pending = roots.map((root) => ({ root, directory: root }));
  while (pending.length > 0 && found.length < maxFiles) {
    const current = pending.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current.directory, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (found.length >= maxFiles) break;
      const absolutePath = join(current.directory, entry.name);
      if (entry.isDirectory()) {
        if (!HINT_SKIPPED_DIRECTORIES.has(entry.name)) pending.push({ root: current.root, directory: absolutePath });
      } else if (entry.isFile()) {
        found.push({ absolutePath, display: relative(current.root, absolutePath) });
      }
    }
  }
  return found;
}

/**
 * The text the cited file actually has near the cited line, so the model repairs against the file
 * rather than against its memory of it. Grounding, not laundering: it quotes the same bytes the
 * checker searched, so a model that ignored the file on its last attempt can now see what is there.
 */
function lineWindow(text: string, startLine: number | undefined, maxChars = 300): string {
  const lines = text.split('\n');
  const start = startLine === undefined ? 0 : Math.min(Math.max(0, startLine - 3), Math.max(0, lines.length - 1));
  const window = normalizeWhitespace(lines.slice(start, start + 6).join(' '));
  const label = startLine === undefined ? 'the file begins:' : `line ${start + 1} reads:`;
  return `${label} "${window.slice(0, maxChars)}${window.length > maxChars ? '…' : ''}"`;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

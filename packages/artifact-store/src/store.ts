import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  PhoenixError,
  ARTIFACT_SCHEMA_VERSION,
  artifactEnvelopeSchema,
  artifactMetaSchema,
  defaultRelativePath,
  nowIso,
  sha256Hex,
  stableStringify,
  type ArtifactFormat,
  type ArtifactId,
  type ArtifactInputRef,
  type ArtifactKind,
  type ArtifactMeta,
  type ArtifactProducer,
  type RunId,
  type Sha256Hex,
} from '@phoenix/shared';

/**
 * The artifact store is how Phoenix agents talk to each other.
 *
 * Nothing important is passed through a shared conversation: every stage writes content-addressed
 * artifacts under `artifacts/<runId>/` and the next stage reads them back by id. Artifacts are
 * append-only in practice — a repair writes a new artifact rather than editing the old one, so the
 * evidence trail survives the run. Integrity is checkable: `verify()` re-hashes every indexed
 * artifact and reports tampering instead of trusting the file name.
 */

export interface ArtifactWriteRequest {
  kind: ArtifactKind;
  runId: RunId;
  producedBy: ArtifactProducer;
  inputs?: ArtifactInputRef[];
  /** Explicit path under `artifacts/<runId>/`; defaults to the canonical name for the kind. */
  relativePath?: string;
  /** Disambiguator for kinds that occur more than once per run. */
  slug?: string;
  format?: ArtifactFormat;
  title?: string;
  tags?: string[];
  /** Hash of the canonical form of the inputs; lets a resumed run skip unchanged work. */
  inputsHash?: Sha256Hex;
}

export interface WrittenArtifact {
  meta: ArtifactMeta;
  absolutePath: string;
  /** True when identical bytes were already stored, i.e. the write was a no-op. */
  deduplicated: boolean;
}

export interface ArtifactIntegrityProblem {
  artifactId: ArtifactId;
  relativePath: string;
  problem: 'missing' | 'tampered' | 'size-mismatch';
  expectedSha256: Sha256Hex;
  actualSha256?: Sha256Hex;
  expectedBytes?: number;
  actualBytes?: number;
}

export interface ArtifactIntegrityReport {
  runId: RunId;
  checked: number;
  ok: number;
  problems: ArtifactIntegrityProblem[];
  verifiedAt: string;
}

export interface ArtifactListFilter {
  kind?: ArtifactKind;
  kinds?: ArtifactKind[];
  producedByRole?: ArtifactProducer['role'];
  tag?: string;
}

/** Canonical content hash of a set of input artifacts, used for idempotent stage resumption. */
export function inputsHashOf(inputs: readonly ArtifactInputRef[]): Sha256Hex {
  const canonical = [...inputs]
    .map((input) => ({ artifactId: input.artifactId, kind: input.kind, role: input.role }))
    .sort((a, b) => a.artifactId.localeCompare(b.artifactId));
  return sha256Hex(stableStringify(canonical));
}

export class FileArtifactStore {
  private readonly indexes = new Map<string, ArtifactMeta[]>();

  constructor(readonly root: string) {
    if (root.trim().length === 0) {
      throw new PhoenixError('ARTIFACT_WRITE_FAILED', 'artifact store root must not be empty', {});
    }
  }

  runRoot(runId: RunId): string {
    return join(this.root, runId);
  }

  /** Writes a validated JSON payload inside a provenance envelope. */
  writeJson<TPayload>(
    request: ArtifactWriteRequest,
    payload: TPayload,
    schema?: z.ZodType<TPayload>,
  ): WrittenArtifact {
    const validated = schema === undefined ? payload : schema.parse(payload);
    const envelope = {
      envelopeVersion: ARTIFACT_SCHEMA_VERSION,
      kind: request.kind,
      runId: request.runId,
      createdAt: nowIso(),
      producedBy: request.producedBy,
      inputs: request.inputs ?? [],
      payload: validated,
    };
    if (schema !== undefined) {
      // Validate the envelope too: a malformed producer block is a bug, not a runtime surprise.
      artifactEnvelopeSchema(schema).parse(envelope);
    }
    return this.writeBytes(request, Buffer.from(`${stableStringify(envelope)}\n`, 'utf8'), 'json');
  }

  writeText(request: ArtifactWriteRequest, content: string, format: ArtifactFormat = 'markdown'): WrittenArtifact {
    return this.writeBytes(request, Buffer.from(content, 'utf8'), format);
  }

  writeBuffer(request: ArtifactWriteRequest, bytes: Uint8Array, format: ArtifactFormat = 'binary'): WrittenArtifact {
    return this.writeBytes(request, Buffer.from(bytes), format);
  }

  private writeBytes(request: ArtifactWriteRequest, bytes: Buffer, format: ArtifactFormat): WrittenArtifact {
    const relativePath =
      request.relativePath ??
      defaultRelativePath(request.kind, request.slug, request.format ?? format);
    const absolutePath = this.resolveInsideRun(request.runId, relativePath);
    const sha256 = sha256Hex(bytes);
    const meta = artifactMetaSchema.parse({
      id: `art_${sha256}`,
      kind: request.kind,
      format: request.format ?? format,
      runId: request.runId,
      relativePath,
      sha256,
      bytes: bytes.byteLength,
      createdAt: nowIso(),
      producedBy: request.producedBy,
      inputs: request.inputs ?? [],
      ...(request.inputsHash !== undefined ? { inputsHash: request.inputsHash } : {}),
      ...(request.title !== undefined ? { title: request.title } : {}),
      tags: request.tags ?? [],
    });

    const deduplicated = this.alreadyStored(absolutePath, meta);
    if (!deduplicated) {
      mkdirSync(dirname(absolutePath), { recursive: true });
      writeAtomic(absolutePath, bytes);
    }
    this.appendIndex(meta);
    return { meta, absolutePath, deduplicated };
  }

  private alreadyStored(absolutePath: string, meta: ArtifactMeta): boolean {
    if (!existsSync(absolutePath)) return false;
    const existing = readFileSync(absolutePath);
    if (existing.byteLength !== meta.bytes) {
      // Same path, different content: refuse to overwrite evidence silently.
      throw new PhoenixError(
        'ARTIFACT_WRITE_FAILED',
        `refusing to overwrite ${meta.relativePath}: existing bytes differ from the new artifact`,
        { relativePath: meta.relativePath, existingBytes: existing.byteLength, newBytes: meta.bytes },
      );
    }
    return sha256Hex(existing) === meta.sha256;
  }

  /** Absolute path for an artifact, guaranteed to stay inside the run directory. */
  resolveInsideRun(runId: RunId, relativePath: string): string {
    if (isAbsolute(relativePath)) {
      throw new PhoenixError('ARTIFACT_WRITE_FAILED', `artifact path must be relative: ${relativePath}`, {
        relativePath,
      });
    }
    const runRoot = resolve(this.runRoot(runId));
    const target = resolve(runRoot, relativePath);
    if (target !== runRoot && !target.startsWith(runRoot + sep)) {
      throw new PhoenixError('ARTIFACT_WRITE_FAILED', `artifact path escapes the run directory: ${relativePath}`, {
        relativePath,
        runRoot,
        target,
      });
    }
    return target;
  }

  absolutePathOf(meta: ArtifactMeta): string {
    return this.resolveInsideRun(meta.runId, meta.relativePath);
  }

  list(runId: RunId, filter: ArtifactListFilter = {}): ArtifactMeta[] {
    const all = this.loadIndex(runId);
    return all.filter((meta) => {
      if (filter.kind !== undefined && meta.kind !== filter.kind) return false;
      if (filter.kinds !== undefined && !filter.kinds.includes(meta.kind)) return false;
      if (filter.producedByRole !== undefined && meta.producedBy.role !== filter.producedByRole) return false;
      if (filter.tag !== undefined && !meta.tags.includes(filter.tag)) return false;
      return true;
    });
  }

  /** The most recently written artifact of a kind — repairs supersede rather than mutate. */
  latest(runId: RunId, kind: ArtifactKind): ArtifactMeta | undefined {
    const matches = this.list(runId, { kind });
    return matches[matches.length - 1];
  }

  find(runId: RunId, artifactId: ArtifactId): ArtifactMeta | undefined {
    return this.loadIndex(runId).find((meta) => meta.id === artifactId);
  }

  readMeta(runId: RunId, artifactId: ArtifactId): ArtifactMeta {
    const meta = this.find(runId, artifactId);
    if (meta === undefined) {
      throw new PhoenixError('ARTIFACT_NOT_FOUND', `artifact ${artifactId} is not indexed for run ${runId}`, {
        artifactId,
        runId,
        indexed: this.loadIndex(runId).map((entry) => entry.id),
      });
    }
    return meta;
  }

  readBytes(meta: ArtifactMeta): Buffer {
    const path = this.absolutePathOf(meta);
    try {
      return readFileSync(path);
    } catch (error) {
      throw new PhoenixError('ARTIFACT_NOT_FOUND', `artifact file is missing: ${meta.relativePath}`, {
        artifactId: meta.id,
        path,
      }, error);
    }
  }

  readText(meta: ArtifactMeta): string {
    return this.readBytes(meta).toString('utf8');
  }

  /** Reads a JSON artifact, unwrapping the provenance envelope and validating the payload. */
  readJson<TPayload>(meta: ArtifactMeta, schema: z.ZodType<TPayload>): TPayload {
    const raw = this.readText(meta);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new PhoenixError('ARTIFACT_SCHEMA_INVALID', `artifact ${meta.id} is not valid JSON`, {
        artifactId: meta.id,
        relativePath: meta.relativePath,
      }, error);
    }
    if (isEnvelope(parsed)) {
      const envelope = artifactEnvelopeSchema(schema).safeParse(parsed);
      if (!envelope.success) {
        // Issue paths are reported against the payload, not the envelope: these strings are what
        // a repair prompt shows the model, and the model never sees the envelope.
        throw schemaFailure(meta, envelope.error.issues, 'payload.');
      }
      // Zod cannot relate the envelope's inferred payload type back to TPayload.
      return envelope.data.payload as TPayload;
    }
    const direct = schema.safeParse(parsed);
    if (!direct.success) throw schemaFailure(meta, direct.error.issues);
    return direct.data;
  }

  /** Re-hashes every indexed artifact of a run. Evidence that cannot be trusted is reported. */
  verify(runId: RunId): ArtifactIntegrityReport {
    const problems: ArtifactIntegrityProblem[] = [];
    const metas = this.loadIndex(runId);
    let ok = 0;
    for (const meta of metas) {
      const path = this.resolveInsideRun(runId, meta.relativePath);
      if (!existsSync(path)) {
        problems.push({
          artifactId: meta.id,
          relativePath: meta.relativePath,
          problem: 'missing',
          expectedSha256: meta.sha256,
          expectedBytes: meta.bytes,
        });
        continue;
      }
      const bytes = readFileSync(path);
      const actualSha256 = sha256Hex(bytes);
      if (actualSha256 !== meta.sha256) {
        problems.push({
          artifactId: meta.id,
          relativePath: meta.relativePath,
          problem: 'tampered',
          expectedSha256: meta.sha256,
          actualSha256,
          expectedBytes: meta.bytes,
          actualBytes: bytes.byteLength,
        });
        continue;
      }
      if (bytes.byteLength !== meta.bytes) {
        problems.push({
          artifactId: meta.id,
          relativePath: meta.relativePath,
          problem: 'size-mismatch',
          expectedSha256: meta.sha256,
          actualSha256,
          expectedBytes: meta.bytes,
          actualBytes: bytes.byteLength,
        });
        continue;
      }
      ok += 1;
    }
    return { runId, checked: metas.length, ok, problems, verifiedAt: nowIso() };
  }

  private appendIndex(meta: ArtifactMeta): void {
    const index = this.loadIndex(meta.runId);
    const withoutDuplicate = index.filter((entry) => entry.id !== meta.id);
    withoutDuplicate.push(meta);
    this.indexes.set(meta.runId, withoutDuplicate);
    const path = this.indexPath(meta.runId);
    mkdirSync(dirname(path), { recursive: true });
    writeAtomic(path, Buffer.from(`${JSON.stringify(withoutDuplicate, null, 2)}\n`, 'utf8'));
  }

  indexPath(runId: RunId): string {
    return join(this.runRoot(runId), 'index.json');
  }

  private loadIndex(runId: RunId): ArtifactMeta[] {
    const cached = this.indexes.get(runId);
    if (cached !== undefined) return cached;
    const path = this.indexPath(runId);
    if (!existsSync(path)) {
      this.indexes.set(runId, []);
      return [];
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch (error) {
      throw new PhoenixError('ARTIFACT_NOT_FOUND', `artifact index for run ${runId} is corrupt`, { path }, error);
    }
    const result = z.array(artifactMetaSchema).safeParse(parsed);
    if (!result.success) {
      throw new PhoenixError('ARTIFACT_SCHEMA_INVALID', `artifact index for run ${runId} is invalid`, {
        path,
        issues: result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      });
    }
    this.indexes.set(runId, result.data);
    return result.data;
  }
}

function isEnvelope(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    'envelopeVersion' in value &&
    'payload' in value &&
    (value as { envelopeVersion: unknown }).envelopeVersion === ARTIFACT_SCHEMA_VERSION
  );
}

function schemaFailure(
  meta: ArtifactMeta,
  issues: readonly z.ZodIssue[],
  stripPrefix?: string,
): PhoenixError {
  return new PhoenixError('ARTIFACT_SCHEMA_INVALID', `artifact ${meta.id} does not match its schema`, {
    artifactId: meta.id,
    kind: meta.kind,
    relativePath: meta.relativePath,
    issues: issues.slice(0, 20).map((issue) => {
      const path = issue.path.join('.') || '<root>';
      const relative =
        stripPrefix !== undefined && path.startsWith(stripPrefix) ? path.slice(stripPrefix.length) : path;
      return `${relative.length > 0 ? relative : '<root>'}: ${issue.message}`;
    }),
  });
}

/** Writes through a temporary file so a crash cannot leave a half-written artifact behind. */
function writeAtomic(path: string, bytes: Buffer): void {
  const temporary = `${path}.tmp-${process.pid}-${createHash('sha1').update(path).digest('hex').slice(0, 8)}`;
  try {
    writeFileSync(temporary, bytes);
    renameSync(temporary, path);
  } catch (error) {
    throw new PhoenixError('ARTIFACT_WRITE_FAILED', `failed to write artifact at ${path}`, { path }, error);
  }
}

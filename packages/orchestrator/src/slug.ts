import type { FileArtifactStore } from '@phoenix/artifact-store';
import { defaultRelativePath, type ArtifactKind, type RunId } from '@phoenix/shared';

/**
 * Artifact paths are immutable inside a run. A later attempt of the same stage keeps the canonical
 * name when it is free, and otherwise writes beside it under its own task id.
 */
export function slugAvoidingCollision(
  store: FileArtifactStore,
  runId: RunId,
  kind: ArtifactKind,
  preferred: string | undefined,
  taskId: string,
): string | undefined {
  const path = defaultRelativePath(kind, preferred);
  const taken = store.list(runId, { kind }).some((meta) => meta.relativePath === path);
  if (!taken) return preferred;
  const base = preferred ?? path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return `${base}-attempt-${taskId}`;
}

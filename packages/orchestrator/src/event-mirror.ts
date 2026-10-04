import { appendFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { phoenixEventSchema, type EventSink, type PhoenixEvent } from '@phoenix/shared';

/**
 * Append-only JSONL mirror of the run's event stream.
 *
 * The in-process `EventSequencer` is what the pipeline talks to; this file is what survives it. A
 * crashed run can be inspected, and the API can answer "what happened?" for a run that is no longer
 * in memory. `EventSequencer` routes sink failures to `onSinkError` rather than into the pipeline,
 * so a full disk degrades observability without corrupting execution.
 */

export const EVENT_MIRROR_RELATIVE_PATH = join('run', 'events.jsonl');

export class JsonlEventSink implements EventSink {
  readonly name = 'jsonl';

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
  }

  emit(event: PhoenixEvent): void {
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, 'utf8');
  }
}

export function eventMirrorPath(artifactRoot: string, runId: string): string {
  return join(artifactRoot, runId, EVENT_MIRROR_RELATIVE_PATH);
}

/** Reads a mirror back, validating every line: a corrupt event file is an error, not a skip. */
export function readEventMirror(path: string): PhoenixEvent[] {
  if (!existsSync(path)) return [];
  const content = readFileSync(path, 'utf8');
  const events: PhoenixEvent[] = [];
  const lines = content.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new Error(`event mirror line ${index + 1} is not valid JSON: ${line.slice(0, 200)}`, { cause: error });
    }
    events.push(phoenixEventSchema.parse(parsed));
  }
  return events;
}

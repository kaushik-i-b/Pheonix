import { nowIso } from './primitives.js';

/**
 * Structured JSON logging. Deliberately dependency-free: one line per event, stable key order,
 * secret redaction, and child loggers that carry context. Everything Phoenix logs is parseable.
 */

export const logLevelSchema = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
} as const;

export type LogLevel = keyof typeof logLevelSchema;

export interface LogRecord {
  time: string;
  level: LogLevel;
  message: string;
  [key: string]: unknown;
}

export interface Logger {
  readonly level: LogLevel;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const REDACTION_PATTERN = /(api[_-]?key|authorization|password|secret|token)/i;

export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry, depth + 1));
  const source = value as Record<string, unknown>;
  const target: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(source)) {
    if (REDACTION_PATTERN.test(key)) {
      target[key] = typeof entry === 'string' ? `${entry.slice(0, 4)}***redacted***` : '***redacted***';
      continue;
    }
    target[key] = redactSecrets(entry, depth + 1);
  }
  return target;
}

export interface LogSink {
  write(line: string): void;
}

export const consoleLogSink: LogSink = {
  write(line: string): void {
    process.stdout.write(`${line}\n`);
  },
};

export const stderrLogSink: LogSink = {
  write(line: string): void {
    process.stderr.write(`${line}\n`);
  },
};

export class MemoryLogSink implements LogSink {
  readonly lines: string[] = [];
  write(line: string): void {
    this.lines.push(line);
  }
  records(): LogRecord[] {
    return this.lines.map((line) => JSON.parse(line) as LogRecord);
  }
  clear(): void {
    this.lines.length = 0;
  }
}

export interface JsonLoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
  /** Component name, e.g. `orchestrator`, `agent-runtime`, `api`. */
  component?: string;
}

export class JsonLogger implements Logger {
  readonly level: LogLevel;
  private readonly sink: LogSink;
  private readonly bindings: Record<string, unknown>;

  constructor(options: JsonLoggerOptions = {}) {
    this.level = options.level ?? 'info';
    this.sink = options.sink ?? stderrLogSink;
    this.bindings = {
      ...(options.component !== undefined ? { component: options.component } : {}),
      ...(options.bindings ?? {}),
    };
  }

  child(bindings: Record<string, unknown>): Logger {
    return new JsonLogger({
      level: this.level,
      sink: this.sink,
      bindings: { ...this.bindings, ...bindings },
    });
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.write('debug', message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.write('info', message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.write('warn', message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.write('error', message, fields);
  }

  private write(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    if (logLevelSchema[level] < logLevelSchema[this.level]) return;
    const record: LogRecord = {
      time: nowIso(),
      level,
      message,
      ...(redactSecrets(this.bindings) as Record<string, unknown>),
      ...(fields !== undefined ? (redactSecrets(fields) as Record<string, unknown>) : {}),
    };
    this.sink.write(JSON.stringify(record));
  }
}

export function createLogger(options: JsonLoggerOptions = {}): Logger {
  return new JsonLogger(options);
}

/** A logger that discards everything; used where logging is optional and noise is unwanted. */
export const silentLogger: Logger = new JsonLogger({ level: 'silent', sink: { write: () => {} } });

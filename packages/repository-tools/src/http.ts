import { PhoenixError, nowIso, type IsoTimestamp } from '@phoenix/shared';

/**
 * HTTP access to a running system under test.
 *
 * Characterization and differential testing have to exercise the legacy system the way its users
 * do, which means real HTTP calls. The target allowlist is enforced here, in code, before any
 * request leaves the process: a prompt cannot talk Phoenix into reaching an unlisted host.
 */

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;
export type HttpMethod = (typeof HTTP_METHODS)[number];

export interface HttpRequest {
  method?: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

export interface HttpExchange {
  request: {
    method: HttpMethod;
    url: string;
    headers: Record<string, string>;
    body?: string;
  };
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  bodyText: string;
  /** Present only when the response body parsed as JSON. */
  json?: unknown;
  durationMs: number;
  at: IsoTimestamp;
  /** Network-level failure; an HTTP 4xx/5xx is a *result*, not an error. */
  error?: { message: string; code: string };
}

const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'set-cookie', 'x-api-key', 'proxy-authorization']);

export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    redacted[name] = SENSITIVE_HEADERS.has(name.toLowerCase()) ? '[redacted]' : value;
  }
  return redacted;
}

export function assertHttpTargetAllowed(url: string, allowedTargets: readonly string[]): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new PhoenixError('TOOL_TARGET_NOT_ALLOWED', `not a valid URL: ${url}`, { url }, error);
  }
  const canonical = parsed.toString();
  const allowed = allowedTargets.some((target) => canonical.startsWith(target) || url.startsWith(target));
  if (!allowed) {
    throw new PhoenixError('TOOL_TARGET_NOT_ALLOWED', `http target ${canonical} is not permitted for this role`, {
      url: canonical,
      allowedTargets: [...allowedTargets],
    });
  }
}

export interface PerformHttpOptions {
  allowedTargets: readonly string[];
  fetchImpl?: typeof fetch;
  defaultTimeoutMs?: number;
  maxBodyBytes?: number;
}

export async function performHttpRequest(request: HttpRequest, options: PerformHttpOptions): Promise<HttpExchange> {
  assertHttpTargetAllowed(request.url, options.allowedTargets);
  const method = request.method ?? 'GET';
  const timeoutMs = request.timeoutMs ?? options.defaultTimeoutMs ?? 30_000;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const headers = request.headers ?? {};
  const startedAt = nowIso();
  const started = Date.now();

  const base = {
    request: {
      method,
      url: request.url,
      headers: redactHeaders(headers),
      ...(request.body !== undefined ? { body: request.body.slice(0, 4000) } : {}),
    },
    at: startedAt,
  };

  let response: Response;
  try {
    response = await fetchImpl(request.url, {
      method,
      headers,
      ...(request.body !== undefined ? { body: request.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      ...base,
      bodyText: '',
      durationMs: Date.now() - started,
      error: {
        code: timedOut ? 'timeout' : 'network',
        message: timedOut
          ? `request timed out after ${timeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      },
    };
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    responseHeaders[name] = value;
  });

  const maxBodyBytes = options.maxBodyBytes ?? 4_000_000;
  const raw = await response.arrayBuffer();
  const truncated = raw.byteLength > maxBodyBytes;
  const bodyText = new TextDecoder().decode(truncated ? raw.slice(0, maxBodyBytes) : raw);

  const exchange: HttpExchange = {
    ...base,
    status: response.status,
    statusText: response.statusText,
    responseHeaders: redactHeaders(responseHeaders),
    bodyText: truncated ? `${bodyText}\n[body truncated at ${maxBodyBytes} bytes]` : bodyText,
    durationMs: Date.now() - started,
  };

  const parsed = tryParseJson(exchange.bodyText);
  return parsed === undefined ? exchange : { ...exchange, json: parsed };
}

function tryParseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

import type { HttpEndpoint, EntryPoint } from '@phoenix/shared';
import type { JavaFile, JavaMethod } from './java.js';

/**
 * HTTP entry-point extraction for annotation-driven Java web layers (Spring MVC, JAX-RS).
 *
 * Routes are structural facts: the annotation text states the method and the path. What is *not*
 * stated — the semantics of the handler — is left for the Archaeologist. Anomalies are recorded
 * here only when they are visible in the source, e.g. an explicit non-success status code.
 */

export interface ExtractedEndpoint {
  id: string;
  method: HttpEndpoint['method'];
  path: string;
  handler: HttpEndpoint['handler'];
  anomalies: string[];
  requestBodySchemaHint: string | undefined;
  responseSchemaHint: string | undefined;
  /** Handler parameters, used later to build request shapes for characterization. */
  parameters: string;
}

export interface ExtractedEntryPoint {
  id: string;
  kind: EntryPoint['kind'];
  label: string;
  location: EntryPoint['location'];
  notes?: string;
}

export interface WebLayerExtraction {
  endpoints: ExtractedEndpoint[];
  entryPoints: ExtractedEntryPoint[];
}

const CLASS_LEVEL_MAPPING = new Set(['RequestMapping', 'Path']);
const METHOD_MAPPING: Record<string, HttpEndpoint['method']> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  PatchMapping: 'PATCH',
  DeleteMapping: 'DELETE',
  RequestMapping: 'GET',
  GET: 'GET',
  POST: 'POST',
  PUT: 'PUT',
  PATCH: 'PATCH',
  DELETE: 'DELETE',
  HEAD: 'HEAD',
  OPTIONS: 'OPTIONS',
};

const NON_SUCCESS_STATUS = /\b(?:INTERNAL_SERVER_ERROR|BAD_REQUEST|NOT_FOUND|CONFLICT|UNPROCESSABLE_ENTITY|SERVICE_UNAVAILABLE|status\s*\(\s*[45]\d\d)/;

export function extractWebLayer(file: JavaFile): WebLayerExtraction {
  const endpoints: ExtractedEndpoint[] = [];
  const entryPoints: ExtractedEntryPoint[] = [];

  const controllerType = file.types.find((type) =>
    type.annotations.some((annotation) => annotation.name === 'RestController' || annotation.name === 'Controller' || annotation.name === 'Path'),
  );
  const classPrefix = controllerType === undefined ? '' : classLevelPrefix(file);

  for (const method of file.methods) {
    if (isMainMethod(method)) {
      entryPoints.push({
        id: `ep-startup-${file.relativePath}-${method.line}`,
        kind: 'startup',
        label: `${file.packageName ?? ''}.${method.declaringType ?? ''}#${method.name}`.replace(/^\.+/, ''),
        location: { path: file.relativePath, startLine: method.line, endLine: method.endLine, symbol: method.name },
        notes: 'process entry point (public static void main)',
      });
    }
    for (const annotation of method.annotations) {
      const simple = annotation.name.split('.').pop() ?? annotation.name;
      const mapped = METHOD_MAPPING[simple];
      if (mapped === undefined) continue;
      for (const path of annotationPaths(annotation.arguments)) {
        const method2 = resolveHttpMethod(simple, annotation.arguments, mapped);
        const fullPath = joinPath(classPrefix, path);
        const responseStatus = method.annotations.find((entry) => entry.name === 'ResponseStatus');
        const anomalies: string[] = [];
        if (responseStatus !== undefined && NON_SUCCESS_STATUS.test(responseStatus.arguments)) {
          // The declared status value stays out of the anomaly: it is source text, and an index that
          // quotes it lets a reader assert the handler's behavior without opening the file.
          anomalies.push('declares a non-success HTTP status on the handler');
        }
        if (/\bResponseEntity\b/.test(method.returnType) && NON_SUCCESS_STATUS.test(method.body)) {
          anomalies.push('handler builds an error status inside its body');
        }
        if (method.annotations.some((entry) => entry.name === 'SuppressWarnings')) {
          anomalies.push('handler suppresses compiler warnings');
        }
        if (simple === 'RequestMapping' && !/RequestMethod\./.test(annotation.arguments)) {
          anomalies.push(`no HTTP verb declared on ${method.name}; the route accepts every method`);
        }
        endpoints.push({
          id: `ep-http-${method2}-${fullPath}-${file.relativePath}:${method.line}`
            .replace(/[^A-Za-z0-9._:/-]+/g, '-')
            .slice(0, 200),
          method: method2,
          path: fullPath,
          handler: {
            path: file.relativePath,
            startLine: method.line,
            endLine: method.endLine,
            symbol: `${method.declaringType ?? ''}#${method.name}`.replace(/^#/, ''),
          },
          anomalies,
          requestBodySchemaHint: requestHint(method),
          responseSchemaHint: method.returnType.length > 0 ? method.returnType : undefined,
          parameters: method.parameters,
        });
      }
    }
  }

  for (const method of file.methods) {
    const scheduled = method.annotations.find((annotation) => annotation.name === 'Scheduled');
    if (scheduled === undefined) continue;
    const cron = /cron\s*=\s*"([^"]*)"/.exec(scheduled.arguments)?.[1];
    entryPoints.push({
      id: `ep-scheduled-${file.relativePath}-${method.line}`,
      kind: 'scheduled',
      label: `${method.declaringType ?? ''}#${method.name}`,
      location: { path: file.relativePath, startLine: method.line, endLine: method.endLine, symbol: method.name },
      notes: cron === undefined ? scheduled.arguments : `cron: ${cron}`,
    });
  }

  return { endpoints, entryPoints };
}

function classLevelPrefix(file: JavaFile): string {
  for (const type of file.types) {
    for (const annotation of type.annotations) {
      const simple = annotation.name.split('.').pop() ?? annotation.name;
      if (!CLASS_LEVEL_MAPPING.has(simple)) continue;
      const paths = literalPaths(annotation.arguments);
      if (paths.length > 0) return paths[0] ?? '';
    }
  }
  return '';
}

function annotationPaths(argumentText: string): string[] {
  const paths = literalPaths(argumentText);
  // A mapping annotation with no path binds to the class prefix alone.
  return paths.length > 0 ? paths : [''];
}

/** Quoted strings inside an annotation argument list, in source order. */
export function literalPaths(argumentText: string): string[] {
  const paths: string[] = [];
  for (const match of argumentText.matchAll(/"([^"]*)"/g)) {
    const value = match[1];
    if (value !== undefined) paths.push(value);
  }
  return paths;
}

function resolveHttpMethod(
  annotationName: string,
  argumentText: string,
  fallback: HttpEndpoint['method'],
): HttpEndpoint['method'] {
  if (annotationName !== 'RequestMapping') return fallback;
  const declared = /RequestMethod\.([A-Z]+)/.exec(argumentText)?.[1];
  if (declared !== undefined && declared in METHOD_MAPPING) return METHOD_MAPPING[declared] ?? fallback;
  // A @RequestMapping with no declared verb accepts every method. Naming one here would be a guess,
  // so the caller records the ambiguity as an endpoint anomaly instead.
  return fallback;
}

function isMainMethod(method: JavaMethod): boolean {
  return method.name === 'main' && method.modifiers.includes('static') && /\bString\s*\[\s*\]\s+\w+/.test(method.parameters);
}

interface HandlerParameter {
  annotations: string[];
  type: string;
  name: string;
}

function parseParameters(parameterText: string): HandlerParameter[] {
  const parameters: HandlerParameter[] = [];
  for (const entry of splitParameters(parameterText)) {
    const text = entry.trim();
    if (text.length === 0) continue;
    const annotations = [...text.matchAll(/@(\w+)(?:\([^)]*\))?/g)].map((match) => match[1] ?? '');
    const withoutAnnotations = text.replace(/@(\w+)(?:\([^)]*\))?/g, '').replace(/\bfinal\b/g, '').trim();
    const parts = withoutAnnotations.split(/\s+/);
    const name = parts[parts.length - 1] ?? '';
    const type = parts.slice(0, -1).join(' ');
    parameters.push({ annotations, type, name });
  }
  return parameters;
}

/** Split a parameter list on commas that are not inside `<...>` or `(...)`. */
function splitParameters(parameterText: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of parameterText) {
    if (character === '<' || character === '(' || character === '[') depth += 1;
    if (character === '>' || character === ')' || character === ']') depth = Math.max(0, depth - 1);
    if (character === ',' && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

function requestHint(method: JavaMethod): string | undefined {
  const parameters = parseParameters(method.parameters);
  if (parameters.length === 0) return undefined;
  const described = parameters.map((parameter) => {
    const source =
      parameter.annotations.find((annotation) => ['RequestBody', 'RequestParam', 'PathVariable', 'RequestHeader'].includes(annotation)) ??
      'param';
    return `${source}:${parameter.type}${parameter.name.length > 0 ? ` ${parameter.name}` : ''}`;
  });
  return described.join(', ').slice(0, 2000);
}

export function joinPath(prefix: string, path: string): string {
  const left = prefix.trim();
  const right = path.trim();
  if (left.length === 0 && right.length === 0) return '/';
  const joined = `${left.endsWith('/') ? left.slice(0, -1) : left}/${right.startsWith('/') ? right.slice(1) : right}`;
  const normalized = joined.replace(/\/{2,}/g, '/');
  return normalized.length === 0 ? '/' : normalized.startsWith('/') ? normalized : `/${normalized}`;
}

/** Route collisions are a real legacy hazard: two handlers, one URL, order-dependent behaviour. */
export function findDuplicateRoutes(endpoints: readonly ExtractedEndpoint[]): Map<string, ExtractedEndpoint[]> {
  const byRoute = new Map<string, ExtractedEndpoint[]>();
  for (const endpoint of endpoints) {
    const key = `${endpoint.method} ${endpoint.path}`;
    const existing = byRoute.get(key) ?? [];
    existing.push(endpoint);
    byRoute.set(key, existing);
  }
  for (const [key, group] of byRoute) {
    if (group.length < 2) byRoute.delete(key);
  }
  return byRoute;
}

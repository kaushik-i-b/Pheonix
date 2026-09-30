import type { DependencyEdge, DependencyMap, DependencyNode } from '@phoenix/shared';
import { nowIso } from '@phoenix/shared';
import { ANALYSIS_GENERATOR, evidenceId } from './evidence.js';
import { lineAt } from './scanner.js';
import type { JavaFile, JavaMethod, JavaTypeDeclaration } from './java.js';
import type { ExtractedEndpoint } from './http-endpoints.js';
import type { SqlFileAnalysis } from './sql.js';
import { looksLikeSql, sqlVerbOf, tablesOf } from './sql-text.js';

/**
 * Structural dependency graph.
 *
 * Nodes are classes, methods, tables, endpoints and database-side functions; edges are what the
 * source literally shows (imports, extends, calls, table reads/writes, route handlers). Calls are
 * resolved at *method* granularity, not class granularity: a class-level "A uses B" edge cannot say
 * which handler reaches which table, and every route in a fat controller would then look identical.
 *
 * A call whose receiver type cannot be resolved to exactly one project class produces no edge.
 * Guessing a target would put a fiction into the evidence graph.
 */

export interface GraphInput {
  javaFiles: readonly JavaFile[];
  sqlFiles: readonly SqlFileAnalysis[];
  endpoints: readonly ExtractedEndpoint[];
  generatedAt?: string;
}

interface ClassRecord {
  id: string;
  name: string;
  qualifiedName: string;
  file: JavaFile;
  declaration: JavaTypeDeclaration;
  node: DependencyNode;
}

interface MethodRecord {
  id: string;
  name: string;
  qualifiedType: string;
  file: JavaFile;
  method: JavaMethod;
}

const MAX_SUPERTYPE_DEPTH = 4;

const SPRING_DATA_REPOSITORIES = new Set([
  'Repository',
  'CrudRepository',
  'PagingAndSortingRepository',
  'JpaRepository',
  'ListCrudRepository',
  'ListPagingAndSortingRepository',
]);

/** Derived-query verbs whose read/write intent Spring Data states in the method name itself. */
const WRITE_VERB = /^(?:save|delete|remove|insert|update|persist)/;
const READ_VERB = /^(?:find|read|get|query|count|exists|stream)/;

function derivedQueryAccess(methodName: string): 'reads' | 'writes' | undefined {
  if (WRITE_VERB.test(methodName)) return 'writes';
  if (READ_VERB.test(methodName)) return 'reads';
  return undefined;
}

export function methodNodeId(qualifiedType: string, methodName: string): string {
  return `method:${qualifiedType}#${methodName}`;
}

const ACCESSOR_BODY = /^(?:return\s+(?:this\s*\.\s*)?[\w$]+\s*;|this\s*\.\s*[\w$]+\s*=\s*[\w$]+\s*;)$/;

/**
 * Getters and setters carry no behaviour. They stay in the dependency graph, but a data flow that
 * listed every accessor a handler touches would bury the steps that actually move data.
 */
export function trivialAccessorIds(javaFiles: readonly JavaFile[]): Set<string> {
  const ids = new Set<string>();
  for (const file of javaFiles) {
    for (const method of file.methods) {
      const type = method.declaringType;
      if (type === undefined || method.kind === 'constructor') continue;
      const body = stripLiterals(method.body).replace(/\s+/g, ' ').trim();
      if (!ACCESSOR_BODY.test(body)) continue;
      ids.add(methodNodeId(file.packageName === undefined ? type : `${file.packageName}.${type}`, method.name));
    }
  }
  return ids;
}

export function buildDependencyMap(input: GraphInput): DependencyMap {
  const generatedAt = input.generatedAt ?? nowIso();
  const nodes = new Map<string, DependencyNode>();
  const edges = new Map<string, DependencyEdge>();
  const classes: ClassRecord[] = [];
  const classBySimpleName = new Map<string, ClassRecord[]>();
  const methodsByType = new Map<string, Map<string, MethodRecord>>();

  for (const file of input.javaFiles) {
    for (const type of file.types) {
      if (type.kind === 'annotation') continue;
      const qualified = file.packageName === undefined ? type.name : `${file.packageName}.${type.name}`;
      const id = `class:${qualified}`;
      if (nodes.has(id)) continue;
      const node: DependencyNode = {
        id,
        kind: 'class',
        label: type.name,
        location: { path: file.relativePath, startLine: type.line, endLine: type.endLine, symbol: type.name },
      };
      nodes.set(id, node);
      const record: ClassRecord = { id, name: type.name, qualifiedName: qualified, file, declaration: type, node };
      classes.push(record);
      const existing = classBySimpleName.get(type.name) ?? [];
      existing.push(record);
      classBySimpleName.set(type.name, existing);
    }
  }

  const addEdge = (from: string, to: string, kind: DependencyEdge['kind'], evidencePath: string, line?: number): void => {
    if (from === to) return;
    const key = `${from}->${to}:${kind}`;
    if (edges.has(key)) return;
    edges.set(key, {
      from,
      to,
      kind,
      evidence: [
        {
          id: evidenceId('edge', key),
          kind: 'source-code',
          collectedAt: generatedAt,
          collectedBy: ANALYSIS_GENERATOR,
          location: { path: evidencePath, ...(line !== undefined ? { startLine: line } : {}) },
        },
      ],
    });
  };

  const addNode = (node: DependencyNode): void => {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
  };

  // --- class-level edges: imports and inheritance -------------------------------

  for (const record of classes) {
    const file = record.file;

    for (const imported of file.imports) {
      const simple = imported.slice(imported.lastIndexOf('.') + 1);
      if (simple === '*') continue;
      for (const target of classBySimpleName.get(simple) ?? []) {
        if (target.qualifiedName === imported) addEdge(record.id, target.id, 'imports', file.relativePath);
      }
    }

    for (const parent of [record.declaration.superclass, ...record.declaration.interfaces]) {
      if (parent === undefined) continue;
      const resolved = resolveClass(simpleTypeName(parent), file, classBySimpleName);
      if (resolved !== undefined) addEdge(record.id, resolved.id, 'extends', file.relativePath, record.declaration.line);
    }
  }

  // --- method nodes ---------------------------------------------------------------

  for (const file of input.javaFiles) {
    for (const method of file.methods) {
      if (method.kind === 'constructor') continue;
      const typeName = method.declaringType;
      if (typeName === undefined) continue;
      const owner = resolveClass(typeName, file, classBySimpleName);
      if (owner === undefined) continue;
      // Overloads collapse into one node: they share a name, and the evidence is the line range.
      const id = methodNodeId(owner.qualifiedName, method.name);
      if (nodes.has(id)) continue;
      nodes.set(id, {
        id,
        kind: 'function',
        label: `${typeName}#${method.name}`,
        location: { path: file.relativePath, startLine: method.line, endLine: method.endLine, symbol: `${typeName}#${method.name}` },
      });
      const byName = methodsByType.get(owner.qualifiedName) ?? new Map<string, MethodRecord>();
      byName.set(method.name, { id, name: method.name, qualifiedType: owner.qualifiedName, file, method });
      methodsByType.set(owner.qualifiedName, byName);
    }
  }

  // --- Spring Data repositories: derived queries are SQL the source never spells out --

  const entityTable = new Map<string, string>();
  for (const record of classes) {
    const annotation = record.declaration.annotations.find((entry) => entry.name === 'Table');
    const name = annotation === undefined ? undefined : /name\s*=\s*"([^"]+)"/.exec(annotation.arguments)?.[1];
    // No @Table means the table name comes from a naming strategy, which is a guess, not evidence.
    if (name !== undefined) entityTable.set(record.qualifiedName, name);
  }

  const repositories = new Map<string, { table: string; record: ClassRecord }>();
  for (const record of classes) {
    const parents = [record.declaration.superclass, ...record.declaration.interfaces].filter(
      (parent): parent is string => parent !== undefined,
    );
    const base = parents.find((parent) => SPRING_DATA_REPOSITORIES.has(simpleTypeName(parent)));
    if (base === undefined) continue;
    const entityName = simpleTypeName(/<\s*([\w$.]+)/.exec(base)?.[1] ?? '');
    if (entityName.length === 0) continue;
    const entity = resolveClass(entityName, record.file, classBySimpleName);
    const table = entity === undefined ? undefined : entityTable.get(entity.qualifiedName);
    if (table === undefined) continue;
    repositories.set(record.qualifiedName, { table, record });
  }

  const ensureRepositoryMethod = (qualifiedType: string, methodName: string): string | undefined => {
    const repository = repositories.get(qualifiedType);
    if (repository === undefined) return undefined;
    const access = derivedQueryAccess(methodName);
    // An unrecognised verb gets a node but no table claim: Phoenix records what it knows.
    const id = methodNodeId(qualifiedType, methodName);
    const declared = methodsByType.get(qualifiedType)?.get(methodName);
    if (declared === undefined) {
      addNode({
        id,
        kind: 'function',
        label: `${repository.record.name}#${methodName}`,
        location: {
          path: repository.record.file.relativePath,
          startLine: repository.record.declaration.line,
          symbol: `${repository.record.name}#${methodName}`,
        },
      });
    }
    if (access !== undefined) {
      const tableId = `table:${repository.table}`;
      addNode({ id: tableId, kind: 'table', label: repository.table });
      addEdge(id, tableId, access, repository.record.file.relativePath, repository.record.declaration.line);
    }
    return id;
  };

  for (const qualifiedType of repositories.keys()) {
    for (const methodName of methodsByType.get(qualifiedType)?.keys() ?? []) {
      ensureRepositoryMethod(qualifiedType, methodName);
    }
  }

  const lookupMethod = (typeName: string, methodName: string, context: JavaFile, depth = 0): MethodRecord | undefined => {
    const owner = resolveClass(typeName, context, classBySimpleName);
    if (owner === undefined) return undefined;
    const direct = methodsByType.get(owner.qualifiedName)?.get(methodName);
    if (direct !== undefined) return direct;
    if (depth >= MAX_SUPERTYPE_DEPTH) return undefined;
    for (const parent of [owner.declaration.superclass, ...owner.declaration.interfaces]) {
      if (parent === undefined) continue;
      const inherited = lookupMethod(simpleTypeName(parent), methodName, owner.file, depth + 1);
      if (inherited !== undefined) return inherited;
    }
    return undefined;
  };

  // --- method-level call edges -----------------------------------------------------

  for (const byName of methodsByType.values()) {
    for (const record of byName.values()) {
      const code = stripLiterals(record.method.body);
      const bindings = bindingsFor(record.file, record.method, code);
      for (const match of code.matchAll(/([A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/g)) {
        const receiver = match[1] ?? '';
        const called = match[2] ?? '';
        if (receiver.length === 0 || called.length === 0) continue;
        const typeName = bindings.get(receiver) ?? (isClassName(receiver) ? receiver : undefined);
        if (typeName === undefined) continue;
        const owner = resolveClass(typeName, record.file, classBySimpleName);
        if (owner === undefined) continue;
        // An inherited repository method (`repo.findById(id)`) has no declaration in this project.
        const target = lookupMethod(typeName, called, record.file)?.id ?? ensureRepositoryMethod(owner.qualifiedName, called);
        if (target === undefined) continue;
        addEdge(record.id, target, 'calls', record.file.relativePath, record.method.line);
      }
    }
  }

  // --- table access, resolved per method ------------------------------------------

  for (const byName of methodsByType.values()) {
    for (const record of byName.values()) {
      for (const access of tableAccessIn(record.file, record.method)) {
        const tableId = `table:${access.table}`;
        addNode({ id: tableId, kind: 'table', label: access.table });
        addEdge(record.id, tableId, access.writes ? 'writes' : 'reads', record.file.relativePath, access.line);
      }
    }
  }

  // --- SQL files: schema objects and database-side behaviour -----------------------

  for (const sqlFile of input.sqlFiles) {
    for (const statement of sqlFile.statements) {
      for (const table of statement.tables) {
        addNode({ id: `table:${table}`, kind: 'table', label: table });
      }
    }
    for (const object of sqlFile.objects) {
      if (object.kind === 'trigger' || object.kind === 'function') {
        const id = `${object.kind}:${object.name}`;
        addNode({ id, kind: 'function', label: object.name, location: { path: sqlFile.relativePath, startLine: object.line, symbol: object.name } });
        if (object.onTable !== undefined) {
          addNode({ id: `table:${object.onTable}`, kind: 'table', label: object.onTable });
          addEdge(id, `table:${object.onTable}`, 'triggers', sqlFile.relativePath, object.line);
        }
      }
      if (object.kind === 'table') {
        addNode({ id: `table:${object.name}`, kind: 'table', label: object.name, location: { path: sqlFile.relativePath, startLine: object.line } });
      }
    }
  }

  // --- endpoints bind to the handler method, not just its class ---------------------

  for (const endpoint of input.endpoints) {
    const id = endpointId(endpoint);
    addNode({ id, kind: 'endpoint', label: `${endpoint.method} ${endpoint.path}`, location: endpoint.handler });
    const handlerFile = input.javaFiles.find((file) => file.relativePath === endpoint.handler.path);
    if (handlerFile === undefined) continue;
    const symbol = endpoint.handler.symbol ?? '';
    const separator = symbol.indexOf('#');
    if (separator === -1) continue;
    const typeName = symbol.slice(0, separator);
    const methodName = symbol.slice(separator + 1);
    if (typeName.length === 0 || methodName.length === 0) continue;
    const handler = lookupMethod(typeName, methodName, handlerFile);
    if (handler === undefined) continue;
    addEdge(id, handler.id, 'http', endpoint.handler.path, endpoint.handler.startLine);
  }

  const nodeList = [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id));
  const edgeList = [...edges.values()].sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

  return {
    schemaVersion: 1,
    generatedAt,
    generator: ANALYSIS_GENERATOR,
    nodes: nodeList,
    edges: edgeList,
    hotspots: computeHotspots(nodeList, edgeList),
    cycles: findCycles(edgeList),
  };
}

/**
 * Picks the one project class a simple name refers to. Ambiguity is resolved by import, then by
 * "declared in the same file"; anything still ambiguous yields nothing rather than a coin flip.
 */
function resolveClass(
  simpleName: string,
  context: JavaFile,
  classBySimpleName: Map<string, ClassRecord[]>,
): ClassRecord | undefined {
  const candidates = classBySimpleName.get(simpleName);
  if (candidates === undefined || candidates.length === 0) return undefined;
  if (candidates.length === 1) return candidates[0];
  const sameFile = candidates.filter((candidate) => candidate.file.relativePath === context.relativePath);
  if (sameFile.length === 1) return sameFile[0];
  const imported = candidates.filter((candidate) => context.imports.includes(candidate.qualifiedName));
  if (imported.length === 1) return imported[0];
  return undefined;
}

function simpleTypeName(raw: string): string {
  const withoutGenerics = raw.replace(/<[^>]*>/g, '').trim();
  const withoutArray = withoutGenerics.replace(/\[\s*\]/g, '').trim();
  return withoutArray.slice(withoutArray.lastIndexOf('.') + 1);
}

/** Java class names start with an upper-case letter; `foo.bar(` receivers do not. */
function isClassName(token: string): boolean {
  return /^[A-Z]/.test(token);
}

/** String and character literals are removed so that prose cannot be mistaken for code. */
export function stripLiterals(text: string): string {
  return text.replace(/"(?:[^"\\\n]|\\.)*"/g, '""').replace(/'(?:[^'\\\n]|\\.)*'/g, "' '");
}

/** Variable name → declared simple type, from fields, parameters and local declarations. */
function bindingsFor(file: JavaFile, method: JavaMethod, code: string): Map<string, string> {
  const bindings = new Map<string, string>();
  for (const field of file.fields) bindings.set(field.name, simpleTypeName(field.type));
  for (const parameter of splitTopLevel(method.parameters, ',')) {
    const text = parameter.replace(/@(\w+)(?:\([^)]*\))?/g, '').replace(/\bfinal\b/g, '').trim();
    if (text.length === 0) continue;
    const parts = text.split(/\s+/);
    const name = parts[parts.length - 1] ?? '';
    const type = parts.slice(0, -1).join(' ');
    if (name.length === 0 || type.length === 0) continue;
    bindings.set(name, simpleTypeName(type));
  }
  for (const match of code.matchAll(/\b([A-Z][A-Za-z0-9_$]*)\s+([a-z_$][A-Za-z0-9_$]*)\s*=/g)) {
    const type = match[1];
    const name = match[2];
    if (type === undefined || name === undefined) continue;
    bindings.set(name, type);
  }
  return bindings;
}

/** Split on a separator that is not nested inside `<...>`, `(...)` or `[...]`. */
export function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const character of text) {
    if (character === '<' || character === '(' || character === '[') depth += 1;
    if (character === '>' || character === ')' || character === ']') depth = Math.max(0, depth - 1);
    if (character === separator && depth === 0) {
      parts.push(current);
      current = '';
      continue;
    }
    current += character;
  }
  if (current.trim().length > 0) parts.push(current);
  return parts;
}

interface TableAccess {
  table: string;
  writes: boolean;
  line: number;
}

/** Every SQL literal inside a method's line range, reduced to the tables it reads and writes. */
function tableAccessIn(file: JavaFile, method: JavaMethod): TableAccess[] {
  const accesses = new Map<string, TableAccess>();
  for (const literal of file.literals) {
    if (!looksLikeSql(literal.value)) continue;
    const line = lineAt(file.scanned.lineStarts, literal.start);
    if (line < method.line || line > method.endLine) continue;
    const verb = sqlVerbOf(literal.value);
    const writes = verb === 'insert' || verb === 'update' || verb === 'delete' || verb === 'ddl';
    for (const table of tablesOf(literal.value)) {
      const existing = accesses.get(table);
      if (existing === undefined) {
        accesses.set(table, { table, writes, line });
        continue;
      }
      // A table that is both read and written by the same method is reported as a write: the write
      // is the part a migration can get wrong.
      if (writes) accesses.set(table, { ...existing, writes: true });
    }
  }
  return [...accesses.values()].sort((a, b) => a.table.localeCompare(b.table));
}

export function computeHotspots(
  nodes: readonly DependencyNode[],
  edges: readonly DependencyEdge[],
): DependencyMap['hotspots'] {
  const inbound = new Map<string, number>();
  const outbound = new Map<string, number>();
  for (const node of nodes) {
    inbound.set(node.id, 0);
    outbound.set(node.id, 0);
  }
  for (const edge of edges) {
    outbound.set(edge.from, (outbound.get(edge.from) ?? 0) + 1);
    inbound.set(edge.to, (inbound.get(edge.to) ?? 0) + 1);
  }
  return nodes
    .map((node) => ({ id: node.id, inbound: inbound.get(node.id) ?? 0, outbound: outbound.get(node.id) ?? 0 }))
    .filter((entry) => entry.inbound + entry.outbound > 0)
    .sort((a, b) => b.inbound - a.inbound || b.outbound - a.outbound || a.id.localeCompare(b.id))
    .slice(0, 20);
}

/** Tarjan's strongly-connected components; any component larger than one node is a dependency cycle. */
export function findCycles(edges: readonly DependencyEdge[]): string[][] {
  const adjacency = new Map<string, string[]>();
  const nodes = new Set<string>();
  for (const edge of edges) {
    nodes.add(edge.from);
    nodes.add(edge.to);
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }

  const index = new Map<string, number>();
  const lowLink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const strongConnect = (root: string): void => {
    // Iterative Tarjan: legacy repositories can have deep chains and the call stack is not ours to spend.
    const work: { node: string; childIndex: number }[] = [{ node: root, childIndex: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);

    while (work.length > 0) {
      const frame = work[work.length - 1];
      if (frame === undefined) break;
      const children = adjacency.get(frame.node) ?? [];
      if (frame.childIndex < children.length) {
        const child = children[frame.childIndex];
        frame.childIndex += 1;
        if (child === undefined) continue;
        if (!index.has(child)) {
          index.set(child, counter);
          lowLink.set(child, counter);
          counter += 1;
          stack.push(child);
          onStack.add(child);
          work.push({ node: child, childIndex: 0 });
          continue;
        }
        if (onStack.has(child)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node) ?? Number.MAX_SAFE_INTEGER, index.get(child) ?? Number.MAX_SAFE_INTEGER));
        }
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent !== undefined) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node) ?? Number.MAX_SAFE_INTEGER, lowLink.get(frame.node) ?? Number.MAX_SAFE_INTEGER));
      }
      if ((lowLink.get(frame.node) ?? Number.MAX_SAFE_INTEGER) === (index.get(frame.node) ?? Number.MAX_SAFE_INTEGER)) {
        const component: string[] = [];
        for (;;) {
          const popped = stack.pop();
          if (popped === undefined) break;
          onStack.delete(popped);
          component.push(popped);
          if (popped === frame.node) break;
        }
        if (component.length > 1) cycles.push(component.sort());
      }
    }
  };

  for (const node of [...nodes].sort()) {
    if (!index.has(node)) strongConnect(node);
  }
  return cycles.sort((a, b) => a.join('|').localeCompare(b.join('|')));
}

/** Structurally derived call chains used as the seed for data-flow reconstruction. */
export function callChains(
  edges: readonly DependencyEdge[],
  from: string,
  maxDepth = 6,
): { chain: string[]; depth: number }[] {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (edge.kind !== 'calls' && edge.kind !== 'http') continue;
    const list = adjacency.get(edge.from) ?? [];
    list.push(edge.to);
    adjacency.set(edge.from, list);
  }
  const results: { chain: string[]; depth: number }[] = [];
  const visit = (chain: string[], seen: Set<string>): void => {
    if (chain.length > maxDepth) return;
    const last = chain[chain.length - 1];
    if (last === undefined) return;
    const children = (adjacency.get(last) ?? []).filter((child) => !seen.has(child));
    if (children.length === 0) {
      if (chain.length > 1) results.push({ chain: [...chain], depth: chain.length - 1 });
      return;
    }
    for (const child of children) {
      const nextSeen = new Set(seen);
      nextSeen.add(child);
      visit([...chain, child], nextSeen);
    }
  };
  visit([from], new Set([from]));
  return results.sort((a, b) => a.chain.join('|').localeCompare(b.chain.join('|')));
}

export function endpointId(endpoint: Pick<ExtractedEndpoint, 'method' | 'path'>): string {
  return `endpoint:${endpoint.method} ${endpoint.path}`;
}

export function classIdOf(file: JavaFile, method: { declaringType?: string }): string | undefined {
  const type = method.declaringType;
  if (type === undefined) return undefined;
  return `class:${file.packageName === undefined ? type : `${file.packageName}.${type}`}`;
}

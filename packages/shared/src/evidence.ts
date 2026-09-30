import { z } from 'zod';
import {
  artifactIdSchema,
  confidenceSchema,
  isoTimestampSchema,
  runIdSchema,
  sourceLocationSchema,
} from './primitives.js';

/**
 * The evidence graph (brief §13).
 *
 * Phoenix must be able to answer "why does this migration preserve behavior?" with a traceable
 * chain rather than "the LLM said so". The chain is:
 *
 *   source code / runtime observation
 *     → business rule
 *       → invariant
 *         → characterization test
 *           → modern implementation
 *             → verification result
 *               → release decision
 *
 * Nodes and edges are plain data; every traversal below is deterministic code.
 */

export const evidenceNodeKindSchema = z.enum([
  'source',
  'observation',
  'database-fact',
  'rule',
  'invariant',
  'test',
  'implementation',
  'adversarial-scenario',
  'verification',
  'decision',
  'artifact',
  'risk',
]);
export type EvidenceNodeKind = z.infer<typeof evidenceNodeKindSchema>;

export const evidenceNodeSchema = z.object({
  id: z.string().min(1),
  kind: evidenceNodeKindSchema,
  label: z.string().min(1).max(500),
  detail: z.string().max(8000).optional(),
  artifactId: artifactIdSchema.optional(),
  location: sourceLocationSchema.optional(),
  /** Domain identifier this node stands for (ruleId, invariantId, caseId, mismatchId, ...). */
  refId: z.string().max(200).optional(),
  status: z.string().max(64).optional(),
  createdAt: isoTimestampSchema,
  createdBy: z.string().min(1),
});
export type EvidenceNode = z.infer<typeof evidenceNodeSchema>;

export const evidenceEdgeKindSchema = z.enum([
  'supports',
  'derives-from',
  'validated-by',
  'implemented-by',
  'verified-by',
  'decided-by',
  'contradicts',
  'references',
  'mitigates',
  'violates',
]);
export type EvidenceEdgeKind = z.infer<typeof evidenceEdgeKindSchema>;

export const evidenceEdgeSchema = z.object({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  kind: evidenceEdgeKindSchema,
  confidence: confidenceSchema.optional(),
  note: z.string().max(2000).optional(),
  createdAt: isoTimestampSchema,
  createdBy: z.string().min(1),
});
export type EvidenceEdge = z.infer<typeof evidenceEdgeSchema>;

export const evidenceGraphSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runId: runIdSchema,
  generatedAt: isoTimestampSchema,
  nodes: z.array(evidenceNodeSchema).default([]),
  edges: z.array(evidenceEdgeSchema).default([]),
});
export type EvidenceGraph = z.infer<typeof evidenceGraphSchema>;

export const evidenceIntegrityIssueSchema = z.object({
  code: z.enum([
    'duplicate-node-id',
    'duplicate-edge-id',
    'dangling-edge-from',
    'dangling-edge-to',
    'self-loop',
    'unsupported-claim',
    'orphan-node',
  ]),
  message: z.string().min(1),
  nodeId: z.string().optional(),
  edgeId: z.string().optional(),
});
export type EvidenceIntegrityIssue = z.infer<typeof evidenceIntegrityIssueSchema>;

export interface EvidenceIndex {
  nodesById: ReadonlyMap<string, EvidenceNode>;
  edgesById: ReadonlyMap<string, EvidenceEdge>;
  outgoing: ReadonlyMap<string, readonly EvidenceEdge[]>;
  incoming: ReadonlyMap<string, readonly EvidenceEdge[]>;
}

export function buildEvidenceIndex(graph: EvidenceGraph): EvidenceIndex {
  const nodesById = new Map<string, EvidenceNode>();
  for (const node of graph.nodes) nodesById.set(node.id, node);
  const edgesById = new Map<string, EvidenceEdge>();
  const outgoing = new Map<string, EvidenceEdge[]>();
  const incoming = new Map<string, EvidenceEdge[]>();
  for (const edge of graph.edges) {
    edgesById.set(edge.id, edge);
    const out = outgoing.get(edge.from);
    if (out) out.push(edge);
    else outgoing.set(edge.from, [edge]);
    const inc = incoming.get(edge.to);
    if (inc) inc.push(edge);
    else incoming.set(edge.to, [edge]);
  }
  return { nodesById, edgesById, outgoing, incoming };
}

/** Claim-bearing node kinds: these must have incoming support, or the graph is not trustworthy. */
export const CLAIM_NODE_KINDS: readonly EvidenceNodeKind[] = [
  'rule',
  'invariant',
  'verification',
  'decision',
] as const;

const SUPPORT_EDGE_KINDS: readonly EvidenceEdgeKind[] = [
  'supports',
  'derives-from',
  'validated-by',
  'implemented-by',
  'verified-by',
  'decided-by',
] as const;

export function checkEvidenceGraphIntegrity(
  graph: EvidenceGraph,
  options: { requireSupportFor?: readonly EvidenceNodeKind[] } = {},
): EvidenceIntegrityIssue[] {
  const requireSupportFor = options.requireSupportFor ?? CLAIM_NODE_KINDS;
  const issues: EvidenceIntegrityIssue[] = [];
  const seenNodes = new Set<string>();
  for (const node of graph.nodes) {
    if (seenNodes.has(node.id)) {
      issues.push({
        code: 'duplicate-node-id',
        message: `node id ${node.id} appears more than once`,
        nodeId: node.id,
      });
    }
    seenNodes.add(node.id);
  }
  const seenEdges = new Set<string>();
  for (const edge of graph.edges) {
    if (seenEdges.has(edge.id)) {
      issues.push({
        code: 'duplicate-edge-id',
        message: `edge id ${edge.id} appears more than once`,
        edgeId: edge.id,
      });
    }
    seenEdges.add(edge.id);
    if (edge.from === edge.to) {
      issues.push({ code: 'self-loop', message: `edge ${edge.id} points at itself`, edgeId: edge.id });
    }
    if (!seenNodes.has(edge.from)) {
      issues.push({
        code: 'dangling-edge-from',
        message: `edge ${edge.id} starts at unknown node ${edge.from}`,
        edgeId: edge.id,
      });
    }
    if (!seenNodes.has(edge.to)) {
      issues.push({
        code: 'dangling-edge-to',
        message: `edge ${edge.id} ends at unknown node ${edge.to}`,
        edgeId: edge.id,
      });
    }
  }

  const index = buildEvidenceIndex(graph);
  for (const node of graph.nodes) {
    if (!requireSupportFor.includes(node.kind)) continue;
    const supported = (index.incoming.get(node.id) ?? []).some((edge) =>
      (SUPPORT_EDGE_KINDS as readonly string[]).includes(edge.kind),
    );
    if (!supported) {
      issues.push({
        code: 'unsupported-claim',
        message: `${node.kind} node "${node.label}" (${node.id}) has no supporting evidence`,
        nodeId: node.id,
      });
    }
  }
  for (const node of graph.nodes) {
    const hasAnyEdge =
      (index.incoming.get(node.id)?.length ?? 0) + (index.outgoing.get(node.id)?.length ?? 0) > 0;
    if (!hasAnyEdge && node.kind !== 'artifact') {
      issues.push({
        code: 'orphan-node',
        message: `node "${node.label}" (${node.id}) is not connected to anything`,
        nodeId: node.id,
      });
    }
  }
  return issues;
}

export const evidenceChainSchema = z.object({
  nodeIdPath: z.array(z.string().min(1)).min(1),
  labels: z.array(z.string().min(1)).min(1),
  kinds: z.array(evidenceNodeKindSchema).min(1),
  edgeKinds: z.array(evidenceEdgeKindSchema),
  /** Weakest confidence along the chain — a chain is only as strong as its least supported link. */
  strength: confidenceSchema,
});
export type EvidenceChain = z.infer<typeof evidenceChainSchema>;

export interface ChainSearchOptions {
  /** Only traverse these edge kinds. Defaults to support-style edges. */
  edgeKinds?: readonly EvidenceEdgeKind[];
  /** Stop expanding after this many edges. */
  maxDepth?: number;
  maxChains?: number;
}

/**
 * Every path of supporting evidence that ends at `targetNodeId`, walked backwards to nodes that
 * have no further support (the roots: source code, observations, database facts).
 */
export function findEvidenceChains(
  graph: EvidenceGraph,
  targetNodeId: string,
  options: ChainSearchOptions = {},
): EvidenceChain[] {
  const index = buildEvidenceIndex(graph);
  const edgeKinds = options.edgeKinds ?? SUPPORT_EDGE_KINDS;
  const maxDepth = options.maxDepth ?? 12;
  const maxChains = options.maxChains ?? 200;
  const chains: EvidenceChain[] = [];

  if (!index.nodesById.has(targetNodeId)) return chains;

  const walk = (nodeId: string, path: string[], edges: EvidenceEdge[], depth: number): void => {
    if (chains.length >= maxChains) return;
    const incoming = (index.incoming.get(nodeId) ?? []).filter((edge) =>
      (edgeKinds as readonly string[]).includes(edge.kind),
    );
    if (incoming.length === 0 || depth >= maxDepth) {
      // A chain with no edges is not evidence: an unsupported claim yields no chains at all,
      // which is what makes `explainEvidence().answered === false` meaningful.
      if (edges.length > 0) chains.push(materialize(index, [...path].reverse(), [...edges].reverse()));
      return;
    }
    for (const edge of incoming) {
      if (path.includes(edge.from)) continue; // cycle guard
      walk(edge.from, [...path, edge.from], [...edges, edge], depth + 1);
    }
  };

  walk(targetNodeId, [targetNodeId], [], 0);
  return chains.sort((a, b) => b.strength - a.strength);
}

function materialize(
  index: EvidenceIndex,
  nodeIds: string[],
  edges: EvidenceEdge[],
): EvidenceChain {
  const labels: string[] = [];
  const kinds: EvidenceNodeKind[] = [];
  for (const id of nodeIds) {
    const node = index.nodesById.get(id);
    labels.push(node?.label ?? id);
    kinds.push(node?.kind ?? 'artifact');
  }
  const strengths = edges.map((edge) => edge.confidence ?? 1);
  const strength = strengths.length === 0 ? 1 : Math.min(...strengths);
  return evidenceChainSchema.parse({
    nodeIdPath: nodeIds,
    labels,
    kinds,
    edgeKinds: edges.map((edge) => edge.kind),
    strength,
  });
}

export const evidenceExplanationSchema = z.object({
  question: z.string().min(1),
  targetNodeId: z.string().min(1),
  answered: z.boolean(),
  chains: z.array(evidenceChainSchema).default([]),
  /** Claim nodes reachable from the target that have no support: the honest gaps. */
  unsupported: z.array(z.string().min(1)).default([]),
  rootEvidence: z
    .array(z.object({ nodeId: z.string().min(1), kind: evidenceNodeKindSchema, label: z.string().min(1) }))
    .default([]),
});
export type EvidenceExplanation = z.infer<typeof evidenceExplanationSchema>;

/**
 * Answers "why does Phoenix believe X?" for any node — typically the release decision.
 * The answer is data, not prose: chains of evidence plus the list of unsupported claims.
 */
export function explainEvidence(
  graph: EvidenceGraph,
  targetNodeId: string,
  question = `Why does Phoenix believe this claim: ${targetNodeId}?`,
  options: ChainSearchOptions = {},
): EvidenceExplanation {
  const chains = findEvidenceChains(graph, targetNodeId, options);
  const index = buildEvidenceIndex(graph);
  const reachable = new Set<string>();
  for (const chain of chains) for (const id of chain.nodeIdPath) reachable.add(id);

  const unsupported: string[] = [];
  for (const id of reachable) {
    const node = index.nodesById.get(id);
    if (!node || !(CLAIM_NODE_KINDS as readonly string[]).includes(node.kind)) continue;
    const supported = (index.incoming.get(id) ?? []).some((edge) =>
      (SUPPORT_EDGE_KINDS as readonly string[]).includes(edge.kind),
    );
    if (!supported) unsupported.push(id);
  }

  const rootEvidence: { nodeId: string; kind: EvidenceNodeKind; label: string }[] = [];
  const seenRoots = new Set<string>();
  for (const chain of chains) {
    const rootId = chain.nodeIdPath[0];
    if (rootId === undefined || seenRoots.has(rootId)) continue;
    seenRoots.add(rootId);
    const node = index.nodesById.get(rootId);
    if (!node) continue;
    rootEvidence.push({ nodeId: node.id, kind: node.kind, label: node.label });
  }

  return evidenceExplanationSchema.parse({
    question,
    targetNodeId,
    answered: chains.length > 0 && unsupported.length === 0,
    chains,
    unsupported,
    rootEvidence,
  });
}

export function nodesOfKind(graph: EvidenceGraph, kind: EvidenceNodeKind): EvidenceNode[] {
  return graph.nodes.filter((node) => node.kind === kind);
}

export function findNodeByRef(graph: EvidenceGraph, refId: string): EvidenceNode | undefined {
  return graph.nodes.find((node) => node.refId === refId);
}

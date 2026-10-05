import { z } from 'zod';
import {
  PhoenixError,
  businessRuleKindSchema,
  businessRuleSchema,
  businessRuleSetSchema,
  computeInvariantStatistics,
  computeRuleStatistics,
  confidenceSchema,
  epistemicStatusSchema,
  invariantCriticalitySchema,
  invariantIdSchema,
  invariantKindSchema,
  invariantSchema,
  invariantSetSchema,
  proposedCheckSchema,
  ruleIdSchema,
  severitySchema,
  specificationUnknownSchema,
  type BusinessRuleSet,
  type Finding,
  type InvariantSet,
} from '@phoenix/shared';
import { modelEvidenceSchema, toEvidenceRefs, type ModelEvidence, type ReportAttribution } from './discovery-schema.js';

/**
 * What the Analyst is allowed to say, and how it becomes the behavioral specification.
 *
 * Two things are deliberately *not* in the model's vocabulary. `lifecycleStatus` is always
 * `candidate` and `confirmation` is always absent, because a rule is confirmed by an executed test
 * against the legacy system, never by the agent that proposed it. `statistics` is computed here from
 * the rules that were actually produced. Everything else the model supplies must carry a citation
 * that resolves against real bytes, or the task fails.
 */

export const modelEdgeCaseSchema = z.object({
  // `_` admitted as a separator: models spell ids after the symbol they name, and a cosmetic
  // rejection must not consume the repair budget the substantive citation gates depend on.
  id: z.string().regex(/^EC-[A-Z0-9][A-Z0-9_-]{0,39}$/, 'expected an id like EC-FEE-BELOW-MINIMUM'),
  description: z.string().min(10).max(2000),
  expectedBehavior: z.string().max(2000).optional(),
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  evidence: z.array(modelEvidenceSchema).max(4).default([]),
});
export type ModelEdgeCase = z.infer<typeof modelEdgeCaseSchema>;

export const modelRuleSchema = z.object({
  ruleId: ruleIdSchema,
  title: z.string().min(5).max(300),
  description: z.string().min(20).max(8000),
  kind: businessRuleKindSchema,
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  /** Why this confidence and not higher — what is missing or ambiguous. Refusing this field is how
   * a guessed rule gets caught. */
  confidenceBasis: z.string().min(20).max(2000),
  sourceEvidence: z.array(modelEvidenceSchema).min(1).max(8),
  affectedComponents: z.array(z.string().min(1).max(500)).min(1).max(20),
  /** Externally observable consequence: this is what characterization and differential tests assert. */
  observableBehavior: z.string().min(20).max(4000),
  edgeCases: z.array(modelEdgeCaseSchema).max(20).default([]),
  assumptions: z.array(z.string().min(1).max(1000)).max(20).default([]),
  testable: z.boolean().default(true),
  proposedChecks: z.array(proposedCheckSchema).max(20).default([]),
  /** Other places implementing the same rule; drift between them is a modernization hazard. */
  duplicateImplementations: z.array(z.string().min(1).max(500)).max(20).default([]),
  contradictsRuleIds: z.array(ruleIdSchema).max(20).default([]),
  derivedFromInvariantIds: z.array(invariantIdSchema).max(20).default([]),
});
export type ModelRule = z.infer<typeof modelRuleSchema>;

export const modelInvariantSchema = z.object({
  invariantId: invariantIdSchema,
  /** A falsifiable sentence, e.g. "the sum of an account's ledger entries equals its balance". */
  statement: z.string().min(20).max(2000),
  formalStatement: z.string().max(4000).optional(),
  kind: invariantKindSchema,
  criticality: invariantCriticalitySchema,
  scope: z.object({
    components: z.array(z.string().min(1).max(500)).max(20).default([]),
    operations: z.array(z.string().min(1).max(500)).max(20).default([]),
  }),
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  sourceEvidence: z.array(modelEvidenceSchema).min(1).max(8),
  checkingStrategy: z.object({
    kind: z.enum([
      'differential-scenario',
      'database-query',
      'property-test',
      'unit-test',
      'api-invariant-check',
      'concurrency-probe',
      'manual',
    ]),
    detail: z.string().min(20).max(4000),
    automated: z.boolean().default(true),
    /** Deterministic query or check text, when the strategy is machine-executable. */
    executable: z.string().max(8000).optional(),
  }),
  violationSeverity: severitySchema,
  derivedFromRuleIds: z.array(ruleIdSchema).max(20).default([]),
  examples: z
    .array(z.object({ description: z.string().min(1).max(1000), expected: z.string().max(1000) }))
    .max(10)
    .default([]),
  /** Cases where the invariant is known not to hold; prevents false blocking at release time. */
  knownExceptions: z.array(z.string().min(1).max(1000)).max(10).default([]),
});
export type ModelInvariant = z.infer<typeof modelInvariantSchema>;

const analystReportShape = z.object({
  summary: z.string().min(40).max(4000),
  rules: z.array(modelRuleSchema).max(60).default([]),
  invariants: z.array(modelInvariantSchema).max(40).default([]),
  unknowns: z.array(specificationUnknownSchema).max(30).default([]),
});

export const analystReportSchema = z.preprocess(demoteUnsupportedClaims, analystReportShape);
export type AnalystReport = z.infer<typeof analystReportSchema>;

function demoteUnsupportedClaims(value: unknown): unknown {
  if (!isRecord(value)) return value;
  const rules = Array.isArray(value.rules) ? value.rules : [];
  const invariants = Array.isArray(value.invariants) ? value.invariants : [];
  const unknowns = Array.isArray(value.unknowns) ? value.unknowns : [];
  const unsupportedRules = rules.filter(hasEmptySourceEvidence);
  const unsupportedInvariants = invariants.filter(hasEmptySourceEvidence);
  if (unsupportedRules.length === 0 && unsupportedInvariants.length === 0) return value;

  const droppedRuleIds = idsOf(unsupportedRules, 'ruleId');
  const droppedInvariantIds = idsOf(unsupportedInvariants, 'invariantId');
  const normalizedUnknowns = unknowns.map((unknown) => {
    if (!isRecord(unknown)) return unknown;
    return {
      ...unknown,
      relatedRuleIds: withoutIds(unknown.relatedRuleIds, droppedRuleIds),
      relatedInvariantIds: withoutIds(unknown.relatedInvariantIds, droppedInvariantIds),
    };
  });

  for (const claim of unsupportedRules) {
    addUnknownWhenMissing(normalizedUnknowns, unknowns, claim, 'ruleId', droppedRuleIds, droppedInvariantIds);
  }
  for (const claim of unsupportedInvariants) {
    addUnknownWhenMissing(normalizedUnknowns, unknowns, claim, 'invariantId', droppedRuleIds, droppedInvariantIds);
  }

  return {
    ...value,
    rules: rules.filter((claim) => !hasEmptySourceEvidence(claim)),
    invariants: invariants.filter((claim) => !hasEmptySourceEvidence(claim)),
    unknowns: normalizedUnknowns,
  };
}

function hasEmptySourceEvidence(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.sourceEvidence) && value.sourceEvidence.length === 0;
}

function idsOf(values: readonly unknown[], field: string): Set<string> {
  return new Set(
    values.flatMap((value) => {
      if (!isRecord(value) || typeof value[field] !== 'string') return [];
      return [value[field]];
    }),
  );
}

function withoutIds(value: unknown, dropped: ReadonlySet<string>): unknown {
  return Array.isArray(value) ? value.filter((item) => typeof item !== 'string' || !dropped.has(item)) : value;
}

function addUnknownWhenMissing(
  normalizedUnknowns: unknown[],
  originalUnknowns: readonly unknown[],
  claim: unknown,
  idField: 'ruleId' | 'invariantId',
  droppedRuleIds: ReadonlySet<string>,
  droppedInvariantIds: ReadonlySet<string>,
): void {
  if (!isRecord(claim) || typeof claim[idField] !== 'string') return;
  const claimId = claim[idField];
  const alreadyRecorded = originalUnknowns.some(
    (unknown) =>
      isRecord(unknown) &&
      [unknown.relatedRuleIds, unknown.relatedInvariantIds].some(
        (ids) => Array.isArray(ids) && ids.includes(claimId),
      ),
  );
  if (alreadyRecorded) return;

  const title = typeof claim.title === 'string' ? claim.title : claim.statement;
  const basis = typeof claim.confidenceBasis === 'string' ? claim.confidenceBasis : claim.statement;
  normalizedUnknowns.push({
    id: `UNK-${claimId.replace(/^(BR|INV)-/, '')}`,
    question: `What repository or runtime evidence establishes ${typeof title === 'string' ? title : claimId}?`,
    whyItMatters:
      typeof basis === 'string'
        ? basis
        : `The model proposed ${claimId} without source evidence, so Phoenix cannot treat it as a specification claim.`,
    resolutionStrategy: 'runtime-probe',
    relatedRuleIds: withoutIds(idField === 'ruleId' ? [claimId] : [], droppedRuleIds),
    relatedInvariantIds: withoutIds(idField === 'invariantId' ? [claimId] : [], droppedInvariantIds),
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface SpecificationAttribution {
  /** ISO timestamp stamped onto the documents and every citation in them. */
  generatedAt: string;
  /** Usually `business-rule-analyst:<taskId>`. */
  generatedBy: string;
  /** The repository the specification describes; recorded so the document cannot be reused blindly. */
  targetRoot: string;
}

export function toBusinessRuleSet(report: AnalystReport, attribution: SpecificationAttribution): BusinessRuleSet {
  const evidenceFor = (claimId: string, evidence: readonly ModelEvidence[]) =>
    toEvidenceRefs(evidence, claimId, {
      collectedAt: attribution.generatedAt,
      collectedBy: attribution.generatedBy,
    });

  const rules = report.rules.map((rule) =>
    businessRuleSchema.parse({
      ruleId: rule.ruleId,
      title: rule.title,
      description: rule.description,
      kind: rule.kind,
      epistemicStatus: rule.epistemicStatus,
      confidence: rule.confidence,
      confidenceBasis: rule.confidenceBasis,
      sourceEvidence: evidenceFor(rule.ruleId, rule.sourceEvidence),
      affectedComponents: rule.affectedComponents,
      observableBehavior: rule.observableBehavior,
      edgeCases: rule.edgeCases.map((edgeCase) => ({
        id: edgeCase.id,
        description: edgeCase.description,
        ...(edgeCase.expectedBehavior !== undefined ? { expectedBehavior: edgeCase.expectedBehavior } : {}),
        epistemicStatus: edgeCase.epistemicStatus,
        confidence: edgeCase.confidence,
        evidence: evidenceFor(`${rule.ruleId}-${edgeCase.id}`, edgeCase.evidence),
      })),
      assumptions: rule.assumptions,
      testable: rule.testable,
      proposedChecks: rule.proposedChecks,
      duplicateImplementations: rule.duplicateImplementations,
      contradictsRuleIds: rule.contradictsRuleIds,
      derivedFromInvariantIds: rule.derivedFromInvariantIds,
      lifecycleStatus: 'candidate',
      discoveredBy: attribution.generatedBy,
      discoveredAt: attribution.generatedAt,
    }),
  );

  return businessRuleSetSchema.parse({
    generatedAt: attribution.generatedAt,
    generatedBy: attribution.generatedBy,
    targetRoot: attribution.targetRoot,
    rules,
    unknowns: report.unknowns,
    statistics: computeRuleStatistics(rules),
  });
}

export function toInvariantSet(report: AnalystReport, attribution: SpecificationAttribution): InvariantSet {
  const evidenceFor = (claimId: string, evidence: readonly ModelEvidence[]) =>
    toEvidenceRefs(evidence, claimId, {
      collectedAt: attribution.generatedAt,
      collectedBy: attribution.generatedBy,
    });

  const invariants = report.invariants.map((invariant) =>
    invariantSchema.parse({
      invariantId: invariant.invariantId,
      statement: invariant.statement,
      ...(invariant.formalStatement !== undefined ? { formalStatement: invariant.formalStatement } : {}),
      kind: invariant.kind,
      criticality: invariant.criticality,
      scope: { components: invariant.scope.components, operations: invariant.scope.operations },
      epistemicStatus: invariant.epistemicStatus,
      confidence: invariant.confidence,
      sourceEvidence: evidenceFor(invariant.invariantId, invariant.sourceEvidence),
      checkingStrategy: {
        kind: invariant.checkingStrategy.kind,
        detail: invariant.checkingStrategy.detail,
        automated: invariant.checkingStrategy.automated,
        ...(invariant.checkingStrategy.executable !== undefined
          ? { executable: invariant.checkingStrategy.executable }
          : {}),
      },
      violationSeverity: invariant.violationSeverity,
      derivedFromRuleIds: invariant.derivedFromRuleIds,
      examples: invariant.examples,
      knownExceptions: invariant.knownExceptions,
      lifecycleStatus: 'candidate',
      discoveredBy: attribution.generatedBy,
      discoveredAt: attribution.generatedAt,
    }),
  );

  return invariantSetSchema.parse({
    generatedAt: attribution.generatedAt,
    generatedBy: attribution.generatedBy,
    targetRoot: attribution.targetRoot,
    invariants,
    // Only the unknowns that bear on an invariant belong in this document; the rest live in the rule
    // set. Duplicating every gap into both would make the two counts disagree with the report.
    unknowns: report.unknowns.filter((unknown) => unknown.relatedInvariantIds.length > 0),
    statistics: computeInvariantStatistics(invariants),
  });
}

/**
 * Every citation the report makes, as findings, so the runtime's `evidence-exists` check verifies
 * them. Edge-case citations are folded into their rule's finding: a quote nobody checks is exactly
 * the kind of claim Phoenix refuses to carry forward.
 */
export function toSpecificationFindings(report: AnalystReport, attribution: ReportAttribution): Finding[] {
  const rules: Finding[] = report.rules.map((rule) => ({
    id: rule.ruleId,
    kind: 'business-rule-candidate',
    summary: rule.title,
    detail: rule.observableBehavior,
    epistemicStatus: rule.epistemicStatus,
    confidence: rule.confidence,
    affectedComponents: rule.affectedComponents,
    relatedRuleIds: [],
    relatedInvariantIds: rule.derivedFromInvariantIds,
    evidence: toEvidenceRefs(
      [
        ...rule.sourceEvidence,
        ...rule.edgeCases.flatMap((edgeCase) => edgeCase.evidence),
      ],
      rule.ruleId,
      attribution,
    ),
  }));
  const invariants: Finding[] = report.invariants.map((invariant) => ({
    id: invariant.invariantId,
    kind: 'invariant-candidate',
    summary: invariant.statement,
    epistemicStatus: invariant.epistemicStatus,
    confidence: invariant.confidence,
    affectedComponents: invariant.scope.components,
    relatedRuleIds: invariant.derivedFromRuleIds,
    relatedInvariantIds: [],
    evidence: toEvidenceRefs(invariant.sourceEvidence, invariant.invariantId, attribution),
  }));
  return [...rules, ...invariants];
}

/** Open questions that no static reading could settle; they become the run's unresolved unknowns. */
export function specificationUnknownsOf(report: AnalystReport): string[] {
  return report.unknowns.map((unknown) => `${unknown.id}: ${unknown.question}`.slice(0, 1000));
}

/**
 * Dangling references and self-confirmation are the two ways a plausible-looking specification turns
 * out to be fiction, so both are refused here rather than left for a reader to notice later.
 */
export function danglingSpecificationReferences(report: AnalystReport): string[] {
  const ruleIds = new Set(report.rules.map((rule) => rule.ruleId));
  const invariantIds = new Set(report.invariants.map((invariant) => invariant.invariantId));
  const problems: string[] = [];

  for (const rule of report.rules) {
    for (const referenced of rule.contradictsRuleIds) {
      if (!ruleIds.has(referenced)) problems.push(`${rule.ruleId} contradicts unknown rule ${referenced}`);
    }
    for (const referenced of rule.derivedFromInvariantIds) {
      if (!invariantIds.has(referenced)) problems.push(`${rule.ruleId} derives from unknown invariant ${referenced}`);
    }
    for (const check of rule.proposedChecks) {
      if (check.targetsRuleId !== undefined && !ruleIds.has(check.targetsRuleId)) {
        problems.push(`${rule.ruleId} proposes a check against unknown rule ${check.targetsRuleId}`);
      }
      if (check.targetsInvariantId !== undefined && !invariantIds.has(check.targetsInvariantId)) {
        problems.push(`${rule.ruleId} proposes a check against unknown invariant ${check.targetsInvariantId}`);
      }
    }
  }
  for (const invariant of report.invariants) {
    for (const referenced of invariant.derivedFromRuleIds) {
      if (!ruleIds.has(referenced)) problems.push(`${invariant.invariantId} derives from unknown rule ${referenced}`);
    }
  }
  for (const unknown of report.unknowns) {
    for (const referenced of unknown.relatedRuleIds) {
      if (!ruleIds.has(referenced)) problems.push(`${unknown.id} concerns unknown rule ${referenced}`);
    }
    for (const referenced of unknown.relatedInvariantIds) {
      if (!invariantIds.has(referenced)) problems.push(`${unknown.id} concerns unknown invariant ${referenced}`);
    }
  }
  return problems;
}

/** Guards the stage against persisting a specification the field-level schemas would let through. */
export function assertSpecificationIsUsable(report: AnalystReport): void {
  const problems = specificationUsabilityProblems(report);
  if (problems.length > 0) {
    throw new PhoenixError(
      'SCHEMA_VALIDATION_FAILED',
      problems[0]!,
      problems.length === 1 ? {} : { problems },
    );
  }
}

export function specificationUsabilityProblems(report: AnalystReport): string[] {
  const problems: string[] = [];

  if (report.rules.length === 0 && report.invariants.length === 0) {
    problems.push(
      'the analyst proposed no rules and no invariants; there is nothing to specify and nothing to test',
    );
    return problems;
  }

  const seen = new Set<string>();
  for (const id of [
    ...report.rules.map((rule) => rule.ruleId),
    ...report.invariants.map((i) => i.invariantId),
  ]) {
    if (seen.has(id)) {
      problems.push(`id ${id} is used more than once in the specification`);
    }
    seen.add(id);
  }

  for (const claim of [
    ...report.rules.map((rule) => ({
      id: rule.ruleId,
      status: rule.epistemicStatus,
      evidence: rule.sourceEvidence,
    })),
    ...report.invariants.map((invariant) => ({
      id: invariant.invariantId,
      status: invariant.epistemicStatus,
      evidence: invariant.sourceEvidence,
    })),
  ]) {
    if (
      claim.status === 'OBSERVED' &&
      claim.evidence.every(
        (item) => item.startLine === undefined && item.symbol === undefined,
      )
    ) {
      problems.push(
        `${claim.id} is marked OBSERVED but cites no line or symbol in any file`,
      );
    }
  }

  const dangling = danglingSpecificationReferences(report);
  for (const item of dangling.slice(0, 6)) {
    problems.push(`dangling reference: ${item}`);
  }
  return problems;
}

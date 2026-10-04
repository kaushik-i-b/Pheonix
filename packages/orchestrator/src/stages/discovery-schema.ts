import { z } from 'zod';
import {
  PhoenixError,
  confidenceSchema,
  discoveryFindingsSchema,
  epistemicStatusSchema,
  findingKindSchema,
  findingSchema,
  severitySchema,
  type DiscoveryFindings,
  type EvidenceRef,
  type Finding,
} from '@phoenix/shared';

/**
 * What the Archaeologist is allowed to say, and how it becomes an artifact.
 *
 * The model never emits `DiscoveryFindings` directly. It emits a report whose evidence is a path
 * plus a verbatim quote — the two things that can be checked mechanically — and deterministic code
 * turns that into findings with proper evidence references, timestamps and attribution. Identity,
 * time and provenance are not the model's to invent.
 */

export const modelEvidenceSchema = z.object({
  /** Path relative to the legacy repository root. */
  path: z.string().min(1).max(500),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  symbol: z.string().min(1).max(300).optional(),
  /**
   * Text copied from the file. Verified against the real bytes before the report is accepted.
   *
   * The cap matches `evidenceRefSchema.quote` (8000) deliberately: a quote that merely runs long
   * must reach the citation check, where the host can anchor it to the real bytes, instead of dying
   * at the schema gate where a 2000-character cap once rejected an otherwise valid report.
   */
  quote: z.string().min(1).max(8000),
  note: z.string().max(500).optional(),
});
export type ModelEvidence = z.infer<typeof modelEvidenceSchema>;

export const modelFindingSchema = z.object({
  // `_` is admitted as a separator because models write ids from the symbol they are naming
  // (`F-CALC_TRANSFER_FEE`). A cosmetic spelling preference must not consume the repair budget that
  // the substantive gates — read-before-you-cite, quote verification — depend on.
  id: z.string().regex(/^F-[A-Z0-9][A-Z0-9_-]{0,39}$/, 'expected an id like F-RETENTION-BOUNDARY'),
  kind: findingKindSchema,
  summary: z.string().min(10).max(600),
  detail: z.string().max(4000).optional(),
  epistemicStatus: epistemicStatusSchema,
  confidence: confidenceSchema,
  severity: severitySchema.optional(),
  affectedComponents: z.array(z.string().min(1).max(500)).max(20).default([]),
  evidence: z.array(modelEvidenceSchema).min(1).max(6),
});
export type ModelFinding = z.infer<typeof modelFindingSchema>;

export const modelOpenQuestionSchema = z.object({
  id: z.string().regex(/^Q-[A-Z0-9][A-Z0-9_-]{0,39}$/, 'expected an id like Q-PURGE-RERUN'),
  question: z.string().min(10).max(1000),
  whyItMatters: z.string().max(2000).optional(),
  resolutionStrategy: z.enum([
    'runtime-probe',
    'characterization-test',
    'differential-scenario',
    'human-input',
    'unresolvable',
  ]),
});
export type ModelOpenQuestion = z.infer<typeof modelOpenQuestionSchema>;

export const archaeologistReportSchema = z
  .object({
    summary: z.string().min(40).max(4000),
    sections: z
      .array(
        z.object({
          heading: z.string().min(1).max(200),
          body: z.string().min(1).max(20_000),
        }),
      )
      .min(3)
      .max(12),
    findings: z.array(modelFindingSchema).max(80).default([]),
    openQuestions: z.array(modelOpenQuestionSchema).max(40).default([]),
  })
  .superRefine((report, ctx) => {
    const seen = new Map<string, string>();
    for (const finding of report.findings) {
      const first = seen.get(finding.id);
      if (first !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['findings'],
          message: `id ${finding.id} is used more than once`,
        });
      }
      seen.set(finding.id, 'finding');
    }
    for (const question of report.openQuestions) {
      if (seen.has(question.id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['openQuestions'],
          message: `id ${question.id} is used more than once`,
        });
      }
      seen.set(question.id, 'question');
    }
  });
export type ArchaeologistReport = z.infer<typeof archaeologistReportSchema>;

export interface ReportAttribution {
  /** ISO timestamp stamped onto every evidence reference and the document itself. */
  collectedAt: string;
  /** Usually `archaeologist:<taskId>`. */
  collectedBy: string;
}

/**
 * Model citations become evidence references here, in host code. Identity, timestamp and attribution
 * are stamped rather than accepted: a model that could choose its own evidence ids and collection
 * time could also choose to reuse or backdate somebody else's.
 */
export function toEvidenceRefs(
  evidence: readonly ModelEvidence[],
  claimId: string,
  attribution: ReportAttribution,
): EvidenceRef[] {
  return evidence.map(
    (item, index): EvidenceRef => ({
      id: `${claimId}-ev-${index + 1}`,
      kind: 'source-code',
      collectedAt: attribution.collectedAt,
      collectedBy: attribution.collectedBy,
      location: {
        path: item.path,
        ...(item.startLine !== undefined ? { startLine: item.startLine } : {}),
        ...(item.endLine !== undefined ? { endLine: item.endLine } : {}),
        ...(item.symbol !== undefined ? { symbol: item.symbol } : {}),
      },
      quote: item.quote,
      ...(item.note !== undefined ? { note: item.note } : {}),
    }),
  );
}

export function toFindings(report: ArchaeologistReport, attribution: ReportAttribution): Finding[] {
  return report.findings.map((finding) =>
    findingSchema.parse({
      id: finding.id,
      kind: finding.kind,
      summary: finding.summary,
      ...(finding.detail !== undefined ? { detail: finding.detail } : {}),
      epistemicStatus: finding.epistemicStatus,
      confidence: finding.confidence,
      ...(finding.severity !== undefined ? { severity: finding.severity } : {}),
      affectedComponents: finding.affectedComponents,
      relatedRuleIds: [],
      relatedInvariantIds: [],
      evidence: toEvidenceRefs(finding.evidence, finding.id, attribution),
    }),
  );
}

/** The structured document persisted as `discovery/findings.json`. */
export function toDiscoveryFindings(
  report: ArchaeologistReport,
  attribution: ReportAttribution,
): DiscoveryFindings {
  return discoveryFindingsSchema.parse({
    generatedAt: attribution.collectedAt,
    summary: report.summary,
    sections: report.sections.map((section) => ({ heading: section.heading, body: section.body })),
    findings: toFindings(report, attribution),
    openQuestions: report.openQuestions.map((question) => ({
      id: question.id,
      question: question.question,
      ...(question.whyItMatters !== undefined ? { whyItMatters: question.whyItMatters } : {}),
      resolutionStrategy: question.resolutionStrategy,
    })),
  });
}

/** Open questions that no automated stage can settle; surfaced as the run's unresolved unknowns. */
export function unresolvedUnknownsOf(report: ArchaeologistReport): string[] {
  return report.openQuestions.map((question) => `${question.id}: ${question.question}`.slice(0, 1000));
}

/** Guards the stage against persisting a report that the schema alone would let through. */
export function assertReportIsUsable(report: ArchaeologistReport): void {
  if (report.findings.length === 0 && report.openQuestions.length === 0) {
    throw new PhoenixError(
      'SCHEMA_VALIDATION_FAILED',
      'the archaeological report claims nothing and asks nothing; it cannot support a migration',
      { sections: report.sections.length },
    );
  }
  const observed = report.findings.filter((finding) => finding.epistemicStatus === 'OBSERVED');
  for (const finding of observed) {
    if (finding.evidence.every((item) => item.startLine === undefined && item.symbol === undefined)) {
      throw new PhoenixError(
        'SCHEMA_VALIDATION_FAILED',
        `finding ${finding.id} is marked OBSERVED but cites no line or symbol in any file`,
        { findingId: finding.id },
      );
    }
  }
}

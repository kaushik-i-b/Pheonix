import { z } from 'zod';
import {
  artifactIdSchema,
  confidenceSchema,
  evidenceRefSchema,
  invariantIdSchema,
  isoTimestampSchema,
  ruleIdSchema,
  severitySchema,
} from './primitives.js';
import { agentRoleSchema } from './roles.js';

/**
 * Verification and release contracts (brief §4 "Release Guardian", §15 "failure is first-class").
 *
 * Both documents are *computed* by deterministic code from upstream artifacts. An LLM may explain
 * a failure but may never decide one: `computedBy` is a code identifier, not a model.
 */

export const checkStatusSchema = z.enum(['PASS', 'FAIL', 'UNKNOWN', 'SKIPPED', 'NOT_APPLICABLE']);
export type CheckStatus = z.infer<typeof checkStatusSchema>;

export const verificationCheckKindSchema = z.enum([
  'characterization-suite-captured',
  'characterization-suite-passes-on-legacy',
  'modern-implementation-builds',
  'modern-tests-pass',
  'invariant-holds',
  'differential-equivalence',
  'adversarial-no-critical-finding',
  'migration-validation',
  'evidence-completeness',
  'required-artifacts-present',
  'coverage',
]);
export type VerificationCheckKind = z.infer<typeof verificationCheckKindSchema>;

export const verificationCheckSchema = z.object({
  checkId: z.string().min(1),
  kind: verificationCheckKindSchema,
  description: z.string().min(1).max(2000),
  status: checkStatusSchema,
  /** A required check that does not PASS blocks release. Non-required checks become warnings. */
  required: z.boolean().default(true),
  detail: z.string().max(4000).optional(),
  observed: z.unknown().optional(),
  threshold: z.unknown().optional(),
  relatedRuleIds: z.array(ruleIdSchema).default([]),
  relatedInvariantIds: z.array(invariantIdSchema).default([]),
  evidence: z.array(evidenceRefSchema).default([]),
});
export type VerificationCheck = z.infer<typeof verificationCheckSchema>;

export const invariantCheckResultSchema = z.object({
  invariantId: invariantIdSchema,
  statement: z.string().min(1).max(2000),
  criticality: z.enum(['CRITICAL', 'MAJOR', 'MINOR']),
  status: checkStatusSchema,
  testedByCaseIds: z.array(z.string().min(1)).default([]),
  testedByScenarioIds: z.array(z.string().min(1)).default([]),
  violations: z
    .array(
      z.object({
        violationId: z.string().min(1),
        scenarioId: z.string().min(1).optional(),
        mismatchId: z.string().min(1).optional(),
        detail: z.string().min(1).max(4000),
        severity: severitySchema,
        evidence: z.array(evidenceRefSchema).min(1),
      }),
    )
    .default([]),
  /** An untested critical invariant is not a pass: it is a gap that blocks release. */
  untestedReason: z.string().max(2000).optional(),
});
export type InvariantCheckResult = z.infer<typeof invariantCheckResultSchema>;

export const verdictSchema = z.enum(['EQUIVALENT', 'NOT_EQUIVALENT', 'INCONCLUSIVE']);
export type Verdict = z.infer<typeof verdictSchema>;

export const verificationVerdictSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runId: z.string().min(1),
  computedAt: isoTimestampSchema,
  /** Identifier of the deterministic code path that produced this verdict. Never a model name. */
  computedBy: z.string().min(1),
  verdict: verdictSchema,
  confidence: confidenceSchema,
  repairIteration: z.number().int().nonnegative().default(0),
  checks: z.array(verificationCheckSchema).default([]),
  invariantResults: z.array(invariantCheckResultSchema).default([]),
  mismatchSummary: z.object({
    total: z.number().int().nonnegative(),
    unresolved: z.number().int().nonnegative(),
    unexplained: z.number().int().nonnegative(),
    bySeverity: z.record(severitySchema, z.number().int().nonnegative()),
    highestSeverity: severitySchema,
  }),
  inputArtifactIds: z.array(artifactIdSchema).default([]),
  reasons: z.array(z.string().min(1).max(2000)).default([]),
  /** Mismatch ids that a repair iteration should target next, in priority order. */
  repairTargets: z.array(z.string().min(1)).default([]),
});
export type VerificationVerdict = z.infer<typeof verificationVerdictSchema>;

export const releaseGateIdSchema = z.enum([
  'required-artifacts-present',
  'characterization-suite-captured',
  'modern-implementation-builds',
  'required-tests-pass',
  'critical-invariants-hold',
  'no-unexplained-differences',
  'no-critical-mismatches',
  'adversarial-no-critical-finding',
  'migration-validation-passed',
  'evidence-complete',
]);
export type ReleaseGateId = z.infer<typeof releaseGateIdSchema>;

export const RELEASE_GATE_IDS: readonly ReleaseGateId[] = [
  'required-artifacts-present',
  'characterization-suite-captured',
  'modern-implementation-builds',
  'required-tests-pass',
  'critical-invariants-hold',
  'no-unexplained-differences',
  'no-critical-mismatches',
  'adversarial-no-critical-finding',
  'migration-validation-passed',
  'evidence-complete',
] as const;

export const releaseGateSchema = z.object({
  gateId: releaseGateIdSchema,
  description: z.string().min(1).max(1000),
  required: z.boolean().default(true),
  passed: z.boolean(),
  detail: z.string().max(4000).optional(),
  observed: z.unknown().optional(),
  checkIds: z.array(z.string().min(1)).default([]),
  evidence: z.array(evidenceRefSchema).default([]),
});
export type ReleaseGate = z.infer<typeof releaseGateSchema>;

export const blockingReasonSchema = z.object({
  code: z.string().min(1),
  gateId: releaseGateIdSchema.optional(),
  detail: z.string().min(1).max(4000),
  severity: severitySchema,
  relatedRuleIds: z.array(ruleIdSchema).default([]),
  relatedInvariantIds: z.array(invariantIdSchema).default([]),
  relatedMismatchIds: z.array(z.string().min(1)).default([]),
  evidence: z.array(evidenceRefSchema).default([]),
});
export type BlockingReason = z.infer<typeof blockingReasonSchema>;

export const releaseDecisionSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  runId: z.string().min(1),
  decidedAt: isoTimestampSchema,
  decidedBy: agentRoleSchema.default('release-guardian'),
  /** Identifier of the deterministic gate evaluation; the Guardian interprets, code decides. */
  evaluatedBy: z.string().min(1),
  decision: z.enum(['PASS', 'REJECT']),
  verdictId: artifactIdSchema.optional(),
  gates: z.array(releaseGateSchema).default([]),
  blockingReasons: z.array(blockingReasonSchema).default([]),
  warnings: z.array(z.string().max(2000)).default([]),
  evidenceArtifactIds: z.array(artifactIdSchema).default([]),
  /** Unknowns that remain unresolved at release time; a PASS with unknowns must list them. */
  unresolvedUnknowns: z.array(z.string().max(2000)).default([]),
  equivalenceConfidence: confidenceSchema,
  repairIterationsUsed: z.number().int().nonnegative().default(0),
})
  .superRefine((decision, ctx) => {
    const failedRequiredGates = decision.gates.filter((gate) => gate.required && !gate.passed);
    if (decision.decision === 'PASS' && failedRequiredGates.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `PASS is invalid while required gates failed: ${failedRequiredGates
          .map((gate) => gate.gateId)
          .join(', ')}`,
      });
    }
    if (decision.decision === 'PASS' && decision.blockingReasons.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'PASS is invalid while blocking reasons are recorded',
      });
    }
    if (decision.decision === 'REJECT' && decision.blockingReasons.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REJECT requires at least one blocking reason: failures are never silent',
      });
    }
  });
export type ReleaseDecision = z.infer<typeof releaseDecisionSchema>;

export function renderReleaseReportMarkdown(decision: ReleaseDecision): string {
  const lines: string[] = [
    '# Release decision',
    '',
    `**Decision: ${decision.decision}**`,
    '',
    `- run: ${decision.runId}`,
    `- decided at: ${decision.decidedAt}`,
    `- decided by: ${decision.decidedBy} (gate evaluation: ${decision.evaluatedBy})`,
    `- equivalence confidence: ${decision.equivalenceConfidence.toFixed(2)}`,
    `- repair iterations used: ${decision.repairIterationsUsed}`,
    '',
    '## Gates',
    '',
    '| Gate | Required | Passed | Detail |',
    '| --- | --- | --- | --- |',
  ];
  for (const gate of decision.gates) {
    lines.push(
      `| ${gate.gateId} | ${gate.required ? 'yes' : 'no'} | ${gate.passed ? 'PASS' : 'FAIL'} | ${
        (gate.detail ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
      } |`,
    );
  }
  lines.push('');
  if (decision.blockingReasons.length > 0) {
    lines.push('## Blocking reasons', '');
    for (const reason of decision.blockingReasons) {
      lines.push(`- **[${reason.severity}] ${reason.code}** — ${reason.detail}`);
      if (reason.relatedInvariantIds.length > 0) {
        lines.push(`  - invariants: ${reason.relatedInvariantIds.join(', ')}`);
      }
      if (reason.relatedMismatchIds.length > 0) {
        lines.push(`  - mismatches: ${reason.relatedMismatchIds.join(', ')}`);
      }
    }
    lines.push('');
  }
  if (decision.warnings.length > 0) {
    lines.push('## Warnings', '');
    for (const warning of decision.warnings) lines.push(`- ${warning}`);
    lines.push('');
  }
  if (decision.unresolvedUnknowns.length > 0) {
    lines.push('## Unresolved unknowns', '');
    for (const unknown of decision.unresolvedUnknowns) lines.push(`- ${unknown}`);
    lines.push('');
  }
  lines.push(
    '## Evidence',
    '',
    decision.evidenceArtifactIds.length > 0
      ? decision.evidenceArtifactIds.map((id) => `- ${id}`).join('\n')
      : '- none recorded',
    '',
  );
  return lines.join('\n');
}

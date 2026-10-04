import {
  maxSeverity,
  nowIso,
  severityRank,
  verificationVerdictSchema,
  type ArtifactId,
  type DifferentialComparison,
  type InvariantCheckResult,
  type Mismatch,
  type Severity,
  type VerificationCheck,
  type VerificationVerdict,
} from '@phoenix/shared';
import { clipTo } from './compare.js';

/**
 * Turning comparison outcomes into a verdict. Deterministic code only: an LLM may explain a
 * mismatch later, but the verdict itself is arithmetic over recorded results.
 *
 * The asymmetry is deliberate. EQUIVALENT is only reachable when every scenario was judged and
 * matched. A scenario that could not be judged — inconclusive, or a baseline that stopped passing
 * its own legacy self-check — yields INCONCLUSIVE, never a pass by omission. Unreachable systems
 * and divergent behavior yield NOT_EQUIVALENT, because both leave the modern system unproven.
 */

const SUITE_CHECK_ID = 'characterization-suite-passes-on-legacy';
const EQUIVALENCE_CHECK_ID = 'differential-equivalence';
const COMPUTED_BY = '@phoenix/differential-testing/verdict.computeDifferentialVerdict';
const REASON_LIMIT = 2_000;
const DETAIL_LIMIT = 4_000;

export interface DifferentialVerdictInput {
  runId: string;
  comparisons: readonly DifferentialComparison[];
  mismatches: readonly Mismatch[];
  /** Cases whose recorded legacy baseline failed its own self-check, from `compareSuite`. */
  legacySelfCheckFailures?: readonly string[];
  repairIteration?: number;
  inputArtifactIds?: readonly ArtifactId[];
  /** Checks from other verification stages, evaluated alongside the differential ones. */
  additionalChecks?: readonly VerificationCheck[];
  invariantResults?: readonly InvariantCheckResult[];
  now?: () => Date;
}

export function computeDifferentialVerdict(input: DifferentialVerdictInput): VerificationVerdict {
  const now = input.now ?? (() => new Date());
  const drift = input.legacySelfCheckFailures ?? [];

  const total = input.comparisons.length;
  const equal = input.comparisons.filter((entry) => entry.outcome === 'equal').length;
  const divergent = input.comparisons.filter((entry) => entry.outcome === 'divergent').length;
  const inconclusive = input.comparisons.filter((entry) => entry.outcome === 'inconclusive').length;
  const unreachable = input.comparisons.filter(
    (entry) => entry.outcome === 'legacy-unreachable' || entry.outcome === 'modern-unreachable',
  ).length;

  const suiteCheck: VerificationCheck = {
    checkId: SUITE_CHECK_ID,
    kind: 'characterization-suite-passes-on-legacy',
    description:
      'The captured legacy baselines still satisfy their own characterization assertions, so they remain a sound contract to compare against.',
    status: drift.length > 0 ? 'FAIL' : total === 0 ? 'UNKNOWN' : 'PASS',
    required: true,
    observed: { comparisons: total, selfCheckFailures: drift.length },
    ...(drift.length > 0 ? { detail: clipTo(drift.join('; '), DETAIL_LIMIT) } : {}),
    relatedRuleIds: [],
    relatedInvariantIds: [],
    evidence: [],
  };

  const equivalenceCheck: VerificationCheck = {
    checkId: EQUIVALENCE_CHECK_ID,
    kind: 'differential-equivalence',
    description:
      'Every judged scenario must reproduce its captured legacy behavior exactly, with no scenario left unjudged.',
    status:
      divergent + unreachable > 0
        ? 'FAIL'
        : total === 0 || inconclusive > 0
          ? 'UNKNOWN'
          : 'PASS',
    required: true,
    observed: { total, equal, divergent, inconclusive, unreachable },
    threshold: { divergent: 0, inconclusive: 0, unreachable: 0 },
    ...(divergent + unreachable > 0
      ? { detail: clipTo(`${divergent} divergent, ${unreachable} unreachable`, DETAIL_LIMIT) }
      : {}),
    relatedRuleIds: [],
    relatedInvariantIds: [],
    evidence: [],
  };

  const checks: VerificationCheck[] = [suiteCheck, equivalenceCheck, ...(input.additionalChecks ?? [])];

  // Fixture drift is inability to judge, not evidence that the modern system differs: it routes to
  // INCONCLUSIVE through `drift`, while every other failed required check routes to NOT_EQUIVALENT.
  const hardCheckFailures = checks.filter(
    (check) => check.required && check.status === 'FAIL' && check.checkId !== SUITE_CHECK_ID,
  );

  const verdict =
    divergent > 0 || unreachable > 0 || hardCheckFailures.length > 0
      ? ('NOT_EQUIVALENT' as const)
      : total === 0 || inconclusive > 0 || drift.length > 0
        ? ('INCONCLUSIVE' as const)
        : ('EQUIVALENT' as const);

  const judgeable = equal + divergent;
  const confidence = total === 0 ? 0 : Math.round((judgeable / total) * 10_000) / 10_000;

  const bySeverity: Record<Severity, number> = { CRITICAL: 0, MAJOR: 0, MINOR: 0, INFO: 0 };
  for (const mismatch of input.mismatches) bySeverity[mismatch.severity] += 1;

  const unresolved = input.mismatches.filter((mismatch) => mismatch.resolvedAt === undefined);
  const repairTargets = [...unresolved]
    .sort(
      (left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        left.mismatchId.localeCompare(right.mismatchId),
    )
    .map((mismatch) => mismatch.mismatchId);

  const reasons: string[] = [];
  if (divergent > 0) {
    reasons.push(
      clipTo(
        `${divergent} of ${total} scenario(s) diverged from the legacy baseline: ${scenarioIdsOf(input.comparisons, 'divergent')}`,
        REASON_LIMIT,
      ),
    );
  }
  if (unreachable > 0) {
    reasons.push(
      clipTo(
        `${unreachable} scenario(s) could not be reached on the modern system: ${scenarioIdsOf(input.comparisons, 'unreachable')}`,
        REASON_LIMIT,
      ),
    );
  }
  if (inconclusive > 0) {
    reasons.push(
      clipTo(
        `${inconclusive} scenario(s) were inconclusive: ${scenarioIdsOf(input.comparisons, 'inconclusive')}`,
        REASON_LIMIT,
      ),
    );
  }
  if (drift.length > 0) {
    reasons.push(
      clipTo(
        `the characterization suite failed its own legacy self-check for ${drift.length} case(s): ${drift.join('; ')}`,
        REASON_LIMIT,
      ),
    );
  }
  if (total === 0) {
    reasons.push('no scenarios were compared, so no equivalence was established');
  }
  for (const failure of hardCheckFailures) {
    reasons.push(
      clipTo(
        `required check ${failure.checkId} failed: ${failure.detail ?? failure.description}`,
        REASON_LIMIT,
      ),
    );
  }
  if (verdict === 'EQUIVALENT') {
    reasons.push(`${equal} scenario(s) reproduce their captured legacy behavior exactly`);
  }

  return verificationVerdictSchema.parse({
    runId: input.runId,
    computedAt: nowIso(now()),
    computedBy: COMPUTED_BY,
    verdict,
    confidence,
    repairIteration: input.repairIteration ?? 0,
    checks,
    invariantResults: input.invariantResults ?? [],
    mismatchSummary: {
      total: input.mismatches.length,
      unresolved: unresolved.length,
      unexplained: input.mismatches.filter((m) => m.explanationStatus === 'unexplained').length,
      bySeverity,
      highestSeverity: maxSeverity(input.mismatches.map((m) => m.severity)),
    },
    inputArtifactIds: input.inputArtifactIds ?? [],
    reasons,
    repairTargets,
  });
}

function scenarioIdsOf(
  comparisons: readonly DifferentialComparison[],
  outcome: 'divergent' | 'inconclusive' | 'unreachable',
): string {
  const ids = comparisons
    .filter((entry) =>
      outcome === 'unreachable'
        ? entry.outcome === 'legacy-unreachable' || entry.outcome === 'modern-unreachable'
        : entry.outcome === outcome,
    )
    .map((entry) => entry.scenarioId);
  return [...new Set(ids)].join(', ');
}

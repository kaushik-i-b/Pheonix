import {
  computeDifferentialStatistics,
  differentialReportSchema,
  nowIso,
  type AgentRole,
  type DifferentialComparison,
  type DifferentialReport,
  type Mismatch,
  type NormalizationConfig,
} from '@phoenix/shared';
import { clipTo, renderValue } from './compare.js';

/**
 * The persisted differential report: everything a reader (human, diagnoser, or release guardian)
 * needs to see what was compared and what diverged, without re-running anything.
 */

const SUMMARY_LIMIT = 8_000;

export interface BuildDifferentialReportInput {
  runId: string;
  comparisons: readonly DifferentialComparison[];
  mismatches: readonly Mismatch[];
  normalization?: NormalizationConfig;
  generatedBy?: AgentRole;
  summary?: string;
  now?: () => Date;
}

export function buildDifferentialReport(input: BuildDifferentialReportInput): DifferentialReport {
  const now = input.now ?? (() => new Date());
  const comparisons = [...input.comparisons];
  const mismatches = [...input.mismatches];
  return differentialReportSchema.parse({
    runId: input.runId,
    generatedAt: nowIso(now()),
    generatedBy: input.generatedBy ?? 'differential-verifier',
    normalization: input.normalization ?? {
      schemaVersion: 1,
      rules: [],
      failOnUnconfiguredNondeterminism: true,
    },
    comparisons,
    mismatches,
    statistics: computeDifferentialStatistics({ comparisons, mismatches }),
    ...(input.summary !== undefined ? { summary: clipTo(input.summary, SUMMARY_LIMIT) } : {}),
  });
}

export function describeDifferentialReport(report: DifferentialReport): string {
  const stats = report.statistics;
  const lines = [
    `${stats.equal}/${stats.scenarios} scenarios equivalent, ${stats.mismatches} mismatch${
      stats.mismatches === 1 ? '' : 'es'
    }`,
  ];
  for (const mismatch of report.mismatches) {
    lines.push(
      `MISMATCH: ${mismatch.title} — legacy ${renderValue(mismatch.legacyValue)} vs modern ${renderValue(
        mismatch.modernValue,
      )} (${mismatch.scenarioId})`,
    );
  }
  if (stats.unreachable > 0) {
    lines.push(`${stats.unreachable} scenario(s) could not be reached on one side`);
  }
  if (stats.inconclusive > 0) {
    lines.push(`${stats.inconclusive} scenario(s) were inconclusive`);
  }
  if (stats.normalizationApplications > 0) {
    lines.push(`${stats.normalizationApplications} normalization application(s) recorded`);
  }
  return clipTo(lines.join('\n'), SUMMARY_LIMIT);
}

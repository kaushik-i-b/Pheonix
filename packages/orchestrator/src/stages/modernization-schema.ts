import { z } from 'zod';
import { PhoenixError, invariantIdSchema, ruleIdSchema, type BusinessRuleSet, type InvariantSet, type Scenario } from '@phoenix/shared';

/**
 * What the Modernizer is allowed to say, and how its answer becomes files on disk.
 *
 * Deliberately absent from this vocabulary: any claim that the implementation is correct. Whether
 * the code matches legacy is decided exclusively by executing differential scenarios against both
 * systems — a field for self-assessment would be a field for fiction, so there is none. The report
 * carries rule and invariant *ids* instead of file citations: its factual content is checked by
 * running it, not by quoting it.
 */

/** A path that can only name a file inside the modern workspace: relative, no traversal, no escapes. */
export function isSafeImplementationPath(path: string): boolean {
  if (path.length === 0 || path.length > 200) return false;
  if (path.startsWith('/') || path.includes('\\')) return false;
  if (/^[A-Za-z]:/.test(path)) return false;
  const segments = path.split('/');
  return segments.every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

const safeImplementationPath = z
  .string()
  .refine(isSafeImplementationPath, 'expected a relative path with no empty, "." or ".." segments, no backslash and no drive letter');

export const modelImplementationFileSchema = z.object({
  path: safeImplementationPath,
  content: z.string().min(1).max(120_000),
  description: z.string().max(600).optional(),
});
export type ModelImplementationFile = z.infer<typeof modelImplementationFileSchema>;

/** The whole answer must fit one model reply; a larger total can never survive the token budget. */
const MAX_TOTAL_CONTENT_CHARS = 60_000;

export const modernizationReportSchema = z
  .object({
    summary: z.string().min(20).max(4000),
    /** The file that starts the server; run with `tsx <entryPoint>` with PORT in the environment. */
    entryPoint: safeImplementationPath,
    files: z.array(modelImplementationFileSchema).min(1).max(12),
    /** Where POST resets all state to a clean startup condition. Declared, not dictated. */
    resetPath: z
      .string()
      .regex(/^\/[A-Za-z0-9_./-]*$/, 'expected an absolute HTTP path like /test/reset')
      .default('/test/reset'),
    ruleIdsImplemented: z.array(ruleIdSchema).max(60).default([]),
    invariantIdsAddressed: z.array(invariantIdSchema).max(40).default([]),
    assumptions: z.array(z.string().min(1).max(1000)).max(20).default([]),
  })
  .superRefine((report, ctx) => {
    const seen = new Set<string>();
    for (const file of report.files) {
      if (seen.has(file.path)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files'], message: `path ${file.path} appears more than once` });
      }
      seen.add(file.path);
    }
    if (!seen.has(report.entryPoint)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['entryPoint'],
        message: `entryPoint ${report.entryPoint} is not among files; the server could never be started`,
      });
    }
    const total = report.files.reduce((sum, file) => sum + file.content.length, 0);
    if (total > MAX_TOTAL_CONTENT_CHARS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files'],
        message: `files total ${total} characters; keep the whole implementation under ${MAX_TOTAL_CONTENT_CHARS} — smallest working code, no boilerplate`,
      });
    }
  });
export type ModernizationReport = z.infer<typeof modernizationReportSchema>;

/** What the host records about the implementation it actually wrote to disk — hashes included. */
export const modernizationChangeReportSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: z.string().min(1),
  generatedBy: z.string().min(1),
  summary: z.string().min(1),
  entryPoint: z.string().min(1),
  resetPath: z.string().min(1),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().min(1),
        description: z.string().max(600).optional(),
      }),
    )
    .min(1),
  ruleIdsImplemented: z.array(ruleIdSchema).default([]),
  invariantIdsAddressed: z.array(invariantIdSchema).default([]),
  assumptions: z.array(z.string().min(1)).default([]),
});
export type ModernizationChangeReport = z.infer<typeof modernizationChangeReportSchema>;

/** Guards the persister against a report the field-level schemas would let through. */
export function assertModernizationIsUsable(report: ModernizationReport): void {
  const paths = new Set(report.files.map((file) => file.path));
  if (!paths.has(report.entryPoint)) {
    throw new PhoenixError(
      'SCHEMA_VALIDATION_FAILED',
      `entryPoint ${report.entryPoint} is not among the returned files; the server could never be started`,
      { entryPoint: report.entryPoint },
    );
  }
  for (const file of report.files) {
    if (!isSafeImplementationPath(file.path)) {
      throw new PhoenixError('SCHEMA_VALIDATION_FAILED', `implementation path ${file.path} is not a safe relative path`, {
        path: file.path,
      });
    }
  }
}

export interface ModernizationBriefOptions {
  /** Rules rendered in full; the rest are counted. Default 40. */
  maxRules?: number;
  /** Invariants rendered in full. Default 30. */
  maxInvariants?: number;
  /** Hard cap on the whole brief. Default 16000. */
  maxChars?: number;
}

/**
 * What the Modernizer is handed from the specification: each rule's observable behavior and where
 * it is enforced, each invariant's statement. Quoted source text is left out on purpose — the
 * Modernizer is expected to open the cited files itself, and a quote lifted from a brief is how a
 * detail gets copied without its context.
 */
export function modernizationSpecBrief(
  rules: BusinessRuleSet,
  invariants: InvariantSet,
  options: ModernizationBriefOptions = {},
): string {
  const maxRules = options.maxRules ?? 40;
  const maxInvariants = options.maxInvariants ?? 30;
  const maxChars = options.maxChars ?? 16_000;

  const lines: string[] = ['# Business rules the implementation must reproduce', ''];
  for (const rule of rules.rules.slice(0, maxRules)) {
    lines.push(`## ${rule.ruleId} — ${rule.title} [${rule.kind}, ${rule.epistemicStatus}, confidence ${rule.confidence.toFixed(2)}]`);
    lines.push(`Observable: ${rule.observableBehavior}`);
    const locations = [
      ...rule.sourceEvidence,
      ...rule.edgeCases.flatMap((edgeCase) => edgeCase.evidence),
    ]
      .map((item) => {
        const where = item.location?.path ?? '(no path)';
        const line = item.location?.startLine !== undefined ? `:${item.location.startLine}` : '';
        const symbol = item.location?.symbol !== undefined ? ` (${item.location.symbol})` : '';
        return `${where}${line}${symbol}`;
      })
      .filter((location) => location !== '(no path)');
    if (locations.length > 0) lines.push(`Enforced at: ${[...new Set(locations)].join(', ')}`);
    if (rule.duplicateImplementations.length > 0) {
      lines.push(`Duplicated in: ${rule.duplicateImplementations.join(', ')}`);
    }
    for (const edgeCase of rule.edgeCases) {
      lines.push(`- edge case ${edgeCase.id}: ${edgeCase.description}${edgeCase.expectedBehavior !== undefined ? ` → ${edgeCase.expectedBehavior}` : ''}`);
    }
    lines.push('');
  }
  if (rules.rules.length > maxRules) {
    lines.push(`${rules.rules.length - maxRules} further rule(s) were omitted; their ids are: ${rules.rules.slice(maxRules).map((rule) => rule.ruleId).join(', ')}`, '');
  }

  lines.push('# Invariants the implementation must preserve', '');
  for (const invariant of invariants.invariants.slice(0, maxInvariants)) {
    lines.push(`## ${invariant.invariantId} — ${invariant.statement} [${invariant.kind}, ${invariant.criticality}]`);
    lines.push('');
  }
  if (invariants.invariants.length > maxInvariants) {
    lines.push(
      `${invariants.invariants.length - maxInvariants} further invariant(s) were omitted; their ids are: ${invariants.invariants
        .slice(maxInvariants)
        .map((invariant) => invariant.invariantId)
        .join(', ')}`,
      '',
    );
  }

  const brief = lines.join('\n');
  if (brief.length <= maxChars) return brief;
  return `${brief.slice(0, maxChars)}\n\n[specification brief truncated at ${maxChars} characters of ${brief.length}; read specification/business-rules.json and specification/invariants.json for the rest]`;
}

/**
 * The scenarios' *requests* only — method, path, payload, side steps. What legacy answered is
 * withheld on purpose: the Modernizer must derive behavior from the specification and the legacy
 * code, not transcribe recorded outputs it was never supposed to see.
 */
export function modernizationScenarioBrief(scenarios: readonly Scenario[], options: { maxChars?: number } = {}): string {
  const maxChars = options.maxChars ?? 12_000;
  const lines: string[] = [
    '# Scenarios the implementation must handle',
    '',
    'These were recorded against the legacy system. Only the requests are shown — never the responses. Derive what each request should return from the business rules above and from the legacy source itself.',
    '',
  ];
  for (const scenario of scenarios) {
    lines.push(`## ${scenario.scenarioId} — ${scenario.title} [${scenario.category}]`);
    if (scenario.hypothesis !== undefined) lines.push(`Why: ${scenario.hypothesis}`);
    for (const phase of [
      { label: 'setup', steps: scenario.setup },
      { label: 'steps', steps: scenario.steps },
      { label: 'teardown', steps: scenario.teardown },
    ]) {
      for (const step of phase.steps) lines.push(`- ${phase.label} ${step.stepId}${step.required ? '' : ' (optional)'}: ${renderStepInputs(step)}`);
    }
    if (scenario.targetRuleIds.length > 0) lines.push(`  targets rules: ${scenario.targetRuleIds.join(', ')}`);
    if (scenario.targetInvariantIds.length > 0) lines.push(`  targets invariants: ${scenario.targetInvariantIds.join(', ')}`);
    lines.push('');
  }

  const brief = lines.join('\n');
  if (brief.length <= maxChars) return brief;
  return `${brief.slice(0, maxChars)}\n\n[scenario brief truncated at ${maxChars} characters of ${brief.length}]`;
}

function renderStepInputs(step: Scenario['steps'][number]): string {
  switch (step.kind) {
    case 'http': {
      if (step.http === undefined) return 'http step with no payload';
      const query = Object.entries(step.http.query)
        .map(([key, value]) => `${key}=${value}`)
        .join('&');
      const body = step.http.rawBody ?? (step.http.body !== undefined ? JSON.stringify(step.http.body) : undefined);
      return `${step.http.method} ${step.http.path}${query.length > 0 ? `?${query}` : ''}${
        body !== undefined ? ` body=${clip(body, 400)}` : ''
      }${Object.keys(step.http.headers).length > 0 ? ` headers=${JSON.stringify(step.http.headers)}` : ''}`;
    }
    case 'sql':
      return step.sql === undefined ? 'sql step with no payload' : `SQL ${clip(step.sql.statement, 300)} params=${JSON.stringify(step.sql.params)}`;
    case 'command':
      return step.command === undefined ? 'command step with no payload' : `command ${step.command.argv.join(' ')}`;
    case 'wait':
      return `wait ${step.waitMs ?? 0}ms`;
    case 'reset':
      return 'reset all state';
    case 'assert-db':
      return step.sql === undefined ? 'assert-db step with no payload' : `assert DB ${clip(step.sql.statement, 300)}`;
  }
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

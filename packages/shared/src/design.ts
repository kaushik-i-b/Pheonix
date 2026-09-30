import { z } from 'zod';
import { invariantIdSchema, isoTimestampSchema, ruleIdSchema, severitySchema } from './primitives.js';
import { agentRoleSchema } from './roles.js';

/**
 * Design artifacts (brief §4 "Architect"). Every decision must reference the requirements or
 * invariants it exists to satisfy — a decision that cites nothing is a preference, not a design.
 */

export const decisionOptionSchema = z.object({
  optionId: z.string().min(1),
  description: z.string().min(1).max(4000),
  pros: z.array(z.string().max(500)).default([]),
  cons: z.array(z.string().max(500)).default([]),
});
export type DecisionOption = z.infer<typeof decisionOptionSchema>;

export const architectureDecisionSchema = z.object({
  decisionId: z.string().min(1),
  title: z.string().min(1).max(300),
  context: z.string().min(1).max(4000),
  options: z.array(decisionOptionSchema).min(1),
  chosenOptionId: z.string().min(1),
  rationale: z.string().min(1).max(4000),
  /** The requirement-level justification: which discovered rules/invariants force this decision. */
  referencesRuleIds: z.array(ruleIdSchema).default([]),
  referencesInvariantIds: z.array(invariantIdSchema).default([]),
  tradeoffs: z.array(z.string().max(1000)).default([]),
  reversibility: z.enum(['easy', 'hard', 'one-way']).default('hard'),
  riskIds: z.array(z.string().min(1)).default([]),
})
  .superRefine((decision, ctx) => {
    if (!decision.options.some((option) => option.optionId === decision.chosenOptionId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `chosenOptionId "${decision.chosenOptionId}" is not among the listed options`,
      });
    }
    if (decision.referencesRuleIds.length === 0 && decision.referencesInvariantIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an architecture decision must reference at least one discovered rule or invariant, otherwise it is unjustified',
      });
    }
  });
export type ArchitectureDecision = z.infer<typeof architectureDecisionSchema>;

export const componentSchema = z.object({
  componentId: z.string().min(1),
  name: z.string().min(1).max(200),
  kind: z.enum(['api', 'service', 'domain', 'persistence', 'job', 'adapter', 'shared', 'infrastructure']),
  responsibility: z.string().min(1).max(2000),
  dependsOn: z.array(z.string().min(1)).default([]),
  /** Legacy components this replaces; used to prove nothing was dropped on the floor. */
  replacesLegacyComponents: z.array(z.string().min(1)).default([]),
  implementsRuleIds: z.array(ruleIdSchema).default([]),
  upholdsInvariantIds: z.array(invariantIdSchema).default([]),
  targetPath: z.string().min(1).optional(),
});
export type Component = z.infer<typeof componentSchema>;

export const apiContractEntrySchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD']),
  path: z.string().min(1),
  purpose: z.string().min(1).max(1000),
  requestShape: z.string().max(4000).optional(),
  responseShape: z.string().max(4000).optional(),
  /** The legacy endpoint whose externally observable behavior must be preserved. */
  mapsToLegacyEndpointId: z.string().min(1).optional(),
  preservesRuleIds: z.array(ruleIdSchema).default([]),
  intentionalDifferences: z.array(z.string().max(1000)).default([]),
});
export type ApiContractEntry = z.infer<typeof apiContractEntrySchema>;

export const dataModelEntrySchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['table', 'entity', 'view', 'event']),
  fields: z.array(z.object({ name: z.string().min(1), type: z.string().min(1), constraints: z.array(z.string().max(200)).default([]) })).default([]),
  constraints: z.array(z.string().max(500)).default([]),
  mapsToLegacyObject: z.string().min(1).optional(),
  upholdsInvariantIds: z.array(invariantIdSchema).default([]),
});
export type DataModelEntry = z.infer<typeof dataModelEntrySchema>;

export const architectureDesignSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generatedBy: agentRoleSchema,
  targetStack: z.object({
    language: z.string().min(1),
    framework: z.string().min(1).optional(),
    database: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
  }),
  summary: z.string().min(1).max(8000),
  components: z.array(componentSchema).min(1),
  decisions: z.array(architectureDecisionSchema).default([]),
  apiContract: z.array(apiContractEntrySchema).default([]),
  dataModel: z.array(dataModelEntrySchema).default([]),
  crossCutting: z.array(z.object({ concern: z.string().min(1).max(200), approach: z.string().min(1).max(4000), referencesInvariantIds: z.array(invariantIdSchema).default([]) })).default([]),
  openQuestions: z.array(z.string().max(2000)).default([]),
});
export type ArchitectureDesign = z.infer<typeof architectureDesignSchema>;

export const migrationStepSchema = z.object({
  stepId: z.string().min(1),
  description: z.string().min(1).max(2000),
  kind: z.enum(['schema', 'data', 'code', 'configuration', 'validation', 'cutover', 'rollback']),
  validation: z.array(z.string().max(1000)).default([]),
  reversible: z.boolean().default(true),
});
export type MigrationStep = z.infer<typeof migrationStepSchema>;

export const migrationPhaseSchema = z.object({
  phaseId: z.string().min(1),
  name: z.string().min(1).max(200),
  objective: z.string().min(1).max(2000),
  steps: z.array(migrationStepSchema).min(1),
  dependsOnPhases: z.array(z.string().min(1)).default([]),
  exitCriteria: z.array(z.string().max(1000)).default([]),
  rollback: z.string().max(2000).optional(),
});
export type MigrationPhase = z.infer<typeof migrationPhaseSchema>;

export const migrationPlanSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generatedBy: agentRoleSchema,
  strategy: z.enum(['big-bang', 'parallel-run', 'strangler-fig', 'shadow-traffic', 'incremental-cutover']),
  phases: z.array(migrationPhaseSchema).min(1),
  dataMigration: z.object({
    required: z.boolean().default(false),
    steps: z.array(migrationStepSchema).default([]),
    validationQueries: z.array(z.string().max(4000)).default([]),
    /** How historical immutability and settled records are preserved. */
    historicalPreservation: z.string().max(4000).optional(),
  }).default({ required: false }),
  parallelRunPlan: z.object({
    enabled: z.boolean().default(true),
    comparisonStrategy: z.string().max(4000).optional(),
    durationHint: z.string().max(200).optional(),
  }).default({ enabled: true }),
  cutover: z.object({ criteria: z.array(z.string().max(1000)).default([]), rollbackTrigger: z.string().max(2000).optional() }).default({ criteria: [] }),
  referencesRuleIds: z.array(ruleIdSchema).default([]),
  referencesInvariantIds: z.array(invariantIdSchema).default([]),
});
export type MigrationPlan = z.infer<typeof migrationPlanSchema>;

export const riskSchema = z.object({
  riskId: z.string().min(1),
  description: z.string().min(1).max(2000),
  category: z.enum([
    'behavioral-divergence',
    'data-loss',
    'precision',
    'concurrency',
    'performance',
    'operational',
    'security',
    'compliance',
    'unknown-unknown',
    'schedule',
    'other',
  ]),
  likelihood: z.number().int().min(1).max(5),
  impact: z.number().int().min(1).max(5),
  severity: severitySchema,
  mitigation: z.string().min(1).max(4000),
  contingency: z.string().max(4000).optional(),
  relatedRuleIds: z.array(ruleIdSchema).default([]),
  relatedInvariantIds: z.array(invariantIdSchema).default([]),
  status: z.enum(['open', 'mitigated', 'accepted', 'materialized']).default('open'),
  detectedBy: z.string().min(1).optional(),
});
export type Risk = z.infer<typeof riskSchema>;

export const riskRegisterSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  generatedAt: isoTimestampSchema,
  generatedBy: agentRoleSchema,
  risks: z.array(riskSchema).default([]),
  statistics: z.object({
    total: z.number().int().nonnegative(),
    open: z.number().int().nonnegative(),
    bySeverity: z.record(severitySchema, z.number().int().nonnegative()),
  }).optional(),
});
export type RiskRegister = z.infer<typeof riskRegisterSchema>;

export function computeRiskStatistics(risks: readonly Risk[]): RiskRegister['statistics'] {
  const bySeverity: Record<z.infer<typeof severitySchema>, number> = {
    CRITICAL: 0,
    MAJOR: 0,
    MINOR: 0,
    INFO: 0,
  };
  for (const risk of risks) bySeverity[risk.severity] += 1;
  return {
    total: risks.length,
    open: risks.filter((risk) => risk.status === 'open' || risk.status === 'materialized').length,
    bySeverity,
  };
}

/** Deterministic severity from the standard 5x5 likelihood/impact grid. */
export function riskSeverity(likelihood: number, impact: number): z.infer<typeof severitySchema> {
  const score = likelihood * impact;
  if (score >= 16) return 'CRITICAL';
  if (score >= 9) return 'MAJOR';
  if (score >= 4) return 'MINOR';
  return 'INFO';
}

export function renderArchitectureMarkdown(design: ArchitectureDesign): string {
  const lines: string[] = ['# Architecture', '', design.summary, ''];
  lines.push(
    '## Target stack',
    '',
    `- language: ${design.targetStack.language}`,
    `- framework: ${design.targetStack.framework ?? 'n/a'}`,
    `- database: ${design.targetStack.database ?? 'n/a'}`,
    `- runtime: ${design.targetStack.runtime ?? 'n/a'}`,
    '',
  );
  lines.push('## Components', '');
  for (const component of design.components) {
    lines.push(
      `### ${component.name} (${component.kind})`,
      '',
      component.responsibility,
      '',
      `- replaces legacy: ${component.replacesLegacyComponents.join(', ') || 'n/a'}`,
      `- implements rules: ${component.implementsRuleIds.join(', ') || 'n/a'}`,
      `- upholds invariants: ${component.upholdsInvariantIds.join(', ') || 'n/a'}`,
      `- depends on: ${component.dependsOn.join(', ') || 'nothing'}`,
      '',
    );
  }
  if (design.decisions.length > 0) {
    lines.push('## Decisions', '');
    for (const decision of design.decisions) {
      lines.push(`### ${decision.decisionId}: ${decision.title}`, '', decision.context, '');
      lines.push('Options considered:', '');
      for (const option of decision.options) {
        const marker = option.optionId === decision.chosenOptionId ? '**chosen**' : 'rejected';
        lines.push(`- ${option.optionId} (${marker}): ${option.description}`);
      }
      lines.push('', `Rationale: ${decision.rationale}`, '');
      lines.push(
        `- references rules: ${decision.referencesRuleIds.join(', ') || 'none'}`,
        `- references invariants: ${decision.referencesInvariantIds.join(', ') || 'none'}`,
        `- reversibility: ${decision.reversibility}`,
        '',
      );
    }
  }
  if (design.apiContract.length > 0) {
    lines.push('## API contract', '', '| Method | Path | Purpose | Legacy endpoint |', '| --- | --- | --- | --- |');
    for (const entry of design.apiContract) {
      lines.push(
        `| ${entry.method} | ${entry.path} | ${entry.purpose.replace(/\|/g, '\\|')} | ${entry.mapsToLegacyEndpointId ?? 'n/a'} |`,
      );
    }
    lines.push('');
  }
  if (design.openQuestions.length > 0) {
    lines.push('## Open questions', '');
    for (const question of design.openQuestions) lines.push(`- ${question}`);
    lines.push('');
  }
  return lines.join('\n');
}

export function renderMigrationPlanMarkdown(plan: MigrationPlan): string {
  const lines: string[] = ['# Migration plan', '', `Strategy: ${plan.strategy}`, ''];
  for (const phase of plan.phases) {
    lines.push(`## ${phase.phaseId}: ${phase.name}`, '', phase.objective, '');
    for (const step of phase.steps) {
      lines.push(`- [${step.kind}] ${step.description} (reversible: ${step.reversible})`);
      for (const validation of step.validation) lines.push(`  - validate: ${validation}`);
    }
    if (phase.exitCriteria.length > 0) {
      lines.push('', 'Exit criteria:');
      for (const criterion of phase.exitCriteria) lines.push(`- ${criterion}`);
    }
    if (phase.rollback) lines.push('', `Rollback: ${phase.rollback}`);
    lines.push('');
  }
  if (plan.dataMigration.required) {
    lines.push('## Data migration', '');
    for (const step of plan.dataMigration.steps) lines.push(`- [${step.kind}] ${step.description}`);
    if (plan.dataMigration.historicalPreservation) {
      lines.push('', plan.dataMigration.historicalPreservation);
    }
    lines.push('');
  }
  if (plan.cutover.criteria.length > 0) {
    lines.push('## Cutover criteria', '');
    for (const criterion of plan.cutover.criteria) lines.push(`- ${criterion}`);
    lines.push('');
  }
  return lines.join('\n');
}

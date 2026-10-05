import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import type { Variant } from './artifacts.js';
import type { Workspace } from './repo-root.js';

export interface Evidence {
  id: string | null;
  kind: string;
  quote: string;
  note: string | null;
  collectedAt: string | null;
  collectedBy: string | null;
  path: string;
  startLine: number;
  endLine: number;
  symbol: string | null;
}

export interface EdgeCase {
  id: string | null;
  description: string;
  epistemicStatus: string | null;
  confidence: number | null;
  expectedBehavior: string | null;
  evidence: Evidence[];
}

export interface ProposedCheck {
  id: string;
  kind: string | null;
  description: string;
  targetsRuleId: string | null;
}

export interface Rule {
  ruleId: string;
  title: string;
  kind: string | null;
  epistemicStatus: string | null;
  lifecycleStatus: string | null;
  description: string | null;
  confidence: number | null;
  confidenceBasis: string | null;
  testable: boolean | null;
  observableBehavior: string | null;
  affectedComponents: string[];
  assumptions: string[];
  duplicateImplementations: string[];
  sourceEvidence: Evidence[];
  edgeCases: EdgeCase[];
  contradictsRuleIds: string[];
  derivedFromInvariantIds: string[];
  proposedChecks: ProposedCheck[];
}

export interface InvariantExample {
  description: string;
  expected: string;
}

export interface CheckingStrategy {
  kind: string | null;
  automated: boolean | null;
  executable: string | null;
  detail: string | null;
}

export interface Invariant {
  invariantId: string;
  statement: string;
  formalStatement: string | null;
  kind: string | null;
  criticality: string | null;
  epistemicStatus: string | null;
  lifecycleStatus: string | null;
  violationSeverity: string | null;
  confidence: number | null;
  scope: {
    components: string[];
    operations: string[];
  };
  checkingStrategy: CheckingStrategy;
  examples: InvariantExample[];
  knownExceptions: string[];
  derivedFromRuleIds: string[];
  sourceEvidence: Evidence[];
}

export interface SpecUnknown {
  id: string;
  question: string;
  whyItMatters: string | null;
  resolutionStrategy: string | null;
  relatedRuleIds: string[];
  relatedInvariantIds: string[];
}

export interface SpecArtifact {
  slug: string;
  fileName: string;
  variant: Variant;
  taskId: string | null;
  ruleCount: number;
  invariantCount: number;
  unknownCount: number;
  rules: Rule[];
  invariants: Invariant[];
  unknowns: SpecUnknown[];
  statistics: Record<string, unknown> | null;
  generatedAt: string | null;
}

export interface SpecificationView {
  artifacts: SpecArtifact[];
  ruleIndex: Map<string, { slug: string; rule: Rule }>;
  problems: string[];
}

type Family = 'rules' | 'invariants';

interface SpecificationGroup {
  variant: Variant;
  taskId: string | null;
  rulesFile: string | null;
  invariantsFile: string | null;
}

const attemptPattern = /^(business-rules|invariants)-attempt-(task_[0-9a-f]+)\.json$/;

export function loadSpecification(ws: Workspace, runId: string): SpecificationView {
  const artifacts: SpecArtifact[] = [];
  const ruleIndex = new Map<string, { slug: string; rule: Rule }>();
  const problems: string[] = [];

  const dir = path.join(ws.artifactsDir, runId, 'specification');
  if (!existsSync(dir)) return { artifacts, ruleIndex, problems };

  const canonical: { rules: string | null; invariants: string | null } = {
    rules: null,
    invariants: null,
  };
  const attempts = new Map<string, { rules: string | null; invariants: string | null }>();

  const fileNames = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  for (const fileName of fileNames) {
    if (!fileName.endsWith('.json')) continue;
    if (fileName === 'business-rules.json' || fileName === 'invariants.json') {
      const family: Family = fileName === 'business-rules.json' ? 'rules' : 'invariants';
      canonical[family] = fileName;
      continue;
    }
    if (!fileName.startsWith('business-rules') && !fileName.startsWith('invariants')) continue;
    const match = attemptPattern.exec(fileName);
    if (match === null) {
      problems.push(`${fileName}: unrecognized specification file name`);
      continue;
    }
    const taskId = match[2]!;
    let group = attempts.get(taskId);
    if (group === undefined) {
      group = { rules: null, invariants: null };
      attempts.set(taskId, group);
    }
    group[match[1] === 'business-rules' ? 'rules' : 'invariants'] = fileName;
  }

  const groups: SpecificationGroup[] = [
    {
      variant: 'canonical',
      taskId: null,
      rulesFile: canonical.rules,
      invariantsFile: canonical.invariants,
    },
    ...[...attempts.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([taskId, files]) => ({
        variant: 'attempt' as const,
        taskId,
        rulesFile: files.rules,
        invariantsFile: files.invariants,
      })),
  ];

  for (const group of groups) {
    loadGroup(dir, group, problems, artifacts, ruleIndex);
  }
  return { artifacts, ruleIndex, problems };
}

function loadGroup(
  dir: string,
  group: SpecificationGroup,
  problems: string[],
  artifacts: SpecArtifact[],
  ruleIndex: Map<string, { slug: string; rule: Rule }>,
): void {
  const refs: Array<{ fileName: string; family: Family }> = [];
  if (group.rulesFile !== null) refs.push({ fileName: group.rulesFile, family: 'rules' });
  if (group.invariantsFile !== null)
    refs.push({ fileName: group.invariantsFile, family: 'invariants' });

  const loaded: Array<{ fileName: string; family: Family; payload: Record<string, unknown> }> = [];
  for (const ref of refs) {
    const payload = readSpecPayload(path.join(dir, ref.fileName), ref.fileName, problems);
    if (payload === null) continue;
    const entries = payload[ref.family];
    if (!Array.isArray(entries)) {
      problems.push(`${ref.fileName}: payload.${ref.family} is not an array`);
      continue;
    }
    loaded.push({ ...ref, payload });
  }
  if (loaded.length === 0) return;

  const primary = loaded[0]!;
  const artifact = makeArtifact(
    slugFrom(primary.fileName),
    primary.fileName,
    group.variant,
    group.taskId,
  );
  const seenUnknownIds = new Set<string>();

  for (const file of loaded) {
    if (file.family === 'rules') {
      (file.payload.rules as unknown[]).forEach((raw, index) => {
        const rule = normalizeRule(raw, file.fileName, index, problems);
        if (rule === null) return;
        artifact.rules.push(rule);
        indexRule(artifact, rule, ruleIndex, problems);
      });
    } else {
      (file.payload.invariants as unknown[]).forEach((raw, index) => {
        const invariant = normalizeInvariant(raw, file.fileName, index, problems);
        if (invariant !== null) artifact.invariants.push(invariant);
      });
    }
    const rawUnknowns = file.payload.unknowns;
    if (Array.isArray(rawUnknowns)) {
      rawUnknowns.forEach((raw, index) => {
        const entry = normalizeUnknown(raw, file.fileName, index, problems);
        if (entry === null || seenUnknownIds.has(entry.id)) return;
        seenUnknownIds.add(entry.id);
        artifact.unknowns.push(entry);
      });
    }
    // The rules artifact carries the richer statistics block; fall back to the invariants one.
    artifact.statistics = artifact.statistics ?? asRecord(file.payload.statistics);
    artifact.generatedAt = artifact.generatedAt ?? asString(file.payload.generatedAt);
  }

  artifact.ruleCount = artifact.rules.length;
  artifact.invariantCount = artifact.invariants.length;
  artifact.unknownCount = artifact.unknowns.length;
  artifacts.push(artifact);
}

function indexRule(
  artifact: SpecArtifact,
  rule: Rule,
  ruleIndex: Map<string, { slug: string; rule: Rule }>,
  problems: string[],
): void {
  const existing = ruleIndex.get(rule.ruleId);
  if (existing !== undefined) {
    problems.push(
      `duplicate rule id ${rule.ruleId} in ${artifact.fileName}; kept the entry from ${existing.slug}`,
    );
    return;
  }
  ruleIndex.set(rule.ruleId, { slug: artifact.slug, rule });
}

function readSpecPayload(
  file: string,
  fileName: string,
  problems: string[],
): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    problems.push(`${fileName}: unparseable JSON`);
    return null;
  }
  const payload = asRecord(asRecord(parsed)?.payload);
  if (payload === null) {
    problems.push(`${fileName}: payload is not an object`);
    return null;
  }
  return payload;
}

function normalizeRule(
  raw: unknown,
  fileName: string,
  index: number,
  problems: string[],
): Rule | null {
  const record = asRecord(raw);
  const ruleId = record?.ruleId;
  const title = record?.title;
  if (
    record === null ||
    typeof ruleId !== 'string' ||
    ruleId.length === 0 ||
    typeof title !== 'string' ||
    title.length === 0
  ) {
    problems.push(`${fileName}: dropped rule ${index + 1}: missing ruleId or title`);
    return null;
  }
  return {
    ruleId,
    title,
    kind: asString(record.kind),
    epistemicStatus: asString(record.epistemicStatus),
    lifecycleStatus: asString(record.lifecycleStatus),
    description: asString(record.description),
    confidence: asNumber(record.confidence),
    confidenceBasis: asString(record.confidenceBasis),
    testable: asBoolean(record.testable),
    observableBehavior: asString(record.observableBehavior),
    affectedComponents: stringArray(record.affectedComponents),
    assumptions: stringArray(record.assumptions),
    duplicateImplementations: stringArray(record.duplicateImplementations),
    sourceEvidence: normalizeEvidenceList(
      record.sourceEvidence,
      `rule ${ruleId}`,
      fileName,
      problems,
    ),
    edgeCases: normalizeEdgeCases(record.edgeCases, ruleId, fileName, problems),
    contradictsRuleIds: stringArray(record.contradictsRuleIds),
    derivedFromInvariantIds: stringArray(record.derivedFromInvariantIds),
    proposedChecks: normalizeProposedChecks(record.proposedChecks, ruleId, fileName, problems),
  };
}

function normalizeInvariant(
  raw: unknown,
  fileName: string,
  index: number,
  problems: string[],
): Invariant | null {
  const record = asRecord(raw);
  const invariantId = record?.invariantId;
  const statement = record?.statement;
  if (
    record === null ||
    typeof invariantId !== 'string' ||
    invariantId.length === 0 ||
    typeof statement !== 'string' ||
    statement.length === 0
  ) {
    problems.push(`${fileName}: dropped invariant ${index + 1}: missing invariantId or statement`);
    return null;
  }
  const scope = asRecord(record.scope);
  const strategy = asRecord(record.checkingStrategy);
  return {
    invariantId,
    statement,
    formalStatement: asString(record.formalStatement),
    kind: asString(record.kind),
    criticality: asString(record.criticality),
    epistemicStatus: asString(record.epistemicStatus),
    lifecycleStatus: asString(record.lifecycleStatus),
    violationSeverity: asString(record.violationSeverity),
    confidence: asNumber(record.confidence),
    scope: {
      components: stringArray(scope?.components),
      operations: stringArray(scope?.operations),
    },
    checkingStrategy: {
      kind: asString(strategy?.kind),
      automated: asBoolean(strategy?.automated),
      executable: asString(strategy?.executable),
      detail: asString(strategy?.detail),
    },
    examples: normalizeExamples(record.examples, invariantId, fileName, problems),
    knownExceptions: stringArray(record.knownExceptions),
    derivedFromRuleIds: stringArray(record.derivedFromRuleIds),
    sourceEvidence: normalizeEvidenceList(
      record.sourceEvidence,
      `invariant ${invariantId}`,
      fileName,
      problems,
    ),
  };
}

export function normalizeUnknown(
  raw: unknown,
  fileName: string,
  index: number,
  problems: string[],
): SpecUnknown | null {
  const record = asRecord(raw);
  const id = record?.id;
  const question = record?.question;
  if (
    record === null ||
    typeof id !== 'string' ||
    id.length === 0 ||
    typeof question !== 'string' ||
    question.length === 0
  ) {
    problems.push(`${fileName}: dropped unknown ${index + 1}: missing id or question`);
    return null;
  }
  return {
    id,
    question,
    whyItMatters: asString(record.whyItMatters),
    resolutionStrategy: asString(record.resolutionStrategy),
    relatedRuleIds: stringArray(record.relatedRuleIds),
    relatedInvariantIds: stringArray(record.relatedInvariantIds),
  };
}

export function normalizeEvidenceList(
  raw: unknown,
  context: string,
  fileName: string,
  problems: string[],
): Evidence[] {
  if (!Array.isArray(raw)) return [];
  const out: Evidence[] = [];
  for (const item of raw) {
    const evidence = normalizeEvidence(item);
    if (evidence === null) {
      problems.push(`${fileName}: dropped evidence for ${context}: missing quote or location`);
      continue;
    }
    out.push(evidence);
  }
  return out;
}

function normalizeEvidence(raw: unknown): Evidence | null {
  const record = asRecord(raw);
  if (record === null) return null;
  const location = asRecord(record.location);
  const kind = record.kind;
  const quote = record.quote;
  const path = location?.path;
  const startLine = location?.startLine;
  if (
    typeof kind !== 'string' ||
    kind.length === 0 ||
    typeof quote !== 'string' ||
    quote.length === 0 ||
    typeof path !== 'string' ||
    path.length === 0 ||
    typeof startLine !== 'number' ||
    !Number.isInteger(startLine)
  ) {
    return null;
  }
  const endLineRaw = location?.endLine;
  const endLine =
    typeof endLineRaw === 'number' && Number.isInteger(endLineRaw) ? endLineRaw : startLine;
  return {
    id: asString(record.id),
    kind,
    quote,
    note: asString(record.note),
    collectedAt: asString(record.collectedAt),
    collectedBy: asString(record.collectedBy),
    path,
    startLine,
    endLine,
    symbol: asString(location?.symbol),
  };
}

function normalizeEdgeCases(
  raw: unknown,
  ruleId: string,
  fileName: string,
  problems: string[],
): EdgeCase[] {
  if (!Array.isArray(raw)) return [];
  const out: EdgeCase[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const description = record?.description;
    if (record === null || typeof description !== 'string' || description.length === 0) {
      problems.push(`${fileName}: dropped edge case for rule ${ruleId}: missing description`);
      continue;
    }
    out.push({
      id: asString(record.id),
      description,
      epistemicStatus: asString(record.epistemicStatus),
      confidence: asNumber(record.confidence),
      expectedBehavior: asString(record.expectedBehavior),
      evidence: normalizeEvidenceList(
        record.evidence,
        `edge case of rule ${ruleId}`,
        fileName,
        problems,
      ),
    });
  }
  return out;
}

function normalizeProposedChecks(
  raw: unknown,
  ruleId: string,
  fileName: string,
  problems: string[],
): ProposedCheck[] {
  if (!Array.isArray(raw)) return [];
  const out: ProposedCheck[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const id = record?.id;
    const description = record?.description;
    if (
      record === null ||
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof description !== 'string' ||
      description.length === 0
    ) {
      problems.push(
        `${fileName}: dropped proposed check for rule ${ruleId}: missing id or description`,
      );
      continue;
    }
    out.push({
      id,
      kind: asString(record.kind),
      description,
      targetsRuleId: asString(record.targetsRuleId),
    });
  }
  return out;
}

function normalizeExamples(
  raw: unknown,
  invariantId: string,
  fileName: string,
  problems: string[],
): InvariantExample[] {
  if (!Array.isArray(raw)) return [];
  const out: InvariantExample[] = [];
  for (const item of raw) {
    const record = asRecord(item);
    const description = record?.description;
    const expected = record?.expected;
    if (
      record === null ||
      typeof description !== 'string' ||
      description.length === 0 ||
      typeof expected !== 'string' ||
      expected.length === 0
    ) {
      problems.push(
        `${fileName}: dropped example for invariant ${invariantId}: missing description or expected`,
      );
      continue;
    }
    out.push({ description, expected });
  }
  return out;
}

function makeArtifact(
  slug: string,
  fileName: string,
  variant: Variant,
  taskId: string | null,
): SpecArtifact {
  return {
    slug,
    fileName,
    variant,
    taskId,
    ruleCount: 0,
    invariantCount: 0,
    unknownCount: 0,
    rules: [],
    invariants: [],
    unknowns: [],
    statistics: null,
    generatedAt: null,
  };
}

function slugFrom(fileName: string): string {
  return fileName.endsWith('.json') ? fileName.slice(0, -'.json'.length) : fileName;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

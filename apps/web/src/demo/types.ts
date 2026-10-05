export interface EvidenceExcerpt {
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
  quote: string | null;
  excerpt: string | null;
  quoteInExcerpt: boolean;
  quoteLocation: { startLine: number; endLine: number; excerpt: string } | null;
}

export interface RuleCard {
  id: string;
  title: string | null;
  description: string | null;
  observableBehavior: string | null;
  epistemicStatus: string | null;
  confidence: number | null;
  assumptions: string[];
  edgeCases: { description: string | null; expectedBehavior: string | null }[];
  evidence: EvidenceExcerpt[];
}

export interface InvariantCard {
  id: string;
  statement: string | null;
  formalStatement: string | null;
  kind: string | null;
  criticality: string | null;
  confidence: number | null;
  knownExceptions: string[];
  checkingStrategy: string | null;
  derivedFromRuleIds: string[];
  evidence: EvidenceExcerpt[];
}

export interface Expectation {
  stepId: string | null;
  kind: string | null;
  path: string | null;
  expected: unknown;
  normalized: boolean;
  description: string | null;
}

export interface Operation {
  stepId: string | null;
  kind: string | null;
  method: string | null;
  path: string | null;
  body: unknown;
}

export interface CaseCard {
  caseId: string;
  title: string | null;
  category: string | null;
  status: string | null;
  targetRuleIds: string[];
  targetInvariantIds: string[];
  assertionCount: number;
  operations: Operation[];
  expectations: Expectation[];
}

export interface ValuePair {
  scenarioTitle: string | null;
  path: string | null;
  legacy: unknown;
  modern: unknown;
  differenceKind: string | null;
  highlighted: boolean;
}

export interface VerificationView {
  id: string;
  label: string;
  taskId: string;
  verdict: string | null;
  repairIteration: number | null;
  reasons: string[];
  mismatchCount: number | null;
  recordedAt: string | null;
  verdictPath: string;
  reportPath: string;
  correction: { kind: string; detail: string };
  mismatches: ValuePair[];
  scenarios: { scenarioTitle: string | null; outcome: string | null; equal: boolean }[];
  samplePairs: ValuePair[];
}

export interface ServiceStack {
  original: {
    primaryLanguage: string | null;
    frameworks: { name: string | null; version: string | null }[];
    buildKind: string | null;
    relativePath: string;
  };
  replacement: {
    entryPoint: string | null;
    stack: string | null;
    relativePath: string;
  };
}

export interface FeeAt60 {
  caseId: string | null;
  stepId: string | null;
  amount: number;
  capturedFee: number | null;
}

export interface RecordedRun {
  label: string;
  runId: string;
  sliceCommit: string;
  finalVerdict: string | null;
  productionClaim: boolean;
  services: ServiceStack;
  feeAt60: FeeAt60 | null;
  discover: {
    taskId: string;
    status: string | null;
    finishedAt: string | null;
    summary: string | null;
    findings: { id: string | null; summary: string | null; severity: string | null; kind: string | null }[];
  };
  specify: { taskId: string; status: string | null; finishedAt: string | null };
  rules: RuleCard[];
  invariants: InvariantCard[];
  unknowns: { id: string | null; question: string | null }[];
  characterization: {
    taskId: string;
    status: string | null;
    finishedAt: string | null;
    caseCount: number | null;
    assertionCount: number | null;
    cases: CaseCard[];
  };
  verification: {
    numeric: VerificationView;
    equivalent: VerificationView;
    defect: VerificationView;
    restored: VerificationView;
    feeConfirmed: boolean;
    feeExample: ValuePair | null;
    numericExample: ValuePair | null;
  };
  artifacts: { taskId: string; relativePath: string; recordedAt: string | null }[];
}

/**
 * Export a browser-safe bundle for one recorded Phoenix run.
 *
 * Selection is an explicit list of task ids and relative paths. The script
 * refuses a file whose envelope was produced by a different task. It does not
 * choose artifacts by timestamp.
 *
 *   node scripts/export-demo-bundle.mjs
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN_ID = 'run_1ad5681e13294219959c3908022799c5';
const SLICE_COMMIT = '3cef6184191e9a5df178a60d6a54cc1d15255a28';
const runRoot = join(repoRoot, 'artifacts', RUN_ID);
const legacyRoot = join(repoRoot, 'examples', 'legacy-bank');

const SELECTION = {
  discover: {
    taskId: 'task_47614a38d04a415692c7566beb09815a',
    result: 'agent/result-task_47614a38d04a415692c7566beb09815a.json',
    findings: 'discovery/findings.json',
    repositoryMap: 'discovery/repository-map.json',
  },
  specify: {
    taskId: 'task_d326ab378f4940e89d81420f1dc9ae2b',
    result: 'agent/result-task_d326ab378f4940e89d81420f1dc9ae2b.json',
    rules: 'specification/business-rules-attempt-task_d326ab378f4940e89d81420f1dc9ae2b.json',
    invariants: 'specification/invariants-attempt-task_d326ab378f4940e89d81420f1dc9ae2b.json',
  },
  characterize: {
    taskId: 'task_378ff718bd1741d0ac6b5360a3da01c5',
    result: 'agent/result-task_378ff718bd1741d0ac6b5360a3da01c5.json',
    suite: 'characterization/suite-attempt-task_378ff718bd1741d0ac6b5360a3da01c5.json',
  },
  numericVerification: {
    taskId: 'task_e08089c72d1d49b8a61f303481163693',
    implementationTaskId: 'task_7301755382be45e9acbe4ca65a3becda',
    changeReport: 'implementation/change-report-attempt-task_7301755382be45e9acbe4ca65a3becda.json',
    verdict: 'verification/verdict-attempt-task_e08089c72d1d49b8a61f303481163693.json',
    report: 'verification/differential-report-attempt-task_e08089c72d1d49b8a61f303481163693.json',
  },
  equivalentVerification: {
    taskId: 'task_041af08b84be4b89839494f2a12d53fb',
    implementationTaskId: 'task_41881c4228ed48198af80641f1a510a1',
    changeReport: 'implementation/change-report-r1-attempt-task_41881c4228ed48198af80641f1a510a1.json',
    verdict: 'verification/verdict-r1-attempt-task_041af08b84be4b89839494f2a12d53fb.json',
    report: 'verification/differential-report-r1-attempt-task_041af08b84be4b89839494f2a12d53fb.json',
  },
  controlledDefect: {
    taskId: 'task_bd4c9553b4c246a6ad14d95fd87c4b58',
    verdict: 'verification/verdict-r4.json',
    report: 'verification/differential-report-r4.json',
  },
  restoredVerification: {
    taskId: 'task_c6057465068b4547aec94b2f742ca168',
    verdict: 'verification/verdict-r5.json',
    report: 'verification/differential-report-r5.json',
  },
};

function readEnvelope(relativePath, expectedTaskId) {
  const absolute = join(runRoot, relativePath);
  const envelope = JSON.parse(readFileSync(absolute, 'utf8'));
  const producedTaskId = envelope.producedBy?.taskId;
  if (producedTaskId !== expectedTaskId) {
    throw new Error(
      `${relativePath} was produced by ${producedTaskId ?? 'nobody'}, not ${expectedTaskId}`,
    );
  }
  if (envelope.runId !== RUN_ID) {
    throw new Error(`${relativePath} belongs to ${envelope.runId}, not ${RUN_ID}`);
  }
  return {
    relativePath,
    recordedAt: typeof envelope.createdAt === 'string' ? envelope.createdAt : null,
    taskId: producedTaskId,
    artifactId: null,
    payload: envelope.payload,
  };
}

function sanitizeString(text) {
  return text
    .replace(/\/(?:Users|home|private|var|tmp|opt|Volumes)\/[^\s"'`)\]},;]*/g, '[host path withheld]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/\bAQ\.[A-Za-z0-9_.-]{8,}/g, '[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]')
    .replace(/\b(?:postgres|jdbc:postgresql):\/\/[^\s'"]+/gi, '[database url withheld]');
}

function clip(text, max) {
  const clean = sanitizeString(text).trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

function textOrNull(value, max = 600) {
  return typeof value === 'string' && value.trim().length > 0 ? clip(value, max) : null;
}

function locateQuote(lines, quote) {
  const needle = quote.trim();
  if (needle.length === 0) return null;
  const blob = lines.join('\n');
  const index = blob.indexOf(needle);
  if (index < 0) return null;
  const startLine = blob.slice(0, index).split('\n').length;
  const endLine = startLine + needle.split('\n').length - 1;
  return {
    startLine,
    endLine,
    excerpt: clip(lines.slice(startLine - 1, endLine).join('\n'), 1200),
  };
}

function excerpt(location, quote) {
  const path = location?.path;
  const start = location?.startLine;
  const end = location?.endLine;
  const recorded = typeof quote === 'string' ? quote : '';
  const base = {
    path: typeof path === 'string' ? path : null,
    startLine: typeof start === 'number' ? start : null,
    endLine: typeof end === 'number' ? end : null,
    symbol: typeof location?.symbol === 'string' ? location.symbol : null,
    quote: textOrNull(recorded, 800),
    excerpt: null,
    quoteInExcerpt: false,
    quoteLocation: null,
  };
  if (base.path === null) return base;
  let lines;
  try {
    lines = readFileSync(join(legacyRoot, base.path), 'utf8').split(/\r?\n/);
  } catch {
    return base;
  }
  if (typeof start === 'number' && typeof end === 'number') {
    const slice = lines.slice(Math.max(0, start - 1), end).join('\n');
    base.excerpt = clip(slice, 1200);
    base.quoteInExcerpt = recorded.trim().length > 0 && slice.includes(recorded.trim());
  }
  base.quoteLocation = locateQuote(lines, recorded);
  return base;
}

function evidenceList(items) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 4).map((item) => excerpt(item.location, item.quote));
}

function capturedOnlineFee(suite, amount) {
  for (const item of suite.cases ?? []) {
    const steps = [...(item.scenario?.setup ?? []), ...(item.scenario?.steps ?? [])];
    const transfer = steps.find((step) => step.kind === 'http' && step.http?.body?.amount === amount);
    if (transfer === undefined) continue;
    const fee = (item.assertions ?? []).find(
      (assertion) =>
        assertion.normalized !== true &&
        assertion.stepId === transfer.stepId &&
        assertion.path === 'responseBody.fee',
    );
    if (fee === undefined) continue;
    return {
      caseId: item.caseId ?? null,
      stepId: transfer.stepId ?? null,
      amount,
      capturedFee: fee.expected ?? null,
    };
  }
  return null;
}

function stageResult(relativePath, taskId) {
  const file = readEnvelope(relativePath, taskId);
  const payload = file.payload;
  if (payload.taskId !== taskId || payload.status !== 'SUCCEEDED') {
    throw new Error(`${relativePath} is not a SUCCEEDED result for ${taskId}`);
  }
  return {
    taskId,
    relativePath,
    recordedAt: file.recordedAt,
    status: payload.status,
    stage: payload.stage,
    startedAt: payload.startedAt ?? null,
    finishedAt: payload.finishedAt ?? null,
  };
}

function mismatchRows(reportPayload) {
  const mismatches = Array.isArray(reportPayload.mismatches) ? reportPayload.mismatches : [];
  return mismatches.map((item) => ({
    scenarioTitle: textOrNull(item.scenarioTitle, 180),
    path: textOrNull(item.path, 180),
    legacy: item.legacyValue === undefined ? null : item.legacyValue,
    modern: item.modernValue === undefined ? null : item.modernValue,
    differenceKind: textOrNull(item.differenceKind, 80),
    highlighted: true,
  }));
}

function scalarPairs(legacySteps, modernSteps) {
  const modernById = new Map((modernSteps ?? []).map((step) => [step.stepId, step]));
  const pairs = [];
  for (const step of legacySteps ?? []) {
    const other = modernById.get(step.stepId);
    if (other === undefined) continue;
    if (step.httpStatus !== undefined) {
      pairs.push({
        scenarioTitle: null,
        path: `${step.stepId}.httpStatus`,
        legacy: step.httpStatus,
        modern: other.httpStatus ?? null,
        differenceKind: null,
        highlighted: step.httpStatus !== other.httpStatus,
      });
    }
    const wanted = ['fee', 'amount', 'balance', 'status'];
    const legacyBody = step.responseBody;
    const modernBody = other.responseBody;
    if (legacyBody && typeof legacyBody === 'object' && modernBody && typeof modernBody === 'object') {
      for (const key of wanted) {
        if (!(key in legacyBody) || !(key in modernBody)) continue;
        pairs.push({
          scenarioTitle: null,
          path: `${step.stepId}.responseBody.${key}`,
          legacy: legacyBody[key],
          modern: modernBody[key],
          differenceKind: null,
          highlighted: JSON.stringify(legacyBody[key]) !== JSON.stringify(modernBody[key]),
        });
      }
    }
    if (pairs.length >= 4) break;
  }
  return pairs.slice(0, 4);
}

function comparisonRows(reportPayload) {
  const comparisons = Array.isArray(reportPayload.comparisons) ? reportPayload.comparisons : [];
  return comparisons.map((item) => ({
    scenarioTitle: textOrNull(item.scenarioTitle, 180),
    outcome: textOrNull(item.outcome, 40),
    equal: item.equal === true,
    pairs: scalarPairs(item.legacy?.steps, item.modern?.steps).map((pair) => ({
      ...pair,
      scenarioTitle: textOrNull(item.scenarioTitle, 180),
    })),
  }));
}

function verificationView(spec, label, correction) {
  const verdictFile = readEnvelope(spec.verdict, spec.taskId);
  const reportFile = readEnvelope(spec.report, spec.taskId);
  const verdict = verdictFile.payload;
  const report = reportFile.payload;
  return {
    id: label,
    label,
    taskId: spec.taskId,
    verdict: verdict.verdict ?? null,
    repairIteration: verdict.repairIteration ?? null,
    reasons: Array.isArray(verdict.reasons) ? verdict.reasons.map((item) => clip(String(item), 400)) : [],
    mismatchCount: verdict.mismatchSummary?.total ?? null,
    recordedAt: verdictFile.recordedAt,
    verdictPath: spec.verdict,
    reportPath: spec.report,
    correction,
    mismatches: mismatchRows(report),
    scenarios: comparisonRows(report).map(({ pairs, ...rest }) => rest),
    samplePairs: comparisonRows(report).flatMap((item) => item.pairs).slice(0, 12),
  };
}

function assertAncestor() {
  execFileSync('git', ['merge-base', '--is-ancestor', SLICE_COMMIT, 'HEAD'], {
    cwd: repoRoot,
    stdio: 'ignore',
  });
}

function operation(step) {
  if (step.kind !== 'http' || step.http === undefined) {
    return { stepId: step.stepId ?? null, kind: step.kind ?? null, method: null, path: null, body: null };
  }
  return {
    stepId: step.stepId ?? null,
    kind: 'http',
    method: step.http.method ?? null,
    path: step.http.path ?? null,
    body: step.http.body === undefined ? null : step.http.body,
  };
}

function expectation(assertion) {
  return {
    stepId: assertion.stepId ?? null,
    kind: assertion.kind ?? null,
    path: assertion.path ?? null,
    expected: assertion.expected === undefined ? null : assertion.expected,
    normalized: assertion.normalized === true,
    description: textOrNull(assertion.description, 240),
  };
}

assertAncestor();

const discover = stageResult(SELECTION.discover.result, SELECTION.discover.taskId);
const findingsFile = readEnvelope(SELECTION.discover.findings, SELECTION.discover.taskId);
const findings = Array.isArray(findingsFile.payload.findings) ? findingsFile.payload.findings : [];

const specify = stageResult(SELECTION.specify.result, SELECTION.specify.taskId);
const rulesFile = readEnvelope(SELECTION.specify.rules, SELECTION.specify.taskId);
const invariantsFile = readEnvelope(SELECTION.specify.invariants, SELECTION.specify.taskId);

const characterize = stageResult(SELECTION.characterize.result, SELECTION.characterize.taskId);
const suiteFile = readEnvelope(SELECTION.characterize.suite, SELECTION.characterize.taskId);
const suite = suiteFile.payload;

const numericChange = readEnvelope(
  SELECTION.numericVerification.changeReport,
  SELECTION.numericVerification.implementationTaskId,
);
const equivalentChange = readEnvelope(
  SELECTION.equivalentVerification.changeReport,
  SELECTION.equivalentVerification.implementationTaskId,
);

const numeric = verificationView(SELECTION.numericVerification, 'Initial verification', {
  kind: 'autonomous',
  detail:
    'A later modernization task wrote a new change report. The equivalent verdict cites that new artifact, so the numeric-scale correction is recorded as an autonomous repair.',
});
const equivalent = verificationView(SELECTION.equivalentVerification, 'Repaired verification', {
  kind: 'autonomous',
  detail: `Change report ${SELECTION.equivalentVerification.changeReport} replaces ${SELECTION.numericVerification.changeReport}.`,
});
const defect = verificationView(SELECTION.controlledDefect, 'Controlled fee defect', {
  kind: 'not-recorded-as-autonomous',
  detail:
    'This verdict and the following equivalent verdict cite the same change-report artifact. No new implementation task is recorded between them.',
});
const restored = verificationView(SELECTION.restoredVerification, 'Verification after restore', {
  kind: 'not-recorded-as-autonomous',
  detail:
    'This verdict cites the same change-report artifact as the controlled-defect verdict. No new implementation task is recorded between them.',
});

const feeRow = defect.mismatches.find(
  (row) => row.path === 'xfer-100-young-account.responseBody.fee' && row.legacy === 0.5 && row.modern === 1,
);
if (feeRow === undefined) {
  throw new Error('controlled fee defect legacy 0.5 versus modern 1 was not found in verdict-r4 report');
}
if (numeric.verdict !== 'NOT_EQUIVALENT' || numeric.mismatchCount !== 80) {
  throw new Error('numeric-scale verification did not match the recorded 80 mismatches');
}
const numericExample = numeric.mismatches.find(
  (row) => row.path === 'xfer-60-young-account.responseBody.amount' && row.legacy === 60 && row.modern === '60.0000',
);
if (numericExample === undefined) {
  throw new Error('numeric-scale example 60 versus "60.0000" was not found');
}
if (equivalent.verdict !== 'EQUIVALENT' || equivalent.mismatchCount !== 0) {
  throw new Error('repaired verification is not EQUIVALENT with zero mismatches');
}
if (restored.verdict !== 'EQUIVALENT' || restored.mismatchCount !== 0) {
  throw new Error('restored verification is not EQUIVALENT with zero mismatches');
}
if (defect.verdict !== 'NOT_EQUIVALENT') {
  throw new Error('controlled defect verdict is not NOT_EQUIVALENT');
}

const defectInputs = readEnvelope(SELECTION.controlledDefect.verdict, SELECTION.controlledDefect.taskId).payload
  .inputArtifactIds;
const restoredInputs = readEnvelope(
  SELECTION.restoredVerification.verdict,
  SELECTION.restoredVerification.taskId,
).payload.inputArtifactIds;
if (JSON.stringify(defectInputs) !== JSON.stringify(restoredInputs)) {
  throw new Error('defect and restored verdicts do not cite the same inputs');
}

const repositoryMap = readEnvelope(SELECTION.discover.repositoryMap, SELECTION.discover.taskId);
const map = repositoryMap.payload;
const replacementDescription = (equivalentChange.payload.files ?? [])
  .map((file) => (typeof file.description === 'string' ? file.description : ''))
  .join('\n');
const services = {
  original: {
    primaryLanguage: typeof map.primaryLanguage === 'string' ? map.primaryLanguage : null,
    frameworks: (map.frameworks ?? []).map((item) => ({
      name: typeof item.name === 'string' ? item.name : null,
      version: typeof item.version === 'string' ? item.version : null,
    })),
    buildKind: typeof map.buildSystems?.[0]?.kind === 'string' ? map.buildSystems[0].kind : null,
    relativePath: SELECTION.discover.repositoryMap,
  },
  replacement: {
    entryPoint: typeof equivalentChange.payload.entryPoint === 'string' ? equivalentChange.payload.entryPoint : null,
    stack: replacementDescription.includes('Node/TypeScript') ? 'Node/TypeScript' : null,
    relativePath: SELECTION.equivalentVerification.changeReport,
  },
};
if (services.original.primaryLanguage !== 'Java' || services.replacement.stack !== 'Node/TypeScript') {
  throw new Error('recorded technology labels were not found in the selected artifacts');
}
const feeAt60 = capturedOnlineFee(suite, 60);
if (feeAt60?.capturedFee !== 0) {
  throw new Error('captured online fee for amount 60 was not 0');
}

const cases = (suite.cases ?? []).map((item) => ({
  caseId: item.caseId,
  title: textOrNull(item.title, 200),
  category: textOrNull(item.category, 80),
  status: textOrNull(item.status, 80),
  targetRuleIds: item.targetRuleIds ?? [],
  targetInvariantIds: item.targetInvariantIds ?? [],
  assertionCount: Array.isArray(item.assertions) ? item.assertions.length : 0,
  operations: [...(item.scenario?.setup ?? []), ...(item.scenario?.steps ?? [])].map(operation),
  expectations: (item.assertions ?? []).filter((assertion) => assertion.normalized !== true).map(expectation),
}));

const bundle = {
  label: 'Recorded run',
  runId: RUN_ID,
  sliceCommit: SLICE_COMMIT,
  finalVerdict: equivalent.verdict,
  productionClaim: false,
  services,
  feeAt60,
  discover: {
    ...discover,
    findingsPath: SELECTION.discover.findings,
    findingsRecordedAt: findingsFile.recordedAt,
    summary: textOrNull(findingsFile.payload.summary, 500),
    findings: findings.map((item) => ({
      id: item.id ?? null,
      summary: textOrNull(item.summary, 400),
      severity: item.severity ?? null,
      kind: item.kind ?? null,
    })),
  },
  rules: (rulesFile.payload.rules ?? []).map((rule) => ({
    id: rule.ruleId,
    title: textOrNull(rule.title, 200),
    description: textOrNull(rule.description, 700),
    observableBehavior: textOrNull(rule.observableBehavior, 500),
    epistemicStatus: rule.epistemicStatus ?? null,
    confidence: typeof rule.confidence === 'number' ? rule.confidence : null,
    assumptions: (rule.assumptions ?? []).map((item) => clip(String(item), 300)),
    edgeCases: (rule.edgeCases ?? []).map((item) => ({
      description: textOrNull(item.description, 300),
      expectedBehavior: textOrNull(item.expectedBehavior, 300),
    })),
    evidence: evidenceList(rule.sourceEvidence),
  })),
  invariants: (invariantsFile.payload.invariants ?? []).map((invariant) => ({
    id: invariant.invariantId,
    statement: textOrNull(invariant.statement, 700),
    formalStatement: textOrNull(invariant.formalStatement, 500),
    kind: invariant.kind ?? null,
    criticality: invariant.criticality ?? null,
    confidence: typeof invariant.confidence === 'number' ? invariant.confidence : null,
    knownExceptions: (invariant.knownExceptions ?? []).map((item) => clip(String(item), 400)),
    checkingStrategy: textOrNull(invariant.checkingStrategy?.detail, 700),
    derivedFromRuleIds: invariant.derivedFromRuleIds ?? [],
    evidence: evidenceList(invariant.sourceEvidence),
  })),
  unknowns: (rulesFile.payload.unknowns ?? []).slice(0, 8).map((item) => ({
    id: item.id ?? null,
    question: textOrNull(item.question, 300),
  })),
  characterization: {
    ...characterize,
    suitePath: SELECTION.characterize.suite,
    suiteRecordedAt: suiteFile.recordedAt,
    caseCount: suite.statistics?.total ?? cases.length,
    assertionCount: suite.statistics?.assertions ?? null,
    capturedCount: suite.statistics?.captured ?? null,
    cases,
  },
  specify,
  rulesPath: SELECTION.specify.rules,
  rulesRecordedAt: rulesFile.recordedAt,
  invariantsPath: SELECTION.specify.invariants,
  invariantsRecordedAt: invariantsFile.recordedAt,
  verification: {
    numeric,
    equivalent,
    defect,
    restored,
    feeConfirmed: true,
    feeExample: feeRow,
    numericExample,
    numericChangeReport: {
      taskId: numericChange.taskId,
      relativePath: numericChange.relativePath,
      recordedAt: numericChange.recordedAt,
    },
    equivalentChangeReport: {
      taskId: equivalentChange.taskId,
      relativePath: equivalentChange.relativePath,
      recordedAt: equivalentChange.recordedAt,
    },
  },
  artifacts: [
    { taskId: discover.taskId, relativePath: SELECTION.discover.result, recordedAt: discover.recordedAt },
    { taskId: discover.taskId, relativePath: SELECTION.discover.findings, recordedAt: findingsFile.recordedAt },
    {
      taskId: discover.taskId,
      relativePath: SELECTION.discover.repositoryMap,
      recordedAt: repositoryMap.recordedAt,
    },
    { taskId: specify.taskId, relativePath: SELECTION.specify.result, recordedAt: specify.recordedAt },
    { taskId: specify.taskId, relativePath: SELECTION.specify.rules, recordedAt: rulesFile.recordedAt },
    { taskId: specify.taskId, relativePath: SELECTION.specify.invariants, recordedAt: invariantsFile.recordedAt },
    { taskId: characterize.taskId, relativePath: SELECTION.characterize.result, recordedAt: characterize.recordedAt },
    { taskId: characterize.taskId, relativePath: SELECTION.characterize.suite, recordedAt: suiteFile.recordedAt },
    { taskId: numericChange.taskId, relativePath: numericChange.relativePath, recordedAt: numericChange.recordedAt },
    { taskId: numeric.taskId, relativePath: numeric.verdictPath, recordedAt: numeric.recordedAt },
    { taskId: numeric.taskId, relativePath: numeric.reportPath, recordedAt: numeric.recordedAt },
    { taskId: equivalentChange.taskId, relativePath: equivalentChange.relativePath, recordedAt: equivalentChange.recordedAt },
    { taskId: equivalent.taskId, relativePath: equivalent.verdictPath, recordedAt: equivalent.recordedAt },
    { taskId: equivalent.taskId, relativePath: equivalent.reportPath, recordedAt: equivalent.recordedAt },
    { taskId: defect.taskId, relativePath: defect.verdictPath, recordedAt: defect.recordedAt },
    { taskId: defect.taskId, relativePath: defect.reportPath, recordedAt: defect.recordedAt },
    { taskId: restored.taskId, relativePath: restored.verdictPath, recordedAt: restored.recordedAt },
    { taskId: restored.taskId, relativePath: restored.reportPath, recordedAt: restored.recordedAt },
  ],
};

const serialized = `${JSON.stringify(bundle, null, 2)}\n`;
if (serialized.includes('/Users/') || serialized.includes('sk-')) {
  throw new Error('bundle still contains a host path or an API-key shape');
}

const targets = [
  join(repoRoot, 'apps/web/src/data/recorded-run.json'),
  join(repoRoot, 'apps/web/public/recorded-run.json'),
];
for (const target of targets) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, serialized);
}
console.log(`wrote ${targets.length} copies, ${serialized.length} bytes, commit ${SLICE_COMMIT.slice(0, 7)}`);

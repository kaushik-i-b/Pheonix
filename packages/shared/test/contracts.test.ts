import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROLE_PERMISSIONS,
  EventSequencer,
  InMemoryEventSink,
  JsonLogger,
  MemoryLogSink,
  PIPELINE_ORDER,
  PhoenixError,
  artifactIdFromContent,
  businessRuleSchema,
  checkEvidenceGraphIntegrity,
  computeDifferentialStatistics,
  computeRuleStatistics,
  confidenceBand,
  createRunRecord,
  defaultPermissionsFor,
  defaultRelativePath,
  describeError,
  differentialComparisonSchema,
  estimateCost,
  evidenceGraphSchema,
  explainEvidence,
  findEvidenceChains,
  findPricing,
  hashStable,
  initialStageRecords,
  invariantSchema,
  maxSeverity,
  mismatchSchema,
  newRunId,
  normalizationRuleSchema,
  nowIso,
  phoenixEventSchema,
  releaseDecisionSchema,
  renderReleaseReportMarkdown,
  sanitizeSlug,
  sha256Hex,
  stableStringify,
  summarizeRun,
} from '../src/index.js';

const EVIDENCE = {
  id: 'ev-1',
  kind: 'source-code' as const,
  collectedAt: nowIso(),
  collectedBy: 'archaeologist',
  location: { path: 'src/main/java/AcctSvc.java', startLine: 10, endLine: 24 },
  quote: 'if (amt.compareTo(THRESHOLD) < 0) return ZERO;',
};

describe('primitives', () => {
  it('generates ids that satisfy their own schemas', () => {
    const runId = newRunId();
    expect(runId).toMatch(/^run_[0-9a-z]{32}$/);
    expect(() => newRunId()).not.toThrow();
  });

  it('produces stable hashes regardless of key order', () => {
    const a = hashStable({ b: 1, a: [1, 2, { y: 2, x: 1 }] });
    const b = hashStable({ a: [1, 2, { x: 1, y: 2 }], b: 1 });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps array order significant', () => {
    expect(hashStable({ a: [1, 2] })).not.toBe(hashStable({ a: [2, 1] }));
  });

  it('serializes JSON stringification deterministically', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(stableStringify(new Map([['b', 1], ['a', 2]]))).toBe('{"a":2,"b":1}');
  });

  it('derives content-addressed artifact ids', () => {
    const id = artifactIdFromContent('hello');
    expect(id).toBe(`art_${sha256Hex('hello')}`);
    expect(artifactIdFromContent('hello')).toBe(id);
    expect(artifactIdFromContent('hello!')).not.toBe(id);
  });

  it('rejects malformed timestamps', () => {
    expect(() => nowIso(new Date('not a date'))).toThrow();
  });

  it('orders severities and confidence bands', () => {
    expect(maxSeverity(['INFO', 'CRITICAL', 'MINOR'])).toBe('CRITICAL');
    expect(maxSeverity([])).toBe('INFO');
    expect(confidenceBand(0.9)).toBe('HIGH');
    expect(confidenceBand(0.7)).toBe('MEDIUM');
    expect(confidenceBand(0.2)).toBe('LOW');
    expect(confidenceBand(0)).toBe('NONE');
  });
});

describe('artifact addressing', () => {
  it('maps kinds to the documented artifact paths from the brief', () => {
    expect(defaultRelativePath('discovery.repository-map')).toBe('discovery/repository-map.json');
    expect(defaultRelativePath('discovery.findings')).toBe('discovery/findings.md');
    expect(defaultRelativePath('specification.business-rules')).toBe(
      'specification/business-rules.json',
    );
    expect(defaultRelativePath('specification.invariants')).toBe('specification/invariants.json');
    expect(defaultRelativePath('adversarial.report')).toBe('adversarial/report.json');
    expect(defaultRelativePath('verification.differential-report')).toBe(
      'verification/differential-report.json',
    );
    expect(defaultRelativePath('release.decision')).toBe('release/decision.json');
    expect(defaultRelativePath('release.report')).toBe('release/report.md');
  });

  it('supports slugged multi-instance artifacts', () => {
    expect(defaultRelativePath('raw.command-output', 'mvn package')).toBe(
      'raw/mvn-package.txt',
    );
  });

  it('refuses path traversal in slugs', () => {
    expect(() => sanitizeSlug('../../etc/passwd')).toThrow();
    expect(() => sanitizeSlug('   ')).toThrow();
  });
});

describe('role permissions', () => {
  it('gives the Release Guardian no ability to write application code', () => {
    const guardian = DEFAULT_ROLE_PERMISSIONS['release-guardian'];
    expect(guardian.tools).not.toContain('write_file');
    expect(guardian.tools).not.toContain('apply_patch');
    expect(guardian.tools).toContain('run_tests');
    expect(guardian.writeRoots).toEqual(['{artifactRoot}/release']);
  });

  it('keeps the Archaeologist read-only', () => {
    const archaeologist = defaultPermissionsFor('archaeologist');
    expect(archaeologist.writeRoots).toEqual([]);
    expect(archaeologist.tools).not.toContain('write_file');
    expect(archaeologist.commandPatterns).toEqual([]);
    expect(archaeologist.databaseReadOnly).toBe(true);
  });

  it('never lets the Modernizer write to the legacy repository', () => {
    const modernizer = DEFAULT_ROLE_PERMISSIONS.modernizer;
    expect(modernizer.readRoots).toContain('{legacyRoot}');
    expect(modernizer.writeRoots).not.toContain('{legacyRoot}');
    expect(modernizer.writeRoots.some((root) => root.includes('legacy'))).toBe(false);
  });

  it('gives the orchestrator no tools at all', () => {
    expect(DEFAULT_ROLE_PERMISSIONS.orchestrator.tools).toEqual([]);
  });

  it('validates every default profile against the schema', () => {
    for (const [role, permissions] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
      expect(permissions.role).toBe(role);
      expect(() => defaultPermissionsFor(role as never)).not.toThrow();
    }
  });
});

describe('events', () => {
  it('numbers events per run and validates before dispatch', () => {
    const sink = new InMemoryEventSink();
    const sequencer = new EventSequencer([sink]);
    const runId = newRunId();
    sequencer.next(runId, 'run.started', {
      configHash: sha256Hex('cfg'),
      legacyRoot: '/legacy',
      modernRoot: '/modern',
      providerId: 'openai-compatible',
      model: 'test-model',
    });
    sequencer.next(runId, 'stage.transition', {
      stage: 'DISCOVERY',
      from: 'WAITING',
      to: 'RUNNING',
      attempt: 1,
    });
    const other = newRunId();
    sequencer.next(other, 'run.started', {
      configHash: sha256Hex('cfg2'),
      legacyRoot: '/legacy',
      modernRoot: '/modern',
      providerId: 'openai-compatible',
      model: 'test-model',
    });

    expect(sink.events.map((event) => event.seq)).toEqual([0, 1, 0]);
    expect(sink.ofType('run.started')).toHaveLength(2);
    expect(sequencer.seqFor(runId)).toBe(2);
  });

  it('reports sink failures instead of throwing into the pipeline', async () => {
    const errors: unknown[] = [];
    const sequencer = new EventSequencer(
      [
        {
          name: 'broken',
          emit() {
            throw new Error('sink exploded');
          },
        },
      ],
      (_sink, error) => errors.push(error),
    );
    const runId = newRunId();
    sequencer.next(runId, 'run.started', {
      configHash: sha256Hex('cfg'),
      legacyRoot: '/legacy',
      modernRoot: '/modern',
      providerId: 'p',
      model: 'm',
    });
    await sequencer.flush();
    expect(errors).toHaveLength(1);
  });

  it('rejects malformed events at the schema boundary', () => {
    expect(() =>
      phoenixEventSchema.parse({
        type: 'stage.transition',
        runId: 'not-a-run-id',
        seq: 0,
        at: nowIso(),
        stage: 'DISCOVERY',
        from: 'WAITING',
        to: 'RUNNING',
        attempt: 1,
      }),
    ).toThrow();
  });
});

describe('run records', () => {
  const config = {
    legacy: { label: 'legacy-bank', rootPath: '/tmp/legacy', runtime: { kind: 'http' as const } },
    modern: { label: 'modern-bank', rootPath: '/tmp/modern', runtime: { kind: 'http' as const } },
    artifactRoot: '/tmp/artifacts',
    workspaceRoot: '/tmp/workspaces',
    llm: {
      providerId: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      model: 'llama3.2',
    },
    limits: {},
    skippedStages: [],
    startedBy: 'test',
  };

  it('starts every pipeline stage in WAITING', () => {
    const stages = initialStageRecords();
    expect(stages.map((stage) => stage.stage)).toEqual([...PIPELINE_ORDER]);
    expect(stages.every((stage) => stage.state === 'WAITING')).toBe(true);
  });

  it('marks operator-skipped stages explicitly rather than silently', () => {
    const stages = initialStageRecords(['DESIGN']);
    expect(stages.find((stage) => stage.stage === 'DESIGN')?.state).toBe('SKIPPED');
  });

  it('summarizes a run for the dashboard', () => {
    const run = createRunRecord({ runId: newRunId(), config: config as never });
    expect(run.status).toBe('PENDING');
    const summary = summarizeRun(run, 0.42);
    expect(summary.stageStates.DISCOVERY).toBe('WAITING');
    expect(summary.equivalenceConfidence).toBe(0.42);
    expect(summary.counters.mismatches).toBe(0);
  });
});

describe('specification contracts', () => {
  it('refuses a business rule without evidence', () => {
    expect(() =>
      businessRuleSchema.parse({
        ruleId: 'BR-FEE-THRESHOLD',
        title: 'Small transfers skip the fee',
        description: 'Transfers below a hardcoded amount are not charged.',
        kind: 'calculation',
        epistemicStatus: 'INFERRED',
        confidence: 0.7,
        confidenceBasis: 'single code path, not yet confirmed at runtime',
        sourceEvidence: [],
        affectedComponents: ['AcctSvc.doProcess2'],
        observableBehavior: 'POST /api/transfers with amount < threshold returns fee 0.00',
        discoveredBy: 'business-rule-analyst',
        discoveredAt: nowIso(),
      }),
    ).toThrow(/evidence/);
  });

  it('refuses an invariant without a checking strategy', () => {
    expect(() =>
      invariantSchema.parse({
        invariantId: 'INV-LEDGER-SUM',
        statement: 'Ledger entries sum to the account balance',
        kind: 'conservation',
        criticality: 'CRITICAL',
        scope: { components: ['ledger'], operations: ['transfer'] },
        epistemicStatus: 'INFERRED',
        confidence: 0.8,
        sourceEvidence: [EVIDENCE],
        violationSeverity: 'CRITICAL',
        discoveredBy: 'invariant-analyst',
        discoveredAt: nowIso(),
      }),
    ).toThrow();
  });

  it('computes rule statistics that separate observation from inference', () => {
    const rules = [
      businessRuleSchema.parse({
        ruleId: 'BR-FEE-A',
        title: 'a',
        description: 'a',
        kind: 'calculation',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        confidenceBasis: 'read directly from source',
        sourceEvidence: [EVIDENCE],
        affectedComponents: ['x'],
        observableBehavior: 'y',
        duplicateImplementations: ['z'],
        lifecycleStatus: 'confirmed',
        discoveredBy: 'analyst',
        discoveredAt: nowIso(),
      }),
      businessRuleSchema.parse({
        ruleId: 'BR-TIMING-B',
        title: 'b',
        description: 'b',
        kind: 'timing',
        epistemicStatus: 'INFERRED',
        confidence: 0.4,
        confidenceBasis: 'ambiguous',
        sourceEvidence: [EVIDENCE],
        affectedComponents: ['x'],
        observableBehavior: 'y',
        discoveredBy: 'analyst',
        discoveredAt: nowIso(),
      }),
    ];
    const stats = computeRuleStatistics(rules);
    expect(stats).toMatchObject({
      total: 2,
      observed: 1,
      inferred: 1,
      confirmed: 1,
      lowConfidenceCount: 1,
      withDuplicateImplementations: 1,
    });
    expect(stats.averageConfidence).toBeCloseTo(0.65, 5);
  });
});

describe('differential contracts', () => {
  it('refuses normalization without a justification', () => {
    expect(() =>
      normalizationRuleSchema.parse({
        ruleId: 'n1',
        path: 'responseBody.id',
        strategy: 'ignore',
        reason: 'ids',
        requestedBy: 'differential-verifier',
      }),
    ).toThrow(/justification/);
  });

  it('requires strategy-specific parameters', () => {
    expect(() =>
      normalizationRuleSchema.parse({
        ruleId: 'n2',
        path: 'responseBody.amount',
        strategy: 'numeric-tolerance',
        reason: 'float noise between implementations',
        requestedBy: 'differential-verifier',
      }),
    ).toThrow(/tolerance/);
  });

  it('refuses a mismatch without evidence', () => {
    expect(() =>
      mismatchSchema.parse({
        mismatchId: 'mm-1',
        scenarioId: 'scn_transfer-1',
        scenarioTitle: 'transfer',
        title: 'fee differs',
        differenceKind: 'value-difference',
        path: 'steps[0].responseBody.fee',
        legacyValue: '2.50',
        modernValue: '2.49',
        severity: 'MAJOR',
        evidence: [],
        firstObservedAt: nowIso(),
      }),
    ).toThrow(/evidence/);
  });

  it('computes report statistics including unexplained mismatches', () => {
    const comparison = (
      index: number,
      outcome: 'equal' | 'divergent' | 'inconclusive' | 'legacy-unreachable',
    ) =>
      differentialComparisonSchema.parse({
        scenarioId: `scn_case-${index}`,
        scenarioTitle: `case ${index}`,
        category: 'normal-path',
        equal: outcome === 'equal',
        outcome,
        durationMs: 10,
      });
    const mismatch = (severity: 'CRITICAL' | 'MINOR', explanationStatus: string) =>
      mismatchSchema.parse({
        mismatchId: `mm-${severity}-${explanationStatus}`,
        scenarioId: 'scn_case-1',
        scenarioTitle: 'case 1',
        title: 'fee differs',
        differenceKind: 'value-difference',
        path: 'steps[0].responseBody.fee',
        legacyValue: '2.50',
        modernValue: '2.49',
        severity,
        explanationStatus,
        evidence: [EVIDENCE],
        firstObservedAt: nowIso(),
      });

    const stats = computeDifferentialStatistics({
      comparisons: [
        comparison(1, 'equal'),
        comparison(2, 'divergent'),
        comparison(3, 'divergent'),
        comparison(4, 'inconclusive'),
        comparison(5, 'legacy-unreachable'),
      ],
      mismatches: [
        mismatch('CRITICAL', 'unexplained'),
        mismatch('MINOR', 'explained-normalization'),
      ],
    });
    expect(stats).toMatchObject({
      scenarios: 5,
      equal: 1,
      divergent: 2,
      inconclusive: 1,
      unreachable: 1,
      mismatches: 2,
      unexplainedMismatches: 1,
    });
    expect(stats.bySeverity.CRITICAL).toBe(1);
  });
});

describe('release decisions', () => {
  const base = {
    runId: newRunId(),
    decidedAt: nowIso(),
    decidedBy: 'release-guardian' as const,
    evaluatedBy: 'verification/release-gate@1',
    equivalenceConfidence: 0.9,
    repairIterationsUsed: 0,
  };

  it('rejects a PASS while a required gate failed', () => {
    expect(() =>
      releaseDecisionSchema.parse({
        ...base,
        decision: 'PASS',
        gates: [
          {
            gateId: 'critical-invariants-hold',
            description: 'all critical invariants hold',
            required: true,
            passed: false,
          },
        ],
      }),
    ).toThrow(/required gates failed/);
  });

  it('rejects a REJECT without blocking reasons', () => {
    expect(() =>
      releaseDecisionSchema.parse({ ...base, decision: 'REJECT', gates: [], blockingReasons: [] }),
    ).toThrow(/blocking reason/);
  });

  it('accepts a justified REJECT and renders it as a report', () => {
    const decision = releaseDecisionSchema.parse({
      ...base,
      decision: 'REJECT',
      gates: [
        {
          gateId: 'no-unexplained-differences',
          description: 'every behavioral difference is explained',
          required: true,
          passed: false,
          detail: '2 unexplained mismatches',
        },
      ],
      blockingReasons: [
        {
          code: 'UNEXPLAINED_DIFFERENCE',
          gateId: 'no-unexplained-differences',
          detail: 'fee rounding diverges on 10.005',
          severity: 'MAJOR',
          relatedInvariantIds: ['INV-ROUNDING'],
        },
      ],
      evidenceArtifactIds: [],
      unresolvedUnknowns: [],
    });
    const report = renderReleaseReportMarkdown(decision);
    expect(report).toContain('**Decision: REJECT**');
    expect(report).toContain('UNEXPLAINED_DIFFERENCE');
    expect(report).toContain('INV-ROUNDING');
  });
});

describe('evidence graph', () => {
  const at = nowIso();
  const graph = evidenceGraphSchema.parse({
    runId: newRunId(),
    generatedAt: at,
    nodes: [
      { id: 'src:AcctSvc.java:120', kind: 'source', label: 'AcctSvc.doProcess2 fee branch', createdAt: at, createdBy: 'archaeologist' },
      { id: 'rule:BR-FEE-THRESHOLD', kind: 'rule', label: 'Fees skipped below threshold', refId: 'BR-FEE-THRESHOLD', createdAt: at, createdBy: 'business-rule-analyst' },
      { id: 'inv:INV-CONSERVATION', kind: 'invariant', label: 'Money is conserved', refId: 'INV-CONSERVATION', createdAt: at, createdBy: 'invariant-analyst' },
      { id: 'test:CHR-FEE-01', kind: 'test', label: 'Characterizes the fee threshold', refId: 'CHR-FEE-01', createdAt: at, createdBy: 'characterization-engineer' },
      { id: 'impl:modern/fee.ts', kind: 'implementation', label: 'Modern fee calculation', createdAt: at, createdBy: 'modernizer' },
      { id: 'ver:diff-report', kind: 'verification', label: 'Differential report', createdAt: at, createdBy: 'differential-verifier' },
      { id: 'dec:release', kind: 'decision', label: 'Release decision', createdAt: at, createdBy: 'release-guardian' },
    ],
    edges: [
      { id: 'e1', from: 'src:AcctSvc.java:120', to: 'rule:BR-FEE-THRESHOLD', kind: 'supports', confidence: 0.9, createdAt: at, createdBy: 'business-rule-analyst' },
      { id: 'e2', from: 'rule:BR-FEE-THRESHOLD', to: 'inv:INV-CONSERVATION', kind: 'derives-from', confidence: 0.8, createdAt: at, createdBy: 'invariant-analyst' },
      { id: 'e3', from: 'inv:INV-CONSERVATION', to: 'test:CHR-FEE-01', kind: 'validated-by', createdAt: at, createdBy: 'characterization-engineer' },
      { id: 'e4', from: 'test:CHR-FEE-01', to: 'impl:modern/fee.ts', kind: 'implemented-by', createdAt: at, createdBy: 'modernizer' },
      { id: 'e5', from: 'impl:modern/fee.ts', to: 'ver:diff-report', kind: 'verified-by', createdAt: at, createdBy: 'differential-verifier' },
      { id: 'e6', from: 'ver:diff-report', to: 'dec:release', kind: 'decided-by', createdAt: at, createdBy: 'release-guardian' },
    ],
  });

  it('accepts a fully connected chain', () => {
    expect(checkEvidenceGraphIntegrity(graph)).toEqual([]);
  });

  it('flags claims with no supporting evidence', () => {
    const orphaned = evidenceGraphSchema.parse({
      ...graph,
      edges: graph.edges.filter((edge) => edge.id !== 'e6' && edge.id !== 'e5'),
    });
    const issues = checkEvidenceGraphIntegrity(orphaned);
    expect(issues.some((issue) => issue.code === 'unsupported-claim')).toBe(true);
  });

  it('flags dangling edges and duplicate ids', () => {
    const broken = evidenceGraphSchema.parse({
      ...graph,
      nodes: [...graph.nodes, graph.nodes[0]],
      edges: [...graph.edges, { id: 'eX', from: 'nope', to: 'dec:release', kind: 'supports', createdAt: at, createdBy: 'x' }],
    });
    const codes = checkEvidenceGraphIntegrity(broken).map((issue) => issue.code);
    expect(codes).toContain('duplicate-node-id');
    expect(codes).toContain('dangling-edge-from');
  });

  it('answers "why is this migration safe?" with a chain back to source code', () => {
    const chains = findEvidenceChains(graph, 'dec:release');
    expect(chains.length).toBeGreaterThan(0);
    const strongest = chains[0];
    expect(strongest?.nodeIdPath[0]).toBe('src:AcctSvc.java:120');
    expect(strongest?.nodeIdPath.at(-1)).toBe('dec:release');
    expect(strongest?.strength).toBeCloseTo(0.8, 5);
  });

  it('reports an unanswerable question honestly', () => {
    const explanation = explainEvidence(graph, 'dec:release');
    expect(explanation.answered).toBe(true);
    expect(explanation.rootEvidence.map((root) => root.kind)).toContain('source');

    const hollow = evidenceGraphSchema.parse({
      runId: graph.runId,
      generatedAt: at,
      nodes: [{ id: 'dec:release', kind: 'decision', label: 'Release decision', createdAt: at, createdBy: 'release-guardian' }],
      edges: [],
    });
    const hollowExplanation = explainEvidence(hollow, 'dec:release');
    expect(hollowExplanation.answered).toBe(false);
    expect(hollowExplanation.chains).toEqual([]);
  });
});

describe('llm pricing', () => {
  const table = {
    currency: 'USD',
    entries: [
      { model: 'qwen3-coder-plus', currency: 'USD', inputPerMillionTokens: 1, outputPerMillionTokens: 3 },
      { model: 'qwen*', currency: 'USD', inputPerMillionTokens: 0.5, outputPerMillionTokens: 1.5 },
    ],
  };

  it('reports cost only when pricing exists', () => {
    const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000 };
    expect(estimateCost(usage, findPricing(table, 'qwen3-coder-plus'))?.amount).toBe(4);
    expect(estimateCost(usage, findPricing(table, 'qwen-turbo'))?.amount).toBe(2);
    expect(estimateCost(usage, findPricing(table, 'llama3.2'))).toBeUndefined();
    expect(estimateCost(usage, undefined)).toBeUndefined();
  });
});

describe('errors and logging', () => {
  it('keeps error codes and details inspectable', () => {
    const error = new PhoenixError('TOOL_PATH_OUT_OF_SCOPE', 'write denied', {
      path: '/legacy/x.java',
      role: 'modernizer',
    });
    const described = describeError(error);
    expect(described.code).toBe('TOOL_PATH_OUT_OF_SCOPE');
    expect(described.details).toMatchObject({ path: '/legacy/x.java' });
    expect(describeError(new TypeError('boom')).code).toBe('INTERNAL');
    expect(describeError('plain string').message).toBe('plain string');
  });

  it('writes one JSON line per record and redacts secrets', () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLogger({ level: 'debug', sink, component: 'test' });
    logger.info('starting', { runId: 'run_x', apiKey: 'sk-secret-value' });
    logger.debug('hidden by level');
    const records = sink.records();
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ level: 'info', message: 'starting', component: 'test' });
    expect(records[0]?.apiKey).toBe('sk-s***redacted***');
    expect(records[1]?.level).toBe('debug');
    expect(logger.child({ role: 'archaeologist' })).toBeDefined();
  });

  it('suppresses records below the configured level', () => {
    const sink = new MemoryLogSink();
    const logger = new JsonLogger({ level: 'warn', sink });
    logger.info('ignored');
    logger.warn('kept');
    expect(sink.records().map((record) => record.level)).toEqual(['warn']);
  });
});

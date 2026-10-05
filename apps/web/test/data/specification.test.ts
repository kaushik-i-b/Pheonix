import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, envelope, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { loadSpecification } from '../../src/data/specification.js';

const fixtures: FixtureWorkspace[] = [];
const runId = 'run_fixture0000000000000000000000000';
const attemptA = 'task_11112222333344445555666677778888';
const attemptBroken = 'task_99998888777766665555444433332222';
const attemptB = 'task_aaaabbbbccccddddeeeeffff00001111';

afterEach(() => {
  for (const fixture of fixtures.splice(0)) cleanupWorkspace(fixture);
});

function workspaceWith(spec: Parameters<typeof makeWorkspace>[0]): Workspace {
  const fixture = makeWorkspace(spec);
  fixtures.push(fixture);
  return resolveWorkspace({ cwd: fixture.repoRoot, env: {} });
}

function evidence(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'ev_1',
    kind: 'file-quote',
    quote: 'balance -= amount;',
    collectedAt: '2026-01-01T00:00:00.000Z',
    collectedBy: 'archaeologist',
    location: { path: 'src/main/java/Bank.java', startLine: 10, endLine: 12, symbol: 'debit' },
    ...overrides,
  };
}

function rule(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ruleId: 'RULE-CANONICAL',
    title: 'Canonical rule',
    kind: 'business-rule',
    epistemicStatus: 'observed',
    lifecycleStatus: 'active',
    description: 'Canonical description.',
    confidence: 0.9,
    confidenceBasis: 'verified quote in Bank.java',
    testable: true,
    observableBehavior: 'Debits reduce the balance before settlement.',
    affectedComponents: ['src/main/java/Bank.java'],
    assumptions: [],
    duplicateImplementations: [],
    sourceEvidence: [evidence()],
    contradictsRuleIds: [],
    derivedFromInvariantIds: [],
    proposedChecks: [
      {
        id: 'check_1',
        kind: 'behavioral',
        description: 'Debit reduces balance.',
        targetsRuleId: null,
      },
    ],
    ...overrides,
  };
}

function invariant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    invariantId: 'INV-1',
    statement: 'Settled debits always leave a non-negative buffered balance.',
    formalStatement: null,
    kind: 'domain-invariant',
    criticality: 'high',
    epistemicStatus: 'observed',
    lifecycleStatus: 'active',
    violationSeverity: 'critical',
    confidence: 0.8,
    scope: {
      components: ['src/main/java/Bank.java'],
      operations: ['POST /api/debit'],
    },
    checkingStrategy: {
      kind: 'database-query',
      automated: true,
      executable: 'SELECT count(*) FROM ledger_entries WHERE amount < 0',
      detail: 'Run against the settled ledger.',
    },
    examples: [{ description: 'Debit of 10 from a balance of 5', expected: 'request rejected' }],
    knownExceptions: [],
    derivedFromRuleIds: ['RULE-CANONICAL'],
    sourceEvidence: [evidence({ id: 'ev_9' })],
    ...overrides,
  };
}

function unknown(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'UNK-1',
    question: 'How are fees routed?',
    whyItMatters: 'Affects balance math.',
    resolutionStrategy: 'Read the fee service.',
    relatedRuleIds: ['RULE-CANONICAL'],
    relatedInvariantIds: [],
    ...overrides,
  };
}

function specificationWorkspace(): Workspace {
  return workspaceWith({
    runs: [
      {
        runId,
        files: {
          'specification/business-rules.json': envelope('specification.business-rules', {
            generatedAt: '2026-01-02T00:00:00.000Z',
            generatedBy: 'archaeologist',
            rules: [rule()],
            schemaVersion: 1,
            statistics: { total: 1 },
            unknowns: [unknown()],
          }),
          'specification/invariants.json': envelope('specification.invariants', {
            invariants: [],
            unknowns: [],
            schemaVersion: 1,
            statistics: { total: 0 },
          }),
          [`specification/business-rules-attempt-${attemptA}.json`]: envelope(
            'specification.business-rules',
            {
              generatedAt: '2026-01-03T00:00:00.000Z',
              rules: [
                rule({
                  title: 'Duplicate canonical id in attempt',
                  sourceEvidence: [
                    evidence({
                      id: 'ev_2',
                      note: 'quote drifted by one line',
                      location: { path: 'src/main/java/Wire.java', startLine: 42 },
                    }),
                  ],
                }),
                rule({
                  ruleId: 'RULE-ATTEMPT',
                  title: 'Attempt-only rule',
                  sourceEvidence: [evidence({ id: 'ev_3', location: null })],
                }),
              ],
              unknowns: [unknown({ id: 'UNK-SHARED', question: 'Shared question from rules.' })],
            },
            { taskId: attemptA },
          ),
          [`specification/invariants-attempt-${attemptA}.json`]: envelope(
            'specification.invariants',
            {
              invariants: [invariant()],
              unknowns: [
                unknown({ id: 'UNK-SHARED', question: 'Shared question from invariants.' }),
                unknown({ id: 'UNK-ONLY-INV', question: 'Only invariants know this.' }),
              ],
            },
            { taskId: attemptA },
          ),
          [`specification/business-rules-attempt-${attemptB}.json`]: envelope(
            'specification.business-rules',
            { rules: [], unknowns: [] },
            { taskId: attemptB },
          ),
        },
        rawFiles: {
          [`specification/business-rules-attempt-${attemptBroken}.json`]: 'not json at all',
        },
      },
    ],
  });
}

describe('loadSpecification', () => {
  it('merges canonical and attempt artifacts with normalized evidence and counts', () => {
    const view = loadSpecification(specificationWorkspace(), runId);

    expect(view.artifacts.map((artifact) => artifact.slug)).toEqual([
      'business-rules',
      `business-rules-attempt-${attemptA}`,
      `business-rules-attempt-${attemptB}`,
    ]);

    const canonical = view.artifacts[0]!;
    expect(canonical.variant).toBe('canonical');
    expect(canonical.taskId).toBeNull();
    expect(canonical.fileName).toBe('business-rules.json');
    expect(canonical.generatedAt).toBe('2026-01-02T00:00:00.000Z');
    expect(canonical.statistics).toEqual({ total: 1 });
    expect([canonical.ruleCount, canonical.invariantCount, canonical.unknownCount]).toEqual([
      1, 0, 1,
    ]);
    expect(canonical.unknowns).toEqual([
      {
        id: 'UNK-1',
        question: 'How are fees routed?',
        whyItMatters: 'Affects balance math.',
        resolutionStrategy: 'Read the fee service.',
        relatedRuleIds: ['RULE-CANONICAL'],
        relatedInvariantIds: [],
      },
    ]);
    expect(canonical.rules[0]).toEqual({
      ruleId: 'RULE-CANONICAL',
      title: 'Canonical rule',
      kind: 'business-rule',
      epistemicStatus: 'observed',
      lifecycleStatus: 'active',
      description: 'Canonical description.',
      confidence: 0.9,
      confidenceBasis: 'verified quote in Bank.java',
      testable: true,
      observableBehavior: 'Debits reduce the balance before settlement.',
      affectedComponents: ['src/main/java/Bank.java'],
      assumptions: [],
      duplicateImplementations: [],
      sourceEvidence: [
        {
          id: 'ev_1',
          kind: 'file-quote',
          quote: 'balance -= amount;',
          note: null,
          collectedAt: '2026-01-01T00:00:00.000Z',
          collectedBy: 'archaeologist',
          path: 'src/main/java/Bank.java',
          startLine: 10,
          endLine: 12,
          symbol: 'debit',
        },
      ],
      edgeCases: [],
      contradictsRuleIds: [],
      derivedFromInvariantIds: [],
      proposedChecks: [
        {
          id: 'check_1',
          kind: 'behavioral',
          description: 'Debit reduces balance.',
          targetsRuleId: null,
        },
      ],
    });

    const attempt = view.artifacts[1]!;
    expect(attempt.variant).toBe('attempt');
    expect(attempt.taskId).toBe(attemptA);
    expect(attempt.fileName).toBe(`business-rules-attempt-${attemptA}.json`);
    expect([attempt.ruleCount, attempt.invariantCount, attempt.unknownCount]).toEqual([2, 1, 2]);
    expect(attempt.unknowns.map((entry) => entry.id)).toEqual(['UNK-SHARED', 'UNK-ONLY-INV']);
    expect(attempt.unknowns[0]!.question).toBe('Shared question from rules.');

    const duplicateRule = attempt.rules[0]!;
    expect(duplicateRule.ruleId).toBe('RULE-CANONICAL');
    expect(duplicateRule.sourceEvidence[0]).toEqual({
      id: 'ev_2',
      kind: 'file-quote',
      quote: 'balance -= amount;',
      note: 'quote drifted by one line',
      collectedAt: '2026-01-01T00:00:00.000Z',
      collectedBy: 'archaeologist',
      path: 'src/main/java/Wire.java',
      startLine: 42,
      endLine: 42,
      symbol: null,
    });
    expect(attempt.rules[1]!.sourceEvidence).toEqual([]);

    expect(attempt.invariants[0]).toEqual({
      invariantId: 'INV-1',
      statement: 'Settled debits always leave a non-negative buffered balance.',
      formalStatement: null,
      kind: 'domain-invariant',
      criticality: 'high',
      epistemicStatus: 'observed',
      lifecycleStatus: 'active',
      violationSeverity: 'critical',
      confidence: 0.8,
      scope: {
        components: ['src/main/java/Bank.java'],
        operations: ['POST /api/debit'],
      },
      checkingStrategy: {
        kind: 'database-query',
        automated: true,
        executable: 'SELECT count(*) FROM ledger_entries WHERE amount < 0',
        detail: 'Run against the settled ledger.',
      },
      examples: [{ description: 'Debit of 10 from a balance of 5', expected: 'request rejected' }],
      knownExceptions: [],
      derivedFromRuleIds: ['RULE-CANONICAL'],
      sourceEvidence: [
        {
          id: 'ev_9',
          kind: 'file-quote',
          quote: 'balance -= amount;',
          note: null,
          collectedAt: '2026-01-01T00:00:00.000Z',
          collectedBy: 'archaeologist',
          path: 'src/main/java/Bank.java',
          startLine: 10,
          endLine: 12,
          symbol: 'debit',
        },
      ],
    });
  });

  it('resolves the rule index to canonical entries first and reports duplicates', () => {
    const view = loadSpecification(specificationWorkspace(), runId);

    const canonicalEntry = view.ruleIndex.get('RULE-CANONICAL');
    expect(canonicalEntry?.slug).toBe('business-rules');
    expect(canonicalEntry?.rule.title).toBe('Canonical rule');

    const attemptEntry = view.ruleIndex.get('RULE-ATTEMPT');
    expect(attemptEntry?.slug).toBe(`business-rules-attempt-${attemptA}`);
    expect(attemptEntry?.rule.title).toBe('Attempt-only rule');
    expect(view.ruleIndex.size).toBe(2);

    expect(view.problems).toEqual([
      `duplicate rule id RULE-CANONICAL in business-rules-attempt-${attemptA}.json; kept the entry from business-rules`,
      `business-rules-attempt-${attemptA}.json: dropped evidence for rule RULE-ATTEMPT: missing quote or location`,
      `business-rules-attempt-${attemptBroken}.json: unparseable JSON`,
    ]);
  });

  it('keeps other artifacts loadable when a specification file is unparseable', () => {
    const view = loadSpecification(specificationWorkspace(), runId);

    expect(view.artifacts).toHaveLength(3);
    expect(view.ruleIndex.get('RULE-ATTEMPT')?.rule.ruleId).toBe('RULE-ATTEMPT');
    expect(view.artifacts.some((artifact) => artifact.slug.includes(attemptBroken))).toBe(false);
  });

  it('renders a zero-count attempt artifact with empty arrays', () => {
    const view = loadSpecification(specificationWorkspace(), runId);

    const zero = view.artifacts[2]!;
    expect(zero.slug).toBe(`business-rules-attempt-${attemptB}`);
    expect(zero.fileName).toBe(`business-rules-attempt-${attemptB}.json`);
    expect(zero.variant).toBe('attempt');
    expect(zero.taskId).toBe(attemptB);
    expect(zero.rules).toEqual([]);
    expect(zero.invariants).toEqual([]);
    expect(zero.unknowns).toEqual([]);
    expect(zero.ruleCount).toBe(0);
    expect(zero.invariantCount).toBe(0);
    expect(zero.unknownCount).toBe(0);
    expect(zero.statistics).toBeNull();
    expect(zero.generatedAt).toBeNull();
  });
});

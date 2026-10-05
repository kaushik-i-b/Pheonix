import { afterEach, describe, expect, it } from 'vitest';
import { cleanupWorkspace, envelope, makeWorkspace } from '../fixtures.js';
import type { FixtureWorkspace } from '../fixtures.js';
import { resolveWorkspace } from '../../src/data/repo-root.js';
import type { Workspace } from '../../src/data/repo-root.js';
import { loadFindings } from '../../src/data/findings.js';

const fixtures: FixtureWorkspace[] = [];
const runId = 'run_fixture0000000000000000000000000';

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
    quote: 'INSERT INTO ledger',
    collectedAt: '2026-01-01T00:00:00.000Z',
    collectedBy: 'archaeologist',
    location: { path: 'src/main/java/Post.java', startLine: 10, endLine: 12, symbol: 'post' },
    ...overrides,
  };
}

function findingsPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    findings: [
      {
        id: 'F-ONE',
        kind: 'ledger-integrity',
        summary: 'Ledger rows are immutable once posted.',
        severity: 'MAJOR',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        affectedComponents: ['src/main/java/Post.java'],
        relatedRuleIds: ['RULE-1'],
        relatedInvariantIds: ['INV-1'],
        evidence: [evidence({ note: 'host-anchored to real bytes at lines 10-12' })],
      },
    ],
    openQuestions: [
      {
        id: 'Q-ONE',
        question: 'How is reconciliation handled?',
        whyItMatters: 'Drives the settlement design.',
        resolutionStrategy: 'runtime-probe',
        relatedRuleIds: ['RULE-1'],
      },
    ],
    sections: [{ heading: 'Overview', body: 'The legacy core.' }],
    summary: 'A legacy banking core.',
    ...overrides,
  };
}

describe('loadFindings', () => {
  it('maps findings, open questions, sections, and summary', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'discovery/findings.json': envelope('discovery.findings', findingsPayload(), { runId }),
          },
        },
      ],
    });
    const view = loadFindings(ws, runId);
    expect(view.problems).toEqual([]);
    expect(view.summary).toBe('A legacy banking core.');
    expect(view.sections).toEqual([{ heading: 'Overview', body: 'The legacy core.' }]);
    expect(view.findings).toEqual([
      {
        id: 'F-ONE',
        kind: 'ledger-integrity',
        summary: 'Ledger rows are immutable once posted.',
        severity: 'MAJOR',
        epistemicStatus: 'OBSERVED',
        confidence: 0.9,
        affectedComponents: ['src/main/java/Post.java'],
        relatedRuleIds: ['RULE-1'],
        relatedInvariantIds: ['INV-1'],
        evidence: [
          {
            id: 'ev_1',
            kind: 'file-quote',
            quote: 'INSERT INTO ledger',
            note: 'host-anchored to real bytes at lines 10-12',
            collectedAt: '2026-01-01T00:00:00.000Z',
            collectedBy: 'archaeologist',
            path: 'src/main/java/Post.java',
            startLine: 10,
            endLine: 12,
            symbol: 'post',
          },
        ],
      },
    ]);
    expect(view.openQuestions).toEqual([
      {
        id: 'Q-ONE',
        question: 'How is reconciliation handled?',
        whyItMatters: 'Drives the settlement design.',
        resolutionStrategy: 'runtime-probe',
        relatedRuleIds: ['RULE-1'],
        relatedInvariantIds: [],
      },
    ]);
  });

  it('returns an empty view with a problem when the file is missing', () => {
    const ws = workspaceWith({ runs: [{ runId }] });
    const view = loadFindings(ws, runId);
    expect(view).toEqual({
      findings: [],
      openQuestions: [],
      sections: [],
      summary: null,
      problems: ['findings.json missing'],
    });
  });

  it('returns an empty view with a problem when the payload is unparseable', () => {
    const ws = workspaceWith({
      runs: [{ runId, rawFiles: { 'discovery/findings.json': 'not json at all' } }],
    });
    const view = loadFindings(ws, runId);
    expect(view).toEqual({
      findings: [],
      openQuestions: [],
      sections: [],
      summary: null,
      problems: ['findings.json: unparseable JSON'],
    });
  });

  it('normalizes missing notes to null and drops malformed entries with problems', () => {
    const ws = workspaceWith({
      runs: [
        {
          runId,
          files: {
            'discovery/findings.json': envelope(
              'discovery.findings',
              findingsPayload({
                summary: { nested: true },
                findings: [
                  {
                    id: 'F-LITE',
                    kind: 'magic-number',
                    summary: 'A threshold is hard-coded.',
                    evidence: [
                      evidence(),
                      {
                        id: 'ev_bad',
                        kind: 'file-quote',
                        quote: '',
                        location: { path: 'x.java', startLine: 1 },
                      },
                    ],
                  },
                  { id: 'F-BROKEN', kind: 'x' },
                ],
                openQuestions: [{ id: 'Q-BROKEN' }],
                sections: [{ heading: 'Only heading' }],
              }),
              { runId },
            ),
          },
        },
      ],
    });
    const view = loadFindings(ws, runId);
    expect(view.findings).toHaveLength(1);
    expect(view.findings[0]?.severity).toBeNull();
    expect(view.findings[0]?.confidence).toBeNull();
    expect(view.findings[0]?.epistemicStatus).toBeNull();
    expect(view.findings[0]?.affectedComponents).toEqual([]);
    expect(view.findings[0]?.evidence).toHaveLength(1);
    expect(view.findings[0]?.evidence[0]?.note).toBeNull();
    expect(view.openQuestions).toEqual([]);
    expect(view.sections).toEqual([]);
    expect(view.summary).toBeNull();
    expect(view.problems).toEqual([
      'findings.json: dropped evidence for finding F-LITE: missing quote or location',
      'findings.json: dropped finding 2: missing id, kind, or summary',
      'findings.json: dropped unknown 1: missing id or question',
      'findings.json: dropped section 1: missing heading or body',
      'findings.json: summary is not a string',
    ]);
  });
});

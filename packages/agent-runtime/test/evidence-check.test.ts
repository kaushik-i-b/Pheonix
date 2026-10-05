import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { findingSchema, type Finding, type RunId } from '@phoenix/shared';
import type { FileArtifactStore } from '@phoenix/artifact-store';
import { checkFindingEvidence, evidenceExistsCheck } from '../src/evidence-check.js';
import { cleanupTemporaryDirectories, tempDirectory, writeSource } from './support.js';

/**
 * The citation verifier's repair hint, in isolation: when a quote is real but attributed to the
 * wrong file, the rejection must say where the text actually lives — that is what turns a
 * dead-end rejection into a repair the model can perform honestly. When the text exists nowhere,
 * the rejection must not pretend otherwise. An invented path gets the same treatment from the
 * other direction: the rejection names the real contents of the nearest directory, because the
 * name the model should have used is the one thing it could not guess.
 *
 * The second property under test is the opened-file requirement: accuracy alone does not license a
 * citation, because a quotation copied from the task brief is accurate and still is not analysis.
 */

const roots: string[] = [];

afterEach(() => {
  cleanupTemporaryDirectories();
});

function sourceFinding(path: string, quote: string): Finding[] {
  return [
    findingSchema.parse({
      id: 'F-MISATTRIBUTED',
      kind: 'behavior',
      summary: 'The fee is rounded half-even on the batch path.',
      epistemicStatus: 'OBSERVED',
      confidence: 0.9,
      evidence: [
        {
          id: 'ev-1',
          kind: 'source-code',
          collectedAt: '2026-10-01T00:00:00.000Z',
          collectedBy: 'test',
          location: { path },
          quote,
        },
      ],
    }),
  ];
}

describe('checkFindingEvidence repair hint', () => {
  it('names the file that really contains a misattributed quote', () => {
    const repo = tempDirectory('phoenix-evidence-hint-');
    roots.push(repo);
    writeSource(repo, 'src/FeeCollector.java', 'BigDecimal fee = Utils.calcXferFeeOnline(amount);\n');
    writeSource(repo, 'src/Utils.java', 'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);\n');

    const violations = checkFindingEvidence(
      sourceFinding('src/FeeCollector.java', 'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);'),
      { roots: [repo] },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain('quoted text does not appear in src/FeeCollector.java');
    expect(violations[0]?.problem).toContain('(the same text appears in src/Utils.java)');
  });

  it('stays silent when the quoted text exists nowhere under the roots', () => {
    const repo = tempDirectory('phoenix-evidence-nowhere-');
    roots.push(repo);
    writeSource(repo, 'src/FeeCollector.java', 'BigDecimal fee = Utils.calcXferFeeOnline(amount);\n');

    const violations = checkFindingEvidence(
      sourceFinding('src/FeeCollector.java', 'f = f.roundHalfEvenBecauseTheModelSaidSo();'),
      { roots: [repo] },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).not.toContain('the same text appears in');
  });

  it('never searches files that cannot be cited sources', () => {
    const repo = tempDirectory('phoenix-evidence-skip-');
    roots.push(repo);
    writeSource(repo, 'src/FeeCollector.java', 'BigDecimal fee = Utils.calcXferFeeOnline(amount);\n');
    // A copy of the quote inside node_modules must not be offered as a place to cite.
    writeSource(
      repo,
      'node_modules/fake-pkg/Utils.java',
      'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);\n',
    );

    const violations = checkFindingEvidence(
      sourceFinding('src/FeeCollector.java', 'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);'),
      { roots: [repo] },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).not.toContain('node_modules');
  });

  it('produces no violations when every citation is accurate', () => {
    const repo = tempDirectory('phoenix-evidence-accurate-');
    roots.push(repo);
    writeSource(repo, 'src/Utils.java', 'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);\n');

    const violations = checkFindingEvidence(
      sourceFinding('src/Utils.java', 'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);'),
      { roots: [repo] },
    );

    expect(violations).toEqual([]);
  });
});

describe('checkFindingEvidence invented-path hint', () => {
  it('names the real sibling of a path the model abbreviated into nonexistence', () => {
    const repo = tempDirectory('phoenix-evidence-invented-');
    roots.push(repo);
    writeSource(repo, 'src/main/java/com/fnb/corebank/svc/AcctSvc.java', 'public Account open(String owner) {\n');

    const violations = checkFindingEvidence(
      sourceFinding('src/main/java/com/fnb/corebank/svc/AccountSvc.java', 'public Account open(String owner) {'),
      { roots: [repo] },
    );

    // The citation is still refused: naming the real file is grounding for a repair, never acceptance.
    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain('cited file does not exist');
    expect(violations[0]?.problem).toContain('svc/ really contains AcctSvc.java');
  });
});

describe('checkFindingEvidence opened-file requirement', () => {
  it('rejects a verbatim-correct quotation from a file the agent never opened', () => {
    const repo = tempDirectory('phoenix-evidence-unopened-');
    roots.push(repo);
    const quote = 'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);';
    writeSource(repo, 'src/Utils.java', `${quote}\n`);

    const violations = checkFindingEvidence(sourceFinding('src/Utils.java', quote), {
      roots: [repo],
      openedPaths: [],
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]?.problem).toContain('was never opened with read_file');
  });

  it('accepts the same quotation once the agent has opened the file', () => {
    const repo = tempDirectory('phoenix-evidence-opened-');
    roots.push(repo);
    const quote = 'BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);';
    writeSource(repo, 'src/Utils.java', `${quote}\n`);

    const violations = checkFindingEvidence(sourceFinding('src/Utils.java', quote), {
      roots: [repo],
      openedPaths: [join(repo, 'src/Utils.java')],
    });

    expect(violations).toEqual([]);
  });
});

describe('evidenceExistsCheck', () => {
  const check = evidenceExistsCheck({ roots: [] });

  function context(findings: readonly Finding[]) {
    return {
      runId: 'run_00000000000000000000000000000000' as RunId,
      artifacts: undefined as unknown as FileArtifactStore,
      generated: [],
      findings,
      testRuns: [],
      payloadOf: () => undefined,
    };
  }

  it('does not report a pass when there was nothing to verify', async () => {
    const result = await check(context([]));
    expect(result.satisfied).toBe(false);
    expect(result.reason).toContain('nothing was verified');
    expect(result.observed).toContain('0 claim(s)');
  });

  it('reports the verified count once citations exist', async () => {
    const repo = tempDirectory('phoenix-evidence-exists-');
    roots.push(repo);
    const quote = 'BigDecimal fee = Utils.calcXferFeeOnline(amount);';
    writeSource(repo, 'src/FeeCollector.java', `${quote}\n`);

    const result = await evidenceExistsCheck({ roots: [repo], openedPaths: [join(repo, 'src/FeeCollector.java')] })(
      context(sourceFinding('src/FeeCollector.java', quote)),
    );
    expect(result.satisfied).toBe(true);
    expect(result.observed).toContain('1 evidence citation(s)');
  });
});

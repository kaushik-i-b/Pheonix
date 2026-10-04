import { describe, expect, it } from 'vitest';
import {
  TRANSPORT_RESPONSE_HEADERS,
  classifyVolatilePaths,
  isTransportHeader,
  normalizationPolicyFor,
} from '../src/index.js';

/**
 * Normalization is the only place a differential test can be made to pass by hiding something, so
 * these tests are less about coverage than about the direction of every mistake: a value that
 * varies for a reason nobody sanctioned must stay in the comparison.
 */

describe('normalizationPolicyFor', () => {
  it.each([
    ['responseBody.transferId', 'identifier suffix'],
    ['responseBody.entries.0.uuid', 'runtime-minted leaf'],
    ['responseBody.createdAt', 'clock suffix'],
    ['responseBody.settledTime', 'clock suffix'],
    ['responseBody.durationMs', 'duration suffix'],
  ])('allows %s (%s)', (path) => {
    expect(normalizationPolicyFor(path).allowed).toBe(true);
  });

  it.each([
    'responseBody.balance',
    'responseBody.fee',
    'responseBody.amount',
    'responseBody.status',
    'responseBody.entries.0.amount',
    'responseBody.currency',
    'httpStatus',
    // A row count is a value the systems must agree on, not something minted at runtime.
    'rowCount',
    // "Rounded" ends in the letters of a duration suffix but is a value, not an interval.
    'responseBody.feeRounded',
  ])('refuses %s', (path) => {
    expect(normalizationPolicyFor(path).allowed).toBe(false);
  });

  it('explains itself either way, so a report can say why a path was excused', () => {
    expect(normalizationPolicyFor('responseBody.transferId').reason).toContain('identifier suffix');
    expect(normalizationPolicyFor('responseBody.balance').reason).toContain('balance');
  });
});

describe('classifyVolatilePaths', () => {
  it('excuses only the paths policy recognises and reports the rest as unexplained', () => {
    const { normalizable, unexplained } = classifyVolatilePaths(
      new Set(['step.transferId', 'step.balance', 'step.createdAt', 'step.fee']),
    );

    expect([...normalizable.keys()].sort()).toEqual(['step.createdAt', 'step.transferId']);
    expect(unexplained).toEqual(['step.balance', 'step.fee']);
  });

  it('keeps a varying balance live rather than excusing it for having moved', () => {
    const { normalizable, unexplained } = classifyVolatilePaths(new Set(['read.responseBody.balance']));
    expect(normalizable.size).toBe(0);
    expect(unexplained).toEqual(['read.responseBody.balance']);
  });

  it('returns nothing when the two executions agreed everywhere', () => {
    const { normalizable, unexplained } = classifyVolatilePaths(new Set());
    expect(normalizable.size).toBe(0);
    expect(unexplained).toEqual([]);
  });
});

describe('isTransportHeader', () => {
  it('matches case-insensitively, because HTTP header names are not case-sensitive', () => {
    expect(isTransportHeader('Content-Length')).toBe(true);
    expect(isTransportHeader('DATE')).toBe(true);
  });

  it('leaves a header the application chose to send in the comparison', () => {
    expect(isTransportHeader('x-legacy-mode')).toBe(false);
    expect(isTransportHeader('content-type')).toBe(false);
    expect(TRANSPORT_RESPONSE_HEADERS.has('content-type')).toBe(false);
  });
});

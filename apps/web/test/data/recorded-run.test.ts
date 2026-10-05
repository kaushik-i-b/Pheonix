import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const bundle = JSON.parse(readFileSync(join(import.meta.dirname, '../../src/data/recorded-run.json'), 'utf8')) as {
  label: string;
  runId: string;
  sliceCommit: string;
  finalVerdict: string;
  discover: { taskId: string };
  verification: {
    numeric: { verdict: string; mismatchCount: number };
    equivalent: { verdict: string; mismatchCount: number };
    defect: { verdict: string };
    restored: { verdict: string; mismatchCount: number };
    feeConfirmed: boolean;
    feeExample: { path: string; legacy: number; modern: number };
    numericExample: { legacy: number; modern: string };
  };
  services: { original: { primaryLanguage: string }; replacement: { stack: string; entryPoint: string } };
  feeAt60: { amount: number; capturedFee: number };
};

describe('recorded-run bundle', () => {
  it('selects the pinned successful lineage rather than a newest-file scan', () => {
    expect(bundle.label).toBe('Recorded run');
    expect(bundle.runId).toBe('run_1ad5681e13294219959c3908022799c5');
    expect(bundle.sliceCommit.startsWith('3cef618')).toBe(true);
    expect(bundle.discover.taskId).toBe('task_47614a38d04a415692c7566beb09815a');
    expect(bundle.finalVerdict).toBe('EQUIVALENT');
  });

  it('keeps the numeric-scale mismatch and the confirmed fee defect', () => {
    expect(bundle.verification.numeric.verdict).toBe('NOT_EQUIVALENT');
    expect(bundle.verification.numeric.mismatchCount).toBe(80);
    expect(bundle.verification.numericExample).toMatchObject({ legacy: 60, modern: '60.0000' });
    expect(bundle.verification.equivalent).toMatchObject({ verdict: 'EQUIVALENT', mismatchCount: 0 });
    expect(bundle.verification.feeConfirmed).toBe(true);
    expect(bundle.verification.feeExample).toMatchObject({
      path: 'xfer-100-young-account.responseBody.fee',
      legacy: 0.5,
      modern: 1,
    });
    expect(bundle.verification.defect.verdict).toBe('NOT_EQUIVALENT');
    expect(bundle.verification.restored).toMatchObject({ verdict: 'EQUIVALENT', mismatchCount: 0 });
    expect(bundle.services.original.primaryLanguage).toBe('Java');
    expect(bundle.services.replacement).toMatchObject({ stack: 'Node/TypeScript', entryPoint: 'server.ts' });
    expect(bundle.feeAt60).toMatchObject({ amount: 60, capturedFee: 0 });
  });

  it('does not embed host paths or credential shapes', () => {
    const raw = readFileSync(join(import.meta.dirname, '../../src/data/recorded-run.json'), 'utf8');
    expect(raw.includes('/Users/')).toBe(false);
    expect(raw.includes('sk-')).toBe(false);
    expect(raw.includes('transcript')).toBe(false);
  });
});

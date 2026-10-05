import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { maskMatch, scanDir, scanText } from '../../../scripts/scan-public-bundle.mjs';

const dirs: string[] = [];

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'phoenix-scan-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('scanText', () => {
  it('detects each pattern class with a 1-based line number', () => {
    const text = [
      'clean first line',
      'key sk-ABCDEFGH1234 here',
      'auth AQ.Ab8xyzxyz9 token',
      'header Authorization: abcdefgh12345',
      'header Bearer abcdefgh extra',
      'path /Users/someone/secret/file.ts',
    ].join('\n');

    const findings = scanText(text);
    const byLabel = new Map(findings.map((finding) => [finding.label, finding]));

    expect([...byLabel.keys()].sort()).toEqual([
      'absolute user path',
      'api key (AQ.)',
      'api key (sk-)',
      'authorization value',
      'bearer token',
    ]);
    expect(byLabel.get('api key (sk-)')?.line).toBe(2);
    expect(byLabel.get('api key (AQ.)')?.line).toBe(3);
    expect(byLabel.get('authorization value')?.line).toBe(4);
    expect(byLabel.get('bearer token')?.line).toBe(5);
    expect(byLabel.get('absolute user path')?.line).toBe(6);
  });

  it('never exposes the full match in masked output', () => {
    const secret = 'sk-ABCDEFGH1234';
    const findings = scanText(`key ${secret} end`);

    expect(findings).toHaveLength(1);
    expect(findings[0].masked).not.toContain(secret);
    expect(findings[0].masked).toBe(maskMatch(secret));
  });

  it('returns no findings for clean text', () => {
    expect(scanText('nothing to see\nsrc/main/java/Main.java\nhttp://localhost:4173/')).toEqual([]);
  });
});

describe('scanDir', () => {
  it('walks nested directories and reports relative file paths and 1-based lines', () => {
    const dir = makeDir();
    mkdirSync(join(dir, 'deep', 'nested'), { recursive: true });
    writeFileSync(join(dir, 'top.txt'), 'ok\nsecret sk-ABCDEFGH1234\n');
    writeFileSync(join(dir, 'deep', 'nested', 'leaf.html'), 'a\nb\npath /Users/someone/x here\n');
    writeFileSync(join(dir, 'deep', 'logo.png'), 'sk-ABCDEFGH1234');

    const findings = scanDir(dir);
    const sk = findings.find((finding) => finding.label === 'api key (sk-)');
    const pathFinding = findings.find((finding) => finding.label === 'absolute user path');

    expect(sk?.file).toBe('top.txt');
    expect(sk?.line).toBe(2);
    expect(sk?.masked).toBe('sk-ABC…34');
    expect(pathFinding?.file).toBe(join('deep', 'nested', 'leaf.html'));
    expect(pathFinding?.line).toBe(3);
    expect(findings.some((finding) => finding.file.endsWith('.png'))).toBe(false);
  });
});

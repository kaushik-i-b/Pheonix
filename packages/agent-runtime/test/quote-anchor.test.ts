import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { anchorQuote, normalizeWhitespace } from '../src/quote-anchor.js';
import type { QuoteAnchorResult } from '../src/quote-anchor.js';

const LEGACY_ROOT = new URL('../../../examples/legacy-bank/', import.meta.url);

function loadLegacy(relativePath: string): string {
  return readFileSync(new URL(relativePath, LEGACY_ROOT), 'utf8');
}

function linesOf(text: string): string[] {
  return text.split('\n');
}

function expectEmittedWithin(result: QuoteAnchorResult, fileText: string): string {
  const emitted = result.quote;
  expect(emitted).toBeDefined();
  if (emitted === undefined) {
    return '';
  }
  expect(emitted).not.toContain('\u2026');
  expect(normalizeWhitespace(fileText)).toContain(normalizeWhitespace(emitted));
  return emitted;
}

const V3_PATH = 'src/main/resources/db/migration/V3__batch_and_triggers.sql';
const RECON_PATH = 'src/main/java/com/fnb/corebank/svc/ReconSvc.java';
const CORRECTION_PATH = 'src/main/java/com/fnb/corebank/svc/CorrectionSvc.java';
const TRANSFER_PATH = 'src/main/java/com/fnb/corebank/svc/TransferSvc.java';

// Exact quotes from run 14 of DISCOVER (artifacts/run_14 discovery.json).
const LEDGER_QUOTE =
  "BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW WHEN (OLD.status = 'SETTLED' AND chan <> 'CORRECTION_JOB') BEGIN RAISE EXCEPTION 'E188: settled ledger entries are immutable (ledger row %)', OLD.id; END;";
const FEE_QUOTE = [
  'CREATE OR REPLACE FUNCTION calc_transfer_fee(amt NUMERIC) RETURNS NUMERIC AS $$',
  'BEGIN',
  '    IF amt < 50 THEN',
  '        RETURN 0;',
  '    END IF;',
  '    RETURN GREATEST(ROUND(amt * 0.005, 2), 0.25);',
  'END;',
  '$$ LANGUAGE plpgsql IMMUTABLE;',
].join('\n');
const SWALLOW_QUOTE = [
  'catch (Exception e) {',
  '    logger.error("Error correcting transfer", e);',
  '}',
].join('\n');
const TIME_QUOTE = [
  'if (LocalDate.now().getDayOfWeek() == DayOfWeek.MONDAY) {',
  '    // Run reconciliation',
  '}',
].join('\n');
const DUP_SUBTRACT_QUOTE = [
  'Account account = accountRepository.findById(fromAccountId).orElseThrow(() -> new RuntimeException("Account not found"));',
  'account.setBalance(account.getBalance().subtract(amount));',
  'accountRepository.save(account);',
].join('\n');
const DUP_ADD_QUOTE = [
  'Account account = accountRepository.findById(accountId).orElseThrow(() -> new RuntimeException("Account not found"));',
  'account.setBalance(account.getBalance().add(amount));',
  'accountRepository.save(account);',
].join('\n');

describe('anchorQuote: run-14 real quotes', () => {
  it('anchors the fused ledger trigger quote to the real immutability block (V3 lines 21-23)', () => {
    const v3 = loadLegacy(V3_PATH);
    const result = anchorQuote({ fileText: v3, quote: LEDGER_QUOTE, citedStartLine: 31 });

    expect(result.kind).toBe('anchored');
    expect(result.startLine).toBe(21);
    expect(result.endLine).toBe(23);
    const emitted = expectEmittedWithin(result, v3);
    expect(emitted).toBe(linesOf(v3).slice(20, 23).join('\n'));
  });

  it('recognizes the SQL function quote as verbatim (V3 lines 4-11)', () => {
    const v3 = loadLegacy(V3_PATH);
    const result = anchorQuote({ fileText: v3, quote: FEE_QUOTE, citedStartLine: 4 });

    expect(result.kind).toBe('verbatim');
    expect(result.startLine).toBe(4);
    expect(result.endLine).toBe(11);
    const emitted = expectEmittedWithin(result, v3);
    expect(emitted).toBe(linesOf(v3).slice(3, 11).join('\n'));
  });

  it('anchors the paraphrased catch block to the real lines 111-113 of CorrectionSvc', () => {
    const correction = loadLegacy(CORRECTION_PATH);
    const result = anchorQuote({ fileText: correction, quote: SWALLOW_QUOTE, citedStartLine: 111 });

    expect(result.kind).toBe('anchored');
    expect(result.startLine).toBe(111);
    expect(result.endLine).toBe(113);
    const emitted = expectEmittedWithin(result, correction);
    expect(emitted).toContain('catch (Exception e) {');
    expect(emitted).toContain('log.debug("audit trail skipped for correction "');
    expect(emitted).not.toContain('Error correcting transfer');
  });

  it('rejects the fabricated DayOfWeek quote against ReconSvc', () => {
    const recon = loadLegacy(RECON_PATH);
    const result = anchorQuote({ fileText: recon, quote: TIME_QUOTE, citedStartLine: 29 });

    expect(result.kind).toBe('unresolved');
  });

  it('rejects all three duplicated-logic quotes against TransferSvc', () => {
    const transfer = loadLegacy(TRANSFER_PATH);

    for (const citedStartLine of [48, 159, 225]) {
      const result = anchorQuote({
        fileText: transfer,
        quote: DUP_SUBTRACT_QUOTE,
        citedStartLine,
      });
      expect(result.kind).toBe('unresolved');
    }
    const addResult = anchorQuote({ fileText: transfer, quote: DUP_ADD_QUOTE, citedStartLine: 159 });
    expect(addResult.kind).toBe('unresolved');
  });
});

describe('anchorQuote: synthetic controls', () => {
  it('rejects a pure invention', () => {
    const recon = loadLegacy(RECON_PATH);
    const result = anchorQuote({
      fileText: recon,
      quote: 'reconciliation runs every Monday at 06:00 and emails the ops team before the standup',
    });
    expect(result.kind).toBe('unresolved');
  });

  it('rejects verbatim text from a different file', () => {
    const recon = loadLegacy(RECON_PATH);
    const result = anchorQuote({
      fileText: recon,
      quote: 'while (n.getDayOfWeek() == DayOfWeek.SATURDAY || n.getDayOfWeek() == DayOfWeek.SUNDAY) {',
    });
    expect(result.kind).toBe('unresolved');
  });

  it('rejects a scattered paraphrase whose strong lines are far apart', () => {
    const recon = loadLegacy(RECON_PATH);
    const quote = [
      'BigDecimal tolerance = new BigDecimal("0.01");',
      'if (diff.compareTo(tolerance) < 0) {',
      '    log.info("within tolerance");',
      '}',
    ].join('\n');
    const result = anchorQuote({ fileText: recon, quote });
    expect(result.kind).toBe('unresolved');
  });

  it('recognizes exact boilerplate', () => {
    const recon = loadLegacy(RECON_PATH);
    const result = anchorQuote({
      fileText: recon,
      quote: 'private static final Logger log = LoggerFactory.getLogger(ReconSvc.class);',
    });
    expect(result.kind).toBe('verbatim');
    expect(result.startLine).toBe(22);
    expect(result.endLine).toBe(22);
  });

  it('anchors a misquoted constant to the real line without leaking the wrong value', () => {
    const recon = loadLegacy(RECON_PATH);
    const result = anchorQuote({
      fileText: recon,
      quote: 'private static final BigDecimal TOLERANCE = new BigDecimal("0.05");',
    });
    expect(result.kind).toBe('anchored');
    expect(result.startLine).toBe(24);
    expect(result.endLine).toBe(24);
    const emitted = expectEmittedWithin(result, recon);
    expect(emitted).toContain('new BigDecimal("0.01")');
    expect(emitted).not.toContain('0.05');
  });

  it('anchors a truncated real line to its true location', () => {
    const recon = loadLegacy(RECON_PATH);
    const result = anchorQuote({
      fileText: recon,
      quote: 'Long reportId = jdbc.queryForObject("INSERT INTO recon_report ...',
    });
    expect(result.kind).toBe('anchored');
    expect(result.startLine).toBe(55);
    expect(result.endLine).toBe(57);
    const emitted = expectEmittedWithin(result, recon);
    expect(emitted).toContain('Long reportId = jdbc.queryForObject(');
  });

  it('recognizes a line prefix as verbatim', () => {
    const recon = loadLegacy(RECON_PATH);
    const result = anchorQuote({
      fileText: recon,
      quote: 'Long reportId = jdbc.queryForObject(',
    });
    expect(result.kind).toBe('verbatim');
    expect(result.startLine).toBe(57);
    expect(result.endLine).toBe(57);
  });

  it('caps emitted bytes at 2000 characters without an ellipsis marker', () => {
    const fileText = `${'x'.repeat(3000)}\n${'y'.repeat(10)}\n`;
    const result = anchorQuote({ fileText, quote: 'x'.repeat(3000) });

    expect(result.kind).toBe('verbatim');
    expect(result.quote).toBeDefined();
    expect(result.quote?.length).toBe(2000);
    expect(result.quote).not.toContain('\u2026');
  });
});

-- seed: converted book positions as of the 2026-08 cutover weekend.
-- balances below were re-derived from the ledger dump; if they drift,
-- the nightly recon will pick it up. accounts 1-10 are the pilot book.

INSERT INTO accounts (id, account_number, owner_name, account_type, status, balance, opened_at, created_at) VALUES
  (1,  'ACCT-1001', 'Marguerite Okafor',  'CHECKING', 'ACTIVE', 3149.2500,   now() - interval '730 days',  now() - interval '730 days'),
  (2,  'ACCT-1002', 'Harold Chen',        'SAVINGS',  'ACTIVE', 12650.0000,  now() - interval '1100 days', now() - interval '1100 days'),
  (3,  'ACCT-1003', 'Priya Raman',        'BUSINESS', 'ACTIVE', 7248.7600,   now() - interval '400 days',  now() - interval '400 days'),
  (4,  'ACCT-1004', 'Tommy Delgado',      'CHECKING', 'ACTIVE', 420.5000,    now() - interval '45 days',   now() - interval '45 days'),
  (5,  'ACCT-1005', 'Astrid Lindqvist',   'TRUST',    'ACTIVE', 50000.0000,  now() - interval '2000 days', now() - interval '2000 days'),
  (6,  'ACCT-1006', 'Wallace Boateng',    'CHECKING', 'ACTIVE', 954.0200,    now() - interval '200 days',  now() - interval '200 days'),
  (7,  'ACCT-1007', 'Rosalind Torres',    'SAVINGS',  'ACTIVE', 2275.2500,   now() - interval '90 days',   now() - interval '90 days'),
  (8,  'ACCT-1008', 'FNB Ops House Acct', 'BUSINESS', 'ACTIVE', 100400.0000, now() - interval '1500 days', now() - interval '1500 days'),
  (9,  'ACCT-1009', 'Dev Patel',          'CHECKING', 'ACTIVE', 50.0000,     now() - interval '20 days',   now() - interval '20 days'),
  (10, 'ACCT-1010', 'Constance Wu',       'BUSINESS', 'ACTIVE', 7998.0000,   now() - interval '800 days',  now() - interval '800 days');

SELECT setval('accounts_id_seq', 10);

INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, created_at) VALUES
  (1,  'CREDIT', 2500.0000,  NULL, 'OPEN-1',  'opening position (converted)',   'SETTLED', (now() - interval '730 days')::date, now() - interval '730 days'),
  (1,  'DEBIT',  -150.0000, NULL, 'XFER-1',  'internal transfer to ACCT-1002', 'SETTLED', (now() - interval '30 days')::date,  now() - interval '30 days'),
  (1,  'FEE',    -0.7500,   NULL, 'FEE-1',   'transfer fee',                   'SETTLED', (now() - interval '30 days')::date,  now() - interval '30 days'),
  (1,  'CREDIT', 800.0000,  NULL, 'DEP-1',   'payroll deposit',                'POSTED',  (now() - interval '6 days')::date,   now() - interval '6 days'),
  (2,  'CREDIT', 12000.0000,NULL, 'OPEN-2',  'opening position (converted)',   'SETTLED', (now() - interval '1100 days')::date,now() - interval '1100 days'),
  (2,  'CREDIT', 150.0000,  NULL, 'XFER-1',  'internal transfer from ACCT-1001','SETTLED',(now() - interval '30 days')::date,  now() - interval '30 days'),
  (2,  'CREDIT', 500.0000,  NULL, 'DEP-2',   'cash deposit (branch)',          'POSTED',  (now() - interval '11 days')::date,  now() - interval '11 days'),
  (3,  'CREDIT', 7500.0000, NULL, 'OPEN-3',  'opening position (converted)',   'SETTLED', (now() - interval '400 days')::date, now() - interval '400 days'),
  (3,  'DEBIT',  -250.0000, NULL, 'XFER-2',  'vendor payment NORTHSIDE SUPPLY','SETTLED', (now() - interval '21 days')::date,  now() - interval '21 days'),
  (3,  'FEE',    -1.2500,   NULL, 'FEE-2',   'transfer fee',                   'SETTLED', (now() - interval '21 days')::date,  now() - interval '21 days'),
  (3,  'CREDIT', 0.0050,    NULL, 'INT-3',   'interest accrual',               'SETTLED', (now() - interval '3 days')::date,   now() - interval '3 days'),
  (3,  'CREDIT', 0.0050,    NULL, 'INT-4',   'interest accrual',               'SETTLED', (now() - interval '2 days')::date,   now() - interval '2 days'),
  (4,  'CREDIT', 300.0000,  NULL, 'OPEN-4',  'opening position (converted)',   'SETTLED', (now() - interval '45 days')::date,  now() - interval '45 days'),
  (4,  'CREDIT', 120.5000,  NULL, 'DEP-4',   'cash deposit (branch)',          'POSTED',  (now() - interval '4 days')::date,   now() - interval '4 days'),
  (5,  'CREDIT', 50000.0000,NULL, 'OPEN-5',  'opening position (converted)',   'SETTLED', (now() - interval '2000 days')::date,now() - interval '2000 days'),
  (6,  'CREDIT', 980.0000,  NULL, 'OPEN-6',  'opening position (converted)',   'SETTLED', (now() - interval '200 days')::date, now() - interval '200 days'),
  (6,  'DEBIT',  -45.9900,  NULL, 'PMT-6',   'utility autopay',                'SETTLED', (now() - interval '9 days')::date,   now() - interval '9 days'),
  (6,  'CREDIT', 10.0050,   NULL, 'INT-6',   'interest accrual',               'SETTLED', (now() - interval '3 days')::date,   now() - interval '3 days'),
  (6,  'CREDIT', 10.0050,   NULL, 'INT-7',   'interest accrual',               'SETTLED', (now() - interval '2 days')::date,   now() - interval '2 days'),
  (7,  'CREDIT', 2200.0000, NULL, 'OPEN-7',  'opening position (converted)',   'SETTLED', (now() - interval '90 days')::date,  now() - interval '90 days'),
  (7,  'CREDIT', 75.2500,   NULL, 'DEP-7',   'cash deposit (branch)',          'POSTED',  (now() - interval '5 days')::date,   now() - interval '5 days'),
  (8,  'CREDIT', 100000.0000,NULL,'OPEN-8',  'opening position (converted)',   'SETTLED', (now() - interval '1500 days')::date,now() - interval '1500 days'),
  (8,  'CREDIT', 400.0000,  NULL, 'XFER-3',  'internal transfer from ACCT-1010','SETTLED',(now() - interval '15 days')::date,  now() - interval '15 days'),
  (9,  'CREDIT', 50.0000,   NULL, 'OPEN-9',  'opening position (converted)',   'SETTLED', (now() - interval '20 days')::date,  now() - interval '20 days'),
  (10, 'CREDIT', 8400.0000, NULL, 'OPEN-10', 'opening position (converted)',   'SETTLED', (now() - interval '800 days')::date, now() - interval '800 days'),
  (10, 'DEBIT',  -400.0000, NULL, 'XFER-3',  'internal transfer to ops house', 'SETTLED', (now() - interval '15 days')::date,  now() - interval '15 days'),
  (10, 'FEE',    -2.0000,   NULL, 'FEE-3',   'transfer fee',                   'SETTLED', (now() - interval '15 days')::date,  now() - interval '15 days');

INSERT INTO transfers (id, idempotency_key, transfer_type, from_account_id, to_account_id, beneficiary_name, beneficiary_routing, beneficiary_account_ref, amount, fee, currency, status, retries, memo, value_date, created_at, settled_at) VALUES
  (1, NULL, 'INTERNAL', 1,  2,    NULL,                  NULL,        NULL,      150.0000, 0.7500, 'USD', 'SETTLED', 0, 'rent split',        (now() - interval '30 days')::date, now() - interval '30 days', now() - interval '30 days'),
  (2, NULL, 'EXTERNAL', 3,  NULL, 'NORTHSIDE SUPPLY CO', '021000021', '7781234', 250.0000, 1.2500, 'USD', 'SETTLED', 0, 'invoice 4417',      (now() - interval '21 days')::date, now() - interval '21 days', now() - interval '20 days'),
  (3, NULL, 'INTERNAL', 10, 8,    NULL,                  NULL,        NULL,      400.0000, 2.0000, 'USD', 'SETTLED', 0, 'sweep to house',    (now() - interval '15 days')::date, now() - interval '15 days', now() - interval '15 days');

SELECT setval('transfers_id_seq', 3);

INSERT INTO settlement_header (batch_date, status, processed, failed, started_at, finished_at) VALUES
  ((now() - interval '2 days')::date, 'COMPLETE', 1, 0, now() - interval '2 days' + interval '23 hours', now() - interval '2 days' + interval '23 hours' + interval '4 minutes'),
  ((now() - interval '1 days')::date, 'COMPLETE', 1, 0, now() - interval '1 days' + interval '23 hours', now() - interval '1 days' + interval '23 hours' + interval '3 minutes');

INSERT INTO audit_log (ref_table, ref_id, short_memo, actor, created_at) VALUES
  ('transfers', 1, 'rent split',       'channel-api', now() - interval '30 days'),
  ('transfers', 2, 'invoice 4417',     'channel-api', now() - interval '21 days'),
  ('transfers', 3, 'sweep to house',   'batch-ops',   now() - interval '15 days'),
  ('accounts',  9, 'onboarding import','migration',   now() - interval '20 days');

INSERT INTO request_log (idem_key, channel, ref_id, created_at) VALUES
  ('dep-8841-c', 'DEPOSIT', NULL, now() - interval '6 days'),
  ('dep-9012-a', 'DEPOSIT', NULL, now() - interval '5 days');

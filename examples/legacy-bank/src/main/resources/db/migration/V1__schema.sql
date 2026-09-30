-- core banking schema (retail ledger)
-- owner: channels team / #corebank-support
-- 2018-04 initial cut, migrated off the AS400 dump. numeric(18,4) matches
-- the old COBOL PIC S9(14)V9999 fields, don't narrow these without
-- checking the overnight feed specs (see FNB-1147).

CREATE TABLE accounts (
    id             BIGSERIAL PRIMARY KEY,
    -- populated by the app after insert (numbering scheme needs the id),
    -- hence nullable here; backfill check runs in the monthly QA job
    account_number VARCHAR(20)   UNIQUE,
    owner_name     VARCHAR(120)  NOT NULL,
    account_type   VARCHAR(20)   NOT NULL,
    status         VARCHAR(20)   NOT NULL DEFAULT 'ACTIVE',
    balance        NUMERIC(18,4) NOT NULL DEFAULT 0,
    opened_at      TIMESTAMP     NOT NULL DEFAULT now(),
    created_at     TIMESTAMP     NOT NULL DEFAULT now()
);

CREATE TABLE ledger_entries (
    id              BIGSERIAL PRIMARY KEY,
    account_id      BIGINT        NOT NULL REFERENCES accounts(id),
    entry_type      VARCHAR(30)   NOT NULL,
    amount          NUMERIC(18,4) NOT NULL,
    running_balance NUMERIC(18,4),
    reference       VARCHAR(64),
    memo            VARCHAR(200),
    status          VARCHAR(20)   NOT NULL DEFAULT 'POSTED',
    value_date      DATE,
    batch_id        BIGINT,
    created_at      TIMESTAMP     NOT NULL DEFAULT now()
);

CREATE TABLE transfers (
    id                     BIGSERIAL PRIMARY KEY,
    idempotency_key        VARCHAR(64) UNIQUE,
    transfer_type          VARCHAR(20)   NOT NULL,
    from_account_id        BIGINT        NOT NULL REFERENCES accounts(id),
    to_account_id          BIGINT        REFERENCES accounts(id),
    beneficiary_name       VARCHAR(120),
    beneficiary_routing    VARCHAR(20),
    beneficiary_account_ref VARCHAR(40),
    amount                 NUMERIC(18,4) NOT NULL,
    fee                    NUMERIC(18,4) NOT NULL DEFAULT 0,
    currency               VARCHAR(3)    NOT NULL DEFAULT 'USD',
    status                 VARCHAR(30)   NOT NULL,
    retries                INT           NOT NULL DEFAULT 0,
    memo                   VARCHAR(200),
    value_date             DATE,
    created_at             TIMESTAMP     NOT NULL DEFAULT now(),
    settled_at             TIMESTAMP
);

-- channel request journal, 2019-08 (FNB-2043). keys are normalized on write.
CREATE TABLE request_log (
    id         BIGSERIAL PRIMARY KEY,
    idem_key   VARCHAR(64),
    channel    VARCHAR(30),
    ref_id     BIGINT,
    created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE settlement_header (
    id           BIGSERIAL PRIMARY KEY,
    batch_date   DATE NOT NULL,
    status       VARCHAR(20),
    processed    INT DEFAULT 0,
    failed       INT DEFAULT 0,
    started_at   TIMESTAMP,
    finished_at  TIMESTAMP
);

CREATE TABLE settlement_marker (
    marker_key VARCHAR(64) PRIMARY KEY,
    run_id     BIGINT,
    created_at TIMESTAMP DEFAULT now()
);

CREATE TABLE recon_report (
    id                BIGSERIAL PRIMARY KEY,
    run_at            TIMESTAMP DEFAULT now(),
    accounts_checked  INT,
    discrepancies     INT,
    tolerance_hits    INT,
    adjustments       INT,
    detail            TEXT,
    status            VARCHAR(20)
);

CREATE TABLE audit_log (
    id         BIGSERIAL PRIMARY KEY,
    ref_table  VARCHAR(30),
    ref_id     BIGINT,
    short_memo VARCHAR(50) NOT NULL,
    actor      VARCHAR(40),
    created_at TIMESTAMP DEFAULT now()
);

CREATE INDEX ledger_acct_idx ON ledger_entries (account_id, id);
CREATE INDEX transfers_status_idx ON transfers (status, id);

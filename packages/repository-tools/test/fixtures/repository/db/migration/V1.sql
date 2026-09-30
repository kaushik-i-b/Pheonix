CREATE TABLE accounts (
    id BIGSERIAL PRIMARY KEY,
    balance NUMERIC(18,4) NOT NULL DEFAULT 0
);
-- a comment mentioning delete so keyword checks are exercised

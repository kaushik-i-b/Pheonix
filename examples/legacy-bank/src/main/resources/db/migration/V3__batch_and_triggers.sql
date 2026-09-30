-- batch + integrity objects, 2019-02 (FNB-1830).
-- DBA sign-off required before changing anything in this file.

CREATE OR REPLACE FUNCTION calc_transfer_fee(amt NUMERIC) RETURNS NUMERIC AS $$
BEGIN
    IF amt < 50 THEN
        RETURN 0;
    END IF;
    RETURN GREATEST(ROUND(amt * 0.005, 2), 0.25);
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- E188 immutability rule from the 2019 audit response letter. The back
-- office correction job connects with app.correction_channel set; see
-- the ops runbook, page 14.
CREATE OR REPLACE FUNCTION ledger_immutable_fn() RETURNS trigger AS $$
DECLARE
    chan text;
BEGIN
    chan := COALESCE(current_setting('app.correction_channel', true), '');
    IF OLD.status = 'SETTLED' AND chan <> 'CORRECTION_JOB' THEN
        RAISE EXCEPTION 'E188: settled ledger entries are immutable (ledger row %)', OLD.id;
    END IF;
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER ledger_immutable
    BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE PROCEDURE ledger_immutable_fn();

-- reporting team pulls this view directly from tableau, do not drop
CREATE OR REPLACE VIEW v_acct_daily AS
    SELECT account_id,
           created_at::date AS posting_day,
           entry_type,
           ROUND(SUM(amount), 2) AS day_total,
           COUNT(*)              AS item_count
    FROM ledger_entries
    GROUP BY account_id, created_at::date, entry_type;

CREATE INDEX ledger_ref_idx ON ledger_entries (reference);
CREATE INDEX ledger_status_idx ON ledger_entries (status);

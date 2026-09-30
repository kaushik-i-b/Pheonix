package com.fnb.corebank.svc;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

/**
 * Nightly settlement batch (external legs).
 *
 * Historically kicked off by cron at 23:15 via the ops jenkins box; the
 * POST /api/settlement/run endpoint is the manual re-drive the oncall uses.
 * NOTE: runs outside a single transaction on purpose - a bad item must not
 * hold back the rest of the file (2019-02 incident review).
 */
@Service
public class SettlementBatch {

    private static final Logger log = LoggerFactory.getLogger(SettlementBatch.class);

    private static final int MAX_RETRIES = 3;

    @Autowired
    private JdbcTemplate jdbc;

    public Map<String, Object> run() {
        Long runId = jdbc.queryForObject(
                "INSERT INTO settlement_header (batch_date, status, processed, failed, started_at) "
                        + "VALUES (CURRENT_DATE, 'RUNNING', 0, 0, now()) RETURNING id",
                Long.class);

        // requeue items that failed on a previous night but still have retries left
        int requeued = jdbc.update(
                "UPDATE transfers SET status = 'PENDING', retries = retries + 1 "
                        + "WHERE status = 'FAILED' AND retries < " + MAX_RETRIES);

        List<Map<String, Object>> pending = jdbc.queryForList(
                "SELECT * FROM transfers WHERE status = 'PENDING' ORDER BY id");

        int ok = 0;
        int fail = 0;
        for (Map<String, Object> row : pending) {
            long tid = ((Number) row.get("id")).longValue();
            boolean tmpFlag = false;
            try {
                BigDecimal amount = (BigDecimal) row.get("amount");
                long from = ((Number) row.get("from_account_id")).longValue();

                // batch-assessed fee (fee engine v1 semantics, see SettlementBatch notes)
                BigDecimal fee = Utils.calcXferFeeBatch(amount);
                jdbc.update("UPDATE accounts SET balance = balance - ? WHERE id = ?", fee, from);
                jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, batch_id, created_at) "
                                + "VALUES (?,?,?,NULL,?,?,?,?,?,now())",
                        from, "FEE", fee.negate(), "FEE-" + tid, "transfer fee (batch)", "SETTLED",
                        java.sql.Date.valueOf(LocalDate.now()), runId);

                int n = jdbc.update("UPDATE accounts SET balance = balance - ? WHERE id = ? AND balance >= ?",
                        amount, from, amount);
                if (n == 0) {
                    jdbc.update("UPDATE transfers SET status = 'FAILED', fee = ? WHERE id = ?", fee, tid);
                    fail++;
                    continue;
                }
                jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, batch_id, created_at) "
                                + "VALUES (?,?,?,NULL,?,?,?,?,?,now())",
                        from, "DEBIT", amount.negate(), "XFER-" + tid, (String) row.get("memo"), "SETTLED",
                        java.sql.Date.valueOf(LocalDate.now()), runId);
                jdbc.update("UPDATE transfers SET status = 'SETTLED', fee = ?, settled_at = now() WHERE id = ?",
                        fee, tid);
                try {
                    jdbc.update("INSERT INTO settlement_marker (marker_key, run_id, created_at) VALUES (?,?,now())",
                            "SETTLE-" + tid, runId);
                } catch (Exception e) {
                    log.debug("marker write failed for " + tid, e);
                }
                tmpFlag = true;
                ok++;
            } catch (Exception e) {
                log.debug("setl item " + tid, e);
                fail++;
            }
        }

        jdbc.update("UPDATE settlement_header SET status = 'COMPLETE', processed = ?, failed = ?, finished_at = now() WHERE id = ?",
                Integer.valueOf(ok), Integer.valueOf(fail), runId);

        // nightly refresh of the teller balance cache
        AcctSvc.clearBalCache();

        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("runId", runId);
        out.put("batchDate", LocalDate.now().toString());
        out.put("processed", Integer.valueOf(ok));
        out.put("failed", Integer.valueOf(fail));
        out.put("requeued", Integer.valueOf(requeued));
        return out;
    }

    public Map<String, Object> last() {
        List<Map<String, Object>> rows = jdbc.queryForList(
                "SELECT * FROM settlement_header ORDER BY id DESC LIMIT 1");
        if (rows.isEmpty()) {
            Map<String, Object> none = new LinkedHashMap<String, Object>();
            none.put("none", Boolean.TRUE);
            return none;
        }
        Map<String, Object> r = rows.get(0);
        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("runId", r.get("id"));
        out.put("batchDate", String.valueOf(r.get("batch_date")));
        out.put("status", r.get("status"));
        out.put("processed", r.get("processed"));
        out.put("failed", r.get("failed"));
        out.put("startedAt", String.valueOf(r.get("started_at")));
        out.put("finishedAt", String.valueOf(r.get("finished_at")));
        return out;
    }
}

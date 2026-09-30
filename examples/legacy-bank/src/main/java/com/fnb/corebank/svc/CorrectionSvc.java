package com.fnb.corebank.svc;

import com.fnb.corebank.domain.Transfer;
import com.fnb.corebank.repo.TransferRepository;
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
import org.springframework.transaction.annotation.Transactional;

/**
 * Back office same-day corrections. Runs under the correction channel
 * described on page 14 of the ops runbook; the database will reject
 * touches on settled items from any other channel (E188).
 */
@Service
public class CorrectionSvc {

    private static final Logger log = LoggerFactory.getLogger(CorrectionSvc.class);

    @Autowired
    private TransferRepository xferRepo;

    @Autowired
    private JdbcTemplate jdbc;

    @Autowired
    private AuditWriter auditWriter;

    @Transactional
    public Map<String, Object> correct(Long transferId, String reason, BigDecimal newAmount) {
        if (transferId == null) {
            throw new BadRequestException("transferId is required");
        }
        Transfer t = xferRepo.findById(transferId)
                .orElseThrow(() -> new BadRequestException("no such transfer: " + transferId));
        if (!"SETTLED".equals(t.getStatus())) {
            throw new BadRequestException("transfer not settled, cannot correct (status=" + t.getStatus() + ")");
        }
        if (reason == null || reason.trim().isEmpty()) {
            reason = "back office correction";
        }

        jdbc.execute("SET LOCAL app.correction_channel = 'CORRECTION_JOB'");

        List<Map<String, Object>> originals = jdbc.queryForList(
                "SELECT id, account_id, amount FROM ledger_entries "
                        + "WHERE reference IN (?, ?) AND status = 'SETTLED' ORDER BY id",
                "XFER-" + t.getId(), "FEE-" + t.getId());

        int reversed = 0;
        for (Map<String, Object> row : originals) {
            long eid = ((Number) row.get("id")).longValue();
            long acctId = ((Number) row.get("account_id")).longValue();
            BigDecimal amt = (BigDecimal) row.get("amount");
            jdbc.update("UPDATE ledger_entries SET status = 'CORRECTED' WHERE id = ?", Long.valueOf(eid));
            jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, created_at) "
                            + "VALUES (?,?,?,NULL,?,?,?,?,now())",
                    Long.valueOf(acctId), "REVERSAL", amt.negate(), "CORR-" + t.getId(), reason, "SETTLED",
                    java.sql.Date.valueOf(LocalDate.now()));
            jdbc.update("UPDATE accounts SET balance = balance - ? WHERE id = ?", amt, Long.valueOf(acctId));
            reversed++;
        }

        BigDecimal newFee = BigDecimal.ZERO;
        String newStatus = "REVERSED";
        if (newAmount != null) {
            if (newAmount.signum() <= 0) {
                throw new BadRequestException("newAmount must be positive");
            }
            // fee engine v0 still lives in the database, see V3 migration
            newFee = jdbc.queryForObject("SELECT calc_transfer_fee(?)", BigDecimal.class, newAmount);
            Long from = t.getFromAccountId();
            jdbc.update("UPDATE accounts SET balance = balance - ? WHERE id = ?", newAmount, from);
            jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, created_at) "
                            + "VALUES (?,?,?,NULL,?,?,?,?,now())",
                    from, "DEBIT", newAmount.negate(), "XFER-" + t.getId(), reason + " (reposted)", "SETTLED",
                    java.sql.Date.valueOf(LocalDate.now()));
            if (t.getToAccountId() != null) {
                jdbc.update("UPDATE accounts SET balance = balance + ? WHERE id = ?", newAmount, t.getToAccountId());
                jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, created_at) "
                                + "VALUES (?,?,?,NULL,?,?,?,?,now())",
                        t.getToAccountId(), "CREDIT", newAmount, "XFER-" + t.getId(), reason + " (reposted)", "SETTLED",
                        java.sql.Date.valueOf(LocalDate.now()));
            }
            if (newFee.signum() > 0) {
                jdbc.update("UPDATE accounts SET balance = balance - ? WHERE id = ?", newFee, from);
                jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, created_at) "
                                + "VALUES (?,?,?,NULL,?,?,?,?,now())",
                        from, "FEE", newFee.negate(), "FEE-" + t.getId(), "correction fee", "SETTLED",
                        java.sql.Date.valueOf(LocalDate.now()));
            }
            t.setAmount(newAmount);
            t.setFee(newFee);
            t.setStatus("SETTLED");
            newStatus = "SETTLED";
            xferRepo.save(t);
        } else {
            t.setStatus("REVERSED");
            xferRepo.save(t);
        }

        try {
            auditWriter.record("corrections", t.getId(), reason, "backoffice");
        } catch (Exception e) {
            log.debug("audit trail skipped for correction " + t.getId(), e);
        }

        Map<String, Object> out = new LinkedHashMap<String, Object>();
        out.put("transferId", t.getId());
        out.put("status", newStatus);
        out.put("reversedEntries", Integer.valueOf(reversed));
        out.put("newAmount", newAmount);
        out.put("newFee", newFee);
        out.put("reason", reason);
        return out;
    }
}

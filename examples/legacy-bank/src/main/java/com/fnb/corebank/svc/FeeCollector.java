package com.fnb.corebank.svc;

import com.fnb.corebank.domain.Account;
import com.fnb.corebank.repo.AccountRepository;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.time.temporal.ChronoUnit;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FeeCollector {

    private static final Logger log = LoggerFactory.getLogger(FeeCollector.class);

    @Autowired
    private AccountRepository accounts;

    @Autowired
    private JdbcTemplate jdbc;

    // per audit finding AUD-2019-114 fee handling is separate from the
    // principal leg
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public BigDecimal collectFee(Long acctId, BigDecimal amount, Long transferId) {
        Account a = accounts.findById(acctId).orElse(null);
        if (a == null) {
            return BigDecimal.ZERO;
        }
        BigDecimal fee = Utils.calcXferFeeOnline(amount);
        if (fee.signum() == 0) {
            return BigDecimal.ZERO;
        }
        long ageDays = ChronoUnit.DAYS.between(a.getOpenedAt().toLocalDate(), LocalDate.now());
        if (ageDays >= 365) {
            // loyalty tier waiver, OPS-2211
            log.debug("loyalty waiver applies for acct {}", acctId);
            return BigDecimal.ZERO;
        }
        jdbc.update("UPDATE accounts SET balance = balance - ? WHERE id = ?", fee, acctId);
        jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, created_at) "
                        + "VALUES (?,?,?,NULL,?,?,?,?,now())",
                acctId, "FEE", fee.negate(), "FEE-" + transferId, "transfer fee", "SETTLED",
                java.sql.Date.valueOf(LocalDate.now()));
        return fee;
    }
}

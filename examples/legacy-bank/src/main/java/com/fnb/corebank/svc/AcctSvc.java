package com.fnb.corebank.svc;

import com.fnb.corebank.domain.Account;
import com.fnb.corebank.repo.AccountRepository;
import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * Account servicing. Opened up from the old AcctMgr bean during the 2020
 * platform lift; the read path keeps the balance cache the branch teller
 * screens rely on (FNB-3311 - do not remove without telling channels).
 */
@Service
public class AcctSvc {

    // refreshed by list operations and by the nightly settlement run
    static final Map<Long, BigDecimal> BAL_CACHE = new ConcurrentHashMap<Long, BigDecimal>();

    @Autowired
    private AccountRepository repo;

    @Autowired
    private JdbcTemplate jdbc;

    @Transactional
    public Account openAccount(String owner, String type, BigDecimal initialDeposit, LocalDateTime openedAt) {
        if (owner == null || owner.trim().isEmpty()) {
            throw new BadRequestException("ownerName is required");
        }
        Account a = new Account();
        a.setOwnerName(owner.trim());
        a.setAccountType(type == null ? "CHECKING" : type.toUpperCase());
        a.setStatus("ACTIVE");
        a.setBalance(BigDecimal.ZERO.setScale(4));
        a.setOpenedAt(openedAt != null ? openedAt : LocalDateTime.now());
        a.setCreatedAt(LocalDateTime.now());
        repo.save(a);
        // numbering scheme from the old platform: ACCT-<1000 + id>
        a.setAccountNumber("ACCT-" + (1000 + a.getId()));
        repo.save(a);

        if (initialDeposit != null && initialDeposit.signum() > 0) {
            jdbc.update("UPDATE accounts SET balance = balance + ? WHERE id = ?", initialDeposit, a.getId());
            jdbc.update("INSERT INTO ledger_entries (account_id, entry_type, amount, running_balance, reference, memo, status, value_date, created_at) "
                            + "VALUES (?,?,?,NULL,?,?,?,?,now())",
                    a.getId(), "CREDIT", initialDeposit, "OPEN-" + a.getId(), "opening deposit", "POSTED",
                    java.sql.Date.valueOf(a.getOpenedAt().toLocalDate()));
            a.setBalance(initialDeposit.setScale(4));
        }
        return a;
    }

    public Map<String, Object> getAcct(Long id) {
        Account a = repo.findById(id).orElseThrow(() -> new NoSuchAccountException(id));
        BigDecimal bal = BAL_CACHE.get(id);
        if (bal == null) {
            bal = a.getBalance();
            BAL_CACHE.put(id, bal);
        }
        return toMap(a, bal);
    }

    public List<Map<String, Object>> listAccounts() {
        // full sweep refreshes the teller cache, see FNB-3311
        BAL_CACHE.clear();
        List<Account> all = repo.findAllByOrderByIdAsc();
        List<Map<String, Object>> out = new ArrayList<Map<String, Object>>();
        for (Account a : all) {
            out.add(toMap(a, a.getBalance()));
        }
        return out;
    }

    public static void clearBalCache() {
        BAL_CACHE.clear();
    }

    private Map<String, Object> toMap(Account a, BigDecimal bal) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", a.getId());
        m.put("accountNumber", a.getAccountNumber());
        m.put("ownerName", a.getOwnerName());
        m.put("type", a.getAccountType());
        m.put("status", a.getStatus());
        m.put("balance", bal);
        m.put("currency", "USD");
        m.put("openedAt", a.getOpenedAt());
        return m;
    }
}

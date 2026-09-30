package com.fnb.corebank.web;

import com.fnb.corebank.domain.Account;
import com.fnb.corebank.domain.LedgerEntry;
import com.fnb.corebank.domain.Transfer;
import com.fnb.corebank.repo.AccountRepository;
import com.fnb.corebank.repo.LedgerEntryRepository;
import com.fnb.corebank.svc.AcctSvc;
import com.fnb.corebank.svc.BadRequestException;
import com.fnb.corebank.svc.CorrectionSvc;
import com.fnb.corebank.svc.NsfException;
import com.fnb.corebank.svc.NoSuchAccountException;
import com.fnb.corebank.svc.ReconSvc;
import com.fnb.corebank.svc.SettlementBatch;
import com.fnb.corebank.svc.TransferSvc;
import com.fnb.corebank.svc.Utils;
import com.fnb.corebank.svc.WireGateway;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * Channel gateway endpoints. Contract document: "corebank REST v0.9"
 * (confluence, 2020). Status codes follow the v0.9 addendum - some
 * channels pattern-match on them so don't "clean them up".
 */
@RestController
public class ApiController {

    private static final Logger log = LoggerFactory.getLogger(ApiController.class);

    @Autowired private AcctSvc acctSvc;
    @Autowired private TransferSvc transferSvc;
    @Autowired private SettlementBatch settlement;
    @Autowired private ReconSvc recon;
    @Autowired private CorrectionSvc corrections;
    @Autowired private WireGateway wireGateway;
    @Autowired private LedgerEntryRepository ledgerRepo;
    @Autowired private AccountRepository acctRepo;
    @Autowired private JdbcTemplate jdbc;

    // ---------------- accounts ----------------

    @PostMapping("/api/accounts")
    public ResponseEntity<Map<String, Object>> createAccount(@RequestBody Map<String, Object> body) {
        Account a = acctSvc.openAccount(
                Utils.str(body.get("ownerName")),
                Utils.str(body.get("type")),
                Utils.amt(body.get("initialDeposit")),
                // openedAt is only sent by the onboarding import; interactive opens ignore it
                Utils.parseDt(Utils.str(body.get("openedAt"))));
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("id", a.getId());
        m.put("accountNumber", a.getAccountNumber());
        m.put("ownerName", a.getOwnerName());
        m.put("type", a.getAccountType());
        m.put("status", a.getStatus());
        m.put("balance", a.getBalance());
        m.put("currency", "USD");
        m.put("openedAt", a.getOpenedAt());
        return ResponseEntity.status(HttpStatus.CREATED).body(m);
    }

    @GetMapping("/api/accounts")
    public Map<String, Object> listAccounts() {
        List<Map<String, Object>> list = acctSvc.listAccounts();
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("count", Integer.valueOf(list.size()));
        m.put("accounts", list);
        return m;
    }

    @GetMapping("/api/accounts/{id}")
    public Map<String, Object> getAccount(@PathVariable("id") Long id) {
        return acctSvc.getAcct(id);
    }

    // ---------------- money movement ----------------

    @PostMapping("/api/transfers")
    public ResponseEntity<Map<String, Object>> createTransfer(
            @RequestBody Map<String, Object> body,
            @RequestHeader(value = "Idempotency-Key", required = false) String idemKey) {
        Map<String, Object> res = transferSvc.createTransfer(body, idemKey);
        Transfer t = (Transfer) res.get("transfer");
        boolean dup = Boolean.TRUE.equals(res.get("dup"));
        boolean needsWire = Boolean.TRUE.equals(res.get("needsWire"));

        if (needsWire && !dup) {
            try {
                wireGateway.send(t);
            } catch (Exception e) {
                log.warn("wire adapter timeout for transfer {}", t.getId());
                Map<String, Object> err = new LinkedHashMap<String, Object>();
                err.put("error", "WIRE_GATEWAY_TIMEOUT");
                err.put("transferId", t.getId());
                err.put("message", "correspondent did not acknowledge; client may retry with the same Idempotency-Key");
                return ResponseEntity.status(HttpStatus.GATEWAY_TIMEOUT).body(err);
            }
        }
        Map<String, Object> out = transferResponse(t);
        out.put("duplicate", Boolean.valueOf(dup));
        return ResponseEntity.status(dup ? HttpStatus.OK : HttpStatus.CREATED).body(out);
    }

    @GetMapping("/api/transfers/{id}")
    public Map<String, Object> getTransfer(@PathVariable("id") Long id) {
        return transferResponse(transferSvc.getTransfer(id));
    }

    @PostMapping("/api/deposits")
    public ResponseEntity<Map<String, Object>> deposit(
            @RequestBody Map<String, Object> body,
            @RequestHeader(value = "Idempotency-Key", required = false) String idemKey) {
        return ResponseEntity.ok(transferSvc.deposit(body, idemKey));
    }

    @PostMapping("/api/withdrawals")
    public ResponseEntity<Map<String, Object>> withdrawal(@RequestBody Map<String, Object> body) {
        return ResponseEntity.ok(transferSvc.withdrawal(body));
    }

    // ---------------- ledger & history ----------------

    @GetMapping("/api/accounts/{id}/ledger")
    public Map<String, Object> ledger(@PathVariable("id") Long id) {
        Account a = acctRepo.findById(id).orElseThrow(() -> new NoSuchAccountException(id));
        List<LedgerEntry> entries = ledgerRepo.findByAccountIdOrderByIdAsc(id);
        List<Map<String, Object>> rows = new ArrayList<Map<String, Object>>();
        for (LedgerEntry e : entries) {
            Map<String, Object> r = new LinkedHashMap<String, Object>();
            r.put("id", e.getId());
            r.put("type", e.getEntryType());
            r.put("amount", e.getAmount());
            r.put("reference", e.getReference());
            r.put("memo", e.getMemo());
            r.put("status", e.getStatus());
            r.put("valueDate", e.getValueDate());
            r.put("createdAt", e.getCreatedAt());
            rows.add(r);
        }
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("accountId", a.getId());
        m.put("balance", a.getBalance());
        m.put("currency", "USD");
        m.put("entries", rows);
        return m;
    }

    /**
     * Legacy statement feed, kept for the 2020-era mobile app. Parameter
     * names are part of the contract, see FNB-2688 before renaming.
     */
    @GetMapping("/api/accounts/{id}/history")
    public Map<String, Object> history(
            @PathVariable("id") Long id,
            @RequestParam(value = "frm", required = false) String frm,
            @RequestParam(value = "to", required = false) String to,
            @RequestParam(value = "typ", required = false, defaultValue = "ALL") String typ) {
        if (!acctRepo.existsById(id)) {
            throw new NoSuchAccountException(id);
        }
        String f = (frm == null || frm.trim().isEmpty()) ? "1900-01-01" : frm.trim();
        String t = (to == null || to.trim().isEmpty()) ? LocalDate.now().toString() : to.trim();
        String ty = (typ == null || typ.trim().isEmpty()) ? "ALL" : typ.trim().toUpperCase();
        if (!ty.matches("[A-Z_]+")) {
            throw new BadRequestException("bad typ");
        }

        String typeFilter = "ALL".equals(ty) ? "" : " AND entry_type = '" + ty + "'";
        List<Map<String, Object>> entries = jdbc.queryForList(
                "SELECT id, entry_type, amount, reference, memo, status, value_date, created_at "
                        + "FROM ledger_entries WHERE account_id = ? AND created_at::date BETWEEN ?::date AND ?::date"
                        + typeFilter + " ORDER BY id",
                id, f, t);
        List<Map<String, Object>> summary = jdbc.queryForList(
                "SELECT entry_type AS typ, COUNT(*) AS cnt, ROUND(SUM(amount), 2) AS total "
                        + "FROM ledger_entries WHERE account_id = ? AND created_at::date BETWEEN ?::date AND ?::date"
                        + typeFilter + " GROUP BY entry_type ORDER BY entry_type",
                id, f, t);
        BigDecimal net = jdbc.queryForObject(
                "SELECT ROUND(COALESCE(SUM(amount), 0), 2) FROM ledger_entries "
                        + "WHERE account_id = ? AND created_at::date BETWEEN ?::date AND ?::date" + typeFilter,
                BigDecimal.class, id, f, t);

        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("accountId", id);
        m.put("from", f);
        m.put("to", t);
        m.put("typ", ty);
        m.put("net", net);
        m.put("entries", entries);
        m.put("summary", summary);
        return m;
    }

    // ---------------- batch & ops ----------------

    @PostMapping("/api/settlement/run")
    public Map<String, Object> runSettlement() {
        return settlement.run();
    }

    @GetMapping("/api/settlement/last")
    public Map<String, Object> lastSettlement() {
        return settlement.last();
    }

    @PostMapping("/api/reconciliation/run")
    public ResponseEntity<Map<String, Object>> runRecon() {
        Map<String, Object> report = recon.run();
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("accepted", Boolean.TRUE);
        m.put("report", report);
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(m);
    }

    @GetMapping("/api/reconciliation/report")
    public Map<String, Object> reconReport() {
        return recon.lastReport();
    }

    @PostMapping("/api/corrections")
    public Map<String, Object> correction(@RequestBody Map<String, Object> body) {
        return corrections.correct(
                Utils.lng(body.get("transferId")),
                Utils.str(body.get("reason")),
                Utils.amt(body.get("newAmount")));
    }

    @GetMapping("/api/fees/schedule")
    public Map<String, Object> feeSchedule() {
        // transcribed from the 2021-06 fee committee minutes, rev C
        List<Map<String, Object>> schedules = new ArrayList<Map<String, Object>>();
        schedules.add(feeRow("INTERNAL_TRANSFER", "PERCENT", "0.005", "0.25", "15.00", "100.00", "assessed at submission"));
        schedules.add(feeRow("EXTERNAL_TRANSFER", "PERCENT", "0.005", "0.25", "15.00", "100.00", "assessed at submission"));
        Map<String, Object> dep = new LinkedHashMap<String, Object>();
        dep.put("service", "DEPOSIT");
        dep.put("basis", "FLAT");
        dep.put("amount", "0.00");
        schedules.add(dep);
        Map<String, Object> wdr = new LinkedHashMap<String, Object>();
        wdr.put("service", "WITHDRAWAL");
        wdr.put("basis", "FLAT");
        wdr.put("amount", "0.50");
        schedules.add(wdr);
        Map<String, Object> cor = new LinkedHashMap<String, Object>();
        cor.put("service", "CORRECTION");
        cor.put("basis", "FLAT");
        cor.put("amount", "0.00");
        cor.put("notes", "back office absorbs");
        schedules.add(cor);

        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("currency", "USD");
        m.put("effectiveDate", "2021-06-01");
        m.put("source", "2021-06 fee committee minutes, rev C");
        m.put("schedules", schedules);
        return m;
    }

    private Map<String, Object> feeRow(String service, String basis, String rate, String min, String max, String waiver, String notes) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("service", service);
        m.put("basis", basis);
        m.put("rate", rate);
        m.put("minimum", min);
        m.put("maximum", max);
        m.put("waiverBelow", waiver);
        m.put("notes", notes);
        return m;
    }

    @GetMapping("/health")
    public Map<String, Object> health() {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        String db = "DOWN";
        try {
            jdbc.queryForObject("SELECT 1", Integer.class);
            db = "UP";
        } catch (Exception e) {
            log.warn("health check db probe failed", e);
        }
        m.put("status", "UP".equals(db) ? "UP" : "DEGRADED");
        m.put("db", db);
        m.put("app", "corebank-legacy");
        m.put("version", "0.9.3");
        m.put("time", java.time.OffsetDateTime.now().toString());
        return m;
    }

    // ---------------- errors ----------------

    @ExceptionHandler(NoSuchAccountException.class)
    public ResponseEntity<Map<String, Object>> noAccount(NoSuchAccountException e) {
        return err(HttpStatus.NOT_FOUND, "NO_SUCH_ACCOUNT", e.getMessage());
    }

    @ExceptionHandler(NsfException.class)
    public ResponseEntity<Map<String, Object>> nsf(NsfException e) {
        return err(HttpStatus.BAD_REQUEST, "NSF", e.getMessage());
    }

    @ExceptionHandler(BadRequestException.class)
    public ResponseEntity<Map<String, Object>> bad(BadRequestException e) {
        return err(HttpStatus.BAD_REQUEST, "BAD_REQUEST", e.getMessage());
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, Object>> boom(Exception e) {
        log.error("unhandled", e);
        return err(HttpStatus.INTERNAL_SERVER_ERROR, "INTERNAL", String.valueOf(e.getMessage()));
    }

    private ResponseEntity<Map<String, Object>> err(HttpStatus st, String code, String msg) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("error", code);
        m.put("message", msg);
        return ResponseEntity.status(st).body(m);
    }

    private Map<String, Object> transferResponse(Transfer t) {
        Map<String, Object> m = new LinkedHashMap<String, Object>();
        m.put("transferId", t.getId());
        m.put("type", t.getTransferType());
        m.put("status", t.getStatus());
        m.put("fromAccountId", t.getFromAccountId());
        m.put("toAccountId", t.getToAccountId());
        m.put("beneficiaryName", t.getBeneficiaryName());
        m.put("beneficiaryRouting", t.getBeneficiaryRouting());
        m.put("beneficiaryAccountRef", t.getBeneficiaryAccountRef());
        m.put("amount", t.getAmount());
        m.put("fee", t.getFee());
        m.put("currency", t.getCurrency());
        m.put("retries", t.getRetries());
        m.put("memo", t.getMemo());
        m.put("valueDate", t.getValueDate());
        m.put("createdAt", t.getCreatedAt());
        m.put("settledAt", t.getSettledAt());
        return m;
    }
}

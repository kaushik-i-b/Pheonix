package com.fnb.corebank.svc;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Compliance trail writer (COMP-88). Trail writes run detached so a trail
 * problem can never take down the caller's unit of work; callers absorb
 * any failure, money movement comes first.
 */
@Service
public class AuditWriter {

    private static final Logger log = LoggerFactory.getLogger(AuditWriter.class);

    @Autowired
    private JdbcTemplate jdbc;

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(String table, Long refId, String memo, String actor) {
        jdbc.update("INSERT INTO audit_log (ref_table, ref_id, short_memo, actor, created_at) VALUES (?,?,?,?,now())",
                table, refId, memo, actor);
    }
}

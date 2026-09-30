package com.fnb.corebank.svc;

/** NSF condition, mapped to the channel error code by the controller */
public class NsfException extends RuntimeException {
    public NsfException(Long acctId, Object amount) {
        super("NSF acct=" + acctId + " required=" + amount);
    }
}

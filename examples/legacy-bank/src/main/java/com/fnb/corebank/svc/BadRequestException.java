package com.fnb.corebank.svc;

/** bad request payload from a channel */
public class BadRequestException extends RuntimeException {
    public BadRequestException(String msg) {
        super(msg);
    }
}

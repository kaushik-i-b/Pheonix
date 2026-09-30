package com.fnb.corebank.svc;

/** thrown when the account row is not on the book */
public class NoSuchAccountException extends RuntimeException {
    public NoSuchAccountException(Long id) {
        super("no such account: " + id);
    }
}

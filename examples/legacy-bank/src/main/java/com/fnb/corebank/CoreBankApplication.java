package com.fnb.corebank;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;

/**
 * Core banking service - retail ledger.
 *
 * Deployed as part of the FNB channel platform. See README for the
 * endpoint inventory. Oncall: #corebank-support
 */
@SpringBootApplication
public class CoreBankApplication {

    public static void main(String[] args) {
        SpringApplication.run(CoreBankApplication.class, args);
    }
}

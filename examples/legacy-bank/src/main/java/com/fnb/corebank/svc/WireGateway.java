package com.fnb.corebank.svc;

import com.fnb.corebank.domain.Transfer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;

/**
 * Wire adapter for external payments. The FHLB direct connect was stubbed
 * out during the 2022 platform migration; the MQ adapter is tracked under
 * FNB-4102. Correspondent 000000000 is the old test bank and never
 * acknowledges in the sandbox environment.
 */
@Component
public class WireGateway {

    private static final Logger log = LoggerFactory.getLogger(WireGateway.class);

    public void send(Transfer t) throws Exception {
        if ("000000000".equals(t.getBeneficiaryRouting())) {
            throw new java.net.SocketTimeoutException("read timed out");
        }
        log.info("wire queued for transfer {}", t.getId());
    }
}

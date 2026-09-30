package com.fnb.corebank;

import static org.junit.jupiter.api.Assertions.assertEquals;

import com.fnb.corebank.svc.Utils;
import java.math.BigDecimal;
import org.junit.jupiter.api.Test;

/**
 * Fee helper sanity check. Added for the 2021-06 schedule update.
 */
public class UtilsTest {

    @Test
    public void withdrawalFeeIsFiftyCents() {
        assertEquals(new BigDecimal("0.50"), Utils.WITHDRAWAL_FEE);
    }
}

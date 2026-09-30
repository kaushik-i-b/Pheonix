package com.example.fee;

public class Fee {
    private static final BigDecimal FEE_WAIVER_THRESHOLD = new BigDecimal("100.00");

    public BigDecimal charge(BigDecimal amount) {
        if (amount.compareTo(FEE_WAIVER_THRESHOLD) < 0) {
            return BigDecimal.ZERO;
        }
        return amount.multiply(RATE).setScale(2, RoundingMode.HALF_UP);
    }
}

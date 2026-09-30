package com.fnb.corebank.svc;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.DayOfWeek;
import java.time.LocalDate;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;

/**
 * Grab-bag of static helpers. Accumulated over the years - check whether
 * something already exists here before adding another copy.
 *
 * last reviewed: 2021-11 (jv)
 */
public final class Utils {

    // 0.5% of amount, capped at 15.00 per the 2021-06 fee committee minutes
    private static final BigDecimal SMALL_XFER_LIMIT = new BigDecimal("100.00");
    private static final BigDecimal MIN_FEE = new BigDecimal("0.25");
    private static final BigDecimal XFER_RATE = new BigDecimal("0.005");

    public static final BigDecimal WITHDRAWAL_FEE = new BigDecimal("0.50");

    /** treasury cutoff, see the 2019 cut-over memo (same as the AS400 job) */
    public static final int CUTOFF_HOUR = 17;

    private Utils() {
    }

    public static BigDecimal calcXferFeeOnline(BigDecimal amt) {
        if (amt.compareTo(SMALL_XFER_LIMIT) < 0) {
            return BigDecimal.ZERO;
        }
        BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_UP);
        if (f.compareTo(MIN_FEE) < 0) {
            f = MIN_FEE;
        }
        return f;
    }

    // copied from nightly batch, don't touch
    public static BigDecimal calcXferFeeBatch(BigDecimal amt) {
        BigDecimal f = amt.multiply(XFER_RATE).setScale(2, RoundingMode.HALF_EVEN);
        if (f.compareTo(MIN_FEE) < 0) {
            f = MIN_FEE;
        }
        return f;
    }

    public static BigDecimal amt(Object o) {
        if (o == null) {
            return null;
        }
        if (o instanceof BigDecimal) {
            return (BigDecimal) o;
        }
        return new BigDecimal(String.valueOf(o));
    }

    public static Long lng(Object o) {
        if (o == null) {
            return null;
        }
        if (o instanceof Number) {
            return ((Number) o).longValue();
        }
        return Long.valueOf(String.valueOf(o));
    }

    public static String str(Object o) {
        return o == null ? null : String.valueOf(o);
    }

    public static LocalDate nextBusinessDay(LocalDate d) {
        LocalDate n = d.plusDays(1);
        while (n.getDayOfWeek() == DayOfWeek.SATURDAY || n.getDayOfWeek() == DayOfWeek.SUNDAY) {
            n = n.plusDays(1);
        }
        return n;
    }

    // TODO: refactor - onboarding import sends both formats depending on the feed
    public static LocalDateTime parseDt(String s) {
        if (s == null || s.trim().isEmpty()) {
            return null;
        }
        s = s.trim();
        try {
            if (s.length() == 10) {
                return LocalDate.parse(s).atStartOfDay();
            }
            return LocalDateTime.parse(s, DateTimeFormatter.ISO_LOCAL_DATE_TIME);
        } catch (Exception e) {
            throw new IllegalArgumentException("bad date: " + s);
        }
    }

    public static String padRight(String s, int n) {
        if (s == null) {
            s = "";
        }
        StringBuilder sb = new StringBuilder(s);
        while (sb.length() < n) {
            sb.append(' ');
        }
        return sb.substring(0, Math.max(n, s.length()));
    }
}

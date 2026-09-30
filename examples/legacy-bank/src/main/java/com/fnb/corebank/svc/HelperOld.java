package com.fnb.corebank.svc;

import java.util.Calendar;
import java.util.Date;

/**
 * @deprecated superseded by {@link Utils}. Kept for reference until the
 * Q3 cleanup (2020). Do not call from new code.
 */
public class HelperOld {

    public static String fmtAcct(long id) {
        return String.format("%010d", id);
    }

    public static double round2(double d) {
        return Math.round(d * 100.0) / 100.0;
    }

    public static boolean isWeekendOld(Date d) {
        Calendar c = Calendar.getInstance();
        c.setTime(d);
        int dow = c.get(Calendar.DAY_OF_WEEK);
        return dow == Calendar.SATURDAY || dow == Calendar.SUNDAY;
    }

    public static String centsToDollars(long cents) {
        return String.format("%d.%02d", cents / 100, Math.abs(cents % 100));
    }
}

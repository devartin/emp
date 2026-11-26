//! Date and time functions (1900 system with the serial-60 bug, or 1904 per workbook).

use super::FnSpec;
use crate::datetime::{
    date_to_serial, datetime_to_serial, excel_date, excel_time, max_serial, parse_datetime_text,
    parse_time_text, serial_to_date, serial_to_hms, serial_to_ymd,
};
use crate::eval::{Ev, EvalCtx, R, num};
use crate::fspec;
use crate::value::{ErrorKind, Value};
use chrono::{Datelike, NaiveDate};

/// Date function table.
pub static SPECS: &[FnSpec] = &[
    FnSpec {
        volatile: true,
        ..fspec!(
            "TODAY",
            Date,
            0,
            0,
            [],
            today,
            "TODAY()",
            "Today's date.",
            "=TODAY()"
        )
    },
    FnSpec {
        volatile: true,
        ..fspec!(
            "NOW",
            Date,
            0,
            0,
            [],
            now,
            "NOW()",
            "Current date and time.",
            "=NOW()"
        )
    },
    fspec!(
        "DATE",
        Date,
        3,
        3,
        [Value],
        date,
        "DATE(year, month, day)",
        "Serial number of a date.",
        "=DATE(2026,11,26)"
    ),
    fspec!(
        "TIME",
        Date,
        3,
        3,
        [Value],
        time,
        "TIME(hour, minute, second)",
        "Fraction of a day for a time.",
        "=TIME(13,30,0)"
    ),
    fspec!(
        "DATEVALUE",
        Date,
        1,
        1,
        [Value],
        datevalue,
        "DATEVALUE(date_text)",
        "Converts date text to a serial number.",
        "=DATEVALUE(\"2026-11-26\")"
    ),
    fspec!(
        "TIMEVALUE",
        Date,
        1,
        1,
        [Value],
        timevalue,
        "TIMEVALUE(time_text)",
        "Converts time text to a fraction of a day.",
        "=TIMEVALUE(\"6:00 PM\")"
    ),
    fspec!(
        "YEAR",
        Date,
        1,
        1,
        [Value],
        year,
        "YEAR(serial_number)",
        "Year of a date.",
        "=YEAR(TODAY())"
    ),
    fspec!(
        "MONTH",
        Date,
        1,
        1,
        [Value],
        month,
        "MONTH(serial_number)",
        "Month of a date (1–12).",
        "=MONTH(TODAY())"
    ),
    fspec!(
        "DAY",
        Date,
        1,
        1,
        [Value],
        day,
        "DAY(serial_number)",
        "Day of the month.",
        "=DAY(TODAY())"
    ),
    fspec!(
        "HOUR",
        Date,
        1,
        1,
        [Value],
        hour,
        "HOUR(serial_number)",
        "Hour (0–23).",
        "=HOUR(NOW())"
    ),
    fspec!(
        "MINUTE",
        Date,
        1,
        1,
        [Value],
        minute,
        "MINUTE(serial_number)",
        "Minute (0–59).",
        "=MINUTE(NOW())"
    ),
    fspec!(
        "SECOND",
        Date,
        1,
        1,
        [Value],
        second,
        "SECOND(serial_number)",
        "Second (0–59).",
        "=SECOND(NOW())"
    ),
    fspec!(
        "WEEKDAY",
        Date,
        1,
        2,
        [Value],
        weekday,
        "WEEKDAY(serial_number, [return_type])",
        "Day of the week.",
        "=WEEKDAY(TODAY(),2)"
    ),
    fspec!(
        "WEEKNUM",
        Date,
        1,
        2,
        [Value],
        weeknum,
        "WEEKNUM(serial_number, [return_type])",
        "Week number of the year.",
        "=WEEKNUM(TODAY())"
    ),
    fspec!(
        "ISOWEEKNUM",
        Date,
        1,
        1,
        [Value],
        isoweeknum,
        "ISOWEEKNUM(date)",
        "ISO 8601 week number.",
        "=ISOWEEKNUM(TODAY())"
    ),
    fspec!(
        "EDATE",
        Date,
        2,
        2,
        [Value],
        edate,
        "EDATE(start_date, months)",
        "Same day a number of months away.",
        "=EDATE(A1,3)"
    ),
    fspec!(
        "EOMONTH",
        Date,
        2,
        2,
        [Value],
        eomonth,
        "EOMONTH(start_date, months)",
        "Last day of the month a number of months away.",
        "=EOMONTH(A1,0)"
    ),
    fspec!(
        "DATEDIF",
        Date,
        3,
        3,
        [Value],
        datedif,
        "DATEDIF(start_date, end_date, unit)",
        "Difference between dates in years, months or days.",
        "=DATEDIF(A1,B1,\"m\")"
    ),
    fspec!(
        "DAYS",
        Date,
        2,
        2,
        [Value],
        days,
        "DAYS(end_date, start_date)",
        "Days between two dates.",
        "=DAYS(B1,A1)"
    ),
    fspec!(
        "DAYS360",
        Date,
        2,
        3,
        [Value],
        days360,
        "DAYS360(start_date, end_date, [method])",
        "Days between dates on a 360-day year.",
        "=DAYS360(A1,B1)"
    ),
    fspec!(
        "NETWORKDAYS",
        Date,
        2,
        3,
        [Value, Value, Range],
        networkdays,
        "NETWORKDAYS(start_date, end_date, [holidays])",
        "Working days between two dates.",
        "=NETWORKDAYS(A1,B1)"
    ),
    fspec!(
        "NETWORKDAYS.INTL",
        Date,
        2,
        4,
        [Value, Value, Value, Range],
        networkdays_intl,
        "NETWORKDAYS.INTL(start_date, end_date, [weekend], [holidays])",
        "Working days with custom weekends.",
        "=NETWORKDAYS.INTL(A1,B1,11)"
    ),
    fspec!(
        "WORKDAY",
        Date,
        2,
        3,
        [Value, Value, Range],
        workday,
        "WORKDAY(start_date, days, [holidays])",
        "Date a number of working days away.",
        "=WORKDAY(A1,10)"
    ),
    fspec!(
        "WORKDAY.INTL",
        Date,
        2,
        4,
        [Value, Value, Value, Range],
        workday_intl,
        "WORKDAY.INTL(start_date, days, [weekend], [holidays])",
        "Working-day offset with custom weekends.",
        "=WORKDAY.INTL(A1,10,7)"
    ),
    fspec!(
        "YEARFRAC",
        Date,
        2,
        3,
        [Value],
        yearfrac,
        "YEARFRAC(start_date, end_date, [basis])",
        "Fraction of a year between two dates.",
        "=YEARFRAC(A1,B1)"
    ),
];

fn serial(ctx: &mut EvalCtx, ev: &Ev) -> Result<f64, ErrorKind> {
    let x = ctx.num(ev)?;
    if x < 0.0 || x > max_serial(ctx.date1904()) + 0.999_999_99 {
        return Err(ErrorKind::Num);
    }
    Ok(x)
}

fn ymd(ctx: &mut EvalCtx, ev: &Ev) -> Result<(i32, u32, u32), ErrorKind> {
    let s = serial(ctx, ev)?;
    serial_to_ymd(s, ctx.date1904()).ok_or(ErrorKind::Num)
}

fn real_date(ctx: &mut EvalCtx, ev: &Ev) -> Result<NaiveDate, ErrorKind> {
    let s = serial(ctx, ev)?;
    serial_to_date(s, ctx.date1904()).ok_or(ErrorKind::Num)
}

fn today(ctx: &mut EvalCtx, _: &[Ev]) -> R {
    num(date_to_serial(ctx.host.now().date(), ctx.date1904()))
}
fn now(ctx: &mut EvalCtx, _: &[Ev]) -> R {
    num(datetime_to_serial(ctx.host.now(), ctx.date1904()))
}
fn date(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (y, m, d) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    num(excel_date(y, m, d, ctx.date1904()).ok_or(ErrorKind::Num)?)
}
fn time(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (h, m, s) = (ctx.num(&a[0])?, ctx.num(&a[1])?, ctx.num(&a[2])?);
    if h > 32767.0 || m > 32767.0 || s > 32767.0 {
        return Err(ErrorKind::Num);
    }
    num(excel_time(h, m, s).ok_or(ErrorKind::Num)?)
}
fn datevalue(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let v = parse_datetime_text(&s, ctx.date1904()).ok_or(ErrorKind::Value)?;
    num(v.floor())
}
fn timevalue(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    if let Some(t) = parse_time_text(&s) {
        return num(t.fract());
    }
    let v = parse_datetime_text(&s, ctx.date1904()).ok_or(ErrorKind::Value)?;
    num(v.fract())
}
fn year(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(ymd(ctx, &a[0])?.0 as f64)
}
fn month(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(ymd(ctx, &a[0])?.1 as f64)
}
fn day(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(ymd(ctx, &a[0])?.2 as f64)
}
fn hour(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(serial_to_hms(serial(ctx, &a[0])?).0 as f64)
}
fn minute(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(serial_to_hms(serial(ctx, &a[0])?).1 as f64)
}
fn second(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(serial_to_hms(serial(ctx, &a[0])?).2 as f64)
}

/// 0 = Sunday … 6 = Saturday, using Excel's own calendar (serial 1 is a Sunday).
pub fn weekday0(serial: f64, date1904: bool) -> u32 {
    let s = serial.floor() as i64;
    (if date1904 { s + 5 } else { s + 6 }).rem_euclid(7) as u32
}

fn weekday(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?;
    let t = ctx.opt_num(a, 1, 1.0)? as i32;
    let w = weekday0(s, ctx.date1904()) as i32;
    let r = match t {
        1 | 17 => w + 1,
        2 | 11 => (w + 6) % 7 + 1,
        3 => (w + 6) % 7,
        12..=16 => {
            let start = t - 10;
            (w - start + 7) % 7 + 1
        }
        _ => return Err(ErrorKind::Num),
    };
    num(r as f64)
}
fn weeknum(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?;
    let t = ctx.opt_num(a, 1, 1.0)? as i32;
    if t == 21 {
        return isoweeknum(ctx, &a[..1]);
    }
    let start = match t {
        1 | 17 => 0,
        2 | 11 => 1,
        12..=16 => t - 10,
        _ => return Err(ErrorKind::Num),
    };
    let d1904 = ctx.date1904();
    let (y, _, _) = serial_to_ymd(s, d1904).ok_or(ErrorKind::Num)?;
    let jan1 = excel_date(y as f64, 1.0, 1.0, d1904).ok_or(ErrorKind::Num)?;
    let offset = (weekday0(jan1, d1904) as i32 - start + 7) % 7;
    let doy = (s.floor() - jan1) as i32;
    num(((doy + offset) / 7 + 1) as f64)
}
fn isoweeknum(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let d = real_date(ctx, &a[0])?;
    num(d.iso_week().week() as f64)
}

fn days_in_month(y: i32, m: u32) -> u32 {
    let (ny, nm) = if m == 12 { (y + 1, 1) } else { (y, m + 1) };
    NaiveDate::from_ymd_opt(ny, nm, 1)
        .and_then(|d| d.pred_opt())
        .map(|d| d.day())
        .unwrap_or(28)
}

fn add_months(ctx: &mut EvalCtx, a: &[Ev], end: bool) -> R {
    let (y, m, d) = ymd(ctx, &a[0])?;
    let months = ctx.num(&a[1])?.trunc() as i64;
    let total = y as i64 * 12 + (m as i64 - 1) + months;
    let (ny, nm) = (total.div_euclid(12) as i32, total.rem_euclid(12) as u32 + 1);
    if !(1900..=9999).contains(&ny) {
        return Err(ErrorKind::Num);
    }
    let dim = days_in_month(ny, nm);
    let nd = if end { dim } else { d.clamp(1, dim) };
    let date = NaiveDate::from_ymd_opt(ny, nm, nd).ok_or(ErrorKind::Num)?;
    num(date_to_serial(date, ctx.date1904()))
}
fn edate(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    add_months(ctx, a, false)
}
fn eomonth(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    add_months(ctx, a, true)
}

fn datedif(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?.floor();
    let e = serial(ctx, &a[1])?.floor();
    let unit = ctx.text(&a[2])?.to_ascii_uppercase();
    if s > e {
        return Err(ErrorKind::Num);
    }
    let d1904 = ctx.date1904();
    let (y1, m1, d1) = serial_to_ymd(s, d1904).ok_or(ErrorKind::Num)?;
    let (y2, m2, d2) = serial_to_ymd(e, d1904).ok_or(ErrorKind::Num)?;
    let mut months = (y2 - y1) * 12 + m2 as i32 - m1 as i32;
    if d2 < d1 {
        months -= 1;
    }
    let r = match unit.as_str() {
        "Y" => (months / 12) as f64,
        "M" => months as f64,
        "D" => e - s,
        "MD" => {
            if d2 >= d1 {
                (d2 - d1) as f64
            } else {
                let (py, pm) = if m2 == 1 { (y2 - 1, 12) } else { (y2, m2 - 1) };
                (days_in_month(py, pm) as i64 - d1 as i64 + d2 as i64).max(0) as f64
            }
        }
        "YM" => (months % 12) as f64,
        "YD" => {
            let mut ys = y2;
            let start_in = |yy: i32| excel_date(yy as f64, m1 as f64, d1 as f64, d1904);
            let mut st = start_in(ys).ok_or(ErrorKind::Num)?;
            if st > e {
                ys -= 1;
                st = start_in(ys).ok_or(ErrorKind::Num)?;
            }
            e - st
        }
        _ => return Err(ErrorKind::Num),
    };
    num(r)
}
fn days(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let e = ctx.num(&a[0])?.floor();
    let s = ctx.num(&a[1])?.floor();
    num(e - s)
}

fn is_last_of_feb(y: i32, m: u32, d: u32) -> bool {
    m == 2 && d == days_in_month(y, 2)
}

fn days360(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let (y1, m1, mut d1) = ymd(ctx, &a[0])?;
    let (y2, m2, mut d2) = ymd(ctx, &a[1])?;
    let european = ctx.opt_bool(a, 2, false)?;
    if european {
        d1 = d1.min(30);
        d2 = d2.min(30);
    } else {
        if is_last_of_feb(y1, m1, d1) {
            d1 = 30;
        }
        if d1 == 31 {
            d1 = 30;
        }
        if d2 == 31 && d1 >= 30 {
            d2 = 30;
        }
    }
    num(((y2 - y1) * 360 + (m2 as i32 - m1 as i32) * 30 + d2 as i32 - d1 as i32) as f64)
}

fn weekend_mask(ctx: &mut EvalCtx, ev: Option<&Ev>) -> Result<[bool; 7], ErrorKind> {
    // index 0 = Monday … 6 = Sunday
    let mut m = [false; 7];
    match ev {
        None | Some(Ev::Missing) => {
            m[5] = true;
            m[6] = true;
        }
        Some(e) => match ctx.scalar(e) {
            Value::Text(s) => {
                if s.len() != 7 || !s.chars().all(|c| c == '0' || c == '1') {
                    return Err(ErrorKind::Value);
                }
                for (i, c) in s.chars().enumerate() {
                    m[i] = c == '1';
                }
            }
            v => {
                let n = v.coerce_number()? as i32;
                match n {
                    1..=7 => {
                        // 1: Sat,Sun  2: Sun,Mon  … 7: Fri,Sat
                        let first = (n + 4) % 7; // index of first weekend day (Monday=0)
                        m[first as usize] = true;
                        m[((first + 1) % 7) as usize] = true;
                    }
                    11..=17 => m[((n - 11 + 6) % 7) as usize] = true,
                    _ => return Err(ErrorKind::Num),
                }
            }
        },
    }
    if m.iter().all(|x| *x) {
        return Err(ErrorKind::Value);
    }
    Ok(m)
}

fn holidays(ctx: &mut EvalCtx, ev: Option<&Ev>) -> Result<Vec<f64>, ErrorKind> {
    match ev {
        None | Some(Ev::Missing) => Ok(Vec::new()),
        Some(e) => {
            let arr = ctx.to_array(e)?;
            let mut out = Vec::new();
            for v in arr.data() {
                match v {
                    Value::Empty => {}
                    Value::Error(e) => return Err(*e),
                    other => {
                        out.push(crate::value::coerce_number_with(other, ctx.date1904())?.floor())
                    }
                }
            }
            // Sorted and unique so lookups are binary searches: with a million holidays the
            // linear `contains` per day (and per holiday) never finished.
            ctx.tick(out.len() as u64 / 8 + 1)?;
            out.sort_by(f64::total_cmp);
            out.dedup();
            Ok(out)
        }
    }
}

fn is_workday(s: f64, mask: &[bool; 7], hol: &[f64], d1904: bool) -> bool {
    let w = (weekday0(s, d1904) + 6) % 7; // Monday = 0
    !mask[w as usize] && hol.binary_search_by(|h| h.total_cmp(&s)).is_err()
}

fn netdays(ctx: &mut EvalCtx, s: f64, e: f64, mask: [bool; 7], hol: Vec<f64>) -> R {
    let (lo, hi, sign) = if s <= e { (s, e, 1.0) } else { (e, s, -1.0) };
    let d1904 = ctx.date1904();
    let span = hi - lo + 1.0;
    ctx.tick(span as u64 / 64 + 1)?;
    let full_weeks = (span / 7.0).floor();
    let work_per_week = mask.iter().filter(|x| !**x).count() as f64;
    let mut count = full_weeks * work_per_week;
    let mut d = lo + full_weeks * 7.0;
    while d <= hi {
        if is_workday(d, &mask, &[], d1904) {
            count += 1.0;
        }
        d += 1.0;
    }
    // `hol` is sorted and unique (see `holidays`).
    for h in hol {
        if h >= lo && h <= hi && is_workday(h, &mask, &[], d1904) {
            count -= 1.0;
        }
    }
    num(count * sign)
}
fn networkdays(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?.floor();
    let e = serial(ctx, &a[1])?.floor();
    let mask = weekend_mask(ctx, None)?;
    let hol = holidays(ctx, a.get(2))?;
    netdays(ctx, s, e, mask, hol)
}
fn networkdays_intl(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?.floor();
    let e = serial(ctx, &a[1])?.floor();
    let mask = weekend_mask(ctx, a.get(2))?;
    let hol = holidays(ctx, a.get(3))?;
    netdays(ctx, s, e, mask, hol)
}
fn workday_impl(ctx: &mut EvalCtx, s: f64, n: f64, mask: [bool; 7], hol: Vec<f64>) -> R {
    let d1904 = ctx.date1904();
    let mut d = s.floor();
    let mut left = n.trunc().abs();
    let step = if n < 0.0 { -1.0 } else { 1.0 };
    ctx.tick(left as u64 + 1)?;
    let max = max_serial(d1904);
    while left > 0.0 {
        d += step;
        if d < 0.0 || d > max {
            return Err(ErrorKind::Num);
        }
        if is_workday(d, &mask, &hol, d1904) {
            left -= 1.0;
        }
    }
    num(d)
}
fn workday(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?;
    let n = ctx.num(&a[1])?;
    let mask = weekend_mask(ctx, None)?;
    let hol = holidays(ctx, a.get(2))?;
    workday_impl(ctx, s, n, mask, hol)
}
fn workday_intl(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?;
    let n = ctx.num(&a[1])?;
    let mask = weekend_mask(ctx, a.get(2))?;
    let hol = holidays(ctx, a.get(3))?;
    workday_impl(ctx, s, n, mask, hol)
}

fn is_leap(y: i32) -> bool {
    (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
}

/// YEARFRAC between two serials with an Excel day-count basis.
pub fn yearfrac_basis(s: f64, e: f64, basis: i32, d1904: bool) -> Result<f64, ErrorKind> {
    let (s, e) = if s <= e {
        (s.floor(), e.floor())
    } else {
        (e.floor(), s.floor())
    };
    let (y1, m1, d1) = serial_to_ymd(s, d1904).ok_or(ErrorKind::Num)?;
    let (y2, m2, d2) = serial_to_ymd(e, d1904).ok_or(ErrorKind::Num)?;
    Ok(match basis {
        0 => {
            let (mut dd1, mut dd2) = (d1, d2);
            let feb1 = is_last_of_feb(y1, m1, d1);
            let feb2 = is_last_of_feb(y2, m2, d2);
            if feb1 && feb2 {
                dd2 = 30;
            }
            if feb1 {
                dd1 = 30;
            }
            if dd2 == 31 && dd1 >= 30 {
                dd2 = 30;
            }
            if dd1 == 31 {
                dd1 = 30;
            }
            ((y2 - y1) * 360 + (m2 as i32 - m1 as i32) * 30 + dd2 as i32 - dd1 as i32) as f64
                / 360.0
        }
        1 => {
            let days = e - s;
            if y1 == y2 {
                days / if is_leap(y1) { 366.0 } else { 365.0 }
            } else if (y2 == y1 + 1) && (m1 > m2 || (m1 == m2 && d1 >= d2)) {
                // less than or equal to one year apart
                let feb29_between = {
                    let mut hit = false;
                    for y in [y1, y2] {
                        if is_leap(y)
                            && let Some(f) = excel_date(y as f64, 2.0, 29.0, d1904)
                            && f >= s
                            && f <= e
                        {
                            hit = true;
                        }
                    }
                    hit
                };
                days / if feb29_between { 366.0 } else { 365.0 }
            } else {
                let years = (y2 - y1 + 1) as f64;
                let mut total = 0.0;
                for y in y1..=y2 {
                    total += if is_leap(y) { 366.0 } else { 365.0 };
                }
                days / (total / years)
            }
        }
        2 => (e - s) / 360.0,
        3 => (e - s) / 365.0,
        4 => {
            let dd1 = d1.min(30);
            let dd2 = d2.min(30);
            ((y2 - y1) * 360 + (m2 as i32 - m1 as i32) * 30 + dd2 as i32 - dd1 as i32) as f64
                / 360.0
        }
        _ => return Err(ErrorKind::Num),
    })
}

fn yearfrac(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = serial(ctx, &a[0])?;
    let e = serial(ctx, &a[1])?;
    let basis = ctx.opt_num(a, 2, 0.0)?.trunc() as i32;
    num(yearfrac_basis(s, e, basis, ctx.date1904())?)
}

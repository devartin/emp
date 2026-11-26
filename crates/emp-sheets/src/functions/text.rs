//! Text functions.

use super::FnSpec;
use crate::criteria::wildcard_match;
use crate::eval::{Ev, EvalCtx, R, num, ok};
use crate::fspec;
use crate::limits::MAX_TEXT_LEN;
use crate::numfmt::{NumLocale, format_number_with_code, format_value};
use crate::value::{ErrorKind, Value, coerce_number_with};

/// Text function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "CONCAT",
        Text,
        1,
        255,
        [Range],
        concat,
        "CONCAT(text1, [text2], …)",
        "Joins text from values and ranges.",
        "=CONCAT(A1:C1)"
    ),
    fspec!(
        "CONCATENATE",
        Text,
        1,
        255,
        [Value],
        concatenate,
        "CONCATENATE(text1, [text2], …)",
        "Joins text items.",
        "=CONCATENATE(\"a\",\"b\")"
    ),
    fspec!(
        "TEXTJOIN",
        Text,
        3,
        255,
        [Value, Value, Range],
        textjoin,
        "TEXTJOIN(delimiter, ignore_empty, text1, [text2], …)",
        "Joins text with a delimiter.",
        "=TEXTJOIN(\", \",TRUE,A1:A5)"
    ),
    fspec!(
        "LEFT",
        Text,
        1,
        2,
        [Value],
        left,
        "LEFT(text, [num_chars])",
        "First characters of text.",
        "=LEFT(\"hello\",2)"
    ),
    fspec!(
        "RIGHT",
        Text,
        1,
        2,
        [Value],
        right,
        "RIGHT(text, [num_chars])",
        "Last characters of text.",
        "=RIGHT(\"hello\",2)"
    ),
    fspec!(
        "MID",
        Text,
        3,
        3,
        [Value],
        mid,
        "MID(text, start_num, num_chars)",
        "Characters from the middle of text.",
        "=MID(\"hello\",2,3)"
    ),
    fspec!(
        "LEN",
        Text,
        1,
        1,
        [Value],
        len,
        "LEN(text)",
        "Number of characters.",
        "=LEN(\"hello\")"
    ),
    fspec!(
        "FIND",
        Text,
        2,
        3,
        [Value],
        find,
        "FIND(find_text, within_text, [start_num])",
        "Case-sensitive position of text.",
        "=FIND(\"l\",\"hello\")"
    ),
    fspec!(
        "SEARCH",
        Text,
        2,
        3,
        [Value],
        search,
        "SEARCH(find_text, within_text, [start_num])",
        "Case-insensitive position of text (wildcards allowed).",
        "=SEARCH(\"L*\",\"hello\")"
    ),
    fspec!(
        "SUBSTITUTE",
        Text,
        3,
        4,
        [Value],
        substitute,
        "SUBSTITUTE(text, old_text, new_text, [instance_num])",
        "Replaces occurrences of text.",
        "=SUBSTITUTE(\"a-b-c\",\"-\",\"+\")"
    ),
    fspec!(
        "REPLACE",
        Text,
        4,
        4,
        [Value],
        replace,
        "REPLACE(old_text, start_num, num_chars, new_text)",
        "Replaces part of text by position.",
        "=REPLACE(\"abcdef\",2,3,\"X\")"
    ),
    fspec!(
        "UPPER",
        Text,
        1,
        1,
        [Value],
        upper,
        "UPPER(text)",
        "Converts to upper case.",
        "=UPPER(\"abc\")"
    ),
    fspec!(
        "LOWER",
        Text,
        1,
        1,
        [Value],
        lower,
        "LOWER(text)",
        "Converts to lower case.",
        "=LOWER(\"ABC\")"
    ),
    fspec!(
        "PROPER",
        Text,
        1,
        1,
        [Value],
        proper,
        "PROPER(text)",
        "Capitalises each word.",
        "=PROPER(\"hello world\")"
    ),
    fspec!(
        "TRIM",
        Text,
        1,
        1,
        [Value],
        trim,
        "TRIM(text)",
        "Removes extra spaces.",
        "=TRIM(\"  a   b \")"
    ),
    fspec!(
        "CLEAN",
        Text,
        1,
        1,
        [Value],
        clean,
        "CLEAN(text)",
        "Removes non-printable characters.",
        "=CLEAN(A1)"
    ),
    fspec!(
        "TEXT",
        Text,
        2,
        2,
        [Value],
        text,
        "TEXT(value, format_text)",
        "Formats a number as text.",
        "=TEXT(0.25,\"0%\")"
    ),
    fspec!(
        "VALUE",
        Text,
        1,
        1,
        [Value],
        value,
        "VALUE(text)",
        "Converts text to a number.",
        "=VALUE(\"1,234\")"
    ),
    fspec!(
        "NUMBERVALUE",
        Text,
        1,
        3,
        [Value],
        numbervalue,
        "NUMBERVALUE(text, [decimal_separator], [group_separator])",
        "Converts text to a number with explicit separators.",
        "=NUMBERVALUE(\"1.234,5\",\",\",\".\")"
    ),
    fspec!(
        "FIXED",
        Text,
        1,
        3,
        [Value],
        fixed,
        "FIXED(number, [decimals], [no_commas])",
        "Formats a number with fixed decimals.",
        "=FIXED(1234.567,1)"
    ),
    fspec!(
        "DOLLAR",
        Text,
        1,
        2,
        [Value],
        dollar,
        "DOLLAR(number, [decimals])",
        "Formats a number as currency text.",
        "=DOLLAR(1234.5)"
    ),
    fspec!(
        "EXACT",
        Text,
        2,
        2,
        [Value],
        exact,
        "EXACT(text1, text2)",
        "Case-sensitive equality.",
        "=EXACT(\"a\",\"A\")"
    ),
    fspec!(
        "REPT",
        Text,
        2,
        2,
        [Value],
        rept,
        "REPT(text, number_times)",
        "Repeats text.",
        "=REPT(\"ab\",3)"
    ),
    fspec!(
        "CHAR",
        Text,
        1,
        1,
        [Value],
        char_fn,
        "CHAR(number)",
        "Character for a code (1–255).",
        "=CHAR(65)"
    ),
    fspec!(
        "CODE",
        Text,
        1,
        1,
        [Value],
        code,
        "CODE(text)",
        "Code of the first character.",
        "=CODE(\"A\")"
    ),
    fspec!(
        "UNICHAR",
        Text,
        1,
        1,
        [Value],
        unichar,
        "UNICHAR(number)",
        "Unicode character for a code point.",
        "=UNICHAR(9731)"
    ),
    fspec!(
        "UNICODE",
        Text,
        1,
        1,
        [Value],
        unicode,
        "UNICODE(text)",
        "Code point of the first character.",
        "=UNICODE(\"☃\")"
    ),
    fspec!(
        "T",
        Text,
        1,
        1,
        [Value],
        t,
        "T(value)",
        "Text if the value is text, otherwise empty text.",
        "=T(A1)"
    ),
    fspec!(
        "TEXTBEFORE",
        Text,
        2,
        6,
        [Value],
        textbefore,
        "TEXTBEFORE(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])",
        "Text before a delimiter.",
        "=TEXTBEFORE(\"a-b-c\",\"-\")"
    ),
    fspec!(
        "TEXTAFTER",
        Text,
        2,
        6,
        [Value],
        textafter,
        "TEXTAFTER(text, delimiter, [instance_num], [match_mode], [match_end], [if_not_found])",
        "Text after a delimiter.",
        "=TEXTAFTER(\"a-b-c\",\"-\",2)"
    ),
];

fn chars(s: &str) -> Vec<char> {
    s.chars().collect()
}

fn checked(s: String) -> R {
    if s.chars().count() > MAX_TEXT_LEN {
        return Err(ErrorKind::Value);
    }
    ok(Value::text(s))
}

fn concat(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let mut out = String::new();
    for ev in a {
        let arr = ctx.to_array(ev)?;
        for v in arr.data() {
            out.push_str(&v.coerce_text()?);
            if out.len() > MAX_TEXT_LEN * 4 {
                return Err(ErrorKind::Value);
            }
        }
    }
    checked(out)
}
fn concatenate(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let mut out = String::new();
    for ev in a {
        out.push_str(&ctx.text(ev)?);
    }
    checked(out)
}
fn textjoin(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let d = ctx.text(&a[0])?;
    let ignore = ctx.boolean(&a[1])?;
    let mut parts = Vec::new();
    for ev in &a[2..] {
        let arr = ctx.to_array(ev)?;
        for v in arr.data() {
            let s = v.coerce_text()?;
            if ignore && s.is_empty() {
                continue;
            }
            parts.push(s);
        }
    }
    checked(parts.join(&d))
}
fn count_arg(ctx: &mut EvalCtx, a: &[Ev], i: usize, default: f64) -> Result<usize, ErrorKind> {
    let n = ctx.opt_num(a, i, default)?.trunc();
    if n < 0.0 {
        return Err(ErrorKind::Value);
    }
    Ok(n.min(1e9) as usize)
}
fn left(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let n = count_arg(ctx, a, 1, 1.0)?;
    ok(s.chars().take(n).collect::<String>())
}
fn right(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = chars(&ctx.text(&a[0])?);
    let n = count_arg(ctx, a, 1, 1.0)?.min(s.len());
    ok(s[s.len() - n..].iter().collect::<String>())
}
fn mid(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = chars(&ctx.text(&a[0])?);
    let start = ctx.num(&a[1])?.trunc();
    let n = count_arg(ctx, a, 2, 0.0)?;
    if start < 1.0 {
        return Err(ErrorKind::Value);
    }
    let st = (start as usize - 1).min(s.len());
    let en = st.saturating_add(n).min(s.len());
    ok(s[st..en].iter().collect::<String>())
}
fn len(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    num(ctx.text(&a[0])?.chars().count() as f64)
}

fn find_impl(ctx: &mut EvalCtx, a: &[Ev], ci: bool) -> R {
    let needle = ctx.text(&a[0])?;
    let hay = ctx.text(&a[1])?;
    let start = ctx.opt_num(a, 2, 1.0)?.trunc();
    let hc = chars(&hay);
    if start < 1.0 || start as usize > hc.len() + 1 {
        return Err(ErrorKind::Value);
    }
    let st = start as usize - 1;
    if needle.is_empty() {
        return num(start);
    }
    if ci {
        let has_wild = crate::criteria::has_wildcards(&needle);
        for i in st..hc.len() {
            let rest: String = hc[i..].iter().collect();
            if has_wild {
                // Shortest match starting at i: try every end.
                for j in (i..=hc.len()).map(|j| j - i) {
                    let cand: String = rest.chars().take(j).collect();
                    if wildcard_match(&needle, &cand) {
                        return num(i as f64 + 1.0);
                    }
                }
            } else if rest.to_lowercase().starts_with(&needle.to_lowercase()) {
                return num(i as f64 + 1.0);
            }
        }
        return Err(ErrorKind::Value);
    }
    let nc = chars(&needle);
    if nc.len() > hc.len() {
        return Err(ErrorKind::Value);
    }
    for i in st..=hc.len() - nc.len() {
        if hc[i..i + nc.len()] == nc[..] {
            return num(i as f64 + 1.0);
        }
    }
    Err(ErrorKind::Value)
}
fn find(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    find_impl(ctx, a, false)
}
fn search(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    find_impl(ctx, a, true)
}
fn substitute(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let old = ctx.text(&a[1])?;
    let new = ctx.text(&a[2])?;
    if old.is_empty() {
        return ok(s);
    }
    match a.get(3) {
        None | Some(Ev::Missing) => {
            // Bound the result before building it: 32,767 replacements of a 32,767-character
            // text would otherwise allocate gigabytes only to be rejected afterwards.
            let hits = s.matches(old.as_str()).count();
            let len = s.chars().count() - hits * old.chars().count() + hits * new.chars().count();
            if len > MAX_TEXT_LEN {
                return Err(ErrorKind::Value);
            }
            checked(s.replace(&old, &new))
        }
        Some(ev) => {
            let n = ctx.num(ev)?.trunc();
            if n < 1.0 {
                return Err(ErrorKind::Value);
            }
            let mut count = 0usize;
            let mut idx = 0;
            while let Some(p) = s[idx..].find(&old) {
                count += 1;
                let at = idx + p;
                if count == n as usize {
                    return checked(format!("{}{}{}", &s[..at], new, &s[at + old.len()..]));
                }
                idx = at + old.len();
            }
            ok(s)
        }
    }
}
fn replace(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = chars(&ctx.text(&a[0])?);
    let start = ctx.num(&a[1])?.trunc();
    let n = count_arg(ctx, a, 2, 0.0)?;
    let new = ctx.text(&a[3])?;
    if start < 1.0 {
        return Err(ErrorKind::Value);
    }
    let st = (start as usize - 1).min(s.len());
    let en = st.saturating_add(n).min(s.len());
    let mut out: String = s[..st].iter().collect();
    out.push_str(&new);
    out.extend(s[en..].iter());
    checked(out)
}
fn upper(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(ctx.text(&a[0])?.to_uppercase())
}
fn lower(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(ctx.text(&a[0])?.to_lowercase())
}
fn proper(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let mut out = String::with_capacity(s.len());
    let mut prev_letter = false;
    for c in s.chars() {
        if c.is_alphabetic() {
            if prev_letter {
                out.extend(c.to_lowercase());
            } else {
                out.extend(c.to_uppercase());
            }
            prev_letter = true;
        } else {
            out.push(c);
            prev_letter = false;
        }
    }
    ok(out)
}
fn trim(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    ok(s.split(' ')
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(" "))
}
fn clean(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(ctx
        .text(&a[0])?
        .chars()
        .filter(|c| (*c as u32) >= 32)
        .collect::<String>())
}
fn text(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = ctx.scalar(&a[0]);
    if let Value::Error(e) = v {
        return Err(e);
    }
    let code = ctx.text(&a[1])?;
    let d1904 = ctx.date1904();
    // Numeric text is formatted as a number.
    let v = match &v {
        Value::Text(_) => match coerce_number_with(&v, d1904) {
            Ok(n) => Value::Number(n),
            Err(_) => v,
        },
        Value::Bool(_) => v,
        Value::Empty => Value::Number(0.0),
        _ => v,
    };
    let f = format_value(&v, &code, &NumLocale::default(), d1904);
    checked(f.text)
}
fn value(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let v = ctx.scalar(&a[0]);
    match v {
        Value::Number(n) => num(n),
        Value::Empty => num(0.0),
        Value::Bool(_) => Err(ErrorKind::Value),
        Value::Error(e) => Err(e),
        Value::Text(ref s) if s.trim().is_empty() => Err(ErrorKind::Value),
        other => num(coerce_number_with(&other, ctx.date1904())?),
    }
}
fn numbervalue(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let dec = ctx.opt_text(a, 1, ".")?.chars().next().unwrap_or('.');
    let grp = ctx.opt_text(a, 2, ",")?.chars().next().unwrap_or(',');
    if dec == grp {
        return Err(ErrorKind::Value);
    }
    let cleaned: String = s
        .chars()
        .filter(|c| !c.is_whitespace() && *c != grp)
        .map(|c| if c == dec { '.' } else { c })
        .collect();
    if cleaned.is_empty() {
        return num(0.0);
    }
    let pct = cleaned.chars().rev().take_while(|c| *c == '%').count();
    let body = &cleaned[..cleaned.len() - pct];
    let mut x = crate::value::parse_number_text(body).ok_or(ErrorKind::Value)?;
    for _ in 0..pct {
        x /= 100.0;
    }
    num(x)
}
fn fixed(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let d = ctx.opt_num(a, 1, 2.0)?.trunc().clamp(-127.0, 127.0);
    let no_commas = ctx.opt_bool(a, 2, false)?;
    let r = super::math::round_half_away(x, d);
    let dd = d.max(0.0) as usize;
    let int = if no_commas { "0" } else { "#,##0" };
    let code = if dd > 0 {
        format!("{int}.{}", "0".repeat(dd))
    } else {
        int.to_string()
    };
    ok(format_number_with_code(r, &code, &NumLocale::default()))
}
fn dollar(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let x = ctx.num(&a[0])?;
    let d = ctx.opt_num(a, 1, 2.0)?.trunc().clamp(-127.0, 127.0);
    let r = super::math::round_half_away(x, d);
    let dd = d.max(0.0) as usize;
    let body = if dd > 0 {
        format!("$#,##0.{}", "0".repeat(dd))
    } else {
        "$#,##0".to_string()
    };
    let code = format!("{body}_);({body})");
    let s = format_number_with_code(r, &code, &NumLocale::default());
    ok(s.trim_end().to_string())
}
fn exact(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    ok(ctx.text(&a[0])? == ctx.text(&a[1])?)
}
fn rept(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let n = ctx.num(&a[1])?.trunc();
    if n < 0.0 {
        return Err(ErrorKind::Value);
    }
    if (s.chars().count() as f64) * n > MAX_TEXT_LEN as f64 {
        return Err(ErrorKind::Value);
    }
    ok(s.repeat(n as usize))
}

const CP1252: [u32; 32] = [
    0x20AC, 0x81, 0x201A, 0x0192, 0x201E, 0x2026, 0x2020, 0x2021, 0x02C6, 0x2030, 0x0160, 0x2039,
    0x0152, 0x8D, 0x017D, 0x8F, 0x90, 0x2018, 0x2019, 0x201C, 0x201D, 0x2022, 0x2013, 0x2014,
    0x02DC, 0x2122, 0x0161, 0x203A, 0x0153, 0x9D, 0x017E, 0x0178,
];

/// Windows-1252 byte → char.
pub fn cp1252_char(b: u8) -> char {
    let cp = if (0x80..0xA0).contains(&b) {
        CP1252[(b - 0x80) as usize]
    } else {
        b as u32
    };
    char::from_u32(cp).unwrap_or('?')
}

fn char_fn(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let n = ctx.num(&a[0])?.trunc();
    if !(1.0..=255.0).contains(&n) {
        return Err(ErrorKind::Value);
    }
    ok(cp1252_char(n as u8).to_string())
}
fn code(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let c = s.chars().next().ok_or(ErrorKind::Value)?;
    let cp = c as u32;
    if cp < 0x80 || (0xA0..=0xFF).contains(&cp) {
        return num(cp as f64);
    }
    match CP1252.iter().position(|x| *x == cp) {
        Some(i) => num(0x80 as f64 + i as f64),
        None => num(63.0),
    }
}
fn unichar(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let n = ctx.num(&a[0])?.trunc();
    if n < 1.0 {
        return Err(ErrorKind::Value);
    }
    match char::from_u32(n as u32) {
        Some(c) => ok(c.to_string()),
        None => Err(ErrorKind::NA),
    }
}
fn unicode(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let s = ctx.text(&a[0])?;
    let c = s.chars().next().ok_or(ErrorKind::Value)?;
    num(c as u32 as f64)
}
fn t(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    match ctx.scalar(&a[0]) {
        Value::Text(s) => ok(Value::Text(s)),
        Value::Error(e) => Err(e),
        _ => ok(""),
    }
}

fn text_around(ctx: &mut EvalCtx, a: &[Ev], before: bool) -> R {
    let s = ctx.text(&a[0])?;
    let d = ctx.text(&a[1])?;
    let n = ctx.opt_num(a, 2, 1.0)?.trunc() as i64;
    let ci = ctx.opt_num(a, 3, 0.0)? == 1.0;
    let match_end = ctx.opt_num(a, 4, 0.0)? == 1.0;
    let not_found = |ctx: &mut EvalCtx| -> R {
        match a.get(5) {
            None | Some(Ev::Missing) => Err(ErrorKind::NA),
            Some(ev) => ok(ctx.scalar(ev)),
        }
    };
    if n == 0 || n.unsigned_abs() as usize > s.len() + 1 {
        return Err(ErrorKind::Value);
    }
    if d.is_empty() {
        return if before {
            ok(if n > 0 { String::new() } else { s })
        } else {
            ok(if n > 0 { s } else { String::new() })
        };
    }
    let hay = if ci { s.to_lowercase() } else { s.clone() };
    let nd = if ci { d.to_lowercase() } else { d.clone() };
    let mut positions: Vec<usize> = hay.match_indices(&nd).map(|(i, _)| i).collect();
    if match_end {
        positions.push(hay.len());
        if n < 0 {
            positions.insert(0, 0);
            positions.pop();
            positions.push(hay.len());
        }
    }
    let idx = if n > 0 {
        positions.get(n as usize - 1).copied()
    } else {
        let k = (-n) as usize;
        if k <= positions.len() {
            Some(positions[positions.len() - k])
        } else {
            None
        }
    };
    let Some(p) = idx else {
        return not_found(ctx);
    };
    if before {
        ok(s.get(..p).unwrap_or("").to_string())
    } else {
        let start = (p + nd.len()).min(s.len());
        ok(s.get(start..).unwrap_or("").to_string())
    }
}
fn textbefore(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    text_around(ctx, a, true)
}
fn textafter(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    text_around(ctx, a, false)
}

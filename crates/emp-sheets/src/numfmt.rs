//! Excel number formats (SPEC §14.4): sections `pos;neg;zero;text`, digit placeholders `0 # ?`, `.`, `,`
//! (thousands and scaling), `%`, `E+`, literals, colours, conditions, date/time tokens (`[h]` elapsed),
//! fractions, and built-in format ids 0–49. All display strings are produced here.

use crate::datetime::{serial_to_ymd, time_fraction_to_seconds};
use crate::value::{Value, number_to_text, round_sig15};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};

/// Locale-dependent separators.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumLocale {
    /// Decimal separator.
    pub decimal: char,
    /// Thousands separator.
    pub thousands: char,
}

impl Default for NumLocale {
    fn default() -> Self {
        NumLocale {
            decimal: '.',
            thousands: ',',
        }
    }
}

/// A formatted value: text plus an optional colour from `[Red]` / `[Color n]`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Formatted {
    /// Display text.
    pub text: String,
    /// Colour name (`red`, `blue`, …) or `#RRGGBB` for `[Color n]`.
    pub color: Option<String>,
}

/// Standard code for a built-in format id (0–49).
pub fn builtin_format(id: u32) -> Option<&'static str> {
    Some(match id {
        0 => "General",
        1 => "0",
        2 => "0.00",
        3 => "#,##0",
        4 => "#,##0.00",
        5 => "\"$\"#,##0_);(\"$\"#,##0)",
        6 => "\"$\"#,##0_);[Red](\"$\"#,##0)",
        7 => "\"$\"#,##0.00_);(\"$\"#,##0.00)",
        8 => "\"$\"#,##0.00_);[Red](\"$\"#,##0.00)",
        9 => "0%",
        10 => "0.00%",
        11 => "0.00E+00",
        12 => "# ?/?",
        13 => "# ??/??",
        14 => "m/d/yyyy",
        15 => "d-mmm-yy",
        16 => "d-mmm",
        17 => "mmm-yy",
        18 => "h:mm AM/PM",
        19 => "h:mm:ss AM/PM",
        20 => "h:mm",
        21 => "h:mm:ss",
        22 => "m/d/yyyy h:mm",
        23..=36 => "General",
        37 => "#,##0 ;(#,##0)",
        38 => "#,##0 ;[Red](#,##0)",
        39 => "#,##0.00;(#,##0.00)",
        40 => "#,##0.00;[Red](#,##0.00)",
        41 => "_(* #,##0_);_(* (#,##0);_(* \"-\"_);_(@_)",
        42 => "_(\"$\"* #,##0_);_(\"$\"* (#,##0);_(\"$\"* \"-\"_);_(@_)",
        43 => "_(* #,##0.00_);_(* (#,##0.00);_(* \"-\"??_);_(@_)",
        44 => "_(\"$\"* #,##0.00_);_(\"$\"* (#,##0.00);_(\"$\"* \"-\"??_);_(@_)",
        45 => "mm:ss",
        46 => "[h]:mm:ss",
        47 => "mmss.0",
        48 => "##0.0E+0",
        49 => "@",
        _ => return None,
    })
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Digit {
    Zero,
    Hash,
    Q,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum DatePart {
    Year(usize),
    Month(usize),
    Day(usize),
    Hour(usize),
    Minute(usize),
    Second(usize),
    ElapsedH(usize),
    ElapsedM(usize),
    ElapsedS(usize),
    AmPm(bool, bool), // (full "AM/PM", lowercase)
    SubSec(usize),
}

#[derive(Clone, Debug, PartialEq)]
enum Tok {
    Lit(String),
    Digit(Digit),
    Dot,
    Comma,
    Percent,
    Exp(bool),
    Text,
    Date(DatePart),
    Slash,
    General,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum CondOp {
    Lt,
    Le,
    Gt,
    Ge,
    Eq,
    Ne,
}

#[derive(Clone, Debug, Default)]
struct Section {
    toks: Vec<Tok>,
    color: Option<String>,
    cond: Option<(CondOp, f64)>,
}

impl Section {
    fn is_date(&self) -> bool {
        self.toks.iter().any(|t| matches!(t, Tok::Date(_)))
    }
    fn has_text(&self) -> bool {
        self.toks.iter().any(|t| matches!(t, Tok::Text))
    }
    fn is_general(&self) -> bool {
        self.toks.iter().any(|t| matches!(t, Tok::General))
    }
    fn has_digits(&self) -> bool {
        self.toks.iter().any(|t| matches!(t, Tok::Digit(_)))
    }
}

/// A parsed number format.
#[derive(Clone, Debug)]
pub struct NumberFormat {
    sections: Vec<Section>,
}

const COLORS: [(&str, &str); 8] = [
    ("black", "#000000"),
    ("blue", "#0000FF"),
    ("cyan", "#00FFFF"),
    ("green", "#00FF00"),
    ("magenta", "#FF00FF"),
    ("red", "#FF0000"),
    ("white", "#FFFFFF"),
    ("yellow", "#FFFF00"),
];

const PALETTE56: [&str; 56] = [
    "#000000", "#FFFFFF", "#FF0000", "#00FF00", "#0000FF", "#FFFF00", "#FF00FF", "#00FFFF",
    "#800000", "#008000", "#000080", "#808000", "#800080", "#008080", "#C0C0C0", "#808080",
    "#9999FF", "#993366", "#FFFFCC", "#CCFFFF", "#660066", "#FF8080", "#0066CC", "#CCCCFF",
    "#000080", "#FF00FF", "#FFFF00", "#00FFFF", "#800080", "#800000", "#008080", "#0000FF",
    "#00CCFF", "#CCFFFF", "#CCFFCC", "#FFFF99", "#99CCFF", "#FF99CC", "#CC99FF", "#FFCC99",
    "#3366FF", "#33CCCC", "#99CC00", "#FFCC00", "#FF9900", "#FF6600", "#666699", "#969696",
    "#003366", "#339966", "#003300", "#333300", "#993300", "#993366", "#333399", "#333333",
];

fn split_sections(code: &str) -> Vec<String> {
    let mut out = vec![String::new()];
    let mut chars = code.chars().peekable();
    let mut in_q = false;
    let mut in_b = false;
    while let Some(c) = chars.next() {
        let cur = out.last_mut();
        let Some(cur) = cur else { break };
        match c {
            '"' if !in_b => {
                in_q = !in_q;
                cur.push(c);
            }
            '\\' if !in_q => {
                cur.push(c);
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            '[' if !in_q => {
                in_b = true;
                cur.push(c);
            }
            ']' if !in_q => {
                in_b = false;
                cur.push(c);
            }
            ';' if !in_q && !in_b => out.push(String::new()),
            _ => cur.push(c),
        }
    }
    out
}

fn parse_section(src: &str) -> Section {
    let mut sec = Section::default();
    let ch: Vec<char> = src.chars().collect();
    let mut i = 0;
    let lower = |c: char| c.to_ascii_lowercase();
    while i < ch.len() {
        let c = ch[i];
        match c {
            '"' => {
                let mut s = String::new();
                i += 1;
                while i < ch.len() && ch[i] != '"' {
                    s.push(ch[i]);
                    i += 1;
                }
                i += 1;
                sec.toks.push(Tok::Lit(s));
                continue;
            }
            '\\' => {
                if i + 1 < ch.len() {
                    sec.toks.push(Tok::Lit(ch[i + 1].to_string()));
                }
                i += 2;
                continue;
            }
            '_' => {
                sec.toks.push(Tok::Lit(" ".into()));
                i += 2;
                continue;
            }
            '*' => {
                i += 2;
                continue;
            }
            '[' => {
                let end = ch[i..]
                    .iter()
                    .position(|x| *x == ']')
                    .map(|p| i + p)
                    .unwrap_or(ch.len());
                let inner: String = ch[i + 1..end.min(ch.len())].iter().collect();
                i = end + 1;
                let il = inner.to_ascii_lowercase();
                if let Some((_, hex)) = COLORS.iter().find(|(n, _)| *n == il) {
                    let _ = hex;
                    sec.color = Some(il);
                } else if let Some(n) = il.strip_prefix("color") {
                    if let Ok(k) = n.trim().parse::<usize>()
                        && (1..=56).contains(&k)
                    {
                        sec.color = Some(PALETTE56[k - 1].to_string());
                    }
                } else if il.starts_with('h') && il.chars().all(|x| x == 'h') {
                    sec.toks.push(Tok::Date(DatePart::ElapsedH(il.len())));
                } else if il.starts_with('m') && il.chars().all(|x| x == 'm') {
                    sec.toks.push(Tok::Date(DatePart::ElapsedM(il.len())));
                } else if il.starts_with('s') && il.chars().all(|x| x == 's') {
                    sec.toks.push(Tok::Date(DatePart::ElapsedS(il.len())));
                } else if let Some(rest) = inner.strip_prefix('$') {
                    let sym = rest.split('-').next().unwrap_or("");
                    if !sym.is_empty() {
                        sec.toks.push(Tok::Lit(sym.to_string()));
                    }
                } else {
                    let (op, rest) = if let Some(r) = inner.strip_prefix(">=") {
                        (CondOp::Ge, r)
                    } else if let Some(r) = inner.strip_prefix("<=") {
                        (CondOp::Le, r)
                    } else if let Some(r) = inner.strip_prefix("<>") {
                        (CondOp::Ne, r)
                    } else if let Some(r) = inner.strip_prefix('>') {
                        (CondOp::Gt, r)
                    } else if let Some(r) = inner.strip_prefix('<') {
                        (CondOp::Lt, r)
                    } else if let Some(r) = inner.strip_prefix('=') {
                        (CondOp::Eq, r)
                    } else {
                        continue;
                    };
                    if let Ok(v) = rest.trim().parse::<f64>() {
                        sec.cond = Some((op, v));
                    }
                }
                continue;
            }
            '0' => sec.toks.push(Tok::Digit(Digit::Zero)),
            '#' => sec.toks.push(Tok::Digit(Digit::Hash)),
            '?' => sec.toks.push(Tok::Digit(Digit::Q)),
            '.' => {
                // ".0" after seconds is sub-second.
                let after_secs = sec
                    .toks
                    .iter()
                    .rev()
                    .find(|t| !matches!(t, Tok::Lit(_)))
                    .is_some_and(|t| {
                        matches!(
                            t,
                            Tok::Date(DatePart::Second(_)) | Tok::Date(DatePart::ElapsedS(_))
                        )
                    });
                if after_secs && ch.get(i + 1) == Some(&'0') {
                    let mut n = 0;
                    while ch.get(i + 1 + n) == Some(&'0') {
                        n += 1;
                    }
                    sec.toks.push(Tok::Lit(".".into()));
                    sec.toks.push(Tok::Date(DatePart::SubSec(n)));
                    i += 1 + n;
                    continue;
                }
                sec.toks.push(Tok::Dot)
            }
            ',' => sec.toks.push(Tok::Comma),
            '%' => sec.toks.push(Tok::Percent),
            '@' => sec.toks.push(Tok::Text),
            '/' => sec.toks.push(Tok::Slash),
            'E' | 'e' if matches!(ch.get(i + 1), Some('+') | Some('-')) => {
                sec.toks.push(Tok::Exp(ch[i + 1] == '+'));
                i += 2;
                continue;
            }
            _ => {
                let lc = lower(c);
                let rest: String = ch[i..].iter().collect::<String>().to_ascii_lowercase();
                if rest.starts_with("general") {
                    sec.toks.push(Tok::General);
                    i += 7;
                    continue;
                }
                if rest.starts_with("am/pm") {
                    let lc_flag = ch[i].is_lowercase();
                    sec.toks.push(Tok::Date(DatePart::AmPm(true, lc_flag)));
                    i += 5;
                    continue;
                }
                if rest.starts_with("a/p") {
                    let lc_flag = ch[i].is_lowercase();
                    sec.toks.push(Tok::Date(DatePart::AmPm(false, lc_flag)));
                    i += 3;
                    continue;
                }
                if matches!(lc, 'y' | 'm' | 'd' | 'h' | 's') {
                    let mut n = 0;
                    while i + n < ch.len() && lower(ch[i + n]) == lc {
                        n += 1;
                    }
                    let part = match lc {
                        'y' => DatePart::Year(n),
                        'd' => DatePart::Day(n),
                        'h' => DatePart::Hour(n),
                        's' => DatePart::Second(n),
                        _ => DatePart::Month(n),
                    };
                    sec.toks.push(Tok::Date(part));
                    i += n;
                    continue;
                }
                sec.toks.push(Tok::Lit(c.to_string()));
            }
        }
        i += 1;
    }
    // Resolve m → minute when after an hour or before a second.
    let n = sec.toks.len();
    for k in 0..n {
        if let Tok::Date(DatePart::Month(len)) = sec.toks[k] {
            if len > 2 {
                continue;
            }
            let prev = sec.toks[..k].iter().rev().find_map(|t| match t {
                Tok::Date(p) => Some(*p),
                _ => None,
            });
            let next = sec.toks[k + 1..].iter().find_map(|t| match t {
                Tok::Date(p) => Some(*p),
                _ => None,
            });
            let after_hour = matches!(prev, Some(DatePart::Hour(_)) | Some(DatePart::ElapsedH(_)));
            let before_sec = matches!(
                next,
                Some(DatePart::Second(_)) | Some(DatePart::ElapsedS(_))
            );
            if after_hour || before_sec {
                sec.toks[k] = Tok::Date(DatePart::Minute(len));
            }
        }
    }
    // In a date section, digit-like characters (0, #, /, ., ,) are literals.
    if sec.is_date() {
        for t in sec.toks.iter_mut() {
            let lit = match t {
                Tok::Digit(Digit::Zero) => Some("0"),
                Tok::Digit(Digit::Hash) => Some("#"),
                Tok::Digit(Digit::Q) => Some("?"),
                Tok::Slash => Some("/"),
                Tok::Dot => Some("."),
                Tok::Comma => Some(","),
                Tok::Percent => Some("%"),
                _ => None,
            };
            if let Some(l) = lit {
                *t = Tok::Lit(l.into());
            }
        }
    } else if !sec.toks.iter().any(|t| matches!(t, Tok::Digit(_))) {
        for t in sec.toks.iter_mut() {
            let lit = match t {
                Tok::Slash => Some("/"),
                Tok::Dot => Some("."),
                Tok::Comma => Some(","),
                _ => None,
            };
            if let Some(l) = lit {
                *t = Tok::Lit(l.into());
            }
        }
    }
    sec
}

impl NumberFormat {
    /// Parse a format code (never fails; unknown characters are literals).
    pub fn parse(code: &str) -> NumberFormat {
        let mut sections: Vec<Section> = split_sections(code)
            .iter()
            .take(4)
            .map(|s| parse_section(s))
            .collect();
        if sections.is_empty() {
            sections.push(Section {
                toks: vec![Tok::General],
                ..Default::default()
            });
        }
        NumberFormat { sections }
    }

    /// Does the format display dates or times?
    pub fn is_date(&self) -> bool {
        self.sections.first().is_some_and(|s| s.is_date())
    }

    /// Format a value.
    pub fn format(&self, v: &Value, loc: &NumLocale, date1904: bool) -> Formatted {
        match v {
            Value::Number(x) => self.format_number(*x, loc, date1904),
            Value::Text(s) => {
                let sec = if self.sections.len() >= 4 {
                    Some(&self.sections[3])
                } else if self.sections.len() == 1 && self.sections[0].has_text() {
                    Some(&self.sections[0])
                } else {
                    None
                };
                match sec {
                    Some(sec) => {
                        let mut out = String::new();
                        for t in &sec.toks {
                            match t {
                                Tok::Text => out.push_str(s),
                                Tok::Lit(l) => out.push_str(l),
                                _ => {}
                            }
                        }
                        Formatted {
                            text: out,
                            color: sec.color.clone(),
                        }
                    }
                    None => Formatted {
                        text: s.to_string(),
                        color: None,
                    },
                }
            }
            Value::Empty => Formatted {
                text: String::new(),
                color: None,
            },
            other => Formatted {
                text: other.display(),
                color: None,
            },
        }
    }

    fn pick(&self, x: f64) -> (&Section, bool) {
        // returns (section, show_minus)
        let s = &self.sections;
        if s.iter().take(3).any(|sec| sec.cond.is_some()) {
            for sec in s.iter().take(3) {
                if let Some((op, v)) = sec.cond {
                    let hit = match op {
                        CondOp::Lt => x < v,
                        CondOp::Le => x <= v,
                        CondOp::Gt => x > v,
                        CondOp::Ge => x >= v,
                        CondOp::Eq => x == v,
                        CondOp::Ne => x != v,
                    };
                    if hit {
                        return (sec, x < 0.0 && !(op == CondOp::Lt || op == CondOp::Le));
                    }
                } else {
                    return (sec, x < 0.0);
                }
            }
            return (&s[0], x < 0.0);
        }
        let text_only = |sec: &Section| {
            sec.has_text() && !sec.has_digits() && !sec.is_date() && !sec.is_general()
        };
        match s.len() {
            1 => (&s[0], x < 0.0),
            2 => {
                if x < 0.0 {
                    (&s[1], false)
                } else {
                    (&s[0], false)
                }
            }
            _ => {
                if x > 0.0 {
                    (&s[0], false)
                } else if x < 0.0 {
                    (&s[1], false)
                } else if text_only(&s[2]) {
                    (&s[0], false)
                } else {
                    (&s[2], false)
                }
            }
        }
    }

    fn format_number(&self, x: f64, loc: &NumLocale, date1904: bool) -> Formatted {
        let (sec, minus) = self.pick(x);
        let color = sec.color.clone();
        if sec.is_general() && !sec.has_digits() {
            let body = general(x.abs(), loc);
            let mut out = String::new();
            if minus || (self.sections.len() == 1 && x < 0.0) {
                out.push('-');
            }
            for t in &sec.toks {
                match t {
                    Tok::General => out.push_str(&body),
                    Tok::Lit(l) => out.push_str(l),
                    _ => {}
                }
            }
            return Formatted { text: out, color };
        }
        if sec.is_date() {
            return Formatted {
                text: format_date(sec, x, date1904),
                color,
            };
        }
        let text = format_numeric(sec, x.abs(), loc);
        let text = if minus && !is_all_zero(&text) {
            format!("-{text}")
        } else {
            text
        };
        Formatted { text, color }
    }
}

fn is_all_zero(s: &str) -> bool {
    !s.chars().any(|c| c.is_ascii_digit() && c != '0')
}

/// General format: up to 15 significant digits, scientific when very large or small.
pub fn general(x: f64, loc: &NumLocale) -> String {
    let s = number_to_text(x);
    if loc.decimal != '.' {
        s.replace('.', &loc.decimal.to_string())
    } else {
        s
    }
}

fn round_to(x: f64, digits: usize) -> f64 {
    let s = 10f64.powi(digits.min(300) as i32);
    let y = round_sig15(x * s);
    let r = y.round() / s;
    if r.is_finite() { r } else { x }
}

fn format_numeric(sec: &Section, mut x: f64, loc: &NumLocale) -> String {
    let toks = &sec.toks;
    if toks.iter().any(|t| matches!(t, Tok::Slash))
        && let Some(s) = format_fraction(sec, x, loc)
    {
        return s;
    }
    let pct = toks.iter().filter(|t| matches!(t, Tok::Percent)).count();
    for _ in 0..pct {
        x *= 100.0;
    }
    let exp_pos = toks.iter().position(|t| matches!(t, Tok::Exp(_)));
    let dot_pos = toks.iter().position(|t| matches!(t, Tok::Dot));
    let mantissa_end = exp_pos.unwrap_or(toks.len());
    let int_end = dot_pos.unwrap_or(mantissa_end).min(mantissa_end);
    // Thousands separator: a comma between digit placeholders in the integer part.
    let first_digit = toks.iter().position(|t| matches!(t, Tok::Digit(_)));
    let last_int_digit = toks[..int_end]
        .iter()
        .rposition(|t| matches!(t, Tok::Digit(_)));
    let mut thousands = false;
    let mut scale = 0;
    if let (Some(f), Some(l)) = (first_digit, last_int_digit) {
        thousands = toks[f..l].iter().any(|t| matches!(t, Tok::Comma));
        // Scaling commas directly after the last integer digit (before '.' or end), or after the last
        // fraction digit.
        let mut k = l + 1;
        while k < toks.len() && matches!(toks[k], Tok::Comma) {
            scale += 1;
            k += 1;
        }
        if let Some(lf) = toks[..mantissa_end]
            .iter()
            .rposition(|t| matches!(t, Tok::Digit(_)))
            && lf > l
        {
            let mut k = lf + 1;
            while k < toks.len() && matches!(toks[k], Tok::Comma) {
                scale += 1;
                k += 1;
            }
        }
    } else if first_digit.is_none() {
        // no digits at all: just literals
        let mut out = String::new();
        for t in toks {
            match t {
                Tok::Lit(l) => out.push_str(l),
                Tok::Percent => out.push('%'),
                _ => {}
            }
        }
        return out;
    }
    for _ in 0..scale {
        x /= 1000.0;
    }
    let int_ph: Vec<Digit> = toks[..int_end]
        .iter()
        .filter_map(|t| {
            if let Tok::Digit(d) = t {
                Some(*d)
            } else {
                None
            }
        })
        .collect();
    let frac_ph: Vec<Digit> = match dot_pos {
        Some(d) if d < mantissa_end => toks[d + 1..mantissa_end]
            .iter()
            .filter_map(|t| {
                if let Tok::Digit(d) = t {
                    Some(*d)
                } else {
                    None
                }
            })
            .collect(),
        _ => Vec::new(),
    };
    // Exponent
    let mut exp_val: i32 = 0;
    let mut exp_digits: Vec<Digit> = Vec::new();
    if let Some(ep) = exp_pos {
        exp_digits = toks[ep + 1..]
            .iter()
            .filter_map(|t| {
                if let Tok::Digit(d) = t {
                    Some(*d)
                } else {
                    None
                }
            })
            .collect();
        if x != 0.0 {
            let n_int = int_ph.len().max(1) as i32;
            let e = x.log10().floor() as i32;
            let step = if int_ph.len() > 1 && int_ph.contains(&Digit::Hash) {
                n_int
            } else {
                1
            };
            exp_val = if step > 1 {
                e.div_euclid(step) * step
            } else {
                e - (int_ph.iter().filter(|d| **d == Digit::Zero).count().max(1) as i32 - 1)
            };
            x /= 10f64.powi(exp_val);
            // Rounding may push the mantissa to the next power.
            let r = round_to(x, frac_ph.len());
            if step == 1
                && r >= 10f64
                    .powi(int_ph.iter().filter(|d| **d == Digit::Zero).count().max(1) as i32)
            {
                exp_val += 1;
                x /= 10.0;
            }
        }
    }
    let r = round_to(x, frac_ph.len());
    let s = format!("{:.*}", frac_ph.len(), r);
    let (ip, fp) = match s.split_once('.') {
        Some((a, b)) => (a.to_string(), b.to_string()),
        None => (s.clone(), String::new()),
    };
    let ip = ip.trim_start_matches('0').to_string();
    // Pad with zeros to the number of '0' placeholders from the first zero.
    let first_zero = int_ph.iter().position(|d| *d == Digit::Zero);
    let min_len = first_zero.map(|z| int_ph.len() - z).unwrap_or(0);
    let mut full = ip.clone();
    while full.len() < min_len {
        full.insert(0, '0');
    }
    let full: Vec<char> = full.chars().collect();
    let p = int_ph.len() as i64;
    let d = full.len() as i64;
    // fraction digits
    let fchars: Vec<char> = fp.chars().collect();
    let mut frac_out: Vec<String> = Vec::new();
    // trailing zeros of '#' / '?' placeholders
    let mut keep = fchars.len();
    while keep > 0
        && fchars[keep - 1] == '0'
        && frac_ph.get(keep - 1).is_some_and(|d| *d != Digit::Zero)
    {
        keep -= 1;
    }
    for (i, ph) in frac_ph.iter().enumerate() {
        if i < keep {
            frac_out.push(fchars[i].to_string());
        } else {
            frac_out.push(match ph {
                Digit::Zero => "0".into(),
                Digit::Hash => String::new(),
                Digit::Q => " ".into(),
            });
        }
    }
    let mut out = String::new();
    let mut int_k = 0i64;
    let mut frac_k = 0usize;
    let mut exp_k = 0usize;
    let exp_str: Vec<char> = {
        let e = exp_val.abs().to_string();
        let min = exp_digits.iter().filter(|d| **d == Digit::Zero).count();
        let mut e = e;
        while e.len() < min {
            e.insert(0, '0');
        }
        e.chars().collect()
    };
    let emit_digit = |out: &mut String, j: i64| {
        out.push(full[j as usize]);
        let remaining = d - j - 1;
        if thousands && remaining > 0 && remaining % 3 == 0 {
            out.push(loc.thousands);
        }
    };
    let mut after_dot = false;
    let mut after_exp = false;
    for (ti, t) in toks.iter().enumerate() {
        match t {
            Tok::Lit(l) => out.push_str(l),
            Tok::Percent => out.push('%'),
            Tok::Comma => {}
            Tok::Dot if !after_exp => {
                after_dot = true;
                // Hide the point when no fraction digit is shown ("#.##" for 1 → "1.")
                out.push(loc.decimal);
            }
            Tok::Exp(plus) => {
                after_exp = true;
                out.push('E');
                if exp_val < 0 {
                    out.push('-');
                } else if *plus {
                    out.push('+');
                }
            }
            Tok::Digit(ph) => {
                if after_exp {
                    // exponent digits: overflow on the first
                    let n = exp_digits.len();
                    let len = exp_str.len();
                    let idx = len as i64 - n as i64 + exp_k as i64;
                    if exp_k == 0 && idx > 0 {
                        out.extend(exp_str[..=idx as usize].iter());
                    } else if idx >= 0 {
                        out.push(exp_str[idx as usize]);
                    } else if *ph == Digit::Q {
                        out.push(' ');
                    }
                    exp_k += 1;
                } else if after_dot && ti < mantissa_end {
                    if let Some(s) = frac_out.get(frac_k) {
                        out.push_str(s);
                    }
                    frac_k += 1;
                } else {
                    let idx = d - p + int_k;
                    if int_k == 0 && idx > 0 {
                        for j in 0..=idx {
                            emit_digit(&mut out, j);
                        }
                    } else if idx >= 0 {
                        emit_digit(&mut out, idx);
                    } else if *ph == Digit::Q {
                        out.push(' ');
                    }
                    int_k += 1;
                }
            }
            _ => {}
        }
    }
    out
}

fn format_fraction(sec: &Section, x: f64, _loc: &NumLocale) -> Option<String> {
    let toks = &sec.toks;
    let slash = toks.iter().position(|t| matches!(t, Tok::Slash))?;
    // numerator digits: contiguous digit run immediately before slash
    let mut ns = slash;
    while ns > 0 && matches!(toks[ns - 1], Tok::Digit(_)) {
        ns -= 1;
    }
    if ns == slash {
        return None;
    }
    let num_ph = slash - ns;
    // denominator: digits after slash (placeholders) or a literal number
    let mut de = slash + 1;
    let mut den_text = String::new();
    let mut den_ph = 0;
    while de < toks.len() {
        match &toks[de] {
            Tok::Digit(Digit::Zero) if den_ph == 0 && !den_text.is_empty() => den_text.push('0'),
            Tok::Digit(_) => den_ph += 1,
            Tok::Lit(l) if den_ph == 0 && l.chars().all(|c| c.is_ascii_digit()) => {
                den_text.push_str(l)
            }
            _ => break,
        }
        de += 1;
    }
    let fixed_den: Option<u64> = den_text.parse().ok().filter(|d: &u64| *d > 0);
    // Integer part: digit placeholders before the numerator group (separated by a literal).
    let has_int = toks[..ns].iter().any(|t| matches!(t, Tok::Digit(_)));
    let (int_part, frac) = if has_int {
        (x.trunc(), x - x.trunc())
    } else {
        (0.0, x)
    };
    let (mut n, mut d) = match fixed_den {
        Some(fd) => (((frac * fd as f64).round()) as u64, fd),
        None => {
            let maxd = 10u64.pow(den_ph.clamp(1, 4) as u32) - 1;
            let mut best = (0u64, 1u64, f64::INFINITY);
            for dd in 1..=maxd {
                let nn = (frac * dd as f64).round();
                let err = (frac - nn / dd as f64).abs();
                if err < best.2 - 1e-12 {
                    best = (nn as u64, dd, err);
                }
            }
            (best.0, best.1)
        }
    };
    let mut ip = int_part;
    if has_int && n == d && n > 0 {
        ip += 1.0;
        n = 0;
    }
    if fixed_den.is_none() && n == 0 {
        d = 1;
    }
    let pad = |s: String, w: usize, left: bool| -> String {
        if s.len() >= w {
            s
        } else if left {
            format!("{}{}", " ".repeat(w - s.len()), s)
        } else {
            format!("{}{}", s, " ".repeat(w - s.len()))
        }
    };
    let mut out = String::new();
    // literals and int part before numerator
    let int_tokens = &toks[..ns];
    let mut int_done = false;
    let num_str = if n == 0 && has_int {
        " ".repeat(num_ph)
    } else {
        pad(n.to_string(), num_ph, true)
    };
    let den_str = if n == 0 && has_int {
        " ".repeat(den_ph.max(den_text.len()))
    } else if fixed_den.is_some() {
        den_text.clone()
    } else {
        pad(d.to_string(), den_ph, false)
    };
    for t in int_tokens {
        match t {
            Tok::Lit(l) => out.push_str(l),
            Tok::Digit(_) if !int_done => {
                int_done = true;
                if ip != 0.0 || n == 0 {
                    out.push_str(&format!("{}", ip as i64));
                }
            }
            _ => {}
        }
    }
    if n == 0 && has_int {
        out.push_str(&num_str);
        out.push(' ');
        out.push_str(&den_str);
    } else {
        out.push_str(&num_str);
        out.push('/');
        out.push_str(&den_str);
    }
    for t in &toks[de..] {
        if let Tok::Lit(l) = t {
            out.push_str(l);
        }
    }
    Some(out)
}

const MONTH_NAMES: [&str; 12] = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
];
const DAY_NAMES: [&str; 7] = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
];

fn format_date(sec: &Section, x: f64, date1904: bool) -> String {
    if x < 0.0 {
        return "#".repeat(8);
    }
    let subsec_digits = sec.toks.iter().find_map(|t| {
        if let Tok::Date(DatePart::SubSec(n)) = t {
            Some(*n)
        } else {
            None
        }
    });
    let has_seconds = sec.toks.iter().any(|t| {
        matches!(
            t,
            Tok::Date(DatePart::Second(_)) | Tok::Date(DatePart::ElapsedS(_))
        )
    });
    // Round to the displayed precision.
    let unit = match subsec_digits {
        Some(n) => 86_400.0 * 10f64.powi(n as i32),
        None => 86_400.0,
    };
    let xr = (x * unit).round() / unit;
    let _ = has_seconds;
    let Some((y, m, d)) = serial_to_ymd(xr, date1904) else {
        return "#".repeat(8);
    };
    let secs_total = time_fraction_to_seconds(xr) as u64;
    let (hh, mi, ss) = (
        (secs_total / 3600) % 24,
        (secs_total / 60) % 60,
        secs_total % 60,
    );
    let ampm = sec
        .toks
        .iter()
        .any(|t| matches!(t, Tok::Date(DatePart::AmPm(..))));
    let weekday = {
        let s = xr.floor() as i64;
        let base = if date1904 { s + 5 } else { s + 6 };
        base.rem_euclid(7) as usize
    };
    let mut out = String::new();
    for t in &sec.toks {
        match t {
            Tok::Lit(l) => out.push_str(l),
            Tok::Date(p) => match *p {
                DatePart::Year(n) => {
                    if n <= 2 {
                        out.push_str(&format!("{:02}", y.rem_euclid(100)));
                    } else {
                        out.push_str(&format!("{y:04}"));
                    }
                }
                DatePart::Month(n) => {
                    let name = MONTH_NAMES[(m as usize).saturating_sub(1).min(11)];
                    match n {
                        1 => out.push_str(&m.to_string()),
                        2 => out.push_str(&format!("{m:02}")),
                        3 => out.push_str(&name[..3]),
                        5 => out.push_str(&name[..1]),
                        _ => out.push_str(name),
                    }
                }
                DatePart::Day(n) => match n {
                    1 => out.push_str(&d.to_string()),
                    2 => out.push_str(&format!("{d:02}")),
                    3 => out.push_str(&DAY_NAMES[weekday][..3]),
                    _ => out.push_str(DAY_NAMES[weekday]),
                },
                DatePart::Hour(n) => {
                    let h = if ampm {
                        let h12 = hh % 12;
                        if h12 == 0 { 12 } else { h12 }
                    } else {
                        hh
                    };
                    if n >= 2 {
                        out.push_str(&format!("{h:02}"));
                    } else {
                        out.push_str(&h.to_string());
                    }
                }
                DatePart::Minute(n) => {
                    if n >= 2 {
                        out.push_str(&format!("{mi:02}"));
                    } else {
                        out.push_str(&mi.to_string());
                    }
                }
                DatePart::Second(n) => {
                    if n >= 2 {
                        out.push_str(&format!("{ss:02}"));
                    } else {
                        out.push_str(&ss.to_string());
                    }
                }
                DatePart::ElapsedH(n) => {
                    let h = (xr * 24.0 + 1e-9).floor() as i64;
                    out.push_str(&format!("{h:0n$}"));
                }
                DatePart::ElapsedM(n) => {
                    let v = (xr * 1440.0 + 1e-9).floor() as i64;
                    out.push_str(&format!("{v:0n$}"));
                }
                DatePart::ElapsedS(n) => {
                    let v = (xr * 86_400.0 + 1e-9).floor() as i64;
                    out.push_str(&format!("{v:0n$}"));
                }
                DatePart::AmPm(full, lower) => {
                    let pm = hh >= 12;
                    let s = match (full, pm) {
                        (true, false) => "AM",
                        (true, true) => "PM",
                        (false, false) => "A",
                        (false, true) => "P",
                    };
                    if lower {
                        out.push_str(&s.to_lowercase());
                    } else {
                        out.push_str(s);
                    }
                }
                DatePart::SubSec(n) => {
                    let frac = (xr * 86_400.0).fract();
                    let v = (frac * 10f64.powi(n as i32)).round() as u64;
                    out.push_str(&format!("{v:0n$}"));
                }
            },
            _ => {}
        }
    }
    out
}

fn cache() -> &'static Mutex<HashMap<String, Arc<NumberFormat>>> {
    static C: OnceLock<Mutex<HashMap<String, Arc<NumberFormat>>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Parse with a small process-wide cache.
pub fn cached(code: &str) -> Arc<NumberFormat> {
    if let Ok(mut g) = cache().lock() {
        if let Some(f) = g.get(code) {
            return f.clone();
        }
        let f = Arc::new(NumberFormat::parse(code));
        if g.len() > 1024 {
            g.clear();
        }
        g.insert(code.to_string(), f.clone());
        return f;
    }
    Arc::new(NumberFormat::parse(code))
}

/// Format a value with a format code.
pub fn format_value(v: &Value, code: &str, loc: &NumLocale, date1904: bool) -> Formatted {
    if code.is_empty() || code.eq_ignore_ascii_case("general") {
        return match v {
            Value::Number(x) => Formatted {
                text: general(*x, loc),
                color: None,
            },
            other => Formatted {
                text: other.display(),
                color: None,
            },
        };
    }
    cached(code).format(v, loc, date1904)
}

/// Format a number with a code, returning only the text.
pub fn format_number_with_code(x: f64, code: &str, loc: &NumLocale) -> String {
    format_value(&Value::Number(x), code, loc, false).text
}

/// Does the format code display a date or time?
pub fn is_date_format(code: &str) -> bool {
    !code.is_empty() && cached(code).is_date()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(x: f64, code: &str) -> String {
        format_number_with_code(x, code, &NumLocale::default())
    }

    #[test]
    fn numbers() {
        assert_eq!(f(1234.567, "0"), "1235");
        assert_eq!(f(1234.567, "0.00"), "1234.57");
        assert_eq!(f(1234.567, "#,##0"), "1,235");
        assert_eq!(f(1234567.891, "#,##0.00"), "1,234,567.89");
        assert_eq!(f(0.5, "#.##"), ".5");
        assert_eq!(f(0.0, "#,##0"), "0");
        assert_eq!(f(5.0, "000"), "005");
        assert_eq!(f(-5.0, "0"), "-5");
        assert_eq!(f(0.256, "0%"), "26%");
        assert_eq!(f(0.256, "0.0%"), "25.6%");
        assert_eq!(f(1234567.0, "#,##0,"), "1,235");
        assert_eq!(f(1234567.0, "0.0,,\"M\""), "1.2M");
        assert_eq!(f(2.675, "0.00"), "2.68");
        assert_eq!(f(1.5, "0.0#"), "1.5");
        assert_eq!(f(1.5, "0.??"), "1.5 ");
        assert_eq!(f(5551234567.0, "(000) 000-0000"), "(555) 123-4567");
        assert_eq!(f(12345.678, "0.00E+00"), "1.23E+04");
        assert_eq!(f(0.000123, "0.00E+00"), "1.23E-04");
        assert_eq!(f(12345.0, "##0.0E+0"), "12.3E+3");
        assert_eq!(f(1234.5, "\"$\"#,##0.00"), "$1,234.50");
        assert_eq!(f(-1234.5, "\"$\"#,##0.00_);(\"$\"#,##0.00)"), "($1,234.50)");
        assert_eq!(f(1234.5, "\"$\"#,##0.00_);(\"$\"#,##0.00)"), "$1,234.50 ");
        assert_eq!(f(0.0, "0;-0;\"zero\""), "zero");
        assert_eq!(f(-3.0, "0;(0)"), "(3)");
        assert_eq!(f(1500.0, "[>=1000]#,##0,\"K\";0"), "2K");
        assert_eq!(f(500.0, "[>=1000]#,##0,\"K\";0"), "500");
        assert_eq!(f(1.0 / 3.0, "General"), "0.333333333333333");
        assert_eq!(f(-1.5, "General"), "-1.5");
    }

    #[test]
    fn fractions() {
        assert_eq!(f(1.5, "# ?/?"), "1 1/2");
        assert_eq!(f(0.75, "?/?"), "3/4");
        assert_eq!(f(3.14158, "# ??/??"), "3 14/99");
        assert_eq!(f(0.3, "# ?/8"), " 2/8");
        assert_eq!(f(2.0, "# ?/?"), "2    ");
    }

    #[test]
    fn dates() {
        let s = 45306.75; // 2024-01-15 18:00 (Monday)
        assert_eq!(f(s, "yyyy-mm-dd"), "2024-01-15");
        assert_eq!(f(s, "m/d/yyyy"), "1/15/2024");
        assert_eq!(f(s, "d-mmm-yy"), "15-Jan-24");
        assert_eq!(f(s, "dddd, mmmm d"), "Monday, January 15");
        assert_eq!(f(s, "h:mm AM/PM"), "6:00 PM");
        assert_eq!(f(s, "hh:mm:ss"), "18:00:00");
        assert_eq!(f(1.5, "[h]:mm"), "36:00");
        assert_eq!(f(0.000_011_574, "mm:ss.0"), "00:01.0");
        assert_eq!(f(60.0, "yyyy-mm-dd"), "1900-02-29");
        assert_eq!(f(s, "mmmmm"), "J");
        assert_eq!(f(s, "ddd"), "Mon");
        assert!(is_date_format("d-mmm-yy"));
        assert!(!is_date_format("0.00"));
    }

    #[test]
    fn text_and_colors() {
        let r = format_value(
            &Value::text("abc"),
            "0;0;0;\"[\"@\"]\"",
            &NumLocale::default(),
            false,
        );
        assert_eq!(r.text, "[abc]");
        let r = format_value(
            &Value::Number(-1.0),
            "0;[Red]-0",
            &NumLocale::default(),
            false,
        );
        assert_eq!(r.color.as_deref(), Some("red"));
        assert_eq!(r.text, "-1");
        let r = format_value(&Value::Bool(true), "0.00", &NumLocale::default(), false);
        assert_eq!(r.text, "TRUE");
        let de = NumLocale {
            decimal: ',',
            thousands: '.',
        };
        assert_eq!(format_number_with_code(1234.5, "#,##0.00", &de), "1.234,50");
    }

    #[test]
    fn builtins() {
        for id in 0..=49 {
            assert!(builtin_format(id).is_some());
        }
        assert_eq!(builtin_format(50), None);
        assert_eq!(f(0.5, builtin_format(10).unwrap_or("")), "50.00%");
    }
}

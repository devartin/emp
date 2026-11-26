//! Function registry (SPEC §14.3). The same `FnSpec` table backs evaluation, `sheet_functions()`,
//! autocomplete and the help panel.

use crate::ast::Expr;
use crate::eval::{Ev, EvalCtx, R};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;

pub mod date;
pub mod dynamic;
pub mod ext;
pub mod finance;
pub mod info;
pub mod logic;
pub mod lookup;
pub mod math;
pub mod stats;
pub mod text;

/// How an argument is passed to the implementation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArgKind {
    /// A scalar; multi-cell references and arrays are lifted element-wise.
    Value,
    /// Passed as-is (reference, array or scalar).
    Range,
}

/// Function implementation.
#[derive(Clone, Copy)]
pub enum FnImpl {
    /// Arguments are evaluated first.
    Eager(fn(&mut EvalCtx, &[Ev]) -> R),
    /// Arguments are passed unevaluated (IF, IFERROR, LET, …).
    Lazy(fn(&mut EvalCtx, &[Expr]) -> R),
}

/// Function category (help panel grouping).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Category {
    /// Math and trigonometry.
    Math,
    /// Statistical.
    Statistical,
    /// Logical.
    Logical,
    /// Lookup and reference.
    Lookup,
    /// Dynamic arrays.
    Dynamic,
    /// Text.
    Text,
    /// Date and time.
    Date,
    /// Financial.
    Financial,
    /// Information.
    Information,
    /// EMP extensions (market data).
    Emp,
}

impl Category {
    /// Display label.
    pub fn label(self) -> &'static str {
        match self {
            Category::Math => "Math",
            Category::Statistical => "Statistical",
            Category::Logical => "Logical",
            Category::Lookup => "Lookup and reference",
            Category::Dynamic => "Dynamic arrays",
            Category::Text => "Text",
            Category::Date => "Date and time",
            Category::Financial => "Financial",
            Category::Information => "Information",
            Category::Emp => "EMP",
        }
    }
}

/// Help text.
#[derive(Clone, Copy, Debug)]
pub struct FnDoc {
    /// `SUM(number1, [number2], …)`
    pub signature: &'static str,
    /// One-sentence description.
    pub description: &'static str,
    /// Example formula.
    pub example: &'static str,
}

/// A function's specification.
#[derive(Clone, Copy)]
pub struct FnSpec {
    /// Upper-case name.
    pub name: &'static str,
    /// Category.
    pub category: Category,
    /// Minimum argument count.
    pub min_args: usize,
    /// Maximum argument count.
    pub max_args: usize,
    /// Argument kinds; positions past the end cycle through `arg_kinds[repeat_from..]`.
    pub arg_kinds: &'static [ArgKind],
    /// Where the repeating tail of `arg_kinds` starts.
    pub repeat_from: usize,
    /// Recomputed on every recalculation.
    pub volatile: bool,
    /// May return a reference (INDEX, OFFSET, INDIRECT, CHOOSE, …).
    pub returns_ref: bool,
    /// Implementation.
    pub imp: FnImpl,
    /// Documentation.
    pub doc: FnDoc,
}

impl FnSpec {
    /// Kind of argument `i`.
    pub fn kind(&self, i: usize) -> ArgKind {
        let n = self.arg_kinds.len();
        if n == 0 {
            return ArgKind::Value;
        }
        if i < n {
            return self.arg_kinds[i];
        }
        let from = self.repeat_from.min(n - 1);
        let period = n - from;
        self.arg_kinds[from + (i - from) % period]
    }
}

/// Declare an eager function spec.
#[macro_export]
#[doc(hidden)]
macro_rules! fspec {
    ($name:literal, $cat:ident, $min:expr, $max:expr, [$($k:ident),*], $imp:expr, $sig:literal, $desc:literal, $ex:literal) => {
        $crate::functions::FnSpec {
            name: $name,
            category: $crate::functions::Category::$cat,
            min_args: $min,
            max_args: $max,
            arg_kinds: &[$($crate::functions::ArgKind::$k),*],
            repeat_from: usize::MAX,
            volatile: false,
            returns_ref: false,
            imp: $crate::functions::FnImpl::Eager($imp),
            doc: $crate::functions::FnDoc { signature: $sig, description: $desc, example: $ex },
        }
    };
}

/// Declare a lazy function spec.
#[macro_export]
#[doc(hidden)]
macro_rules! lspec {
    ($name:literal, $cat:ident, $min:expr, $max:expr, $imp:expr, $sig:literal, $desc:literal, $ex:literal) => {
        $crate::functions::FnSpec {
            name: $name,
            category: $crate::functions::Category::$cat,
            min_args: $min,
            max_args: $max,
            arg_kinds: &[],
            repeat_from: usize::MAX,
            volatile: false,
            returns_ref: false,
            imp: $crate::functions::FnImpl::Lazy($imp),
            doc: $crate::functions::FnDoc {
                signature: $sig,
                description: $desc,
                example: $ex,
            },
        }
    };
}

fn registry() -> &'static HashMap<&'static str, &'static FnSpec> {
    static REG: OnceLock<HashMap<&'static str, &'static FnSpec>> = OnceLock::new();
    REG.get_or_init(|| {
        let mut m = HashMap::new();
        for table in all_tables() {
            for s in table.iter() {
                m.insert(s.name, s);
            }
        }
        m
    })
}

fn all_tables() -> [&'static [FnSpec]; 10] {
    [
        math::SPECS,
        stats::SPECS,
        logic::SPECS,
        lookup::SPECS,
        dynamic::SPECS,
        text::SPECS,
        date::SPECS,
        finance::SPECS,
        info::SPECS,
        ext::SPECS,
    ]
}

/// Look up a function by (upper-case) name. `GOOGLEFINANCE` maps to `STOCK`.
pub fn lookup_function(name: &str) -> Option<&'static FnSpec> {
    let reg = registry();
    if let Some(s) = reg.get(name) {
        return Some(s);
    }
    let up = name.to_ascii_uppercase();
    let up = if up == "GOOGLEFINANCE" {
        "STOCK".to_string()
    } else {
        up
    };
    reg.get(up.as_str()).copied()
}

/// Is the function known to the engine?
pub fn is_supported(name: &str) -> bool {
    lookup_function(name).is_some()
}

/// All function specs, sorted by name.
pub fn all_functions() -> Vec<&'static FnSpec> {
    let mut v: Vec<&'static FnSpec> = registry().values().copied().collect();
    v.sort_by_key(|s| s.name);
    v
}

/// One argument in the help listing.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgInfo {
    /// Argument name.
    pub name: String,
    /// `[optional]` in the signature.
    pub optional: bool,
    /// Followed by `…` (repeatable).
    pub repeat: bool,
}

/// `sheet_functions()` row (IPC shape).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    /// Name.
    pub name: String,
    /// Category label.
    pub category: String,
    /// Signature.
    pub signature: String,
    /// Description.
    pub description: String,
    /// Example.
    pub example: String,
    /// Arguments parsed from the signature.
    pub args: Vec<ArgInfo>,
}

/// Parse `NAME(a, [b], [c], …)` into argument infos.
pub fn parse_signature_args(sig: &str) -> Vec<ArgInfo> {
    let inner = match (sig.find('('), sig.rfind(')')) {
        (Some(a), Some(b)) if b > a => &sig[a + 1..b],
        _ => return Vec::new(),
    };
    let mut out: Vec<ArgInfo> = Vec::new();
    for part in inner.split(',') {
        let p = part.trim();
        if p.is_empty() {
            continue;
        }
        if p == "…" || p == "..." {
            if let Some(last) = out.last_mut() {
                last.repeat = true;
            }
            continue;
        }
        let optional = p.starts_with('[');
        let name = p
            .trim_matches(|c| c == '[' || c == ']')
            .trim()
            .trim_end_matches('…')
            .trim()
            .to_string();
        out.push(ArgInfo {
            name,
            optional,
            repeat: p.ends_with('…'),
        });
    }
    out
}

/// The help listing for every function.
pub fn function_infos() -> Vec<FunctionInfo> {
    all_functions()
        .into_iter()
        .map(|s| FunctionInfo {
            name: s.name.to_string(),
            category: s.category.label().to_string(),
            signature: s.doc.signature.to_string(),
            description: s.doc.description.to_string(),
            example: s.doc.example.to_string(),
            args: parse_signature_args(s.doc.signature),
        })
        .collect()
}

// ---------------------------------------------------------------------------- shared helpers

use crate::value::{ErrorKind, Value};

/// Collect the numbers of all arguments (Excel aggregate semantics).
pub(crate) fn nums(ctx: &mut EvalCtx, args: &[Ev]) -> Result<Vec<f64>, ErrorKind> {
    ctx.collect_numbers(args)
}

/// Collect values for the `*A` functions: numbers, booleans as 1/0 and text as 0 (from refs), direct
/// text coerced.
pub(crate) fn nums_a(ctx: &mut EvalCtx, args: &[Ev]) -> Result<Vec<f64>, ErrorKind> {
    let mut out = Vec::new();
    let d1904 = ctx.date1904();
    for a in args {
        ctx.for_each_value(a, &mut |v, from_ref| {
            match v {
                Value::Number(n) => out.push(*n),
                Value::Bool(b) => out.push(if *b { 1.0 } else { 0.0 }),
                Value::Text(_) if from_ref => out.push(0.0),
                Value::Text(_) => out.push(crate::value::coerce_number_with(v, d1904)?),
                Value::Error(e) => return Err(*e),
                _ => {}
            }
            Ok(())
        })?;
    }
    Ok(out)
}

/// Numbers from an array argument where non-numbers are kept as `None` (for paired statistics).
pub(crate) fn num_or_none(ctx: &mut EvalCtx, ev: &Ev) -> Result<Vec<Option<f64>>, ErrorKind> {
    let arr = ctx.to_array(ev)?;
    let mut out = Vec::with_capacity(arr.len());
    for v in arr.data() {
        match v {
            Value::Number(n) => out.push(Some(*n)),
            Value::Error(e) => return Err(*e),
            _ => out.push(None),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_is_complete() {
        let names: Vec<&str> = all_functions().iter().map(|s| s.name).collect();
        for t in all_tables() {
            for s in t.iter() {
                assert!(s.min_args <= s.max_args, "{}", s.name);
                assert!(s.doc.signature.starts_with(s.name), "{} signature", s.name);
                assert!(!s.doc.description.is_empty(), "{}", s.name);
            }
        }
        assert!(names.len() > 230, "only {} functions", names.len());
        assert!(lookup_function("GOOGLEFINANCE").is_some());
        assert!(lookup_function("sum").is_some());
    }

    #[test]
    fn signature_parsing() {
        let a = parse_signature_args("SUM(number1, [number2], …)");
        assert_eq!(a.len(), 2);
        assert!(!a[0].optional);
        assert!(a[1].optional && a[1].repeat);
    }

    #[test]
    fn kind_cycles() {
        let s = lookup_function("SUMIFS");
        if let Some(s) = s {
            assert_eq!(s.kind(0), ArgKind::Range);
            assert_eq!(s.kind(1), ArgKind::Range);
            assert_eq!(s.kind(2), ArgKind::Value);
            assert_eq!(s.kind(3), ArgKind::Range);
            assert_eq!(s.kind(4), ArgKind::Value);
        }
    }
}

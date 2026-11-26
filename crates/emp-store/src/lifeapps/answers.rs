//! Wizard answers: resolution (quick / guided mode, defaults, recommendations), the Metric-dialect context and the
//! `${path}` / `{{expr}}` string templating used by template specs.
//!
//! **Flattening for the Metric dialect.** `answers.<id>` paths are one level deep (§14.7), so nested answers are
//! exposed flattened:
//! * scalars → `answers.<id>`;
//! * objects → `answers.<id>_<field>` (one level; nested objects recurse with `_`);
//! * lists → `answers.<id>` (a list of scalars), `answers.<id>_count`, and for every string element `s`
//!   `answers.<id>_<s> = true`; for lists of objects, every string field value `v` of field `f` gives
//!   `answers.<id>_<f>_<v> = true` and numeric fields give `answers.<id>_<f>_sum`.

use std::collections::{BTreeMap, HashMap};

use chrono::NaiveDate;
use emp_sheets::dialect::metric::{self, MetricContext};
use emp_sheets::dialect::{DateVal, RowValue};
use serde_json::{Map, Value};

use crate::lifeapps::manifest::LifeAppManifest;
use crate::lifeapps::recommend::{self, Recommendation};
use crate::{Result, StoreError};

/// Maximum serialized size of an answers object.
pub const MAX_ANSWERS_BYTES: usize = 256 * 1024;

/// Wizard mode.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    /// Only `quick:true` steps are asked; the rest take their default or recommendation.
    #[default]
    Quick,
    /// Every step is asked.
    Guided,
}

/// Answers after defaults and recommendations were applied.
#[derive(Clone, Debug, PartialEq)]
pub struct Resolved {
    /// The full answers object.
    pub answers: Map<String, Value>,
    /// Recommendations made for steps (shown with "Why?" chips).
    pub recommendations: Vec<(String, Recommendation)>,
}

/// Validates the size and shape of user answers.
pub fn check_answers(answers: &Map<String, Value>) -> Result<()> {
    let n = serde_json::to_vec(answers)?.len();
    if n > MAX_ANSWERS_BYTES {
        return Err(StoreError::TooLarge("answers"));
    }
    fn finite(v: &Value) -> bool {
        match v {
            Value::Number(n) => n.as_f64().is_some_and(f64::is_finite),
            Value::Array(a) => a.iter().all(finite),
            Value::Object(o) => o.values().all(finite),
            _ => true,
        }
    }
    if !answers.values().all(finite) {
        return Err(StoreError::invalid_field(
            "answers",
            "numbers must be finite",
        ));
    }
    Ok(())
}

/// Resolves answers for `mode`: user answers win; skipped steps (non-quick in quick mode, or unanswered) take
/// their recommendation (if the step has a recommender) or their default. Steps whose `when` is false are dropped.
pub fn resolve(
    m: &LifeAppManifest,
    user: &Map<String, Value>,
    mode: Mode,
    today: NaiveDate,
) -> Result<Resolved> {
    check_answers(user)?;
    // Recommenders see every answer the user gave plus the defaults of the remaining steps, so a recommendation
    // can depend on answers collected later in the wizard (the method step is asked before accounts).
    let mut base = user.clone();
    for step in &m.steps {
        if let Some(d) = &step.default {
            base.entry(step.id.clone()).or_insert_with(|| d.clone());
        }
    }
    let mut out = Map::new();
    let mut recs = Vec::new();
    for step in &m.steps {
        let ctx = AnswerContext::new(&out, today);
        if let Some(w) = &step.when
            && !metric::test(w, &ctx).unwrap_or(false)
        {
            continue;
        }
        // In quick mode non-quick steps are not shown; an answer supplied anyway (tune-up pre-fill) still wins.
        let _asked = mode == Mode::Guided || step.quick;
        let given = user.get(&step.id).filter(|v| !v.is_null()).cloned();
        let rec = step
            .recommend
            .as_deref()
            .and_then(|r| recommend::run(r, &base, today));
        if let Some(r) = &rec {
            recs.push((step.id.clone(), r.clone()));
        }
        let value = match given {
            Some(v) => Some(v),
            None => rec
                .map(|r| merge_recommendation(step.default.clone(), r.value))
                .or_else(|| step.default.clone()),
        };
        if let Some(v) = value {
            out.insert(step.id.clone(), v);
        }
    }
    // Answers to unknown steps are kept (forward compatible) but never override resolved ones.
    for (k, v) in user {
        out.entry(k.clone()).or_insert_with(|| v.clone());
    }
    Ok(Resolved {
        answers: out,
        recommendations: recs,
    })
}

/// A recommendation for an object-valued step only fills the recommended field.
fn merge_recommendation(default: Option<Value>, rec: Value) -> Value {
    match (default, rec) {
        (Some(Value::Object(mut d)), Value::Object(r)) => {
            for (k, v) in r {
                d.insert(k, v);
            }
            Value::Object(d)
        }
        (_, r) => r,
    }
}

/// JSON → Metric-dialect value.
#[must_use]
pub fn to_row_value(v: &Value) -> RowValue {
    match v {
        Value::Null => RowValue::Empty,
        Value::Bool(b) => RowValue::Bool(*b),
        Value::Number(n) => n.as_f64().map_or(RowValue::Empty, RowValue::Number),
        Value::String(s) => {
            if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                RowValue::Date(DateVal::day(d))
            } else {
                RowValue::Text(s.clone())
            }
        }
        Value::Array(a) => RowValue::List(a.iter().map(to_row_value).collect()),
        Value::Object(_) => RowValue::Text(v.to_string()),
    }
}

fn key_part(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .collect()
}

/// Flattens answers into `answers.<name>` values (see the module docs).
#[must_use]
pub fn flatten(answers: &Map<String, Value>) -> HashMap<String, RowValue> {
    let mut out = HashMap::new();
    for (k, v) in answers {
        flatten_into(&mut out, k, v, 0);
    }
    out
}

fn flatten_into(out: &mut HashMap<String, RowValue>, name: &str, v: &Value, depth: usize) {
    match v {
        Value::Object(o) if depth < 3 => {
            for (f, x) in o {
                flatten_into(out, &format!("{name}_{}", key_part(f)), x, depth + 1);
            }
        }
        Value::Array(a) => {
            out.insert(format!("{name}_count"), RowValue::Number(a.len() as f64));
            let scalars = a.iter().all(|x| !x.is_object() && !x.is_array());
            if scalars {
                out.insert(name.to_owned(), to_row_value(v));
            }
            let mut sums: BTreeMap<String, f64> = BTreeMap::new();
            for x in a {
                match x {
                    Value::String(s) => {
                        out.insert(format!("{name}_{}", key_part(s)), RowValue::Bool(true));
                    }
                    Value::Object(o) => {
                        for (f, fv) in o {
                            match fv {
                                Value::String(s) => {
                                    out.insert(
                                        format!("{name}_{}_{}", key_part(f), key_part(s)),
                                        RowValue::Bool(true),
                                    );
                                }
                                Value::Number(n) => {
                                    *sums.entry(key_part(f)).or_default() +=
                                        n.as_f64().unwrap_or(0.0);
                                }
                                Value::Bool(true) => {
                                    out.insert(
                                        format!("{name}_{}_true", key_part(f)),
                                        RowValue::Bool(true),
                                    );
                                }
                                _ => {}
                            }
                        }
                    }
                    _ => {}
                }
            }
            for (f, s) in sums {
                out.insert(format!("{name}_{f}_sum"), RowValue::Number(s));
            }
        }
        other => {
            out.insert(name.to_owned(), to_row_value(other));
        }
    }
}

/// A Metric-dialect context over answers (plus optional metrics and pack values).
#[derive(Clone, Debug, Default)]
pub struct AnswerContext {
    /// `answers.*` (flattened).
    pub answers: HashMap<String, RowValue>,
    /// `metrics.*`.
    pub metrics: HashMap<String, RowValue>,
    /// `pack.*` by dotted path.
    pub pack: Option<Value>,
    /// `today`.
    pub today: NaiveDate,
}

impl AnswerContext {
    /// A context over answers only.
    #[must_use]
    pub fn new(answers: &Map<String, Value>, today: NaiveDate) -> Self {
        Self {
            answers: flatten(answers),
            metrics: HashMap::new(),
            pack: None,
            today,
        }
    }
}

impl MetricContext for AnswerContext {
    fn metric(&self, name: &str) -> Option<RowValue> {
        self.metrics.get(name).cloned()
    }
    fn answer(&self, id: &str) -> Option<RowValue> {
        self.answers.get(id).cloned()
    }
    fn pack(&self, path: &[String]) -> Option<RowValue> {
        let mut cur = self.pack.as_ref()?;
        for p in path {
            cur = match cur {
                Value::Object(o) => o.get(p)?,
                Value::Array(a) => a.get(p.parse::<usize>().ok()?)?,
                _ => return None,
            };
        }
        Some(to_row_value(cur))
    }
    fn today(&self) -> NaiveDate {
        self.today
    }
}

/// Evaluates a `when` condition (errors count as false).
#[must_use]
pub fn test(expr: Option<&str>, ctx: &AnswerContext) -> bool {
    expr.is_none_or(|w| metric::test(w, ctx).unwrap_or(false))
}

// ───────────────────────────────────────────────────────────────────────────── `${path}` templating

/// The JSON scope of `${path}` substitution.
#[derive(Clone, Debug)]
pub struct Scope<'a> {
    /// `answers.*`.
    pub answers: &'a Map<String, Value>,
    /// `pack.*`.
    pub pack: Option<&'a Value>,
    /// `item.*` inside `forEach`.
    pub item: Option<&'a Value>,
    /// `index` inside `forEach`.
    pub index: Option<usize>,
}

impl<'a> Scope<'a> {
    /// A scope over answers.
    #[must_use]
    pub fn new(answers: &'a Map<String, Value>, pack: Option<&'a Value>) -> Self {
        Self {
            answers,
            pack,
            item: None,
            index: None,
        }
    }

    /// The same scope with a `forEach` item.
    #[must_use]
    pub fn with_item(&self, item: &'a Value, index: usize) -> Self {
        Self {
            answers: self.answers,
            pack: self.pack,
            item: Some(item),
            index: Some(index),
        }
    }

    /// Looks a dotted path up (`answers.income.0.amount`, `item.name`, `index`, `pack.documents`).
    #[must_use]
    pub fn lookup(&self, path: &str) -> Option<Value> {
        let mut parts = path.trim().split('.');
        let root = parts.next()?;
        let mut cur: Value = match root {
            "answers" => {
                let first = parts.next()?;
                self.answers.get(first)?.clone()
            }
            "pack" => self.pack?.clone(),
            "item" => self.item?.clone(),
            "index" => return self.index.map(|i| Value::from(i as u64)),
            _ => return None,
        };
        for p in parts {
            cur = match cur {
                Value::Object(mut o) => o.remove(p)?,
                Value::Array(mut a) => {
                    let i = p.parse::<usize>().ok()?;
                    if i >= a.len() {
                        return None;
                    }
                    a.swap_remove(i)
                }
                _ => return None,
            };
        }
        Some(cur)
    }

    /// The list a `forEach` path names (missing or non-list → empty).
    #[must_use]
    pub fn list(&self, path: &str) -> Vec<Value> {
        match self.lookup(path) {
            Some(Value::Array(a)) => a,
            _ => Vec::new(),
        }
    }
}

fn display(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(0.0);
            emp_sheets::value::number_to_text(f)
        }
        other => other.to_string(),
    }
}

/// Substitutes every `${path}` in `s` (missing paths become empty).
#[must_use]
pub fn subst_str(s: &str, scope: &Scope<'_>) -> String {
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find("${") {
        out.push_str(&rest[..i]);
        let after = &rest[i + 2..];
        match after.find('}') {
            Some(j) => {
                if let Some(v) = scope.lookup(&after[..j]) {
                    out.push_str(&display(&v));
                }
                rest = &after[j + 1..];
            }
            None => {
                out.push_str(&rest[i..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// Substitutes `${path}` throughout a JSON value. A string that is exactly one `${path}` takes the JSON value.
#[must_use]
pub fn subst(v: &Value, scope: &Scope<'_>) -> Value {
    match v {
        Value::String(s) => {
            let t = s.trim();
            if t.starts_with("${") && t.ends_with('}') && t.matches("${").count() == 1 {
                return scope.lookup(&t[2..t.len() - 1]).unwrap_or(Value::Null);
            }
            if s.contains("${") {
                Value::String(subst_str(s, scope))
            } else {
                v.clone()
            }
        }
        Value::Array(a) => Value::Array(a.iter().map(|x| subst(x, scope)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, x)| (k.clone(), subst(x, scope)))
                .collect(),
        ),
        other => other.clone(),
    }
}

/// `${…}` substitution followed by `{{expr}}` interpolation.
#[must_use]
pub fn render(s: &str, scope: &Scope<'_>, ctx: &AnswerContext) -> String {
    let s = if s.contains("${") {
        subst_str(s, scope)
    } else {
        s.to_owned()
    };
    if s.contains("{{") {
        metric::interpolate(&s, ctx)
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn obj(v: Value) -> Map<String, Value> {
        v.as_object().cloned().unwrap()
    }

    #[test]
    fn flattening() {
        let a = obj(json!({
            "currency": {"code": "EUR", "monthStartDay": 1},
            "income": ["employment", "self_employment"],
            "accounts": [{"name": "Visa", "type": "credit_card", "balance": 1200}, {"name": "Car", "type": "auto_loan", "balance": 8000}],
            "grace": "never_miss_twice"
        }));
        let f = flatten(&a);
        assert_eq!(f["currency_code"], RowValue::Text("EUR".into()));
        assert_eq!(f["income_self_employment"], RowValue::Bool(true));
        assert_eq!(f["income_count"], RowValue::Number(2.0));
        assert_eq!(f["accounts_type_credit_card"], RowValue::Bool(true));
        assert_eq!(f["accounts_balance_sum"], RowValue::Number(9200.0));
        let ctx = AnswerContext::new(&a, NaiveDate::from_ymd_opt(2026, 11, 26).unwrap());
        assert!(test(
            Some("answers.accounts_type_credit_card or answers.accounts_type_mortgage"),
            &ctx
        ));
        assert!(!test(Some("answers.income_rental"), &ctx));
        assert!(test(None, &ctx));
    }

    #[test]
    fn substitution() {
        let a =
            obj(json!({"currency": {"code": "USD"}, "bills": [{"name": "Rent", "amount": 1500}]}));
        let s = Scope::new(&a, None);
        let item = json!({"name": "Rent", "amount": 1500});
        let si = s.with_item(&item, 0);
        assert_eq!(subst(&json!("${item.amount}"), &si), json!(1500));
        assert_eq!(
            subst(&json!("Pay ${item.name} (${answers.currency.code})"), &si),
            json!("Pay Rent (USD)")
        );
        assert_eq!(subst(&json!("${index}"), &si), json!(0));
        assert_eq!(s.list("answers.bills").len(), 1);
        assert_eq!(s.list("answers.nope").len(), 0);
        let ctx = AnswerContext::new(&a, NaiveDate::from_ymd_opt(2026, 1, 1).unwrap());
        assert_eq!(
            render("{{fmt_money(1500)}} for ${item.name}", &si, &ctx),
            "$1,500 for Rent"
        );
    }
}

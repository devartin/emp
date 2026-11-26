//! Categorisation rules engine (§15.2 Rules) using the IPC `Rule` shape (§11.3 `finance_rules_list`).
//!
//! Rules run in ascending priority (ties by id). The first matching rule wins unless it sets
//! `continue`; with `continue`, later matches may still fill fields the earlier rules left unset
//! (tags accumulate). Text comparisons are case-insensitive. Regexes are compiled with a 256 KiB size limit.

use std::collections::HashMap;

use chrono::{Datelike, NaiveDate};
use regex::{Regex, RegexBuilder};
use rust_decimal::Decimal;
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::error::{FinanceError, Result};
use crate::money::{cents, parse_decimal};
use crate::payee::payee_key;

/// Regex compiled size limit (§15.2).
pub const REGEX_SIZE_LIMIT: usize = 256 * 1024;
/// Maximum regex pattern length accepted from users.
pub const REGEX_MAX_PATTERN: usize = 4096;

/// Field a condition inspects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    /// Normalised payee.
    Payee,
    /// Raw bank description.
    Raw,
    /// Memo.
    Memo,
    /// Signed amount.
    Amount,
    /// Absolute amount.
    AbsAmount,
    /// Account id.
    Account,
    /// Day of month (1–31).
    DayOfMonth,
}

/// Comparison operator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
    /// Substring.
    Contains,
    /// Equality.
    Equals,
    /// Prefix.
    StartsWith,
    /// Regular expression.
    Regex,
    /// Less than.
    Lt,
    /// Greater than.
    Gt,
    /// Inclusive range `[lo, hi]`.
    Between,
    /// Membership in a list.
    In,
}

/// One condition: `{ field, op, value }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Condition {
    /// Inspected field.
    pub field: Field,
    /// Operator.
    pub op: Op,
    /// Operand (string, number, `[lo, hi]` or a list).
    pub value: Value,
}

/// All conditions must hold.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct When {
    /// Conjunction of conditions. An empty list never matches (guards against catch-all accidents).
    pub all: Vec<Condition>,
}

/// One split line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SplitSpec {
    /// Category for this line.
    pub category_id: String,
    /// Percentage (0–100) of the transaction amount.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pct: Option<Decimal>,
    /// Fixed absolute amount (sign follows the transaction).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub amount: Option<Decimal>,
}

/// Actions applied on match.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Then {
    /// Category to assign.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category_id: Option<String>,
    /// Replacement payee name.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rename_payee: Option<String>,
    /// Tags to add.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Mark as transfer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mark_transfer: Option<bool>,
    /// Split into lines.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split: Option<Vec<SplitSpec>>,
}

/// A rule, as stored and exchanged over IPC.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Rule {
    /// Row id.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Ascending priority.
    pub priority: i64,
    /// Conditions.
    pub when: When,
    /// Actions.
    pub then: Then,
    /// Keep evaluating later rules after a match.
    #[serde(rename = "continue")]
    pub continue_: bool,
    /// Application counter (maintained by the app).
    #[serde(default)]
    pub times_applied: u64,
}

/// The transaction view rules evaluate.
#[derive(Debug, Clone, PartialEq)]
pub struct RuleTxn<'a> {
    /// Normalised payee.
    pub payee: &'a str,
    /// Raw description.
    pub raw: &'a str,
    /// Memo.
    pub memo: &'a str,
    /// Signed amount.
    pub amount: Decimal,
    /// Account id.
    pub account_id: &'a str,
    /// Date.
    pub date: NaiveDate,
}

#[derive(Debug, Clone)]
enum Matcher {
    Text { op: Op, needle: String },
    TextIn(Vec<String>),
    Re(Regex),
    Num { op: Op, a: Decimal, b: Decimal },
    NumIn(Vec<Decimal>),
}

#[derive(Debug, Clone)]
struct CompiledCondition {
    field: Field,
    matcher: Matcher,
}

#[derive(Debug, Clone)]
struct CompiledRule {
    rule: Rule,
    conditions: Vec<CompiledCondition>,
}

/// Result of running the rule set over one transaction.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleOutcome {
    /// Assigned category.
    pub category_id: Option<String>,
    /// Renamed payee.
    pub rename_payee: Option<String>,
    /// Accumulated tags.
    pub tags: Vec<String>,
    /// Transfer flag.
    pub mark_transfer: bool,
    /// Split lines.
    pub split: Option<Vec<SplitSpec>>,
    /// Ids of every rule that matched, in evaluation order.
    pub matched: Vec<String>,
}

impl RuleOutcome {
    /// The rule that decided the category (first match), if any.
    pub fn first_rule(&self) -> Option<&str> {
        self.matched.first().map(String::as_str)
    }
}

/// A validated, compiled rule set.
#[derive(Debug, Clone, Default)]
pub struct RuleSet {
    rules: Vec<CompiledRule>,
}

fn value_str(v: &Value) -> Result<String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        Value::Number(n) => Ok(n.to_string()),
        Value::Bool(b) => Ok(b.to_string()),
        _ => Err(FinanceError::invalid("rule value must be a string")),
    }
}

fn value_dec(v: &Value) -> Result<Decimal> {
    parse_decimal(&value_str(v)?)
}

fn value_list(v: &Value) -> Result<&Vec<Value>> {
    v.as_array()
        .ok_or_else(|| FinanceError::invalid("rule value must be a list"))
}

fn compile_condition(c: &Condition) -> Result<CompiledCondition> {
    let numeric = matches!(
        c.field,
        Field::Amount | Field::AbsAmount | Field::DayOfMonth
    );
    let matcher = match (numeric, c.op) {
        (false, Op::Contains | Op::Equals | Op::StartsWith) => Matcher::Text {
            op: c.op,
            needle: value_str(&c.value)?.to_lowercase(),
        },
        (false, Op::In) => Matcher::TextIn(
            value_list(&c.value)?
                .iter()
                .map(|v| value_str(v).map(|s| s.to_lowercase()))
                .collect::<Result<_>>()?,
        ),
        (false, Op::Regex) => {
            let pat = value_str(&c.value)?;
            if pat.len() > REGEX_MAX_PATTERN {
                return Err(FinanceError::TooLarge("regex pattern too long".into()));
            }
            let re = RegexBuilder::new(&pat)
                .case_insensitive(true)
                .size_limit(REGEX_SIZE_LIMIT)
                .dfa_size_limit(REGEX_SIZE_LIMIT)
                .build()
                .map_err(|e| FinanceError::invalid(format!("invalid regex: {e}")))?;
            Matcher::Re(re)
        }
        (true, Op::Equals | Op::Lt | Op::Gt) => {
            let a = value_dec(&c.value)?;
            Matcher::Num { op: c.op, a, b: a }
        }
        (true, Op::Between) => {
            let l = value_list(&c.value)?;
            if l.len() != 2 {
                return Err(FinanceError::invalid("between needs [lo, hi]"));
            }
            let (a, b) = (value_dec(&l[0])?, value_dec(&l[1])?);
            Matcher::Num {
                op: Op::Between,
                a: a.min(b),
                b: a.max(b),
            }
        }
        (true, Op::In) => Matcher::NumIn(
            value_list(&c.value)?
                .iter()
                .map(value_dec)
                .collect::<Result<_>>()?,
        ),
        (_, op) => {
            return Err(FinanceError::invalid(format!(
                "operator {op:?} is not valid for field {:?}",
                c.field
            )));
        }
    };
    Ok(CompiledCondition {
        field: c.field,
        matcher,
    })
}

impl CompiledCondition {
    fn matches(&self, t: &RuleTxn<'_>) -> bool {
        let num = || match self.field {
            Field::Amount => t.amount,
            Field::AbsAmount => t.amount.abs(),
            _ => Decimal::from(t.date.day()),
        };
        let text = || match self.field {
            Field::Payee => t.payee,
            Field::Raw => t.raw,
            Field::Memo => t.memo,
            _ => t.account_id,
        };
        match &self.matcher {
            Matcher::Text { op, needle } => {
                let hay = text().to_lowercase();
                match op {
                    Op::Contains => hay.contains(needle.as_str()),
                    Op::StartsWith => hay.starts_with(needle.as_str()),
                    _ => hay.trim() == needle.trim(),
                }
            }
            Matcher::TextIn(list) => {
                let hay = text().to_lowercase();
                list.iter().any(|x| x.trim() == hay.trim())
            }
            Matcher::Re(re) => re.is_match(text()),
            Matcher::Num { op, a, b } => {
                let x = num();
                match op {
                    Op::Lt => x < *a,
                    Op::Gt => x > *a,
                    Op::Between => x >= *a && x <= *b,
                    _ => x == *a,
                }
            }
            Matcher::NumIn(list) => list.contains(&num()),
        }
    }
}

/// Validates a rule without building a set (used by `finance_rule_upsert`).
pub fn validate_rule(rule: &Rule) -> Result<()> {
    if rule.name.len() > 1024 {
        return Err(FinanceError::invalid("rule name too long"));
    }
    if rule.when.all.is_empty() {
        return Err(FinanceError::invalid("a rule needs at least one condition"));
    }
    for c in &rule.when.all {
        compile_condition(c)?;
    }
    if let Some(split) = &rule.then.split {
        validate_split(split)?;
    }
    Ok(())
}

fn validate_split(split: &[SplitSpec]) -> Result<()> {
    if split.is_empty() {
        return Err(FinanceError::invalid("split needs at least one line"));
    }
    let mut pct = Decimal::ZERO;
    for s in split {
        match (s.pct, s.amount) {
            (Some(p), None) if p >= Decimal::ZERO && p <= Decimal::ONE_HUNDRED => pct += p,
            (None, Some(a)) if a >= Decimal::ZERO => {}
            (None, None) => {}
            _ => {
                return Err(FinanceError::invalid(
                    "each split line needs either pct (0–100) or a non-negative amount",
                ));
            }
        }
    }
    if pct > Decimal::ONE_HUNDRED {
        return Err(FinanceError::invalid("split percentages exceed 100"));
    }
    Ok(())
}

impl RuleSet {
    /// Compiles and sorts rules. Invalid rules are rejected with the offending rule's name.
    pub fn compile(rules: &[Rule]) -> Result<Self> {
        let mut compiled = Vec::with_capacity(rules.len());
        for r in rules {
            validate_rule(r)
                .map_err(|e| FinanceError::invalid(format!("rule {:?}: {e}", r.name)))?;
            let conditions = r
                .when
                .all
                .iter()
                .map(compile_condition)
                .collect::<Result<Vec<_>>>()?;
            compiled.push(CompiledRule {
                rule: r.clone(),
                conditions,
            });
        }
        compiled.sort_by(|a, b| {
            a.rule
                .priority
                .cmp(&b.rule.priority)
                .then_with(|| a.rule.id.cmp(&b.rule.id))
        });
        Ok(Self { rules: compiled })
    }

    /// Number of rules.
    pub fn len(&self) -> usize {
        self.rules.len()
    }

    /// Whether the set is empty.
    pub fn is_empty(&self) -> bool {
        self.rules.is_empty()
    }

    /// Evaluates the rules against one transaction.
    pub fn apply(&self, t: &RuleTxn<'_>) -> RuleOutcome {
        let mut out = RuleOutcome::default();
        for cr in &self.rules {
            if !cr.conditions.iter().all(|c| c.matches(t)) {
                continue;
            }
            let th = &cr.rule.then;
            out.matched.push(cr.rule.id.clone());
            if out.category_id.is_none() {
                out.category_id.clone_from(&th.category_id);
            }
            if out.rename_payee.is_none() {
                out.rename_payee.clone_from(&th.rename_payee);
            }
            if out.split.is_none() {
                out.split.clone_from(&th.split);
            }
            if th.mark_transfer == Some(true) {
                out.mark_transfer = true;
            }
            for tag in th.tags.iter().flatten() {
                if !out.tags.contains(tag) {
                    out.tags.push(tag.clone());
                }
            }
            if !cr.rule.continue_ {
                break;
            }
        }
        out
    }
}

/// Resolves split lines into signed amounts for a transaction of `amount`. Percentage and fixed lines
/// are computed first (cents, half-up); lines with neither, or the last line, absorb the remainder so the
/// lines always sum exactly to `amount`.
pub fn resolve_split(amount: Decimal, split: &[SplitSpec]) -> Result<Vec<(String, Decimal)>> {
    validate_split(split)?;
    let sign = if amount.is_sign_negative() {
        -Decimal::ONE
    } else {
        Decimal::ONE
    };
    let mut lines: Vec<(String, Option<Decimal>)> = split
        .iter()
        .map(|s| {
            let v = match (s.pct, s.amount) {
                (Some(p), _) => Some(cents(amount * p / Decimal::ONE_HUNDRED)),
                (None, Some(a)) => Some(a * sign),
                _ => None,
            };
            (s.category_id.clone(), v)
        })
        .collect();
    let fixed: Decimal = lines.iter().filter_map(|(_, v)| *v).sum();
    if fixed.abs() > amount.abs() {
        return Err(FinanceError::invalid(
            "split lines exceed the transaction amount",
        ));
    }
    let remainder = amount - fixed;
    let idx = lines
        .iter()
        .position(|(_, v)| v.is_none())
        .unwrap_or(lines.len() - 1);
    let base = lines[idx].1.unwrap_or(Decimal::ZERO);
    lines[idx].1 = Some(base + remainder);
    Ok(lines
        .into_iter()
        .map(|(c, v)| (c, v.unwrap_or(Decimal::ZERO)))
        .collect())
}

/// Learns categories from history and spots repeated manual recategorisations.
#[derive(Debug, Clone, Default)]
pub struct CategoryLearner {
    usage: HashMap<String, HashMap<String, u32>>,
    recats: HashMap<(String, String), u32>,
}

/// The inline "Always categorise …?" suggestion.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleSuggestion {
    /// Normalised payee.
    pub payee: String,
    /// Category id.
    pub category_id: String,
    /// UI copy with `{category}` left for the caller to fill with the category's display name.
    pub message: String,
    /// A ready-to-upsert rule draft (id empty).
    pub draft: Rule,
}

impl CategoryLearner {
    /// Empty learner.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a categorised transaction from history.
    pub fn observe(&mut self, payee: &str, category_id: &str) {
        *self
            .usage
            .entry(payee_key(payee))
            .or_default()
            .entry(category_id.to_string())
            .or_default() += 1;
    }

    /// The category this payee has used most often (ties broken by id for determinism).
    pub fn suggest(&self, payee: &str) -> Option<&str> {
        self.usage
            .get(&payee_key(payee))?
            .iter()
            .max_by(|a, b| a.1.cmp(b.1).then_with(|| b.0.cmp(a.0)))
            .map(|(c, _)| c.as_str())
    }

    /// Records a manual recategorisation. Returns a suggestion on the second identical
    /// (payee, category) change when no existing rule already maps the payee.
    pub fn record_recategorization(
        &mut self,
        payee: &str,
        category_id: &str,
        rules: &RuleSet,
    ) -> Option<RuleSuggestion> {
        self.observe(payee, category_id);
        let key = (payee_key(payee), category_id.to_string());
        let n = self.recats.entry(key).or_default();
        *n += 1;
        if *n != 2 {
            return None;
        }
        let probe = RuleTxn {
            payee,
            raw: payee,
            memo: "",
            amount: Decimal::ZERO,
            account_id: "",
            date: NaiveDate::default(),
        };
        if rules.apply(&probe).category_id.as_deref() == Some(category_id) {
            return None;
        }
        Some(RuleSuggestion {
            payee: payee.to_string(),
            category_id: category_id.to_string(),
            message: format!("Always categorise {payee} as {{category}}?"),
            draft: Rule {
                id: String::new(),
                name: payee.to_string(),
                priority: 100,
                when: When {
                    all: vec![Condition {
                        field: Field::Payee,
                        op: Op::Equals,
                        value: Value::String(payee.to_string()),
                    }],
                },
                then: Then {
                    category_id: Some(category_id.to_string()),
                    ..Then::default()
                },
                continue_: false,
                times_applied: 0,
            },
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rule(id: &str, prio: i64, conds: Value, cat: &str, cont: bool) -> Rule {
        Rule {
            id: id.into(),
            name: id.into(),
            priority: prio,
            when: serde_json::from_value(json!({ "all": conds })).unwrap(),
            then: Then {
                category_id: Some(cat.into()),
                tags: Some(vec![id.into()]),
                ..Then::default()
            },
            continue_: cont,
            times_applied: 0,
        }
    }

    fn t<'a>(payee: &'a str, amount: &str) -> RuleTxn<'a> {
        RuleTxn {
            payee,
            raw: payee,
            memo: "",
            amount: amount.parse().unwrap(),
            account_id: "acc1",
            date: "2026-03-15".parse().unwrap(),
        }
    }

    #[test]
    fn ipc_shape_roundtrip() {
        let j = json!({"id":"r1","name":"Coffee","priority":1,"when":{"all":[{"field":"payee","op":"contains","value":"coffee"}]},
            "then":{"categoryId":"c1"},"continue":false,"timesApplied":3});
        let r: Rule = serde_json::from_value(j.clone()).unwrap();
        assert_eq!(serde_json::to_value(&r).unwrap(), j);
    }

    #[test]
    fn priority_first_match_and_continue() {
        let rules = vec![
            rule(
                "b",
                2,
                json!([{"field":"payee","op":"contains","value":"star"}]),
                "coffee",
                false,
            ),
            rule(
                "a",
                1,
                json!([{"field":"abs_amount","op":"gt","value":"100"}]),
                "big",
                true,
            ),
            rule(
                "c",
                3,
                json!([{"field":"payee","op":"regex","value":"^star"}]),
                "never",
                false,
            ),
        ];
        let rs = RuleSet::compile(&rules).unwrap();
        let o = rs.apply(&t("Starbucks", "-150"));
        assert_eq!(o.category_id.as_deref(), Some("big"));
        assert_eq!(o.matched, vec!["a", "b"]);
        assert_eq!(o.tags, vec!["a", "b"]);
        let o = rs.apply(&t("Starbucks", "-5"));
        assert_eq!(o.category_id.as_deref(), Some("coffee"));
        assert_eq!(o.first_rule(), Some("b"));
        assert!(rs.apply(&t("Dunkin", "-5")).matched.is_empty());
    }

    #[test]
    fn operators() {
        let rs = RuleSet::compile(&[
            rule("between", 1, json!([{"field":"amount","op":"between","value":["-20","-10"]},{"field":"day_of_month","op":"in","value":[15, 16]}]), "x", false),
            rule("acct", 2, json!([{"field":"account","op":"in","value":["ACC1"]}]), "y", false),
            rule("sw", 0, json!([{"field":"memo","op":"starts_with","value":"zzz"}]), "z", false),
        ])
        .unwrap();
        assert_eq!(rs.apply(&t("A", "-15")).category_id.as_deref(), Some("x"));
        assert_eq!(rs.apply(&t("A", "-25")).category_id.as_deref(), Some("y"));
    }

    #[test]
    fn invalid_rules_rejected() {
        let bad_op = rule(
            "x",
            1,
            json!([{"field":"amount","op":"contains","value":"1"}]),
            "c",
            false,
        );
        assert!(RuleSet::compile(&[bad_op]).is_err());
        let bad_re = rule(
            "x",
            1,
            json!([{"field":"payee","op":"regex","value":"("}]),
            "c",
            false,
        );
        assert!(RuleSet::compile(&[bad_re]).is_err());
        let huge = rule(
            "x",
            1,
            json!([{"field":"payee","op":"regex","value":"\\w{1000}\\w{1000}\\w{1000}"}]),
            "c",
            false,
        );
        assert!(
            RuleSet::compile(&[huge]).is_err(),
            "size limit must reject pathological regexes"
        );
        let empty = rule("x", 1, json!([]), "c", false);
        assert!(validate_rule(&empty).is_err());
    }

    #[test]
    fn splits() {
        let s = vec![
            SplitSpec {
                category_id: "a".into(),
                pct: Some("33.333".parse().unwrap()),
                amount: None,
            },
            SplitSpec {
                category_id: "b".into(),
                pct: None,
                amount: Some("10".parse().unwrap()),
            },
            SplitSpec {
                category_id: "c".into(),
                pct: None,
                amount: None,
            },
        ];
        let r = resolve_split("-100".parse().unwrap(), &s).unwrap();
        assert_eq!(r[0].1, "-33.33".parse::<Decimal>().unwrap());
        assert_eq!(r[1].1, "-10".parse::<Decimal>().unwrap());
        assert_eq!(
            r.iter().map(|x| x.1).sum::<Decimal>(),
            "-100".parse::<Decimal>().unwrap()
        );
        let over = vec![SplitSpec {
            category_id: "a".into(),
            pct: None,
            amount: Some("200".parse().unwrap()),
        }];
        assert!(resolve_split("-100".parse().unwrap(), &over).is_err());
    }

    #[test]
    fn learner() {
        let mut l = CategoryLearner::new();
        l.observe("Starbucks", "coffee");
        l.observe("starbucks", "coffee");
        l.observe("Starbucks", "dining");
        assert_eq!(l.suggest("STARBUCKS"), Some("coffee"));
        let rs = RuleSet::default();
        assert!(
            l.record_recategorization("Blue Bottle", "coffee", &rs)
                .is_none()
        );
        let s = l
            .record_recategorization("Blue Bottle", "coffee", &rs)
            .unwrap();
        assert_eq!(s.message, "Always categorise Blue Bottle as {category}?");
        assert!(validate_rule(&s.draft).is_ok());
        assert!(
            l.record_recategorization("Blue Bottle", "coffee", &rs)
                .is_none()
        );
    }
}

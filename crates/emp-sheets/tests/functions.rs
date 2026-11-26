//! Table-driven function tests: every `tests/functions/*.toml` file holds a `[setup]` table of cell
//! inputs on `Sheet1` and a list of `[[case]]` formulas with expected values (Excel results).

use emp_sheets::host::{CacheHost, ExternalKey, ExternalValue, test_now};
use emp_sheets::{Value, Workbook, parse_a1};
use std::sync::Arc;

fn setup_workbook(setup: Option<&toml::Table>) -> Workbook {
    let host = CacheHost::fixed(test_now(), 7);
    host.set(
        ExternalKey::Stock {
            symbol: "AAPL".into(),
            field: "price".into(),
        },
        ExternalValue::Ready(Value::Number(190.5)),
    );
    host.set(
        ExternalKey::Fx {
            from: "USD".into(),
            to: "EUR".into(),
            date: None,
        },
        ExternalValue::Ready(Value::Number(0.92)),
    );
    let mut wb = Workbook::empty(Arc::new(host));
    let _ = wb.add_sheet(Some("Sheet1"), None);
    let _ = wb.add_sheet(Some("Data"), None);
    let sheet = wb.sheets()[0].id;
    let data = wb.sheets()[1].id;
    if let Some(t) = setup {
        for (k, v) in t {
            let (target, addr) = match k.split_once('!') {
                Some(("Data", a)) => (data, a),
                _ => (sheet, k.as_str()),
            };
            let Some((r, c)) = parse_a1(addr) else {
                panic!("bad address {k}")
            };
            let text = match v {
                toml::Value::String(s) => s.clone(),
                toml::Value::Integer(i) => i.to_string(),
                toml::Value::Float(f) => format!("{f}"),
                toml::Value::Boolean(b) => {
                    if *b {
                        "TRUE".into()
                    } else {
                        "FALSE".into()
                    }
                }
                other => panic!("unsupported setup value {other:?}"),
            };
            if let Err(e) = wb.set_input(target, r, c, &text) {
                panic!("setup {k}={text}: {e}");
            }
        }
    }
    wb
}

fn expect_matches(got: &Value, want: &toml::Value, tol: f64) -> bool {
    match (got, want) {
        (Value::Number(n), toml::Value::Integer(i)) => close(*n, *i as f64, tol),
        (Value::Number(n), toml::Value::Float(f)) => close(*n, *f, tol),
        (Value::Text(s), toml::Value::String(w)) => &**s == w.as_str(),
        (Value::Bool(b), toml::Value::Boolean(w)) => b == w,
        (Value::Array(a), toml::Value::Array(rows)) => {
            if rows.len() != a.rows() {
                return false;
            }
            for (r, row) in rows.iter().enumerate() {
                let Some(row) = row.as_array() else {
                    return false;
                };
                if row.len() != a.cols() {
                    return false;
                }
                for (c, w) in row.iter().enumerate() {
                    let g = a.get(r, c);
                    let ok = match w {
                        toml::Value::String(s) if s.starts_with('#') => g.display() == *s,
                        _ => expect_matches(g, w, tol),
                    };
                    if !ok {
                        return false;
                    }
                }
            }
            true
        }
        _ => false,
    }
}

fn close(a: f64, b: f64, tol: f64) -> bool {
    a == b || (a - b).abs() <= tol * b.abs().max(1.0)
}

#[test]
fn function_tables() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/functions");
    let mut files: Vec<_> = std::fs::read_dir(&dir)
        .map(|d| d.filter_map(|e| e.ok()).map(|e| e.path()).collect())
        .unwrap_or_default();
    files.sort();
    let mut failures = Vec::new();
    let mut total = 0;
    for path in files {
        if path.extension().and_then(|e| e.to_str()) != Some("toml") {
            continue;
        }
        let text = std::fs::read_to_string(&path).unwrap_or_default();
        let doc: toml::Table = match text.parse() {
            Ok(d) => d,
            Err(e) => panic!("{}: {e}", path.display()),
        };
        let wb = setup_workbook(doc.get("setup").and_then(|v| v.as_table()));
        let sheet = wb.sheets()[0].id;
        let cases = doc
            .get("case")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        for case in cases {
            total += 1;
            let f = case.get("f").and_then(|v| v.as_str()).unwrap_or("");
            let tol = case.get("tol").and_then(|v| v.as_float()).unwrap_or(1e-9);
            let got = match wb.eval_formula(Some(sheet), f) {
                Ok(v) => v,
                Err(e) => {
                    if case.get("parse_error").is_some() {
                        continue;
                    }
                    failures.push(format!("{}: {f} → error {e}", path.display()));
                    continue;
                }
            };
            let ok = if let Some(e) = case.get("e").and_then(|v| v.as_str()) {
                got.display() == e
            } else if let Some(want) = case.get("v") {
                expect_matches(&got, want, tol)
            } else {
                false
            };
            if !ok {
                failures.push(format!(
                    "{}: {f} → {:?}, expected {:?}",
                    path.file_name().and_then(|s| s.to_str()).unwrap_or(""),
                    got,
                    case.get("v").or(case.get("e"))
                ));
            }
        }
    }
    assert!(total > 0, "no cases found");
    if !failures.is_empty() {
        panic!(
            "{} of {} cases failed:\n{}",
            failures.len(),
            total,
            failures.join("\n")
        );
    }
    eprintln!("{total} function cases passed");
}

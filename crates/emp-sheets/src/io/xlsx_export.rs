//! xlsx export with rust_xlsxwriter. Text is written with `write_string`; formulas are printed from their
//! parsed ASTs (with `_xlfn.` prefixes); sheet names are sanitised (§9.17).

use crate::address::{SheetId, sanitize_sheet_name};
use crate::printer::{PrintOptions, SheetNames, print};
use crate::value::Value;
use crate::workbook::sheet::CellInput;
use crate::workbook::style::{BorderStyle, CellStyle, HAlign, VAlign};
use crate::workbook::{SheetError, Workbook};
use rust_xlsxwriter::{
    Color, ConditionalFormatCell, ConditionalFormatCellRule, ConditionalFormatDataBar,
    ConditionalFormatFormula, Format, FormatAlign, FormatBorder, FormatUnderline, Formula,
    Workbook as XlsxBook, XlsxError,
};
use std::collections::HashMap;

fn xe(e: XlsxError) -> SheetError {
    SheetError::Io(e.to_string())
}

fn color(s: &str) -> Option<Color> {
    let h = s.trim().trim_start_matches('#');
    if h.len() != 6 {
        return None;
    }
    u32::from_str_radix(h, 16).ok().map(Color::RGB)
}

fn border(b: BorderStyle) -> FormatBorder {
    match b {
        BorderStyle::Thin => FormatBorder::Thin,
        BorderStyle::Medium => FormatBorder::Medium,
        BorderStyle::Thick => FormatBorder::Thick,
        BorderStyle::Dashed => FormatBorder::Dashed,
    }
}

/// Convert an EMP style to an xlsx format.
pub fn to_format(st: &CellStyle) -> Format {
    let mut f = Format::new();
    if let Some(n) = &st.num_fmt {
        f = f.set_num_format(n);
    }
    if let Some(font) = &st.font {
        if font.b == Some(true) {
            f = f.set_bold();
        }
        if font.i == Some(true) {
            f = f.set_italic();
        }
        if font.u == Some(true) {
            f = f.set_underline(FormatUnderline::Single);
        }
        if font.s == Some(true) {
            f = f.set_font_strikethrough();
        }
        if let Some(c) = font.color.as_deref().and_then(color) {
            f = f.set_font_color(c);
        }
        if let Some(sz) = font.size {
            f = f.set_font_size(sz);
        }
    }
    if let Some(c) = st.fill.as_deref().and_then(color) {
        f = f.set_background_color(c);
    }
    if let Some(a) = &st.align {
        f = match a.h {
            Some(HAlign::Left) => f.set_align(FormatAlign::Left),
            Some(HAlign::Center) => f.set_align(FormatAlign::Center),
            Some(HAlign::Right) => f.set_align(FormatAlign::Right),
            None => f,
        };
        f = match a.v {
            Some(VAlign::Top) => f.set_align(FormatAlign::Top),
            Some(VAlign::Middle) => f.set_align(FormatAlign::VerticalCenter),
            Some(VAlign::Bottom) => f.set_align(FormatAlign::Bottom),
            None => f,
        };
        if a.wrap == Some(true) {
            f = f.set_text_wrap();
        }
    }
    if let Some(b) = &st.border {
        if let Some(e) = &b.t {
            f = f.set_border_top(border(e.style));
            if let Some(c) = color(&e.color) {
                f = f.set_border_top_color(c);
            }
        }
        if let Some(e) = &b.r {
            f = f.set_border_right(border(e.style));
            if let Some(c) = color(&e.color) {
                f = f.set_border_right_color(c);
            }
        }
        if let Some(e) = &b.b {
            f = f.set_border_bottom(border(e.style));
            if let Some(c) = color(&e.color) {
                f = f.set_border_bottom_color(c);
            }
        }
        if let Some(e) = &b.l {
            f = f.set_border_left(border(e.style));
            if let Some(c) = color(&e.color) {
                f = f.set_border_left_color(c);
            }
        }
    }
    f
}

struct ExportNames<'a> {
    map: &'a HashMap<SheetId, String>,
}

impl SheetNames for ExportNames<'_> {
    fn sheet_name(&self, id: SheetId) -> Option<String> {
        self.map.get(&id).cloned()
    }
}

fn result_text(v: &Value) -> String {
    match v.scalar() {
        Value::Bool(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        other => other.display(),
    }
}

/// Export the workbook to xlsx bytes.
pub fn export_xlsx(wb: &Workbook) -> Result<Vec<u8>, SheetError> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| export_inner(wb)))
        .unwrap_or_else(|_| Err(SheetError::Internal("xlsx export panicked".into())))
}

fn export_inner(wb: &Workbook) -> Result<Vec<u8>, SheetError> {
    let mut book = XlsxBook::new();
    // Unique sanitised names.
    let mut names: HashMap<SheetId, String> = HashMap::new();
    let mut used: Vec<String> = Vec::new();
    for s in wb.sheets() {
        let mut n = sanitize_sheet_name(&s.name);
        let mut i = 2;
        while used.iter().any(|u| u.eq_ignore_ascii_case(&n)) {
            let suffix = format!(" ({i})");
            n = format!(
                "{}{}",
                n.chars().take(31 - suffix.len()).collect::<String>(),
                suffix
            );
            i += 1;
        }
        used.push(n.clone());
        names.insert(s.id, n);
    }
    let pn = ExportNames { map: &names };
    let popts = PrintOptions {
        dialect: crate::parser::Dialect::Excel,
        xlfn: true,
    };
    let mut formats: HashMap<u32, Format> = HashMap::new();
    let mut fmt = |id: u32| -> Format {
        formats
            .entry(id)
            .or_insert_with(|| to_format(wb.styles().get(id)))
            .clone()
    };
    for s in wb.sheets() {
        let ws = book.add_worksheet();
        ws.set_name(names.get(&s.id).cloned().unwrap_or_else(|| "Sheet".into()))
            .map_err(xe)?;
        if s.hidden {
            ws.set_hidden(true);
        }
        if let Some(c) = s.color.as_deref().and_then(color) {
            ws.set_tab_color(c);
        }
        for (&c, &w) in &s.col_widths {
            if c < 16_384 {
                ws.set_column_width_pixels(c as u16, w.clamp(0.0, 4096.0) as u32)
                    .map_err(xe)?;
            }
        }
        for (&r, &h) in &s.row_heights {
            ws.set_row_height_pixels(r, h.clamp(0.0, 4096.0) as u32)
                .map_err(xe)?;
        }
        for m in &s.merges {
            let st = s.cell(m.r0, m.c0).map(|c| c.style).unwrap_or(0);
            ws.merge_range(m.r0, m.c0 as u16, m.r1, m.c1 as u16, "", &fmt(st))
                .map_err(xe)?;
        }
        for (r, c) in s.positions() {
            let Some(cell) = s.cell(r, c) else { continue };
            let f = fmt(cell.style);
            let col = c as u16;
            match &cell.input {
                CellInput::Formula(formula) => {
                    let text = format!("={}", print(&formula.expr, &pn, popts));
                    let res = result_text(&cell.value);
                    let fx = Formula::new(text).set_result(res);
                    if let Some(rect) = s.spills.get(&(r, c)) {
                        ws.write_dynamic_array_formula_with_format(
                            rect.r0,
                            rect.c0 as u16,
                            rect.r1,
                            rect.c1 as u16,
                            fx,
                            &f,
                        )
                        .map_err(xe)?;
                    } else if formula.dynamic {
                        ws.write_dynamic_array_formula_with_format(r, col, r, col, fx, &f)
                            .map_err(xe)?;
                    } else {
                        ws.write_formula_with_format(r, col, fx, &f).map_err(xe)?;
                    }
                }
                CellInput::Value(v) => match v {
                    Value::Number(n) => {
                        ws.write_number_with_format(r, col, *n, &f).map_err(xe)?;
                    }
                    Value::Text(t) => {
                        ws.write_string_with_format(r, col, &**t, &f).map_err(xe)?;
                    }
                    Value::Bool(b) => {
                        ws.write_boolean_with_format(r, col, *b, &f).map_err(xe)?;
                    }
                    Value::Error(e) => {
                        ws.write_formula_with_format(
                            r,
                            col,
                            Formula::new(format!("={}", e.as_str())).set_result(e.as_str()),
                            &f,
                        )
                        .map_err(xe)?;
                    }
                    Value::Empty | Value::Array(_) => {
                        if cell.style != 0 {
                            ws.write_blank(r, col, &f).map_err(xe)?;
                        }
                    }
                },
            }
        }
        if s.frozen_rows > 0 || s.frozen_cols > 0 {
            ws.set_freeze_panes(s.frozen_rows, s.frozen_cols as u16)
                .map_err(xe)?;
        }
        for rule in &s.cond_formats {
            let rr = rule.rect;
            let style = rule.style_id.map(&mut fmt).unwrap_or_default();
            let vals: Vec<String> = rule.values.clone().unwrap_or_default();
            let num = |i: usize| vals.get(i).and_then(|v| v.parse::<f64>().ok());
            match rule.kind.as_str() {
                "cell" => {
                    let cf = match (rule.op.as_deref(), num(0), num(1)) {
                        (Some("gt"), Some(a), _) => Some(
                            ConditionalFormatCell::new()
                                .set_rule(ConditionalFormatCellRule::GreaterThan(a)),
                        ),
                        (Some("lt"), Some(a), _) => Some(
                            ConditionalFormatCell::new()
                                .set_rule(ConditionalFormatCellRule::LessThan(a)),
                        ),
                        (Some("eq"), Some(a), _) => Some(
                            ConditionalFormatCell::new()
                                .set_rule(ConditionalFormatCellRule::EqualTo(a)),
                        ),
                        (Some("between"), Some(a), Some(b)) => Some(
                            ConditionalFormatCell::new()
                                .set_rule(ConditionalFormatCellRule::Between(a, b)),
                        ),
                        _ => None,
                    };
                    if let Some(cf) = cf {
                        ws.add_conditional_format(
                            rr.r0,
                            rr.c0 as u16,
                            rr.r1,
                            rr.c1 as u16,
                            &cf.set_format(style),
                        )
                        .map_err(xe)?;
                    }
                }
                "formula" => {
                    if let Some(src) = &rule.formula {
                        let src = src.strip_prefix('=').unwrap_or(src);
                        if let Ok(mut e) = crate::parser::parse(src, crate::parser::Dialect::Excel)
                        {
                            wb.bind(&mut e);
                            let text = format!("={}", print(&e, &pn, popts));
                            let cf = ConditionalFormatFormula::new()
                                .set_rule(text.as_str())
                                .set_format(style);
                            ws.add_conditional_format(
                                rr.r0,
                                rr.c0 as u16,
                                rr.r1,
                                rr.c1 as u16,
                                &cf,
                            )
                            .map_err(xe)?;
                        }
                    }
                }
                "data_bar" => {
                    let mut bar = ConditionalFormatDataBar::new();
                    if let Some(c) = rule
                        .colors
                        .as_ref()
                        .and_then(|c| c.first())
                        .and_then(|c| color(c))
                    {
                        bar = bar.set_fill_color(c);
                    }
                    ws.add_conditional_format(rr.r0, rr.c0 as u16, rr.r1, rr.c1 as u16, &bar)
                        .map_err(xe)?;
                }
                _ => {}
            }
        }
    }
    for (name, reference) in wb.named_ranges() {
        let key = name.to_uppercase();
        let text = wb
            .names
            .get(&key)
            .map(|n| print(&n.expr, &pn, popts))
            .unwrap_or(reference);
        if book.define_name(name.clone(), &format!("={text}")).is_err() {
            continue;
        }
    }
    book.save_to_buffer().map_err(xe)
}

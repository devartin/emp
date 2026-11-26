//! Minimal readers for the xlsx parts calamine does not expose: `xl/workbook.xml` (sheet paths, visibility,
//! 1904 flag), `xl/styles.xml` (number formats, fonts, fills, alignment) and per-sheet extras (cell style
//! indices, column widths, row heights, freeze panes, merges, tab colour).
//!
//! XML is parsed with `quick-xml`, which never resolves DTDs or custom entities.

use crate::address::{Rect, parse_a1, parse_rect};
use crate::numfmt::builtin_format;
use crate::workbook::style::{Align, CellStyle, FontStyle, HAlign, VAlign};
use quick_xml::Reader;
use quick_xml::events::{BytesStart, Event};
use std::collections::HashMap;

fn attr(e: &BytesStart, key: &[u8]) -> Option<String> {
    for a in e.attributes().flatten() {
        let k = a.key.as_ref();
        let local = match k.iter().rposition(|b| *b == b':') {
            Some(i) => &k[i + 1..],
            None => k,
        };
        if k == key || local == key {
            let raw = std::str::from_utf8(&a.value).ok()?;
            return quick_xml::escape::unescape(raw)
                .ok()
                .map(|v| v.into_owned());
        }
    }
    None
}

fn local(e: &BytesStart) -> Vec<u8> {
    e.local_name().as_ref().to_vec()
}

/// Colour `FFRRGGBB` → `#RRGGBB`.
fn argb(s: &str) -> Option<String> {
    let s = s.trim();
    let hex = if s.len() == 8 { &s[2..] } else { s };
    (hex.len() == 6 && hex.chars().all(|c| c.is_ascii_hexdigit()))
        .then(|| format!("#{}", hex.to_ascii_uppercase()))
}

/// Parsed `xl/workbook.xml` + rels.
#[derive(Clone, Debug, Default)]
pub struct WorkbookXml {
    /// 1904 date system.
    pub date1904: bool,
    /// `(name, part path, hidden)` in tab order.
    pub sheets: Vec<(String, String, bool)>,
}

/// Parse workbook.xml and its relationships.
pub fn parse_workbook(workbook_xml: &[u8], rels_xml: &[u8]) -> WorkbookXml {
    let mut rels: HashMap<String, String> = HashMap::new();
    let mut r = Reader::from_reader(rels_xml);
    let mut buf = Vec::new();
    loop {
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if local(&e) == b"Relationship" => {
                if let (Some(id), Some(t)) = (attr(&e, b"Id"), attr(&e, b"Target")) {
                    let path = if let Some(abs) = t.strip_prefix('/') {
                        abs.to_string()
                    } else {
                        format!("xl/{t}")
                    };
                    rels.insert(id, path);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    let mut out = WorkbookXml::default();
    let mut r = Reader::from_reader(workbook_xml);
    loop {
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match local(&e).as_slice() {
                b"workbookPr" => {
                    out.date1904 =
                        matches!(attr(&e, b"date1904").as_deref(), Some("1") | Some("true"));
                }
                b"sheet" => {
                    let name = attr(&e, b"name").unwrap_or_default();
                    let hidden = matches!(
                        attr(&e, b"state").as_deref(),
                        Some("hidden") | Some("veryHidden")
                    );
                    let path = attr(&e, b"r:id")
                        .and_then(|id| rels.get(&id).cloned())
                        .unwrap_or_default();
                    out.sheets.push((name, path, hidden));
                }
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

/// Parse `xl/styles.xml` into one `CellStyle` per `cellXfs` entry.
pub fn parse_styles(xml: &[u8]) -> Vec<CellStyle> {
    let mut numfmts: HashMap<u32, String> = HashMap::new();
    let mut fonts: Vec<FontStyle> = Vec::new();
    let mut fills: Vec<Option<String>> = Vec::new();
    let mut xfs: Vec<CellStyle> = Vec::new();
    let mut r = Reader::from_reader(xml);
    let mut buf = Vec::new();
    let mut section: Vec<u8> = Vec::new();
    let mut cur_font: Option<FontStyle> = None;
    let mut cur_fill: Option<Option<String>> = None;
    let mut cur_xf: Option<CellStyle> = None;
    loop {
        let ev = r.read_event_into(&mut buf);
        let (e, empty) = match &ev {
            Ok(Event::Start(e)) => (Some(e.clone()), false),
            Ok(Event::Empty(e)) => (Some(e.clone()), true),
            Ok(Event::End(end)) => {
                match end.local_name().as_ref() {
                    b"font" => {
                        if let Some(f) = cur_font.take() {
                            fonts.push(f);
                        }
                    }
                    b"fill" => {
                        if let Some(f) = cur_fill.take() {
                            fills.push(f);
                        }
                    }
                    b"xf" => {
                        if let Some(x) = cur_xf.take() {
                            xfs.push(x);
                        }
                    }
                    b"fonts" | b"fills" | b"cellXfs" | b"numFmts" | b"cellStyleXfs" => {
                        section.clear()
                    }
                    _ => {}
                }
                buf.clear();
                continue;
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => (None, false),
        };
        let Some(e) = e else {
            buf.clear();
            continue;
        };
        let name = local(&e);
        match name.as_slice() {
            b"numFmts" | b"fonts" | b"fills" | b"cellXfs" | b"cellStyleXfs" | b"borders" => {
                if !empty {
                    section = name.clone();
                }
            }
            b"numFmt" => {
                if let (Some(id), Some(code)) = (attr(&e, b"numFmtId"), attr(&e, b"formatCode"))
                    && let Ok(id) = id.parse()
                {
                    numfmts.insert(id, code);
                }
            }
            b"font" if section == b"fonts" => {
                cur_font = Some(FontStyle::default());
                if empty {
                    fonts.push(FontStyle::default());
                    cur_font = None;
                }
            }
            b"b" | b"i" | b"u" | b"strike" | b"sz" | b"color" if cur_font.is_some() => {
                let on = !matches!(
                    attr(&e, b"val").as_deref(),
                    Some("0") | Some("false") | Some("none")
                );
                if let Some(f) = cur_font.as_mut() {
                    match name.as_slice() {
                        b"b" => f.b = on.then_some(true),
                        b"i" => f.i = on.then_some(true),
                        b"u" => f.u = on.then_some(true),
                        b"strike" => f.s = on.then_some(true),
                        b"sz" => {
                            f.size = attr(&e, b"val")
                                .and_then(|v| v.parse().ok())
                                .filter(|s: &f64| (*s - 11.0).abs() > f64::EPSILON)
                        }
                        _ => {
                            f.color = attr(&e, b"rgb")
                                .and_then(|c| argb(&c))
                                .filter(|c| c != "#000000")
                        }
                    }
                }
            }
            b"fill" if section == b"fills" => {
                cur_fill = Some(None);
                if empty {
                    fills.push(None);
                    cur_fill = None;
                }
            }
            b"fgColor" if cur_fill.is_some() => {
                if let Some(c) = attr(&e, b"rgb").and_then(|c| argb(&c)) {
                    cur_fill = Some(Some(c));
                }
            }
            b"xf" if section == b"cellXfs" => {
                let mut st = CellStyle::default();
                if let Some(id) = attr(&e, b"numFmtId").and_then(|v| v.parse::<u32>().ok())
                    && id != 0
                {
                    st.num_fmt = numfmts
                        .get(&id)
                        .cloned()
                        .or_else(|| builtin_format(id).map(|s| s.to_string()))
                        .filter(|s| s != "General");
                }
                if let Some(fid) = attr(&e, b"fontId").and_then(|v| v.parse::<usize>().ok())
                    && let Some(f) = fonts.get(fid)
                    && *f != FontStyle::default()
                {
                    st.font = Some(f.clone());
                }
                if let Some(fid) = attr(&e, b"fillId").and_then(|v| v.parse::<usize>().ok())
                    && let Some(Some(c)) = fills.get(fid)
                {
                    st.fill = Some(c.clone());
                }
                if empty {
                    xfs.push(st);
                } else {
                    cur_xf = Some(st);
                }
            }
            b"alignment" if cur_xf.is_some() => {
                let h = match attr(&e, b"horizontal").as_deref() {
                    Some("left") => Some(HAlign::Left),
                    Some("center") | Some("centerContinuous") => Some(HAlign::Center),
                    Some("right") => Some(HAlign::Right),
                    _ => None,
                };
                let v = match attr(&e, b"vertical").as_deref() {
                    Some("top") => Some(VAlign::Top),
                    Some("center") => Some(VAlign::Middle),
                    Some("bottom") => Some(VAlign::Bottom),
                    _ => None,
                };
                let wrap = matches!(attr(&e, b"wrapText").as_deref(), Some("1") | Some("true"))
                    .then_some(true);
                let al = Align { h, v, wrap };
                if al != Align::default()
                    && let Some(x) = cur_xf.as_mut()
                {
                    x.align = Some(al);
                }
            }
            _ => {}
        }
        buf.clear();
    }
    xfs
}

/// Per-sheet extras.
#[derive(Clone, Debug, Default)]
pub struct SheetExtras {
    /// `(row, col, xf index)` for cells with a non-zero style.
    pub cell_styles: Vec<(u32, u32, u32)>,
    /// Column widths in px.
    pub col_widths: Vec<(u32, f64)>,
    /// Row heights in px.
    pub row_heights: Vec<(u32, f64)>,
    /// Frozen `(rows, cols)`.
    pub frozen: (u32, u32),
    /// Merges.
    pub merges: Vec<Rect>,
    /// Tab colour.
    pub tab_color: Option<String>,
}

/// Stored column width (which already includes the 5 px padding) → pixels (Calibri 11).
pub fn width_to_px(w: f64) -> f64 {
    if w <= 0.0 { 0.0 } else { (w * 7.0).round() }
}

/// Parse a worksheet part for styles, sizes, panes and merges.
pub fn parse_sheet(xml: &[u8], max_cells: usize) -> SheetExtras {
    let mut out = SheetExtras::default();
    let mut r = Reader::from_reader(xml);
    let mut buf = Vec::new();
    loop {
        match r.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match local(&e).as_slice() {
                b"c" => {
                    if out.cell_styles.len() < max_cells
                        && let (Some(rf), Some(s)) = (attr(&e, b"r"), attr(&e, b"s"))
                        && let (Some((row, col)), Ok(s)) = (parse_a1(&rf), s.parse::<u32>())
                        && s != 0
                    {
                        out.cell_styles.push((row, col, s));
                    }
                }
                b"col" => {
                    let custom = matches!(
                        attr(&e, b"customWidth").as_deref(),
                        Some("1") | Some("true")
                    );
                    if let (Some(min), Some(max), Some(w)) =
                        (attr(&e, b"min"), attr(&e, b"max"), attr(&e, b"width"))
                        && let (Ok(min), Ok(max), Ok(w)) =
                            (min.parse::<u32>(), max.parse::<u32>(), w.parse::<f64>())
                        && custom
                        && min >= 1
                    {
                        for c in min..=max.min(min + 16_384) {
                            out.col_widths.push((c - 1, width_to_px(w)));
                        }
                    }
                }
                b"row" => {
                    let custom = matches!(
                        attr(&e, b"customHeight").as_deref(),
                        Some("1") | Some("true")
                    );
                    if custom
                        && let (Some(rr), Some(ht)) = (attr(&e, b"r"), attr(&e, b"ht"))
                        && let (Ok(rr), Ok(ht)) = (rr.parse::<u32>(), ht.parse::<f64>())
                        && rr >= 1
                    {
                        out.row_heights.push((rr - 1, (ht * 4.0 / 3.0).round()));
                    }
                }
                b"pane" => {
                    if matches!(
                        attr(&e, b"state").as_deref(),
                        Some("frozen") | Some("frozenSplit")
                    ) {
                        let x = attr(&e, b"xSplit")
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        let y = attr(&e, b"ySplit")
                            .and_then(|v| v.parse::<f64>().ok())
                            .unwrap_or(0.0);
                        out.frozen = (y as u32, x as u32);
                    }
                }
                b"mergeCell" => {
                    if let Some(rf) = attr(&e, b"ref")
                        && let Some(rect) = parse_rect(&rf)
                    {
                        out.merges.push(rect);
                    }
                }
                b"tabColor" => out.tab_color = attr(&e, b"rgb").and_then(|c| argb(&c)),
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn styles_xml() {
        let xml = br#"<?xml version="1.0"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0%"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><i/><sz val="14"/><color rgb="FFFF0000"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/></patternFill></fill></fills>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0"/><xf numFmtId="164" fontId="1" fillId="2" applyNumberFormat="1"><alignment horizontal="center" wrapText="1"/></xf><xf numFmtId="14" fontId="0" fillId="0"/></cellXfs>
</styleSheet>"#;
        let st = parse_styles(xml);
        assert_eq!(st.len(), 3);
        assert!(st[0].is_default());
        assert_eq!(st[1].num_fmt.as_deref(), Some("0.0%"));
        assert_eq!(st[1].fill.as_deref(), Some("#FFFF00"));
        let f = st[1].font.clone().unwrap_or_default();
        assert_eq!(
            (f.b, f.i, f.size, f.color.as_deref()),
            (Some(true), Some(true), Some(14.0), Some("#FF0000"))
        );
        assert_eq!(st[1].align.as_ref().and_then(|a| a.h), Some(HAlign::Center));
        assert_eq!(st[2].num_fmt.as_deref(), Some("m/d/yyyy"));
    }

    #[test]
    fn workbook_and_sheet_xml() {
        let wb = br#"<workbook xmlns:r="r"><workbookPr date1904="1"/><sheets><sheet name="A" sheetId="1" r:id="rId1"/><sheet name="B" sheetId="2" state="hidden" r:id="rId2"/></sheets></workbook>"#;
        let rels = br#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#;
        let w = parse_workbook(wb, rels);
        assert!(w.date1904);
        assert_eq!(
            w.sheets[0],
            ("A".into(), "xl/worksheets/sheet1.xml".into(), false)
        );
        assert_eq!(
            w.sheets[1],
            ("B".into(), "xl/worksheets/sheet2.xml".into(), true)
        );
        let sx = br#"<worksheet><sheetPr><tabColor rgb="FF00FF00"/></sheetPr><sheetViews><sheetView><pane xSplit="1" ySplit="2" state="frozen"/></sheetView></sheetViews>
<cols><col min="1" max="2" width="20" customWidth="1"/></cols><sheetData><row r="1" ht="30" customHeight="1"><c r="A1" s="1"><v>1</v></c><c r="B1"><v>2</v></c></row></sheetData>
<mergeCells><mergeCell ref="A3:B4"/></mergeCells></worksheet>"#;
        let e = parse_sheet(sx, 1000);
        assert_eq!(e.cell_styles, vec![(0, 0, 1)]);
        assert_eq!(e.col_widths, vec![(0, 140.0), (1, 140.0)]);
        assert_eq!(e.row_heights, vec![(0, 40.0)]);
        assert_eq!(e.frozen, (2, 1));
        assert_eq!(e.merges, vec![Rect::new(2, 0, 3, 1)]);
        assert_eq!(e.tab_color.as_deref(), Some("#00FF00"));
    }

    #[test]
    fn no_entity_expansion() {
        let xml = br#"<?xml version="1.0"?><!DOCTYPE x [<!ENTITY boom "BOOM">]><styleSheet><numFmts><numFmt numFmtId="164" formatCode="&boom;"/></numFmts><cellXfs><xf numFmtId="164"/></cellXfs></styleSheet>"#;
        let st = parse_styles(xml);
        // Custom entities are never resolved: the attribute fails to unescape and is ignored.
        assert!(st.iter().all(|s| s.num_fmt.as_deref() != Some("BOOM")));
    }
}

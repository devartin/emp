//! Sheet commands (SPEC §11.3 Sheets): tile reads (`sheet_get_range`), cell details, and edit batches routed to
//! the emp-sheets engine of the workbook (see [`crate::repo::workbooks`] for persistence). Sheet ids on the wire
//! are the `sheets.id` UUIDs; the engine's numeric ids never leave the store.

use emp_sheets::workbook::sheet::CondFormatRule;
use emp_sheets::{
    Axis, CellEdit, CellError, CellInfo, ClearWhat, CopyResult, EditOutcome, FillMode, PackedCells,
    PasteMode, RangeData, Rect, SheetId, StylePatch,
};
use serde::{Deserialize, Serialize};

use crate::repo::workbooks::{Engine, SheetMeta, sheet_err};
use crate::{Result, Store, StoreError};

/// Maximum edits per `sheet_set_cells` call.
pub const MAX_EDITS: usize = 100_000;
/// Maximum area of one range read.
pub const MAX_RANGE_AREA: u64 = 1_000_000;

/// A rectangle of a sheet that changed outside the visible window.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DirtyRect {
    /// Sheet id.
    pub sheet_id: String,
    /// Rectangle.
    pub rect: Rect,
}

/// `sheet_get_range` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct RangeResult {
    /// Workbook data revision.
    pub rev: i64,
    /// Cells and layout of the window.
    #[serde(flatten)]
    pub data: RangeData,
}

/// Result of edits (`sheet_set_cells`, `sheet_paste`, `sheet_clear`, …).
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditResult {
    /// Workbook data revision after the edit.
    pub rev: i64,
    /// Changed cells inside the visible window.
    pub changed: PackedCells,
    /// Other changed areas.
    pub dirty_rects: Vec<DirtyRect>,
    /// Recalculation time.
    pub recalc_ms: u64,
    /// Rejected edits.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub errors: Option<Vec<CellError>>,
}

/// `sheet_set_style` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct StyleResult {
    /// Every style by id (new ids included).
    pub styles: std::collections::BTreeMap<u32, emp_sheets::CellStyle>,
    /// Restyled cells.
    pub changed: PackedCells,
}

/// `sheet_sort` key (`{col, dir}` on the wire).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SortSpec {
    /// Column.
    pub col: u32,
    /// `asc|desc`.
    pub dir: crate::query::model::SortDir,
}

/// `sheet_update.patch`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetPatch {
    /// Name.
    #[serde(default)]
    pub name: Option<String>,
    /// Colour (`null` clears).
    #[serde(default, deserialize_with = "crate::model::double_option")]
    pub color: Option<Option<String>>,
    /// Hidden.
    #[serde(default)]
    pub hidden: Option<bool>,
}

fn check_rect(r: &Rect) -> Result<()> {
    if r.r1 < r.r0
        || r.c1 < r.c0
        || r.r1 >= emp_sheets::limits::MAX_ROWS
        || r.c1 >= emp_sheets::limits::MAX_COLS
    {
        return Err(StoreError::invalid_field("rect", "invalid rectangle"));
    }
    Ok(())
}

fn bounding(rects: &[Rect]) -> Option<Rect> {
    let mut it = rects.iter();
    let first = *it.next()?;
    Some(it.fold(first, |a, b| Rect {
        r0: a.r0.min(b.r0),
        c0: a.c0.min(b.c0),
        r1: a.r1.max(b.r1),
        c1: a.c1.max(b.c1),
    }))
}

fn edit_result(
    e: &Engine,
    sid: SheetId,
    out: &EditOutcome,
    visible: Option<&Rect>,
    ms: u64,
) -> EditResult {
    let changed =
        e.wb.packed_changes(sid, &out.report.changed, &out.report.dirty_rects, visible);
    let mut dirty: Vec<DirtyRect> = out
        .report
        .dirty_rects
        .iter()
        .filter_map(|(s, r)| {
            Some(DirtyRect {
                sheet_id: e.uuid(*s)?.to_owned(),
                rect: *r,
            })
        })
        .collect();
    // Changed cells on other sheets, or outside the window, as one bounding rectangle per sheet.
    let mut per_sheet: std::collections::BTreeMap<SheetId, Vec<Rect>> =
        std::collections::BTreeMap::new();
    for k in &out.report.changed {
        let (s, r, c) = (k.sheet(), k.row(), k.col());
        let inside =
            s == sid && visible.is_none_or(|v| r >= v.r0 && r <= v.r1 && c >= v.c0 && c <= v.c1);
        if !inside {
            per_sheet.entry(s).or_default().push(Rect {
                r0: r,
                c0: c,
                r1: r,
                c1: c,
            });
        }
    }
    for (s, rects) in per_sheet {
        if let (Some(u), Some(b)) = (e.uuid(s), bounding(&rects)) {
            dirty.push(DirtyRect {
                sheet_id: u.to_owned(),
                rect: b,
            });
        }
    }
    EditResult {
        rev: e.rev(),
        changed,
        dirty_rects: dirty,
        recalc_ms: ms,
        errors: (!out.errors.is_empty()).then(|| out.errors.clone()),
    }
}

impl Store {
    fn sheet_edit(
        &self,
        sheet_id: &str,
        visible: Option<Rect>,
        f: impl FnOnce(&mut Engine, SheetId) -> std::result::Result<EditOutcome, emp_sheets::SheetError>,
    ) -> Result<EditResult> {
        if let Some(v) = &visible {
            check_rect(v)?;
        }
        let wb = self.workbook_of(sheet_id)?;
        let started = std::time::Instant::now();
        let sheet = sheet_id.to_owned();
        let ((out, sid), rev) = self.sheet_mutate(&wb, move |e| {
            let sid = e.engine_id(&sheet)?;
            Ok((f(e, sid).map_err(sheet_err)?, sid))
        })?;
        let ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX);
        self.sheet_read(&wb, |e| {
            let mut r = edit_result(e, sid, &out, visible.as_ref(), ms);
            r.rev = rev;
            Ok(r)
        })
    }

    fn sheet_view<T>(
        &self,
        sheet_id: &str,
        f: impl FnOnce(&Engine, SheetId) -> Result<T>,
    ) -> Result<T> {
        let wb = self.workbook_of(sheet_id)?;
        self.sheet_read(&wb, |e| f(e, e.engine_id(sheet_id)?))
    }

    /// `sheet_get_range`: one tile of cells (display strings, kinds, styles) plus layout and conditional formats.
    pub fn sheet_get_range(&self, sheet_id: &str, rect: Rect) -> Result<RangeResult> {
        check_rect(&rect)?;
        if rect.area() > MAX_RANGE_AREA {
            return Err(StoreError::TooLarge("range"));
        }
        self.sheet_view(sheet_id, |e, sid| {
            Ok(RangeResult {
                rev: e.rev(),
                data: e.wb.range_data(sid, &rect),
            })
        })
    }

    /// `sheet_get_cell`.
    pub fn sheet_get_cell(&self, sheet_id: &str, row: u32, col: u32) -> Result<CellInfo> {
        check_rect(&Rect {
            r0: row,
            c0: col,
            r1: row,
            c1: col,
        })?;
        self.sheet_view(sheet_id, |e, sid| Ok(e.wb.cell_info(sid, row, col)))
    }

    /// Sheet metadata.
    pub fn sheet_meta(&self, sheet_id: &str) -> Result<SheetMeta> {
        self.sheet_view(sheet_id, |e, _| {
            e.metas()
                .into_iter()
                .find(|m| m.id == sheet_id)
                .ok_or(StoreError::NotFound("sheet"))
        })
    }

    /// `sheet_set_cells`: one undo group; invalid formulas are reported in `errors` and skipped.
    pub fn sheet_set_cells(
        &self,
        sheet_id: &str,
        edits: Vec<CellEdit>,
        visible: Rect,
        undo_group: Option<String>,
    ) -> Result<EditResult> {
        if edits.len() > MAX_EDITS {
            return Err(StoreError::TooLarge("edits"));
        }
        self.sheet_edit(sheet_id, Some(visible), move |e, sid| {
            e.wb.set_cells(sid, &edits, undo_group.as_deref())
        })
    }

    /// `sheet_set_style`.
    pub fn sheet_set_style(
        &self,
        sheet_id: &str,
        rects: Vec<Rect>,
        patch: StylePatch,
    ) -> Result<StyleResult> {
        for r in &rects {
            check_rect(r)?;
        }
        let vis = bounding(&rects);
        let r = self.sheet_edit(sheet_id, vis, move |e, sid| {
            e.wb.set_style(sid, &rects, &patch)
        })?;
        let wb = self.workbook_of(sheet_id)?;
        let styles = self.sheet_read(&wb, |e| {
            Ok(e.wb
                .styles()
                .all()
                .iter()
                .enumerate()
                .map(|(i, s)| (u32::try_from(i).unwrap_or(u32::MAX), s.clone()))
                .collect())
        })?;
        Ok(StyleResult {
            styles,
            changed: r.changed,
        })
    }

    /// `sheet_clear`.
    pub fn sheet_clear(
        &self,
        sheet_id: &str,
        rects: Vec<Rect>,
        what: ClearWhat,
    ) -> Result<EditResult> {
        for r in &rects {
            check_rect(r)?;
        }
        let vis = bounding(&rects);
        self.sheet_edit(sheet_id, vis, move |e, sid| e.wb.clear(sid, &rects, what))
    }

    /// `sheet_insert` (rows / columns; references are rewritten).
    pub fn sheet_insert(&self, sheet_id: &str, axis: Axis, at: u32, count: u32) -> Result<i64> {
        Ok(self
            .sheet_edit(sheet_id, None, move |e, sid| {
                e.wb.insert_span(sid, axis, at, count)
            })?
            .rev)
    }

    /// `sheet_delete_span`.
    pub fn sheet_delete_span(
        &self,
        sheet_id: &str,
        axis: Axis,
        at: u32,
        count: u32,
    ) -> Result<i64> {
        Ok(self
            .sheet_edit(sheet_id, None, move |e, sid| {
                e.wb.delete_span(sid, axis, at, count)
            })?
            .rev)
    }

    /// `sheet_resize` (`None` size = auto / default).
    pub fn sheet_resize(
        &self,
        sheet_id: &str,
        axis: Axis,
        indices: Vec<u32>,
        size: Option<f64>,
    ) -> Result<()> {
        if size.is_some_and(|s| !s.is_finite() || !(0.0..=4_000.0).contains(&s)) {
            return Err(StoreError::invalid_field("size", "invalid size"));
        }
        if indices.len() > 100_000 {
            return Err(StoreError::TooLarge("indices"));
        }
        self.sheet_edit(sheet_id, None, move |e, sid| {
            e.wb.resize(sid, axis, &indices, size)
        })?;
        Ok(())
    }

    /// `sheet_merge`.
    pub fn sheet_merge(&self, sheet_id: &str, rect: Rect, merge: bool) -> Result<()> {
        check_rect(&rect)?;
        self.sheet_edit(sheet_id, None, move |e, sid| e.wb.merge(sid, rect, merge))?;
        Ok(())
    }

    /// `sheet_freeze`.
    pub fn sheet_freeze(&self, sheet_id: &str, rows: u32, cols: u32) -> Result<SheetMeta> {
        self.sheet_edit(sheet_id, None, move |e, sid| e.wb.freeze(sid, rows, cols))?;
        self.sheet_meta(sheet_id)
    }

    /// `sheet_copy`.
    pub fn sheet_copy(&self, sheet_id: &str, rect: Rect) -> Result<CopyResult> {
        check_rect(&rect)?;
        self.sheet_view(sheet_id, |e, sid| {
            e.wb.copy_range(sid, rect).map_err(sheet_err)
        })
    }

    /// `sheet_paste` (internal clip preferred, else TSV).
    pub fn sheet_paste(
        &self,
        sheet_id: &str,
        at: (u32, u32),
        clip: Option<String>,
        tsv: Option<String>,
        mode: PasteMode,
        visible: Rect,
    ) -> Result<EditResult> {
        if clip.as_ref().is_some_and(|c| c.len() > 64 << 20)
            || tsv.as_ref().is_some_and(|c| c.len() > 64 << 20)
        {
            return Err(StoreError::TooLarge("clipboard"));
        }
        self.sheet_edit(sheet_id, Some(visible), move |e, sid| {
            e.wb.paste(sid, at, clip.as_deref(), tsv.as_deref(), mode)
        })
    }

    /// `sheet_fill`.
    pub fn sheet_fill(
        &self,
        sheet_id: &str,
        source: Rect,
        target: Rect,
        mode: FillMode,
    ) -> Result<EditResult> {
        check_rect(&source)?;
        check_rect(&target)?;
        self.sheet_edit(sheet_id, Some(target), move |e, sid| {
            e.wb.fill(sid, source, target, mode)
        })
    }

    /// `sheet_sort`.
    pub fn sheet_sort(
        &self,
        sheet_id: &str,
        rect: Rect,
        keys: Vec<SortSpec>,
        has_header: bool,
    ) -> Result<EditResult> {
        check_rect(&rect)?;
        let keys: Vec<emp_sheets::SortKey> = keys
            .into_iter()
            .map(|k| emp_sheets::SortKey {
                col: k.col,
                desc: k.dir == crate::query::model::SortDir::Desc,
            })
            .collect();
        self.sheet_edit(sheet_id, Some(rect), move |e, sid| {
            e.wb.sort_range(sid, rect, &keys, has_header)
        })
    }

    /// `sheet_add` → the new sheet.
    pub fn sheet_add(
        &self,
        workbook_id: &str,
        name: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<SheetMeta> {
        let (name, after) = (name.map(str::to_owned), after_id.map(str::to_owned));
        let (uuid, _) = self.sheet_mutate(workbook_id, move |e| {
            if e.wb.sheets().len() >= crate::repo::workbooks::MAX_SHEETS {
                return Err(StoreError::TooLarge("sheets"));
            }
            let after = after.map(|a| e.engine_id(&a)).transpose()?;
            let sid = e.wb.add_sheet(name.as_deref(), after).map_err(sheet_err)?;
            Ok(e.register(sid))
        })?;
        self.sheet_meta(&uuid)
    }

    /// `sheet_update`.
    pub fn sheet_update(&self, sheet_id: &str, patch: SheetPatch) -> Result<SheetMeta> {
        self.sheet_edit(sheet_id, None, move |e, sid| {
            e.wb.update_sheet(sid, patch.name.as_deref(), patch.color, patch.hidden)
        })?;
        self.sheet_meta(sheet_id)
    }

    /// `sheet_remove` (a workbook keeps at least one sheet).
    pub fn sheet_remove(&self, sheet_id: &str) -> Result<()> {
        self.sheet_edit(sheet_id, None, |e, sid| e.wb.remove_sheet(sid))?;
        Ok(())
    }

    /// `sheet_reorder`.
    pub fn sheet_reorder(
        &self,
        sheet_id: &str,
        before_id: Option<&str>,
        after_id: Option<&str>,
    ) -> Result<SheetMeta> {
        let wb = self.workbook_of(sheet_id)?;
        let (sheet, before, after) = (
            sheet_id.to_owned(),
            before_id.map(str::to_owned),
            after_id.map(str::to_owned),
        );
        self.sheet_mutate(&wb, move |e| {
            let sid = e.engine_id(&sheet)?;
            let order: Vec<SheetId> =
                e.wb.sheets()
                    .iter()
                    .map(|s| s.id)
                    .filter(|s| *s != sid)
                    .collect();
            let index = match (&after, &before) {
                (Some(a), _) => {
                    let a = e.engine_id(a)?;
                    order
                        .iter()
                        .position(|s| *s == a)
                        .map_or(order.len(), |i| i + 1)
                }
                (None, Some(b)) => {
                    let b = e.engine_id(b)?;
                    order.iter().position(|s| *s == b).unwrap_or(0)
                }
                (None, None) => order.len(),
            };
            e.wb.move_sheet(sid, index).map(|_| ()).map_err(sheet_err)
        })?;
        self.sheet_meta(sheet_id)
    }

    /// `sheet_cond_format_set` (replaces the sheet's rules).
    pub fn sheet_cond_format_set(&self, sheet_id: &str, rules: Vec<CondFormatRule>) -> Result<()> {
        if rules.len() > 1_000 {
            return Err(StoreError::TooLarge("rules"));
        }
        self.sheet_edit(sheet_id, None, move |e, sid| {
            e.wb.set_cond_formats(sid, rules)
        })?;
        Ok(())
    }

    /// `sheet_chart_set`: upserts (`chart` with optional `id`) or deletes (`{id, delete:true}`) a chart.
    pub fn sheet_chart_set(&self, sheet_id: &str, chart: serde_json::Value) -> Result<()> {
        if serde_json::to_vec(&chart)?.len() > 256 * 1024 {
            return Err(StoreError::TooLarge("chart"));
        }
        self.sheet_edit(sheet_id, None, move |e, sid| {
            let mut charts =
                e.wb.sheet(sid)
                    .map(|s| s.charts.clone())
                    .unwrap_or_default();
            let id = chart
                .get("id")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned);
            if chart.get("delete").and_then(serde_json::Value::as_bool) == Some(true) {
                charts.retain(|c| c.get("id").and_then(serde_json::Value::as_str) != id.as_deref());
            } else {
                let mut c = chart.clone();
                let id = id.unwrap_or_else(crate::model::ids::new_id);
                if let Some(o) = c.as_object_mut() {
                    o.insert("id".into(), serde_json::json!(id));
                }
                match charts
                    .iter_mut()
                    .find(|x| x.get("id").and_then(serde_json::Value::as_str) == Some(id.as_str()))
                {
                    Some(slot) => *slot = c,
                    None => charts.push(c),
                }
            }
            e.wb.set_charts(sid, charts)
        })?;
        Ok(())
    }
}

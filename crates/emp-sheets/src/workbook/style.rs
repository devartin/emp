//! Cell styles (IPC `CellStyle`) and the de-duplicating style table.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Font settings.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FontStyle {
    /// Bold.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<bool>,
    /// Italic.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub i: Option<bool>,
    /// Underline.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub u: Option<bool>,
    /// Strikethrough.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub s: Option<bool>,
    /// Text colour (`#RRGGBB`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Size in points.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<f64>,
}

/// Horizontal alignment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum HAlign {
    /// Left.
    Left,
    /// Center.
    Center,
    /// Right.
    Right,
}

/// Vertical alignment.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VAlign {
    /// Top.
    Top,
    /// Middle.
    Middle,
    /// Bottom.
    Bottom,
}

/// Alignment.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Align {
    /// Horizontal.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub h: Option<HAlign>,
    /// Vertical.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub v: Option<VAlign>,
    /// Wrap text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wrap: Option<bool>,
}

/// Border line style.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BorderStyle {
    /// Thin.
    Thin,
    /// Medium.
    Medium,
    /// Thick.
    Thick,
    /// Dashed.
    Dashed,
}

/// One border edge.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderEdge {
    /// Line style.
    pub style: BorderStyle,
    /// Colour (`#RRGGBB`).
    pub color: String,
}

/// Borders.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Borders {
    /// Top.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub t: Option<BorderEdge>,
    /// Right.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub r: Option<BorderEdge>,
    /// Bottom.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub b: Option<BorderEdge>,
    /// Left.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub l: Option<BorderEdge>,
}

/// Semantic role of a cell (Spreadsheet Studio conventions).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum CellRole {
    /// User input.
    Input,
    /// Computed output.
    Output,
    /// A check cell.
    Check,
}

/// A cell style (IPC `CellStyle`).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellStyle {
    /// Font.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font: Option<FontStyle>,
    /// Fill colour.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fill: Option<String>,
    /// Alignment.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub align: Option<Align>,
    /// Number format code.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_fmt: Option<String>,
    /// Borders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub border: Option<Borders>,
    /// Role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<CellRole>,
}

/// A partial style update (`Partial<CellStyle>`): present fields replace, `null` clears.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StylePatch {
    /// Font fields to merge.
    #[serde(
        default,
        deserialize_with = "double_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub font: Option<Option<FontStyle>>,
    /// Fill.
    #[serde(
        default,
        deserialize_with = "double_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub fill: Option<Option<String>>,
    /// Alignment fields to merge.
    #[serde(
        default,
        deserialize_with = "double_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub align: Option<Option<Align>>,
    /// Number format.
    #[serde(
        default,
        deserialize_with = "double_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub num_fmt: Option<Option<String>>,
    /// Borders to merge.
    #[serde(
        default,
        deserialize_with = "double_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub border: Option<Option<Borders>>,
    /// Role.
    #[serde(
        default,
        deserialize_with = "double_opt",
        skip_serializing_if = "Option::is_none"
    )]
    pub role: Option<Option<CellRole>>,
}

fn double_opt<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(d).map(Some)
}

fn merge_opt<T: Clone>(base: &mut Option<T>, patch: &Option<T>, merge: impl Fn(&mut T, &T)) {
    match (base.as_mut(), patch) {
        (Some(b), Some(p)) => merge(b, p),
        (None, Some(p)) => *base = Some(p.clone()),
        _ => {}
    }
}

impl CellStyle {
    /// Apply a patch.
    pub fn apply(&mut self, p: &StylePatch) {
        if let Some(f) = &p.font {
            match f {
                None => self.font = None,
                Some(_) => merge_opt(&mut self.font, f, |b, p| {
                    if p.b.is_some() {
                        b.b = p.b;
                    }
                    if p.i.is_some() {
                        b.i = p.i;
                    }
                    if p.u.is_some() {
                        b.u = p.u;
                    }
                    if p.s.is_some() {
                        b.s = p.s;
                    }
                    if p.color.is_some() {
                        b.color = p.color.clone();
                    }
                    if p.size.is_some() {
                        b.size = p.size;
                    }
                }),
            }
        }
        if let Some(f) = &p.fill {
            self.fill = f.clone();
        }
        if let Some(a) = &p.align {
            match a {
                None => self.align = None,
                Some(_) => merge_opt(&mut self.align, a, |b, p| {
                    if p.h.is_some() {
                        b.h = p.h;
                    }
                    if p.v.is_some() {
                        b.v = p.v;
                    }
                    if p.wrap.is_some() {
                        b.wrap = p.wrap;
                    }
                }),
            }
        }
        if let Some(n) = &p.num_fmt {
            self.num_fmt = n.clone().filter(|s| !s.is_empty());
        }
        if let Some(bd) = &p.border {
            match bd {
                None => self.border = None,
                Some(_) => merge_opt(&mut self.border, bd, |b, p| {
                    if p.t.is_some() {
                        b.t = p.t.clone();
                    }
                    if p.r.is_some() {
                        b.r = p.r.clone();
                    }
                    if p.b.is_some() {
                        b.b = p.b.clone();
                    }
                    if p.l.is_some() {
                        b.l = p.l.clone();
                    }
                }),
            }
        }
        if let Some(r) = &p.role {
            self.role = *r;
        }
    }

    /// Is this the default (empty) style?
    pub fn is_default(&self) -> bool {
        *self == CellStyle::default()
    }
}

/// De-duplicating style table; id 0 is the default style.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct StyleTable {
    styles: Vec<CellStyle>,
    #[serde(skip)]
    index: HashMap<String, u32>,
}

impl Default for StyleTable {
    fn default() -> Self {
        let mut t = StyleTable {
            styles: vec![CellStyle::default()],
            index: HashMap::new(),
        };
        t.reindex();
        t
    }
}

fn style_key(s: &CellStyle) -> String {
    serde_json::to_string(s).unwrap_or_default()
}

impl StyleTable {
    /// Rebuild the lookup index (after deserialisation).
    pub fn reindex(&mut self) {
        if self.styles.is_empty() {
            self.styles.push(CellStyle::default());
        }
        self.index = self
            .styles
            .iter()
            .enumerate()
            .map(|(i, s)| (style_key(s), i as u32))
            .collect();
    }
    /// Intern a style and return its id.
    pub fn intern(&mut self, s: CellStyle) -> u32 {
        if s.is_default() {
            return 0;
        }
        let k = style_key(&s);
        if let Some(id) = self.index.get(&k) {
            return *id;
        }
        let id = self.styles.len() as u32;
        self.styles.push(s);
        self.index.insert(k, id);
        id
    }
    /// Append without de-duplication (loading keeps ids stable).
    pub(crate) fn push_raw(&mut self, s: CellStyle) -> u32 {
        let id = self.styles.len() as u32;
        self.styles.push(s);
        id
    }
    /// Style by id (default for unknown ids).
    pub fn get(&self, id: u32) -> &CellStyle {
        self.styles.get(id as usize).unwrap_or(&self.styles[0])
    }
    /// Number of styles.
    pub fn len(&self) -> usize {
        self.styles.len()
    }
    /// Never empty (id 0 always exists).
    pub fn is_empty(&self) -> bool {
        false
    }
    /// All styles by id.
    pub fn all(&self) -> &[CellStyle] {
        &self.styles
    }
    /// Apply a patch to style `id`, returning the new id.
    pub fn patched(&mut self, id: u32, p: &StylePatch) -> u32 {
        let mut s = self.get(id).clone();
        s.apply(p);
        self.intern(s)
    }
    /// Number format of a style.
    pub fn num_fmt(&self, id: u32) -> Option<&str> {
        self.get(id).num_fmt.as_deref()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interning_and_patches() {
        let mut t = StyleTable::default();
        let bold = CellStyle {
            font: Some(FontStyle {
                b: Some(true),
                ..Default::default()
            }),
            ..Default::default()
        };
        let a = t.intern(bold.clone());
        let b = t.intern(bold);
        assert_eq!(a, b);
        assert_eq!(t.intern(CellStyle::default()), 0);
        let p: StylePatch =
            serde_json::from_str(r#"{"numFmt":"0.00","font":{"i":true}}"#).unwrap_or_default();
        let c = t.patched(a, &p);
        let s = t.get(c);
        assert_eq!(s.num_fmt.as_deref(), Some("0.00"));
        assert_eq!(s.font.as_ref().and_then(|f| f.b), Some(true));
        assert_eq!(s.font.as_ref().and_then(|f| f.i), Some(true));
        let clear: StylePatch = serde_json::from_str(r#"{"font":null}"#).unwrap_or_default();
        let d = t.patched(c, &clear);
        assert!(t.get(d).font.is_none());
    }
}

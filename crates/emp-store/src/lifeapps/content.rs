//! Generated page content: [`BlockSpec`]s → a TipTap document (§7.1 schema).
//!
//! Markdown blocks go through the Markdown importer (GFM, `> [!tip]` callouts, `- [ ]` to-dos, tables) after
//! `${…}` / `{{…}}` rendering; embeds (`databaseView`, `kpi`, `chart`, `sheetEmbed`, `pageLink`) reference the
//! deterministic ids of the generated records. Block ids are derived from the owner id so documents are
//! reproducible (tune-up diffs compare them byte for byte).

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{Value, json};

use crate::Result;
use crate::doc::schema::{container, normalize};
use crate::import::markdown::{MdOptions, NoResolve, convert};
use crate::lifeapps::answers::{AnswerContext, Scope, render};
use crate::lifeapps::ids::IdGen;
use crate::lifeapps::manifest::BlockSpec;
use crate::model::{BlockColor, TipTapDoc, TipTapNode};

/// What block rendering needs to know.
pub struct ContentCtx<'a> {
    /// `${…}` scope.
    pub scope: Scope<'a>,
    /// `{{…}}` context.
    pub actx: &'a AnswerContext,
    /// Id generator of the instance.
    pub ids: &'a IdGen,
    /// Instance id (metric sources).
    pub instance_id: &'a str,
    /// Manifest disclaimer.
    pub disclaimer: Option<&'a str>,
    /// Enabled template keys (embeds of disabled items are dropped).
    pub enabled: &'a BTreeSet<String>,
    /// Chart specs of database views (`db.view` → `ChartSpec` JSON with ids).
    pub view_charts: &'a BTreeMap<String, Value>,
    /// Resolves a property key of a database to its id (`(db, prop)`), for explicit chart specs.
    pub prop_id: &'a dyn Fn(&str, &str) -> Option<String>,
}

fn md_blocks(md: &str) -> Result<Vec<TipTapNode>> {
    let r = convert(md, MdOptions::default(), &mut NoResolve)?;
    Ok(r.doc.blocks().to_vec())
}

/// Inline content of the first paragraph of `md`.
fn md_inline(md: &str) -> Result<Vec<TipTapNode>> {
    let blocks = md_blocks(md)?;
    Ok(blocks
        .first()
        .and_then(|c| c.children().first())
        .map(|p| p.children().to_vec())
        .unwrap_or_default())
}

fn text_node(kind: &str, s: &str) -> TipTapNode {
    let n = TipTapNode::new(kind);
    if s.is_empty() {
        n
    } else {
        n.with_content(vec![TipTapNode::text(s)])
    }
}

fn callout(icon: &str, color: BlockColor, inline: Vec<TipTapNode>) -> Result<TipTapNode> {
    container(
        TipTapNode::new("callout")
            .with_attr("icon", json!({"t": "emoji", "v": icon}))
            .with_attr("color", serde_json::to_value(color)?)
            .with_content(inline),
        None,
    )
}

/// Resolves `{"prop": "<key>"}` references of an explicit chart spec.
fn resolve_chart(spec: &Value, db: &str, cx: &ContentCtx<'_>) -> Value {
    fn walk(v: &mut Value, db: &str, cx: &ContentCtx<'_>) {
        match v {
            Value::Object(o) => {
                if let Some(Value::String(p)) = o.get("prop")
                    && !p.starts_with('$')
                    && let Some(id) = (cx.prop_id)(db, p)
                {
                    o.insert("prop".into(), Value::String(id));
                }
                for (_, x) in o.iter_mut() {
                    walk(x, db, cx);
                }
            }
            Value::Array(a) => {
                for x in a {
                    walk(x, db, cx);
                }
            }
            _ => {}
        }
    }
    let mut s = spec.clone();
    walk(&mut s, db, cx);
    s
}

/// Renders blocks into block containers.
pub fn render_blocks(blocks: &[BlockSpec], cx: &ContentCtx<'_>) -> Result<Vec<TipTapNode>> {
    let mut out = Vec::new();
    let on = |k: &str| cx.enabled.contains(k);
    for b in blocks {
        match b {
            BlockSpec::Md { md } => out.extend(md_blocks(&render(md, &cx.scope, cx.actx))?),
            BlockSpec::Callout { icon, color, md } => out.push(callout(
                icon.as_deref().unwrap_or("💡"),
                color.unwrap_or(BlockColor::Gray),
                md_inline(&render(md, &cx.scope, cx.actx))?,
            )?),
            BlockSpec::Disclaimer => {
                if let Some(d) = cx.disclaimer {
                    out.push(callout("⚠️", BlockColor::Gray, vec![TipTapNode::text(d)])?);
                }
            }
            BlockSpec::Database { db, view, height } => {
                if on(db) {
                    out.push(container(
                        TipTapNode::new("databaseView")
                            .with_attr("databaseId", json!(cx.ids.id(db)))
                            .with_attr(
                                "viewId",
                                view.as_ref().map_or(Value::Null, |v| {
                                    json!(cx.ids.id(&format!("{db}.view:{v}")))
                                }),
                            )
                            .with_attr("linked", json!(true))
                            .with_attr("height", height.map_or(Value::Null, |h| json!(h))),
                        None,
                    )?);
                }
            }
            BlockSpec::PageLink { page } => {
                if on(page) {
                    out.push(container(
                        TipTapNode::new("pageLink").with_attr("pageId", json!(cx.ids.id(page))),
                        None,
                    )?);
                }
            }
            BlockSpec::Kpi {
                metric,
                db,
                view,
                agg,
                label,
                format,
            } => {
                let source = match (metric, db) {
                    (Some(m), _) => {
                        json!({"kind": "metric", "instanceId": cx.instance_id, "metric": m})
                    }
                    (None, Some(d)) if on(d) => {
                        let mut s = json!({"kind": "db", "databaseId": cx.ids.id(d)});
                        if let Some(v) = view {
                            s["viewId"] = json!(cx.ids.id(&format!("{d}.view:{v}")));
                        }
                        s
                    }
                    _ => continue,
                };
                out.push(container(
                    TipTapNode::new("kpi")
                        .with_attr("source", source)
                        .with_attr(
                            "agg",
                            serde_json::to_value(agg.unwrap_or(crate::query::model::AggFn::Count))?,
                        )
                        .with_attr("label", json!(render(label, &cx.scope, cx.actx)))
                        .with_attr("format", json!(format.as_deref().unwrap_or("number"))),
                    None,
                )?);
            }
            BlockSpec::Chart {
                db,
                view,
                metric,
                spec,
                title,
            } => {
                let (source, chart) = match (metric, db) {
                    (Some(m), _) => (
                        json!({"kind": "metric", "instanceId": cx.instance_id, "metric": m}),
                        spec.clone().unwrap_or_else(|| {
                            json!({"type": "line", "x": {"prop": "date"}, "y": [{"agg": "sum", "prop": "value"}]})
                        }),
                    ),
                    (None, Some(d)) if on(d) => {
                        let mut s = json!({"kind": "db", "databaseId": cx.ids.id(d)});
                        if let Some(v) = view {
                            s["viewId"] = json!(cx.ids.id(&format!("{d}.view:{v}")));
                        }
                        let chart = match spec {
                            Some(sp) => resolve_chart(sp, d, cx),
                            None => match view.as_ref().and_then(|v| cx.view_charts.get(&format!("{d}.{v}"))) {
                                Some(c) => c.clone(),
                                None => continue,
                            },
                        };
                        (s, chart)
                    }
                    _ => continue,
                };
                if let Some(t) = title {
                    out.push(container(
                        text_node("heading", t)
                            .with_attr("level", json!(3))
                            .with_attr("toggle", json!(false))
                            .with_attr("collapsed", json!(false)),
                        None,
                    )?);
                }
                out.push(container(
                    TipTapNode::new("chart")
                        .with_attr("source", source)
                        .with_attr("spec", chart),
                    None,
                )?);
            }
            BlockSpec::Sheet {
                workbook,
                sheet,
                range,
            } => {
                if on(workbook) {
                    out.push(container(
                        TipTapNode::new("sheetEmbed")
                            .with_attr("workbookId", json!(cx.ids.id(workbook)))
                            .with_attr(
                                "sheetId",
                                json!(cx.ids.id(&format!("{workbook}.sheet:{sheet}"))),
                            )
                            .with_attr("range", json!(range)),
                        None,
                    )?);
                }
            }
            BlockSpec::Checklist { items } => {
                for i in items {
                    let t = render(i, &cx.scope, cx.actx);
                    out.push(container(
                        text_node("todoItem", &t).with_attr("checked", json!(false)),
                        None,
                    )?);
                }
            }
            BlockSpec::Divider => out.push(container(TipTapNode::new("divider"), None)?),
            BlockSpec::Toc => out.push(container(TipTapNode::new("toc"), None)?),
        }
    }
    Ok(out)
}

/// Assigns deterministic block ids (`owner`, ordinal) to every block container.
pub fn assign_ids(doc: &mut TipTapDoc, ids: &IdGen, owner: &str) {
    fn walk(n: &mut TipTapNode, ids: &IdGen, owner: &str, k: &mut usize) {
        if n.kind == "blockContainer" {
            let id = ids.block_id(owner, *k);
            *k += 1;
            n.attrs
                .get_or_insert_with(Default::default)
                .insert("id".into(), json!(id));
        }
        if let Some(c) = n.content.as_mut() {
            for x in c {
                walk(x, ids, owner, k);
            }
        }
    }
    let mut k = 0;
    for n in &mut doc.content {
        walk(n, ids, owner, &mut k);
    }
}

/// Builds a normalised document with deterministic ids.
pub fn document(containers: Vec<TipTapNode>, ids: &IdGen, owner: &str) -> Result<TipTapDoc> {
    let mut doc = if containers.is_empty() {
        TipTapDoc::empty()?
    } else {
        TipTapDoc::from_blocks(containers)
    };
    assign_ids(&mut doc, ids, owner);
    normalize(&mut doc)?;
    Ok(doc)
}

//! Derived values: formulas (`Dialect::Row` from emp-sheets, SPEC §14.6), rollups (§8.1) and the
//! `created_time` / `updated_time` columns.
//!
//! A [`World`] holds the decoded live rows of a database and of every database reachable through its relations
//! (bounded). An [`Evaluator`] computes derived cells lazily with memoisation and cycle detection
//! ("Circular reference"), following property → formula → rollup → formula chains across databases.

use std::cell::RefCell;
use std::collections::{HashMap, HashSet};
use std::rc::Rc;

use emp_sheets::dialect::RowValue;
use emp_sheets::dialect::row::{RowContext, RowFormula, compile, eval};

use super::agg::{Func, aggregate};
use super::cells::{self, computed_error, computed_from_row, to_row_value};
use super::config::HasConfig;
use super::dates::DateCtx;
use super::model::{CellValue, DatabasePayload, PropType, Property, RowDto, RowPayload};
use crate::model::Id;

/// Maximum number of databases loaded for one query (the main one plus related ones).
pub const MAX_WORLD_DBS: usize = 16;
/// Maximum nesting of derived values (formula of rollup of formula …).
pub const MAX_DEPTH: usize = 24;

/// A decoded live row.
#[derive(Clone, Debug, PartialEq)]
pub struct RowRec {
    /// Id.
    pub id: Id,
    /// Revision.
    pub rev: i64,
    /// Manual order key.
    pub sort_key: String,
    /// Created (ms).
    pub created_at: i64,
    /// Updated (ms).
    pub updated_at: i64,
    /// Stored payload.
    pub payload: RowPayload,
    /// Has a body document.
    pub has_body: bool,
}

/// One database with its live rows.
#[derive(Clone, Debug)]
pub struct DbData {
    /// Database id.
    pub id: Id,
    /// Title (page title).
    pub title: String,
    /// Payload.
    pub info: DatabasePayload,
    /// Live properties in column order.
    pub props: Vec<Property>,
    /// Live rows in manual order.
    pub rows: Vec<RowRec>,
    /// Data revision.
    pub data_rev: i64,
    /// Schema revision.
    pub schema_rev: i64,
    index: HashMap<Id, usize>,
}

impl DbData {
    /// Builds the row index.
    #[must_use]
    pub fn new(
        id: Id,
        title: String,
        info: DatabasePayload,
        props: Vec<Property>,
        rows: Vec<RowRec>,
        data_rev: i64,
        schema_rev: i64,
    ) -> Self {
        let index = rows
            .iter()
            .enumerate()
            .map(|(i, r)| (r.id.clone(), i))
            .collect();
        Self {
            id,
            title,
            info,
            props,
            rows,
            data_rev,
            schema_rev,
            index,
        }
    }

    /// A property by id.
    #[must_use]
    pub fn prop(&self, id: &str) -> Option<&Property> {
        self.props.iter().find(|p| p.id == id)
    }

    /// Resolves a formula key: `#<id>` or a property name (case-insensitive).
    #[must_use]
    pub fn resolve(&self, key: &str) -> Option<&Property> {
        match key.strip_prefix('#') {
            Some(id) => self.prop(id),
            None => self
                .props
                .iter()
                .find(|p| p.name == key)
                .or_else(|| self.props.iter().find(|p| p.name.eq_ignore_ascii_case(key))),
        }
    }

    /// Row index by id.
    #[must_use]
    pub fn row_index(&self, id: &str) -> Option<usize> {
        self.index.get(id).copied()
    }

    /// The title property.
    #[must_use]
    pub fn title_prop(&self) -> Option<&Property> {
        self.prop(&self.info.primary_prop_id)
            .or_else(|| self.props.iter().find(|p| p.kind == PropType::Title))
    }

    /// Plain title of a row.
    #[must_use]
    pub fn row_title(&self, row: usize) -> String {
        let Some(p) = self.title_prop() else {
            return String::new();
        };
        self.rows
            .get(row)
            .and_then(|r| r.payload.values.get(&p.id))
            .map(cells::plain_text)
            .unwrap_or_default()
    }
}

/// The databases visible to one evaluation.
#[derive(Clone, Debug, Default)]
pub struct World {
    dbs: Vec<DbData>,
    by_id: HashMap<Id, usize>,
    row_owner: HashMap<Id, (usize, usize)>,
}

impl World {
    /// Indexes the databases.
    #[must_use]
    pub fn new(dbs: Vec<DbData>) -> Self {
        let mut by_id = HashMap::new();
        let mut row_owner = HashMap::new();
        for (i, d) in dbs.iter().enumerate() {
            by_id.insert(d.id.clone(), i);
            for (j, r) in d.rows.iter().enumerate() {
                row_owner.insert(r.id.clone(), (i, j));
            }
        }
        Self {
            dbs,
            by_id,
            row_owner,
        }
    }

    /// Database by id.
    #[must_use]
    pub fn db(&self, id: &str) -> Option<&DbData> {
        self.by_id.get(id).map(|&i| &self.dbs[i])
    }

    /// Ordinal of a database.
    #[must_use]
    pub fn ord(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }

    /// Database by ordinal.
    #[must_use]
    pub fn at(&self, ord: usize) -> &DbData {
        &self.dbs[ord]
    }

    /// `(db ordinal, row index)` of a row id.
    #[must_use]
    pub fn locate(&self, row_id: &str) -> Option<(usize, usize)> {
        self.row_owner.get(row_id).copied()
    }

    /// All databases.
    #[must_use]
    pub fn dbs(&self) -> &[DbData] {
        &self.dbs
    }
}

/// Relation targets of a database's properties (for loading a [`World`]).
#[must_use]
pub fn relation_targets(props: &[Property]) -> Vec<Id> {
    let mut out: Vec<Id> = props
        .iter()
        .filter(|p| p.kind == PropType::Relation)
        .map(|p| p.relation().target_database_id)
        .filter(|t| !t.is_empty())
        .collect();
    out.sort();
    out.dedup();
    out
}

type Key = (usize, usize, usize);

/// Lazy, memoised evaluator of derived values.
pub struct Evaluator<'w> {
    world: &'w World,
    ctx: DateCtx,
    memo: RefCell<HashMap<Key, Option<CellValue>>>,
    stack: RefCell<HashSet<Key>>,
    compiled: RefCell<HashMap<(usize, usize), Result<Rc<RowFormula>, String>>>,
}

impl<'w> Evaluator<'w> {
    /// A new evaluator.
    #[must_use]
    pub fn new(world: &'w World, ctx: DateCtx) -> Self {
        Self {
            world,
            ctx,
            memo: RefCell::new(HashMap::new()),
            stack: RefCell::new(HashSet::new()),
            compiled: RefCell::new(HashMap::new()),
        }
    }

    /// The world.
    #[must_use]
    pub fn world(&self) -> &'w World {
        self.world
    }

    /// The date context.
    #[must_use]
    pub fn ctx(&self) -> &DateCtx {
        &self.ctx
    }

    /// The (stored or derived) value of property `prop` in row `row` of database `db` (ordinals).
    #[must_use]
    pub fn value(&self, db: usize, row: usize, prop: &Property) -> Option<CellValue> {
        let d = self.world.at(db);
        let r = d.rows.get(row)?;
        match prop.kind {
            PropType::CreatedTime => Some(CellValue::Ts { v: r.created_at }),
            PropType::UpdatedTime => Some(CellValue::Ts { v: r.updated_at }),
            PropType::Formula | PropType::Rollup => {
                let pi = d.props.iter().position(|p| p.id == prop.id)?;
                let key = (db, row, pi);
                if let Some(v) = self.memo.borrow().get(&key) {
                    return v.clone();
                }
                if self.stack.borrow().contains(&key) {
                    return Some(computed_error("Circular reference"));
                }
                if self.stack.borrow().len() >= MAX_DEPTH {
                    return Some(computed_error("Too deeply nested"));
                }
                self.stack.borrow_mut().insert(key);
                let out = if prop.kind == PropType::Formula {
                    self.formula(db, row, pi, prop)
                } else {
                    self.rollup(db, row, prop)
                };
                self.stack.borrow_mut().remove(&key);
                self.memo.borrow_mut().insert(key, out.clone());
                out
            }
            _ => r.payload.values.get(&prop.id).cloned(),
        }
    }

    /// Value by property id.
    #[must_use]
    pub fn value_of(&self, db: usize, row: usize, prop_id: &str) -> Option<CellValue> {
        let p = self.world.at(db).prop(prop_id)?.clone();
        self.value(db, row, &p)
    }

    fn compiled(&self, db: usize, pi: usize, prop: &Property) -> Result<Rc<RowFormula>, String> {
        if let Some(c) = self.compiled.borrow().get(&(db, pi)) {
            return c.clone();
        }
        let src = prop.formula();
        let c = if src.trim().is_empty() {
            Err(String::new())
        } else {
            compile(&src).map(Rc::new).map_err(|e| e.message)
        };
        self.compiled.borrow_mut().insert((db, pi), c.clone());
        c
    }

    fn formula(&self, db: usize, row: usize, pi: usize, prop: &Property) -> Option<CellValue> {
        let f = match self.compiled(db, pi, prop) {
            Ok(f) => f,
            Err(e) if e.is_empty() => return None,
            Err(e) => return Some(computed_error(&e)),
        };
        let ctx = Ctx {
            ev: self,
            db,
            row,
            err: RefCell::new(None),
        };
        let res = eval(&f, &ctx);
        if let Some(e) = ctx.err.into_inner() {
            return Some(computed_error(&e));
        }
        Some(match res {
            Ok(r) => {
                if matches!(r.value, RowValue::Empty) {
                    return None;
                }
                computed_from_row(&r.value, &r.display)
            }
            Err(e) => computed_error(&e),
        })
    }

    fn rollup(&self, db: usize, row: usize, prop: &Property) -> Option<CellValue> {
        let cfg = prop.rollup()?;
        let d = self.world.at(db);
        let rel = d.prop(&cfg.relation_prop_id)?;
        if rel.kind != PropType::Relation {
            return Some(computed_error("The rollup relation is not a relation"));
        }
        let target = rel.relation().target_database_id;
        let Some(tord) = self.world.ord(&target) else {
            return Some(computed_error("Related database unavailable"));
        };
        let tdb = self.world.at(tord);
        let Some(tprop) = tdb.prop(&cfg.target_prop_id).cloned() else {
            return Some(computed_error("Rolled-up property was deleted"));
        };
        let ids = cells::ids(d.rows[row].payload.values.get(&rel.id));
        let vals: Vec<Option<CellValue>> = ids
            .iter()
            .filter_map(|id| tdb.row_index(id))
            .map(|ri| self.value(tord, ri, &tprop))
            .collect();
        let refs: Vec<Option<&CellValue>> = vals.iter().map(Option::as_ref).collect();
        Some(aggregate(Func::from(cfg.func), &refs, &tprop, &self.ctx).to_cell())
    }

    /// A full row DTO (stored and derived values; secrets stay masked; `props` limits the values returned).
    #[must_use]
    pub fn row_dto(&self, db: usize, row: usize, props: Option<&[Id]>) -> Option<RowDto> {
        let d = self.world.at(db);
        let r = d.rows.get(row)?;
        let mut values = std::collections::BTreeMap::new();
        for p in &d.props {
            if props.is_some_and(|ps| !ps.iter().any(|x| x == &p.id)) {
                continue;
            }
            if let Some(v) = self.value(db, row, p) {
                values.insert(p.id.clone(), v);
            }
        }
        Some(RowDto {
            id: r.id.clone(),
            rev: r.rev,
            sort_key: r.sort_key.clone(),
            created_at: r.created_at,
            updated_at: r.updated_at,
            values,
            has_body: r.has_body,
            icon: r.payload.icon.clone(),
            sample: r
                .payload
                .tags
                .as_ref()
                .map(|t| t.iter().any(|x| x == "sample"))
                .filter(|s| *s),
        })
    }
}

struct Ctx<'a, 'w> {
    ev: &'a Evaluator<'w>,
    db: usize,
    row: usize,
    /// First error read from a dependency (propagated, e.g. "Circular reference").
    err: RefCell<Option<String>>,
}

impl Ctx<'_, '_> {
    fn read(&self, db: usize, row: usize, key: &str) -> Option<RowValue> {
        let d = self.ev.world.at(db);
        let p = d.resolve(key)?.clone();
        let v = self.ev.value(db, row, &p);
        if let Some(CellValue::Computed { v: c }) = &v
            && c.kind == super::model::ComputedKind::Error
        {
            self.err.borrow_mut().get_or_insert_with(|| c.display.clone());
            return Some(RowValue::Empty);
        }
        Some(to_row_value(v.as_ref(), &p, &self.ev.ctx))
    }
}

impl RowContext for Ctx<'_, '_> {
    fn prop(&self, key: &str) -> Option<RowValue> {
        self.read(self.db, self.row, key)
    }

    fn related_prop(&self, row_id: &str, key: &str) -> Option<RowValue> {
        let (db, row) = self.ev.world.locate(row_id)?;
        self.read(db, row, key)
    }

    fn now(&self) -> chrono::NaiveDateTime {
        self.ev.ctx.now()
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::query::model::{RollupFn, rich};
    use serde_json::{Map, json};

    pub fn prop(id: &str, name: &str, kind: PropType, config: serde_json::Value) -> Property {
        Property {
            id: id.into(),
            name: name.into(),
            kind,
            config: config.as_object().cloned().unwrap_or_else(Map::new),
            role: None,
            hidden: false,
            sort_key: id.into(),
            description: None,
        }
    }

    pub fn row(id: &str, values: Vec<(&str, CellValue)>) -> RowRec {
        RowRec {
            id: id.into(),
            rev: 1,
            sort_key: id.into(),
            created_at: 1_000,
            updated_at: 2_000,
            payload: RowPayload {
                v: 1,
                values: values
                    .into_iter()
                    .map(|(k, v)| (k.to_owned(), v))
                    .collect(),
                ..RowPayload::default()
            },
            has_body: false,
        }
    }

    pub fn info(primary: &str) -> DatabasePayload {
        DatabasePayload {
            v: 1,
            description: None,
            primary_prop_id: primary.into(),
            uid_prefix: None,
            uid_seq: 0,
            inline: false,
            templates: vec![],
            default_template_id: None,
            hide_empty_props: false,
            roles: Default::default(),
        }
    }

    fn world() -> World {
        let items = DbData::new(
            "items".into(),
            "Items".into(),
            info("it"),
            vec![
                prop("it", "Name", PropType::Title, json!({})),
                prop("amt", "Amount", PropType::Number, json!({})),
            ],
            vec![
                row("i1", vec![("it", CellValue::text("A")), ("amt", CellValue::number(10.0))]),
                row("i2", vec![("it", CellValue::text("B")), ("amt", CellValue::number(5.5))]),
            ],
            1,
            1,
        );
        let orders = DbData::new(
            "orders".into(),
            "Orders".into(),
            info("ot"),
            vec![
                prop("ot", "Order", PropType::Title, json!({})),
                prop("rel", "Items", PropType::Relation, json!({"targetDatabaseId":"items"})),
                prop(
                    "sum",
                    "Total",
                    PropType::Rollup,
                    json!({"relationPropId":"rel","targetPropId":"amt","fn":"sum"}),
                ),
                prop("f", "Double", PropType::Formula, json!({"expression":"prop(\"#sum\") * 2"})),
                prop(
                    "f2",
                    "Mapped",
                    PropType::Formula,
                    json!({"expression":"prop(\"Items\").map(current.prop(\"Amount\")).sum()"}),
                ),
                prop("c1", "Loop A", PropType::Formula, json!({"expression":"prop(\"#c2\") + 1"})),
                prop("c2", "Loop B", PropType::Formula, json!({"expression":"prop(\"#c1\") + 1"})),
            ],
            vec![row(
                "o1",
                vec![
                    ("ot", CellValue::Text { v: rich("Order 1") }),
                    ("rel", CellValue::Relation { v: vec!["i1".into(), "i2".into()] }),
                ],
            )],
            1,
            1,
        );
        World::new(vec![orders, items])
    }

    #[test]
    fn rollups_formulas_and_cycles() {
        let w = world();
        let ev = Evaluator::new(&w, DateCtx::utc(0));
        let o = w.ord("orders").unwrap();
        assert_eq!(cells::number(ev.value_of(o, 0, "sum").as_ref()), Some(15.5));
        assert_eq!(cells::number(ev.value_of(o, 0, "f").as_ref()), Some(31.0));
        assert_eq!(cells::number(ev.value_of(o, 0, "f2").as_ref()), Some(15.5));
        let loop_v = ev.value_of(o, 0, "c1").unwrap();
        assert!(cells::plain_text(&loop_v).contains("Circular"), "{loop_v:?}");
        let dto = ev.row_dto(o, 0, None).unwrap();
        assert!(dto.values.contains_key("sum"));
        let _ = RollupFn::Sum;
    }
}

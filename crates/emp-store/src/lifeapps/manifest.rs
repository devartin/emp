//! `LifeAppManifest` and the typed template specs (SPEC §16.1, decision D-11).
//!
//! Manifests are JSON files in `crates/emp-store/lifeapps/<id>.json`, embedded with `include_str!` and parsed with
//! `deny_unknown_fields` everywhere. The top-level shape is exactly the §16.1 `LifeAppManifest`; each
//! `Template.spec` is an open JSON value on the wire and is parsed into the typed spec of its `kind`
//! ([`TemplateSpec`]) by [`Template::typed`].
//!
//! ## String templating inside specs
//! * `{{expr}}` — a Metric-dialect expression (§14.7) over `answers.*` (flattened, see
//!   [`crate::lifeapps::answers`]), `pack.*` and `today`, e.g. `{{fmt_money(answers.emergency_target)}}`.
//! * `${path}` — a JSON path into the current scope: `answers.<id>[.<field>…]`, and inside `forEach`
//!   expansions `item.<field>` and `index`. A string that is exactly one `${path}` keeps the JSON type of the
//!   value (numbers stay numbers).
//!
//! ## Keys
//! Template keys are unique per manifest. Property, option, view and row keys are unique within their database.
//! Record ids derive from keys (`UUIDv5`, see [`crate::lifeapps::ids`]): `<db>` for the database page,
//! `<db>.prop:<key>`, `<db>.prop:<key>.opt:<key>`, `<db>.view:<key>`, `<db>.row:<rowKey>`.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::model::BlockColor;
use crate::query::model::{
    AggFn, CardSettings, DateBucket, Layout, OpenIn, PropType, RollupFn, SortDir, StatusGroup,
};
use crate::{Result, StoreError};

// ───────────────────────────────────────────────────────────────────────────── manifest (§16.1)

/// App category.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Category {
    Finance,
    Investing,
    Tax,
    Sheets,
    Planning,
    Health,
}

impl Category {
    /// Lowercase name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Finance => "finance",
            Self::Investing => "investing",
            Self::Tax => "tax",
            Self::Sheets => "sheets",
            Self::Planning => "planning",
            Self::Health => "health",
        }
    }
}

/// Data sensitivity: `high` triggers the encryption prompt on unencrypted vaults.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Sensitivity {
    Normal,
    High,
}

/// A life-app manifest (SPEC §16.1 `LifeAppManifest`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifeAppManifest {
    /// App id (`money-hq`).
    pub id: String,
    /// Semver.
    pub version: String,
    /// Title.
    pub title: String,
    /// Tagline.
    pub tagline: String,
    /// Lucide icon name.
    pub icon: String,
    /// Accent / block colour name.
    pub color: String,
    /// Category.
    pub category: Category,
    /// Sensitivity.
    pub sensitivity: Sensitivity,
    /// Estimated setup minutes.
    pub est_minutes: u32,
    /// Footer disclaimer for finance and tax pages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub disclaimer: Option<String>,
    /// Wizard steps.
    pub steps: Vec<Step>,
    /// Generated content.
    pub templates: Vec<Template>,
    /// Metrics.
    pub metrics: Vec<MetricDef>,
    /// Advisor rules.
    pub advisor: Vec<AdvisorRule>,
    /// Checklist.
    pub checklist: Vec<ChecklistItem>,
    /// Additive migrations.
    pub migrations: Vec<Migration>,
    /// Sample-data generator.
    pub sample: SampleDef,
}

/// Wizard step kind (§16.1 `Step.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum StepKind {
    ChoiceCards,
    MultiChips,
    Money,
    Percent,
    Number,
    Slider,
    Date,
    Recurrence,
    ListBuilder,
    FileImport,
    Connect,
    Jurisdiction,
    Text,
    Toggle,
    Review,
}

/// A choice option.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StepOption {
    /// Stored value.
    pub value: String,
    /// Label.
    pub label: String,
    /// Description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Lucide icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// A wizard step (§16.1 `Step`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Step {
    /// Step id (= answer key).
    pub id: String,
    /// Kind.
    pub kind: StepKind,
    /// Title.
    pub title: String,
    /// Help text.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub help: Option<String>,
    /// "Why?" rationale.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub why: Option<String>,
    /// Asked in quick mode.
    pub quick: bool,
    /// Can be skipped.
    pub skippable: bool,
    /// Metric-dialect condition over earlier answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    /// Default answer.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default: Option<Value>,
    /// Recommender id ([`crate::lifeapps::recommend`]).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommend: Option<String>,
    /// Options.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub options: Option<Vec<StepOption>>,
    /// Item fields of list builders (`field → type`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub item_schema: Option<BTreeMap<String, String>>,
    /// Minimum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub min: Option<f64>,
    /// Maximum.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max: Option<f64>,
    /// Step.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub step: Option<f64>,
}

/// Template kind (§16.1 `Template.kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum TemplateKind {
    Page,
    Database,
    View,
    Dashboard,
    Workbook,
    Reminder,
    Recurring,
    Rule,
    Row,
}

/// A template (§16.1 `Template`). `spec` is typed per kind ([`TemplateSpec`]).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Template {
    /// Key (unique per manifest).
    pub key: String,
    /// Kind.
    pub kind: TemplateKind,
    /// Parent page / database key.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_key: Option<String>,
    /// The user may opt out in the wizard.
    pub optional: bool,
    /// Metric-dialect condition over the answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub when: Option<String>,
    /// Kind-specific spec.
    pub spec: Value,
}

/// Metric implementation kind.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum MetricKind {
    Rust,
    Expr,
}

/// A metric definition.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MetricDef {
    /// Name.
    pub name: String,
    /// Kind.
    pub kind: MetricKind,
    /// Rust function id (`kind: rust`).
    #[serde(default, rename = "fn", skip_serializing_if = "Option::is_none")]
    pub func: Option<String>,
    /// Metric-dialect expression (`kind: expr`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expr: Option<String>,
    /// Dependencies (`templateKey.role` or `templateKey`).
    pub deps: Vec<String>,
}

/// Insight severity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Severity {
    Info,
    Tip,
    Warn,
    Critical,
}

/// An advisor action.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvisorAction {
    /// Label.
    pub label: String,
    /// Route string (`page:<key>`, `db:<key>[:<view>]`, `sheet:<key>`, `app[:<tab>]`, `settings:<section>`,
    /// `today`, `home`, `markets`, `lifeapps`).
    pub route: String,
}

/// An advisor rule.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdvisorRule {
    /// Rule id.
    pub id: String,
    /// Metric-dialect condition.
    pub when: String,
    /// Severity.
    pub severity: Severity,
    /// Title (`{{expr}}` interpolation).
    pub title: String,
    /// Body (`{{expr}}` interpolation).
    pub body: String,
    /// Metrics shown under "Show math".
    pub math_metrics: Vec<String>,
    /// Actions.
    pub actions: Vec<AdvisorAction>,
}

/// Checklist auto-tick trigger.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AutoTick {
    /// Event name (`finance.import_committed`, `budget.assigned`, …; `metrics` = after each metric refresh).
    pub event: String,
    /// Metric-dialect condition (`metrics.*` / `answers.*`; event payload fields appear as `answers.event_<field>`).
    #[serde(default, rename = "where", skip_serializing_if = "Option::is_none")]
    pub where_: Option<String>,
}

/// A checklist item.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChecklistItem {
    /// Id.
    pub id: String,
    /// Label.
    pub label: String,
    /// Auto-tick trigger.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auto_tick: Option<AutoTick>,
}

/// An additive migration to manifest version `to`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Migration {
    /// Target version.
    pub to: String,
    /// Operations (template keys to add: `{"addTemplate": "<key>"}`).
    pub ops: Vec<Value>,
}

/// Sample-data generator.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SampleDef {
    /// Generator id ([`crate::lifeapps::sample`]).
    pub generator: String,
    /// PRNG seed.
    pub seed: u64,
}

// ───────────────────────────────────────────────────────────────────────────── template specs

/// Content block of a page, dashboard or row template body.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "camelCase", deny_unknown_fields)]
pub enum BlockSpec {
    /// Markdown (GFM: headings, lists, `- [ ]` to-dos, `> [!tip]` callouts, tables) with `{{expr}}`.
    Md {
        /// Markdown source.
        md: String,
    },
    /// A callout.
    Callout {
        /// Emoji.
        #[serde(default)]
        icon: Option<String>,
        /// Colour.
        #[serde(default)]
        color: Option<BlockColor>,
        /// Markdown text (inline content only).
        md: String,
    },
    /// The manifest disclaimer as a footer callout.
    Disclaimer,
    /// An embedded view of a generated database.
    Database {
        /// Database template key.
        db: String,
        /// View key.
        #[serde(default)]
        view: Option<String>,
        /// Height.
        #[serde(default)]
        height: Option<u32>,
    },
    /// A link to a generated page.
    PageLink {
        /// Page template key.
        page: String,
    },
    /// A KPI tile.
    Kpi {
        /// Metric name (source `{kind:'metric'}`), or …
        #[serde(default)]
        metric: Option<String>,
        /// … a database (source `{kind:'db'}`) with an aggregate.
        #[serde(default)]
        db: Option<String>,
        /// View key of `db`.
        #[serde(default)]
        view: Option<String>,
        /// Aggregate.
        #[serde(default)]
        agg: Option<AggFn>,
        /// Label.
        label: String,
        /// `money|percent|months|number|date|text`.
        #[serde(default)]
        format: Option<String>,
    },
    /// A chart.
    Chart {
        /// Database (source `{kind:'db'}`) …
        #[serde(default)]
        db: Option<String>,
        /// … and view whose chart spec is used.
        #[serde(default)]
        view: Option<String>,
        /// Metric series (source `{kind:'metric'}`).
        #[serde(default)]
        metric: Option<String>,
        /// Explicit chart spec (prop keys are resolved).
        #[serde(default)]
        spec: Option<Value>,
        /// Title above the chart.
        #[serde(default)]
        title: Option<String>,
    },
    /// An embedded sheet range.
    Sheet {
        /// Workbook template key.
        workbook: String,
        /// Sheet name.
        sheet: String,
        /// A1 range.
        range: String,
    },
    /// To-do items.
    Checklist {
        /// Labels (`{{expr}}` allowed).
        items: Vec<String>,
    },
    /// A divider.
    Divider,
    /// A table of contents.
    Toc,
}

/// `page` template spec.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageSpec {
    /// Title (`{{expr}}` allowed).
    pub title: String,
    /// `lucide:<name>` or an emoji.
    #[serde(default)]
    pub icon: Option<String>,
    /// Content.
    #[serde(default)]
    pub blocks: Vec<BlockSpec>,
    /// Mark as a page template (recurring check-ins).
    #[serde(default)]
    pub template: bool,
    /// Full width.
    #[serde(default)]
    pub full_width: bool,
}

/// `dashboard` template spec: a page of kind `dashboard` (the app hub when it is the root).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DashboardSpec {
    /// Title.
    pub title: String,
    /// Icon.
    #[serde(default)]
    pub icon: Option<String>,
    /// Subtitle shown under the h1.
    #[serde(default)]
    pub subtitle: Option<String>,
    /// Underline tabs of the landing header.
    #[serde(default)]
    pub tabs: Vec<String>,
    /// KPI row and charts (kpi / chart / database / sheet blocks).
    #[serde(default)]
    pub tiles: Vec<BlockSpec>,
    /// Further content below the tiles.
    #[serde(default)]
    pub blocks: Vec<BlockSpec>,
}

/// A select / status option.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OptionSpec {
    /// Key (unique in the property).
    pub key: String,
    /// Name.
    pub name: String,
    /// Colour.
    #[serde(default)]
    pub color: Option<BlockColor>,
    /// Status group.
    #[serde(default)]
    pub group: Option<StatusGroup>,
}

/// The dual side of a two-way relation.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DualSpec {
    /// Property key in the target database.
    pub key: String,
    /// Name.
    pub name: String,
}

/// Relation settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationSpec {
    /// Target database template key.
    pub db: String,
    /// Two-way pairing.
    #[serde(default)]
    pub dual: Option<DualSpec>,
    /// `one|many`.
    #[serde(default)]
    pub limit: Option<String>,
}

/// Rollup settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollupSpec {
    /// Relation property key of this database.
    pub relation: String,
    /// Property key in the target database.
    pub target: String,
    /// Function.
    #[serde(rename = "fn")]
    pub func: RollupFn,
}

/// A database property.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropSpec {
    /// Key (unique in the database).
    pub key: String,
    /// Name.
    pub name: String,
    /// Type.
    #[serde(rename = "type")]
    pub kind: PropType,
    /// Semantic role (§15.0).
    #[serde(default)]
    pub role: Option<String>,
    /// Hidden.
    #[serde(default)]
    pub hidden: bool,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
    /// Options (select / multi_select / status).
    #[serde(default)]
    pub options: Option<Vec<OptionSpec>>,
    /// Currency (money; `${answers.currency}` allowed).
    #[serde(default)]
    pub currency: Option<String>,
    /// Number format (`number|comma|percent`).
    #[serde(default)]
    pub format: Option<String>,
    /// Display decimals.
    #[serde(default)]
    pub decimals: Option<u32>,
    /// Relation.
    #[serde(default)]
    pub relation: Option<RelationSpec>,
    /// Rollup.
    #[serde(default)]
    pub rollup: Option<RollupSpec>,
    /// Formula (Row dialect, `prop("Name")` references).
    #[serde(default)]
    pub formula: Option<String>,
    /// Unique-id prefix.
    #[serde(default)]
    pub prefix: Option<String>,
    /// Rating maximum.
    #[serde(default)]
    pub max: Option<u32>,
}

/// A sort level (prop key or `$created` / `$updated` / `$manual`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SortSpec {
    /// Property key.
    pub prop: String,
    /// Direction.
    pub dir: SortDir,
}

/// Grouping.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupSpec {
    /// Property key.
    pub prop: String,
    /// Date bucket.
    #[serde(default)]
    pub date_bucket: Option<DateBucket>,
    /// Group status by option group.
    #[serde(default)]
    pub by_status_group: Option<bool>,
    /// Hide empty groups.
    #[serde(default)]
    pub hide_empty: Option<bool>,
}

/// Calendar settings.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CalendarSpec {
    /// Date property key.
    pub date_prop: String,
    /// Show weekends.
    #[serde(default = "yes")]
    pub show_weekends: bool,
}

fn yes() -> bool {
    true
}

/// A database view. `filter` and `chart` are the `Filter` / `ChartSpec` JSON with property keys in place of
/// ids; option operands are written `opt:<optionKey>`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewSpec {
    /// Key (unique in the database).
    pub key: String,
    /// Name.
    pub name: String,
    /// Layout.
    pub layout: Layout,
    /// Lucide icon.
    #[serde(default)]
    pub icon: Option<String>,
    /// Filter.
    #[serde(default)]
    pub filter: Option<Value>,
    /// Sorts.
    #[serde(default)]
    pub sorts: Vec<SortSpec>,
    /// Grouping.
    #[serde(default)]
    pub group_by: Option<GroupSpec>,
    /// Visible property keys (all when absent).
    #[serde(default)]
    pub visible: Option<Vec<String>>,
    /// Calendar.
    #[serde(default)]
    pub calendar: Option<CalendarSpec>,
    /// Chart.
    #[serde(default)]
    pub chart: Option<Value>,
    /// Footer aggregates by property key.
    #[serde(default)]
    pub footer: BTreeMap<String, AggFn>,
    /// Card settings.
    #[serde(default)]
    pub card: Option<CardSettings>,
    /// Where rows open.
    #[serde(default)]
    pub open_in: Option<OpenIn>,
}

/// A seeded row (or, with `forEach`, one row per list item).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowSeed {
    /// Row key (`${item.field}` / `${index}` allowed with `forEach`).
    pub key: String,
    /// Values by property key (simple JSON: text, numbers, option keys or names, `YYYY-MM-DD`, `@today+3d`,
    /// booleans, related row keys or titles, `{rrule, dtstart}`).
    pub values: Map<String, Value>,
    /// JSON path of a list to expand (`answers.accounts`, `pack.documents`).
    #[serde(default)]
    pub for_each: Option<String>,
    /// Condition (Metric dialect; inside `forEach`, `${…}` is substituted first).
    #[serde(default)]
    pub when: Option<String>,
    /// Emoji icon.
    #[serde(default)]
    pub icon: Option<String>,
}

/// A row template.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowTemplateSpec {
    /// Key.
    pub key: String,
    /// Name.
    pub name: String,
    /// Emoji icon.
    #[serde(default)]
    pub icon: Option<String>,
    /// Values by property key.
    #[serde(default)]
    pub values: Map<String, Value>,
    /// Body.
    #[serde(default)]
    pub body: Vec<BlockSpec>,
    /// Default template.
    #[serde(default)]
    pub default: bool,
}

/// `database` template spec.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DatabaseSpec {
    /// Title.
    pub title: String,
    /// Icon.
    #[serde(default)]
    pub icon: Option<String>,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
    /// Properties (the first `title` property is the primary one).
    pub properties: Vec<PropSpec>,
    /// Views (a default table view is added when empty).
    #[serde(default)]
    pub views: Vec<ViewSpec>,
    /// Row templates.
    #[serde(default)]
    pub row_templates: Vec<RowTemplateSpec>,
    /// Seed rows.
    #[serde(default)]
    pub rows: Vec<RowSeed>,
}

/// `view` template spec: an extra view on a generated database.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ViewTemplateSpec {
    /// Database template key.
    pub db: String,
    /// The view.
    pub view: ViewSpec,
}

/// `row` / `rule` template spec: rows added to a generated database.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowsSpec {
    /// Database template key.
    pub db: String,
    /// Wizard title of the item.
    pub title: String,
    /// Plan item kind (`goal`, `rule`); rows are folded into the database item otherwise.
    #[serde(default)]
    pub plan_kind: Option<String>,
    /// Rows.
    pub rows: Vec<RowSeed>,
}

/// A style applied to an A1 range.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CellStyleSpec {
    /// A1 range.
    pub range: String,
    /// `input|output|check`.
    #[serde(default)]
    pub role: Option<String>,
    /// Bold.
    #[serde(default)]
    pub bold: bool,
    /// Italic.
    #[serde(default)]
    pub italic: bool,
    /// Number format.
    #[serde(default)]
    pub num_fmt: Option<String>,
    /// Fill `#RRGGBB`.
    #[serde(default)]
    pub fill: Option<String>,
    /// Text colour `#RRGGBB`.
    #[serde(default)]
    pub color: Option<String>,
}

/// A conditional format.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CondFormatSpec {
    /// A1 range.
    pub range: String,
    /// `cell|formula|data_bar|color_scale`.
    pub kind: String,
    /// Operator.
    #[serde(default)]
    pub op: Option<String>,
    /// Operands.
    #[serde(default)]
    pub values: Option<Vec<String>>,
    /// Formula.
    #[serde(default)]
    pub formula: Option<String>,
    /// Fill when matched.
    #[serde(default)]
    pub fill: Option<String>,
    /// Text colour when matched.
    #[serde(default)]
    pub color: Option<String>,
    /// Scale colours.
    #[serde(default)]
    pub colors: Option<Vec<String>>,
}

/// A block of cells: `rows[i][j]` goes to `at` + (i, j).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GridSpec {
    /// Top-left A1 cell.
    pub at: String,
    /// Cell inputs (typed text; formulas start with `=`; empty strings are skipped).
    pub rows: Vec<Vec<String>>,
}

/// One sheet.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SheetSpec {
    /// Name.
    pub name: String,
    /// Condition (Metric dialect over the answers); sheets that other sheets reference must not be conditional.
    #[serde(default)]
    pub when: Option<String>,
    /// Tab colour.
    #[serde(default)]
    pub color: Option<String>,
    /// Frozen `[rows, cols]`.
    #[serde(default)]
    pub freeze: Option<[u32; 2]>,
    /// Column widths by letter.
    #[serde(default)]
    pub col_widths: BTreeMap<String, f64>,
    /// Cell blocks.
    #[serde(default)]
    pub grid: Vec<GridSpec>,
    /// Styles.
    #[serde(default)]
    pub styles: Vec<CellStyleSpec>,
    /// Conditional formats.
    #[serde(default)]
    pub cond_formats: Vec<CondFormatSpec>,
    /// Charts (opaque specs with A1 ranges).
    #[serde(default)]
    pub charts: Vec<Value>,
}

/// `workbook` template spec.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkbookSpec {
    /// Title.
    pub title: String,
    /// Sheets.
    pub sheets: Vec<SheetSpec>,
    /// Defined names (`Rate` → `Inputs!$B$3`).
    #[serde(default)]
    pub names: BTreeMap<String, String>,
    /// Post-processing hook (`settle`: write "who pays whom" from the Balances sheet).
    #[serde(default)]
    pub post: Option<String>,
}

/// `reminder` / `recurring` template spec.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderSpec {
    /// Wizard title.
    pub title: String,
    /// Notification text.
    pub text: String,
    /// Target page / database key (default: the app root).
    #[serde(default)]
    pub target: Option<String>,
    /// One reminder per list item.
    #[serde(default)]
    pub for_each: Option<String>,
    /// Item condition.
    #[serde(default)]
    pub when: Option<String>,
    /// RFC 5545 rule (recurring reminders re-arm after firing).
    #[serde(default)]
    pub rrule: Option<String>,
    /// First occurrence / fixed date (`YYYY-MM-DD`, `@today+Nd`).
    #[serde(default)]
    pub at: Option<String>,
    /// Local time `HH:MM` (default 09:00).
    #[serde(default)]
    pub time: Option<String>,
    /// Days before the occurrence (`${answers.reminders.days}` allowed).
    #[serde(default)]
    pub days_before: Option<Value>,
}

/// A typed template spec.
#[derive(Clone, Debug, PartialEq)]
#[allow(missing_docs)]
pub enum TemplateSpec {
    Page(PageSpec),
    Dashboard(DashboardSpec),
    Database(DatabaseSpec),
    View(ViewTemplateSpec),
    Workbook(WorkbookSpec),
    Reminder(ReminderSpec),
    Rows(RowsSpec),
}

impl Template {
    /// Parses `spec` according to `kind`.
    pub fn typed(&self) -> Result<TemplateSpec> {
        let bad = |e: serde_json::Error| {
            StoreError::invalid(format!("template {}: invalid spec: {e}", self.key))
        };
        let v = self.spec.clone();
        Ok(match self.kind {
            TemplateKind::Page => TemplateSpec::Page(serde_json::from_value(v).map_err(bad)?),
            TemplateKind::Dashboard => {
                TemplateSpec::Dashboard(serde_json::from_value(v).map_err(bad)?)
            }
            TemplateKind::Database => {
                TemplateSpec::Database(serde_json::from_value(v).map_err(bad)?)
            }
            TemplateKind::View => TemplateSpec::View(serde_json::from_value(v).map_err(bad)?),
            TemplateKind::Workbook => {
                TemplateSpec::Workbook(serde_json::from_value(v).map_err(bad)?)
            }
            TemplateKind::Reminder | TemplateKind::Recurring => {
                TemplateSpec::Reminder(serde_json::from_value(v).map_err(bad)?)
            }
            TemplateKind::Rule | TemplateKind::Row => {
                TemplateSpec::Rows(serde_json::from_value(v).map_err(bad)?)
            }
        })
    }

    /// Wizard title of the template.
    pub fn title(&self) -> Result<String> {
        Ok(match self.typed()? {
            TemplateSpec::Page(p) => p.title,
            TemplateSpec::Dashboard(d) => d.title,
            TemplateSpec::Database(d) => d.title,
            TemplateSpec::View(v) => v.view.name,
            TemplateSpec::Workbook(w) => w.title,
            TemplateSpec::Reminder(r) => r.title,
            TemplateSpec::Rows(r) => r.title,
        })
    }
}

// ───────────────────────────────────────────────────────────────────────────── validation

fn check_expr(what: &str, src: &str) -> Result<()> {
    emp_sheets::dialect::metric::validate(src)
        .map(|_| ())
        .map_err(|e| StoreError::invalid(format!("{what}: {}", e.message)))
}

/// Metric expressions embedded as `{{…}}` in a string.
fn check_interpolations(what: &str, s: &str) -> Result<()> {
    let mut rest = s;
    while let Some(i) = rest.find("{{") {
        let after = &rest[i + 2..];
        let Some(j) = after.find("}}") else { break };
        check_expr(what, after[..j].trim())?;
        rest = &after[j + 2..];
    }
    Ok(())
}

fn check_blocks(
    manifest: &LifeAppManifest,
    keys: &BTreeMap<&str, TemplateKind>,
    what: &str,
    blocks: &[BlockSpec],
) -> Result<()> {
    let metric_names: BTreeSet<&str> = manifest.metrics.iter().map(|m| m.name.as_str()).collect();
    for b in blocks {
        match b {
            BlockSpec::Md { md } | BlockSpec::Callout { md, .. } => check_interpolations(what, md)?,
            BlockSpec::Checklist { items } => {
                for i in items {
                    check_interpolations(what, i)?;
                }
            }
            BlockSpec::Database { db, .. } => {
                if keys.get(db.as_str()) != Some(&TemplateKind::Database) {
                    return Err(StoreError::invalid(format!(
                        "{what}: unknown database {db}"
                    )));
                }
            }
            BlockSpec::PageLink { page } => {
                if !keys.contains_key(page.as_str()) {
                    return Err(StoreError::invalid(format!("{what}: unknown page {page}")));
                }
            }
            BlockSpec::Kpi { metric, db, .. } | BlockSpec::Chart { metric, db, .. } => {
                if let Some(m) = metric
                    && !metric_names.contains(m.as_str())
                {
                    return Err(StoreError::invalid(format!("{what}: unknown metric {m}")));
                }
                if let Some(d) = db
                    && keys.get(d.as_str()) != Some(&TemplateKind::Database)
                {
                    return Err(StoreError::invalid(format!("{what}: unknown database {d}")));
                }
                if metric.is_none() && db.is_none() {
                    return Err(StoreError::invalid(format!(
                        "{what}: tile without a source"
                    )));
                }
            }
            BlockSpec::Sheet { workbook, .. } => {
                if keys.get(workbook.as_str()) != Some(&TemplateKind::Workbook) {
                    return Err(StoreError::invalid(format!(
                        "{what}: unknown workbook {workbook}"
                    )));
                }
            }
            BlockSpec::Disclaimer => {
                if manifest.disclaimer.is_none() {
                    return Err(StoreError::invalid(format!(
                        "{what}: no disclaimer in manifest"
                    )));
                }
            }
            BlockSpec::Divider | BlockSpec::Toc => {}
        }
    }
    Ok(())
}

fn check_db(spec: &DatabaseSpec, key: &str, dual_keys: &BTreeSet<String>) -> Result<()> {
    let mut seen = BTreeSet::new();
    let titles = spec
        .properties
        .iter()
        .filter(|p| p.kind == PropType::Title)
        .count();
    if titles != 1 {
        return Err(StoreError::invalid(format!(
            "database {key}: needs exactly one title property"
        )));
    }
    for p in &spec.properties {
        if !seen.insert(p.key.as_str()) {
            return Err(StoreError::invalid(format!(
                "database {key}: duplicate property {}",
                p.key
            )));
        }
        if p.kind == PropType::Relation && p.relation.is_none() {
            return Err(StoreError::invalid(format!(
                "database {key}: relation {} has no target",
                p.key
            )));
        }
        if p.kind == PropType::Rollup && p.rollup.is_none() {
            return Err(StoreError::invalid(format!(
                "database {key}: rollup {} has no config",
                p.key
            )));
        }
        if p.kind == PropType::Formula && p.formula.is_none() {
            return Err(StoreError::invalid(format!(
                "database {key}: formula {} has no expression",
                p.key
            )));
        }
        if let Some(opts) = &p.options {
            let mut ok = BTreeSet::new();
            for o in opts {
                if !ok.insert(o.key.as_str()) {
                    return Err(StoreError::invalid(format!(
                        "database {key}: duplicate option {}.{}",
                        p.key, o.key
                    )));
                }
            }
        }
    }
    for p in &spec.properties {
        if let Some(r) = &p.rollup
            && !spec
                .properties
                .iter()
                .any(|q| q.key == r.relation && q.kind == PropType::Relation)
            && !dual_keys.contains(&r.relation)
        {
            return Err(StoreError::invalid(format!(
                "database {key}: rollup {} needs relation {}",
                p.key, r.relation
            )));
        }
    }
    let mut views = BTreeSet::new();
    for v in &spec.views {
        if !views.insert(v.key.as_str()) {
            return Err(StoreError::invalid(format!(
                "database {key}: duplicate view {}",
                v.key
            )));
        }
    }
    Ok(())
}

impl LifeAppManifest {
    /// Parses and validates a manifest.
    pub fn parse(json: &str) -> Result<Self> {
        let m: Self = serde_json::from_str(json)
            .map_err(|e| StoreError::invalid(format!("manifest: {e}")))?;
        m.validate()?;
        Ok(m)
    }

    /// A template by key.
    #[must_use]
    pub fn template(&self, key: &str) -> Option<&Template> {
        self.templates.iter().find(|t| t.key == key)
    }

    /// A step by id.
    #[must_use]
    pub fn step(&self, id: &str) -> Option<&Step> {
        self.steps.iter().find(|s| s.id == id)
    }

    /// Structural validation: unique ids/keys, resolvable references, parseable expressions and specs.
    pub fn validate(&self) -> Result<()> {
        let semver = self.version.split('.').count() == 3
            && self.version.split('.').all(|p| p.parse::<u32>().is_ok());
        if !semver {
            return Err(StoreError::invalid(format!(
                "{}: version is not semver",
                self.id
            )));
        }
        let mut steps = BTreeSet::new();
        for s in &self.steps {
            if !steps.insert(s.id.as_str()) {
                return Err(StoreError::invalid(format!("duplicate step {}", s.id)));
            }
            if let Some(w) = &s.when {
                check_expr(&format!("step {}", s.id), w)?;
            }
            if let Some(r) = &s.recommend
                && !crate::lifeapps::recommend::known(r)
            {
                return Err(StoreError::invalid(format!(
                    "step {}: unknown recommender {r}",
                    s.id
                )));
            }
        }
        let mut keys: BTreeMap<&str, TemplateKind> = BTreeMap::new();
        for t in &self.templates {
            if keys.insert(t.key.as_str(), t.kind).is_some() {
                return Err(StoreError::invalid(format!("duplicate template {}", t.key)));
            }
        }
        match self.templates.first() {
            Some(t)
                if t.parent_key.is_none()
                    && matches!(t.kind, TemplateKind::Page | TemplateKind::Dashboard)
                    && !t.optional
                    && t.when.is_none() => {}
            _ => {
                return Err(StoreError::invalid(format!(
                    "{}: the first template must be the (required, unconditional) hub page",
                    self.id
                )));
            }
        }
        for t in &self.templates {
            let what = format!("template {}", t.key);
            if let Some(p) = &t.parent_key
                && !matches!(
                    keys.get(p.as_str()),
                    Some(TemplateKind::Page | TemplateKind::Dashboard)
                )
            {
                return Err(StoreError::invalid(format!("{what}: unknown parent {p}")));
            }
            if let Some(w) = &t.when {
                check_expr(&what, w)?;
            }
            match t.typed()? {
                TemplateSpec::Page(p) => {
                    check_interpolations(&what, &p.title)?;
                    check_blocks(self, &keys, &what, &p.blocks)?;
                }
                TemplateSpec::Dashboard(d) => {
                    check_blocks(self, &keys, &what, &d.tiles)?;
                    check_blocks(self, &keys, &what, &d.blocks)?;
                }
                TemplateSpec::Database(d) => {
                    // Relations other databases pair with this one (their duals live here).
                    let mut dual_keys = BTreeSet::new();
                    for o in &self.templates {
                        if let Ok(TemplateSpec::Database(od)) = o.typed() {
                            for p in &od.properties {
                                if let Some(r) = &p.relation
                                    && r.db == t.key
                                    && let Some(dd) = &r.dual
                                {
                                    dual_keys.insert(dd.key.clone());
                                }
                            }
                        }
                    }
                    check_db(&d, &t.key, &dual_keys)?;
                    for p in &d.properties {
                        if let Some(r) = &p.relation
                            && keys.get(r.db.as_str()) != Some(&TemplateKind::Database)
                        {
                            return Err(StoreError::invalid(format!(
                                "{what}: relation to unknown database {}",
                                r.db
                            )));
                        }
                    }
                    for rt in &d.row_templates {
                        check_blocks(self, &keys, &what, &rt.body)?;
                    }
                }
                TemplateSpec::View(v) => {
                    if keys.get(v.db.as_str()) != Some(&TemplateKind::Database) {
                        return Err(StoreError::invalid(format!(
                            "{what}: unknown database {}",
                            v.db
                        )));
                    }
                }
                TemplateSpec::Rows(r) => {
                    if keys.get(r.db.as_str()) != Some(&TemplateKind::Database) {
                        return Err(StoreError::invalid(format!(
                            "{what}: unknown database {}",
                            r.db
                        )));
                    }
                }
                TemplateSpec::Workbook(w) => {
                    if w.sheets.is_empty() {
                        return Err(StoreError::invalid(format!("{what}: no sheets")));
                    }
                }
                TemplateSpec::Reminder(r) => {
                    if let Some(tg) = &r.target
                        && !keys.contains_key(tg.as_str())
                    {
                        return Err(StoreError::invalid(format!("{what}: unknown target {tg}")));
                    }
                    check_interpolations(&what, &r.text)?;
                }
            }
        }
        let mut metrics = BTreeSet::new();
        for m in &self.metrics {
            if !metrics.insert(m.name.as_str()) {
                return Err(StoreError::invalid(format!("duplicate metric {}", m.name)));
            }
            match m.kind {
                MetricKind::Expr => {
                    let e = m.expr.as_deref().ok_or_else(|| {
                        StoreError::invalid(format!("metric {}: no expr", m.name))
                    })?;
                    check_expr(&format!("metric {}", m.name), e)?;
                }
                MetricKind::Rust => {
                    let f = m
                        .func
                        .as_deref()
                        .ok_or_else(|| StoreError::invalid(format!("metric {}: no fn", m.name)))?;
                    if !crate::lifeapps::metrics::known_fn(f) {
                        return Err(StoreError::invalid(format!(
                            "metric {}: unknown fn {f}",
                            m.name
                        )));
                    }
                }
            }
            for d in &m.deps {
                let k = d.split('.').next().unwrap_or_default();
                if !keys.contains_key(k)
                    && !metrics.contains(k)
                    && self.metrics.iter().all(|x| x.name != k)
                {
                    return Err(StoreError::invalid(format!(
                        "metric {}: unknown dependency {d}",
                        m.name
                    )));
                }
            }
        }
        let mut rules = BTreeSet::new();
        for r in &self.advisor {
            if !rules.insert(r.id.as_str()) {
                return Err(StoreError::invalid(format!(
                    "duplicate advisor rule {}",
                    r.id
                )));
            }
            let what = format!("advisor {}", r.id);
            check_expr(&what, &r.when)?;
            check_interpolations(&what, &r.title)?;
            check_interpolations(&what, &r.body)?;
            for mm in &r.math_metrics {
                if !metrics.contains(mm.as_str()) {
                    return Err(StoreError::invalid(format!("{what}: unknown metric {mm}")));
                }
            }
            for a in &r.actions {
                let first = a.route.split(':').next().unwrap_or_default();
                let target = a.route.split(':').nth(1);
                match (first, target) {
                    ("page" | "db" | "sheet", Some(k)) if keys.contains_key(k) => {}
                    ("app" | "today" | "home" | "markets" | "lifeapps" | "settings", _) => {}
                    _ => {
                        return Err(StoreError::invalid(format!(
                            "{what}: bad route {}",
                            a.route
                        )));
                    }
                }
            }
        }
        let mut items = BTreeSet::new();
        for c in &self.checklist {
            if !items.insert(c.id.as_str()) {
                return Err(StoreError::invalid(format!(
                    "duplicate checklist item {}",
                    c.id
                )));
            }
            if let Some(w) = c.auto_tick.as_ref().and_then(|a| a.where_.as_deref()) {
                check_expr(&format!("checklist {}", c.id), w)?;
            }
        }
        if !crate::lifeapps::sample::known(&self.sample.generator) {
            return Err(StoreError::invalid(format!(
                "unknown sample generator {}",
                self.sample.generator
            )));
        }
        Ok(())
    }
}

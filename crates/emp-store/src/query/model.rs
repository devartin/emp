//! Database DTOs and payloads (SPEC §8, §10.3 `DatabasePayload` / `PropertyPayload` / `RowPayload` /
//! `ViewPayload`, §11.3 "Databases").
//!
//! IPC-facing types use `camelCase` and match `src/backend/types.ts`. Property configuration stays an open JSON
//! object (`config: Record<string, unknown>`); typed views of the parts the engine needs are in
//! [`crate::query::config`].

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::model::{BlockColor, Icon, Id, Rev, TipTapDoc, Ts, double_option};

// ───────────────────────────────────────────────────────────────────────────── rich text and cell values

/// A mark on a rich-text run.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct RunMark {
    /// `bold|italic|underline|strike|code|link|mention|textColor|highlight`.
    #[serde(rename = "type")]
    pub kind: String,
    /// Attributes.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attrs: Option<Map<String, Value>>,
}

/// One run of [`RichText`].
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct TextRun {
    /// Text.
    pub text: String,
    /// Marks.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub marks: Option<Vec<RunMark>>,
}

/// `RichText` (SPEC §11.2).
pub type RichText = Vec<TextRun>;

/// Plain text of rich text.
#[must_use]
pub fn rich_plain(rt: &RichText) -> String {
    rt.iter().map(|r| r.text.as_str()).collect()
}

/// Rich text holding one unmarked run (empty input gives an empty vector).
#[must_use]
pub fn rich(text: &str) -> RichText {
    if text.is_empty() {
        Vec::new()
    } else {
        vec![TextRun {
            text: text.to_owned(),
            marks: None,
        }]
    }
}

/// `DateValue`: `start`/`end` are `YYYY-MM-DD` when `time` is false, else RFC 3339 with offset.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateValue {
    /// Start.
    pub start: String,
    /// End of a range.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
    /// Whether the value carries a time.
    pub time: bool,
    /// IANA time zone of timed values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
}

/// Recurrence mode.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecurrenceMode {
    /// Next date follows the schedule.
    Schedule,
    /// Next date is computed from the completion date.
    Completion,
}

/// `RecurrenceValue`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurrenceValue {
    /// RFC 5545 rule (`FREQ=WEEKLY;BYDAY=MO`), with or without the `RRULE:` prefix.
    pub rrule: String,
    /// First occurrence (`YYYY-MM-DD` or RFC 3339).
    pub dtstart: String,
    /// IANA zone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tz: Option<String>,
    /// Mode.
    pub mode: RecurrenceMode,
}

/// A file reference of a `files` cell.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRef {
    /// Asset id.
    pub asset_id: Id,
    /// Display name.
    pub name: String,
}

/// Masked secret.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SecretMask {
    /// `••••1234`.
    pub masked: String,
}

/// Kind of a computed value.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum ComputedKind {
    Number,
    Money,
    Text,
    Bool,
    Date,
    List,
    Error,
}

/// Value of a computed cell (formulas, rollups, life-app `computed` properties).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ComputedValue {
    /// Kind.
    pub kind: ComputedKind,
    /// Raw value (number, string, boolean, ISO date, list).
    pub value: Value,
    /// Display string.
    pub display: String,
}

/// A typed cell value (SPEC §11.3 `CellValue`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum CellValue {
    Text { v: RichText },
    Number { v: Option<f64> },
    Money { v: Option<String>, cur: String },
    Select { v: Option<Id> },
    Status { v: Option<Id> },
    Multi { v: Vec<Id> },
    Date { v: Option<DateValue> },
    Check { v: bool },
    Url { v: Option<String> },
    Email { v: Option<String> },
    Phone { v: Option<String> },
    Files { v: Vec<FileRef> },
    Relation { v: Vec<Id> },
    Uid { v: String },
    Rating { v: Option<f64> },
    Progress { v: Option<f64> },
    Ticker { v: Option<String> },
    Recurrence { v: Option<RecurrenceValue> },
    Secret { v: Option<SecretMask> },
    Computed { v: ComputedValue },
    Ts { v: Ts },
}

impl CellValue {
    /// A text cell.
    #[must_use]
    pub fn text(s: &str) -> Self {
        Self::Text { v: rich(s) }
    }

    /// A number cell.
    #[must_use]
    pub fn number(n: f64) -> Self {
        Self::Number { v: Some(n) }
    }

    /// The `t` tag.
    #[must_use]
    pub fn tag(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Number { .. } => "number",
            Self::Money { .. } => "money",
            Self::Select { .. } => "select",
            Self::Status { .. } => "status",
            Self::Multi { .. } => "multi",
            Self::Date { .. } => "date",
            Self::Check { .. } => "check",
            Self::Url { .. } => "url",
            Self::Email { .. } => "email",
            Self::Phone { .. } => "phone",
            Self::Files { .. } => "files",
            Self::Relation { .. } => "relation",
            Self::Uid { .. } => "uid",
            Self::Rating { .. } => "rating",
            Self::Progress { .. } => "progress",
            Self::Ticker { .. } => "ticker",
            Self::Recurrence { .. } => "recurrence",
            Self::Secret { .. } => "secret",
            Self::Computed { .. } => "computed",
            Self::Ts { .. } => "ts",
        }
    }
}

// ───────────────────────────────────────────────────────────────────────────── properties

/// Property type (SPEC §8.1).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum PropType {
    Title,
    Text,
    Number,
    Money,
    Select,
    MultiSelect,
    Status,
    Date,
    Checkbox,
    Url,
    Email,
    Phone,
    Files,
    Relation,
    Rollup,
    Formula,
    CreatedTime,
    UpdatedTime,
    UniqueId,
    Rating,
    Progress,
    Ticker,
    Recurrence,
    Secret,
    Computed,
}

impl PropType {
    /// The snake_case name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Title => "title",
            Self::Text => "text",
            Self::Number => "number",
            Self::Money => "money",
            Self::Select => "select",
            Self::MultiSelect => "multi_select",
            Self::Status => "status",
            Self::Date => "date",
            Self::Checkbox => "checkbox",
            Self::Url => "url",
            Self::Email => "email",
            Self::Phone => "phone",
            Self::Files => "files",
            Self::Relation => "relation",
            Self::Rollup => "rollup",
            Self::Formula => "formula",
            Self::CreatedTime => "created_time",
            Self::UpdatedTime => "updated_time",
            Self::UniqueId => "unique_id",
            Self::Rating => "rating",
            Self::Progress => "progress",
            Self::Ticker => "ticker",
            Self::Recurrence => "recurrence",
            Self::Secret => "secret",
            Self::Computed => "computed",
        }
    }

    /// Values computed at read time (never stored in `RowPayload.values`).
    #[must_use]
    pub fn is_derived(self) -> bool {
        matches!(
            self,
            Self::Rollup | Self::Formula | Self::CreatedTime | Self::UpdatedTime
        )
    }

    /// Values users cannot write through `db_rows_update`.
    #[must_use]
    pub fn is_read_only(self) -> bool {
        self.is_derived() || matches!(self, Self::UniqueId | Self::Computed)
    }
}

/// `Property` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Property {
    /// Id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Type.
    #[serde(rename = "type")]
    pub kind: PropType,
    /// Type-specific configuration.
    pub config: Map<String, Value>,
    /// Semantic role (life apps).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Hidden in views by default.
    pub hidden: bool,
    /// Column order.
    pub sort_key: String,
    /// Description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// Stored payload of a `db_properties` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PropertyPayload {
    /// Payload version.
    pub v: u32,
    /// Name.
    pub name: String,
    /// Type.
    #[serde(rename = "type")]
    pub kind: PropType,
    /// Configuration.
    #[serde(default)]
    pub config: Map<String, Value>,
    /// Semantic role.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<String>,
    /// Hidden.
    #[serde(default)]
    pub hidden: bool,
    /// Description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// A property to create (`db_create.properties[]`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertySpec {
    /// Name.
    pub name: String,
    /// Type.
    #[serde(rename = "type")]
    pub kind: PropType,
    /// Configuration.
    #[serde(default)]
    pub config: Option<Map<String, Value>>,
}

impl PropertySpec {
    /// A property spec without configuration.
    #[must_use]
    pub fn new(name: &str, kind: PropType) -> Self {
        Self {
            name: name.to_owned(),
            kind,
            config: None,
        }
    }

    /// Builder: sets the configuration.
    #[must_use]
    pub fn with_config(mut self, config: Value) -> Self {
        self.config = config.as_object().cloned();
        self
    }
}

/// `db_property_update.patch`.
#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PropertyPatch {
    /// New name.
    #[serde(default)]
    pub name: Option<String>,
    /// Replacement configuration (merged key by key into the current one).
    #[serde(default)]
    pub config: Option<Map<String, Value>>,
    /// Hidden.
    #[serde(default)]
    pub hidden: Option<bool>,
    /// Description.
    #[serde(default)]
    pub description: Option<String>,
}

/// Status option group.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum StatusGroup {
    Todo,
    InProgress,
    Complete,
}

impl StatusGroup {
    /// Snake-case name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::InProgress => "in_progress",
            Self::Complete => "complete",
        }
    }
}

/// One select / multi-select / status option.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectOption {
    /// Option id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Colour.
    pub color: BlockColor,
    /// Status group.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group: Option<StatusGroup>,
}

/// `db_select_option_upsert.option`.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SelectOptionInput {
    /// Existing option id (update) or absent (create).
    #[serde(default)]
    pub id: Option<Id>,
    /// Name.
    pub name: String,
    /// Colour.
    pub color: BlockColor,
    /// Status group.
    #[serde(default)]
    pub group: Option<StatusGroup>,
}

/// Rollup function (SPEC §8.1 RollupFn).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum RollupFn {
    ShowOriginal,
    ShowUnique,
    CountAll,
    CountValues,
    CountUnique,
    CountEmpty,
    CountNotEmpty,
    PctEmpty,
    PctNotEmpty,
    Sum,
    Average,
    Median,
    Min,
    Max,
    Range,
    Earliest,
    Latest,
    DateRange,
    Checked,
    Unchecked,
    PctChecked,
    PctUnchecked,
}

// ───────────────────────────────────────────────────────────────────────────── databases

/// Template value: a cell or a variable token such as `@today+3d`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TemplateValue {
    /// A literal cell.
    Cell(CellValue),
    /// A template variable (`@today`, `@now`, `@today+Nd|w|m`, `@name`, `@seq`) or plain text.
    Token(String),
}

/// `RowTemplate`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowTemplate {
    /// Id.
    pub id: Id,
    /// Name.
    pub name: String,
    /// Icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Values by property id.
    #[serde(default)]
    pub values: BTreeMap<Id, TemplateValue>,
    /// Body document.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub doc: Option<TipTapDoc>,
}

/// Stored payload of a `databases` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabasePayload {
    /// Payload version.
    pub v: u32,
    /// Description.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<RichText>,
    /// The title property.
    pub primary_prop_id: Id,
    /// Prefix of `unique_id` values.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid_prefix: Option<String>,
    /// Last issued unique-id number (monotonic; never reused).
    #[serde(default)]
    pub uid_seq: i64,
    /// Inline database (shown inside a page).
    #[serde(default)]
    pub inline: bool,
    /// Row templates.
    #[serde(default)]
    pub templates: Vec<RowTemplate>,
    /// Default template.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_template_id: Option<Id>,
    /// Hide empty properties on row pages.
    #[serde(default)]
    pub hide_empty_props: bool,
    /// Semantic role → property id.
    #[serde(default)]
    pub roles: BTreeMap<String, Id>,
}

/// `DbSchema.database`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbInfo {
    /// Database (= page) id.
    pub id: Id,
    /// Title (from the page).
    pub title: String,
    /// Icon (from the page).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Description.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<RichText>,
    /// Title property.
    pub primary_prop_id: Id,
    /// Schema revision.
    pub schema_rev: Rev,
    /// Data revision.
    pub data_rev: Rev,
    /// Templates.
    pub templates: Vec<RowTemplate>,
    /// Default template.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_template_id: Option<Id>,
    /// Hide empty properties.
    pub hide_empty_props: bool,
    /// Roles.
    pub roles: BTreeMap<String, Id>,
    /// Owning life-app instance.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_instance_id: Option<Id>,
}

/// `DbSchema`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbSchema {
    /// Database info.
    pub database: DbInfo,
    /// Live properties in column order.
    pub properties: Vec<Property>,
    /// Live views in tab order.
    pub views: Vec<View>,
}

impl DbSchema {
    /// A property by id.
    #[must_use]
    pub fn property(&self, id: &str) -> Option<&Property> {
        self.properties.iter().find(|p| p.id == id)
    }

    /// A property by (case-insensitive) name.
    #[must_use]
    pub fn property_named(&self, name: &str) -> Option<&Property> {
        self.properties
            .iter()
            .find(|p| p.name.eq_ignore_ascii_case(name))
    }
}

/// `db_create` request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DbCreate {
    /// Workspace.
    pub workspace_id: Id,
    /// Parent page.
    #[serde(default)]
    pub parent_id: Option<Id>,
    /// Title.
    pub title: String,
    /// Inline database.
    #[serde(default)]
    pub inline: bool,
    /// Properties besides the title (a `title` entry renames the title property).
    #[serde(default)]
    pub properties: Option<Vec<PropertySpec>>,
    /// Sibling to insert after.
    #[serde(default)]
    pub after_id: Option<Id>,
}

impl DbCreate {
    /// A request with defaults.
    #[must_use]
    pub fn new(workspace_id: &str, parent_id: Option<&str>, title: &str) -> Self {
        Self {
            workspace_id: workspace_id.to_owned(),
            parent_id: parent_id.map(str::to_owned),
            title: title.to_owned(),
            inline: false,
            properties: None,
            after_id: None,
        }
    }

    /// Builder: sets the properties.
    #[must_use]
    pub fn with_properties(mut self, props: Vec<PropertySpec>) -> Self {
        self.properties = Some(props);
        self
    }
}

/// `db_create` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DbCreated {
    /// The database page.
    pub page: crate::model::PageMeta,
    /// Its schema.
    pub schema: DbSchema,
}

/// `db_update.patch`.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DbPatch {
    /// Description.
    #[serde(default)]
    pub description: Option<RichText>,
    /// Templates (replaces the list).
    #[serde(default)]
    pub templates: Option<Vec<RowTemplate>>,
    /// Default template (`null` clears).
    #[serde(default, deserialize_with = "double_option")]
    pub default_template_id: Option<Option<Id>>,
    /// Hide empty properties.
    #[serde(default)]
    pub hide_empty_props: Option<bool>,
    /// Inline.
    #[serde(default)]
    pub inline: Option<bool>,
}

// ───────────────────────────────────────────────────────────────────────────── rows

/// Stored payload of a `db_rows` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct RowPayload {
    /// Payload version.
    pub v: u32,
    /// Values by property id.
    #[serde(default)]
    pub values: BTreeMap<Id, CellValue>,
    /// Icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Tags (`sample` marks seeded demo rows).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tags: Option<Vec<String>>,
    /// Secret ids behind `secret` cells, by property id (storage only; never sent over IPC).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub secrets: BTreeMap<Id, Id>,
}

/// `RowDTO`.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowDto {
    /// Id.
    pub id: Id,
    /// Revision.
    pub rev: Rev,
    /// Manual order.
    pub sort_key: String,
    /// Created.
    pub created_at: Ts,
    /// Updated.
    pub updated_at: Ts,
    /// Values (stored and computed).
    pub values: BTreeMap<Id, CellValue>,
    /// Whether the row has a body document.
    pub has_body: bool,
    /// Icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
    /// Sample (demo) row.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample: Option<bool>,
}

impl RowDto {
    /// Plain text of the value of `prop` (empty if absent).
    #[must_use]
    pub fn text_of(&self, prop: &str) -> String {
        self.values
            .get(prop)
            .map(crate::query::cells::plain_text)
            .unwrap_or_default()
    }
}

/// `db_row_create` request.
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowCreate {
    /// Database.
    pub database_id: Id,
    /// Initial values.
    #[serde(default)]
    pub values: Option<BTreeMap<Id, CellValue>>,
    /// Insert after this row.
    #[serde(default)]
    pub after_id: Option<Id>,
    /// View the row is created from (its filter pre-fills simple `eq` conditions).
    #[serde(default)]
    pub view_id: Option<Id>,
    /// Template.
    #[serde(default)]
    pub template_id: Option<Id>,
}

impl RowCreate {
    /// A request for `database_id`.
    #[must_use]
    pub fn new(database_id: &str) -> Self {
        Self {
            database_id: database_id.to_owned(),
            ..Self::default()
        }
    }

    /// Builder: one value.
    #[must_use]
    pub fn with(mut self, prop: &str, value: CellValue) -> Self {
        self.values
            .get_or_insert_with(BTreeMap::new)
            .insert(prop.to_owned(), value);
        self
    }
}

/// One `db_rows_update` item.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RowUpdate {
    /// Row.
    pub id: Id,
    /// Values (`null` clears).
    pub values: BTreeMap<Id, Option<CellValue>>,
    /// Optimistic concurrency.
    #[serde(default)]
    pub base_rev: Option<Rev>,
}

impl RowUpdate {
    /// An update of one value.
    #[must_use]
    pub fn one(id: &str, prop: &str, value: Option<CellValue>) -> Self {
        let mut values = BTreeMap::new();
        values.insert(prop.to_owned(), value);
        Self {
            id: id.to_owned(),
            values,
            base_rev: None,
        }
    }
}

/// `db_rows_move.groupValue`.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupValue {
    /// Grouped property.
    pub prop: Id,
    /// New value.
    pub value: CellValue,
}

/// `db_row_get` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RowGet {
    /// The row.
    pub row: RowDto,
    /// Body.
    pub doc: Option<TipTapDoc>,
    /// Body revision (0 without a body).
    pub doc_rev: Rev,
    /// Database.
    pub database_id: Id,
    /// Previous row in manual order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prev_id: Option<Id>,
    /// Next row in manual order.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_id: Option<Id>,
}

/// `db_relation_options` item.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RelationOption {
    /// Row id.
    pub id: Id,
    /// Row title.
    pub title: String,
    /// Icon.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub icon: Option<Icon>,
}

/// `db_formula_check` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaCheck {
    /// Valid.
    pub ok: bool,
    /// Result type.
    #[serde(rename = "type", skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// Error with byte span.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<FormulaError>,
    /// Results for the first rows.
    pub preview: Vec<String>,
}

/// Error of [`FormulaCheck`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FormulaError {
    /// Message.
    pub message: String,
    /// Start byte.
    pub from: usize,
    /// End byte.
    pub to: usize,
}

// ───────────────────────────────────────────────────────────────────────────── views and queries

/// Filter operator.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum FilterOp {
    Eq,
    Neq,
    Contains,
    NotContains,
    StartsWith,
    EndsWith,
    Empty,
    NotEmpty,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
    AnyOf,
    NoneOf,
    AllOf,
    GroupEq,
    Before,
    After,
    OnOrBefore,
    OnOrAfter,
    Within,
    Checked,
    Unchecked,
}

/// A filter tree (`and`/`or` groups at most 3 levels deep).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Filter {
    /// All children match.
    And {
        /// Children.
        and: Vec<Filter>,
    },
    /// Any child matches.
    Or {
        /// Children.
        or: Vec<Filter>,
    },
    /// A condition on a property (`$created` / `$updated` for row timestamps).
    Cond {
        /// Property id.
        prop: String,
        /// Operator.
        op: FilterOp,
        /// Operand.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        value: Option<Value>,
    },
}

impl Filter {
    /// A condition.
    #[must_use]
    pub fn cond(prop: &str, op: FilterOp, value: Option<Value>) -> Self {
        Self::Cond {
            prop: prop.to_owned(),
            op,
            value,
        }
    }
}

/// Sort direction.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum SortDir {
    Asc,
    Desc,
}

/// One sort level (`prop` may be `$created`, `$updated` or `$manual`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Sort {
    /// Property id.
    pub prop: String,
    /// Direction.
    pub dir: SortDir,
}

/// Date bucket for grouping.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum DateBucket {
    Relative,
    Day,
    Week,
    Month,
    Quarter,
    Year,
}

/// `GroupBy`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GroupBy {
    /// Property.
    pub prop: Id,
    /// Date bucket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date_bucket: Option<DateBucket>,
    /// Status: group by option group instead of option.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub by_status_group: Option<bool>,
    /// Hide empty groups.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hide_empty: Option<bool>,
    /// Manual group order (keys).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<Vec<String>>,
}

/// View layout.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
#[allow(missing_docs)]
pub enum Layout {
    Table,
    Board,
    List,
    Gallery,
    Calendar,
    Chart,
}

/// Footer / group aggregate (SPEC §8.5).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum AggFn {
    Count,
    CountValues,
    CountUnique,
    Empty,
    NotEmpty,
    PctEmpty,
    PctNotEmpty,
    Sum,
    Avg,
    Median,
    Min,
    Max,
    Range,
    Earliest,
    Latest,
    Checked,
    Unchecked,
    PctChecked,
}

/// Card settings of board / gallery views.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CardSettings {
    /// `none|cover|content|<propId>`.
    pub preview: String,
    /// `s|m|l`.
    pub size: String,
    /// Fit image.
    pub fit: bool,
}

/// Calendar settings.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarSettings {
    /// Date property.
    pub date_prop: Id,
    /// Show weekends.
    pub show_weekends: bool,
}

/// Chart X axis.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChartX {
    /// Property (or `$created`).
    pub prop: String,
    /// Date bucket.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bucket: Option<DateBucket>,
}

/// Chart Y measure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChartY {
    /// Aggregate.
    pub agg: AggFn,
    /// Property (absent for `count`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prop: Option<String>,
    /// Combo charts: `bar|line`.
    #[serde(default, rename = "as", skip_serializing_if = "Option::is_none")]
    pub as_: Option<String>,
}

/// Series split.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChartSeries {
    /// Property.
    pub prop: String,
}

/// `ChartSpec`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChartSpec {
    /// Chart type.
    #[serde(rename = "type")]
    pub kind: String,
    /// X axis.
    pub x: ChartX,
    /// Measures.
    pub y: Vec<ChartY>,
    /// Series.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub series: Option<ChartSeries>,
    /// Stacked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stacked: Option<bool>,
    /// Cumulative.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cumulative: Option<bool>,
    /// Data labels.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub labels: Option<bool>,
    /// Smoothing.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub smooth: Option<bool>,
    /// Omit zero buckets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub omit_zero: Option<bool>,
    /// `auto|gainloss`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub colors: Option<String>,
}

/// Where rows open.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
#[allow(missing_docs)]
pub enum OpenIn {
    #[default]
    SidePeek,
    FullPage,
}

/// Stored payload of a `db_views` row.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewPayload {
    /// Payload version.
    pub v: u32,
    /// Name.
    pub name: String,
    /// Icon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    /// Layout.
    pub layout: Layout,
    /// Filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    /// Sorts.
    #[serde(default)]
    pub sorts: Vec<Sort>,
    /// Grouping.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<GroupBy>,
    /// Visible properties in order.
    #[serde(default)]
    pub visible_props: Vec<Id>,
    /// Column widths.
    #[serde(default)]
    pub prop_widths: BTreeMap<Id, f64>,
    /// Per-column wrap.
    #[serde(default)]
    pub wrap: BTreeMap<Id, bool>,
    /// Card settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardSettings>,
    /// Calendar settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar: Option<CalendarSettings>,
    /// Chart settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<ChartSpec>,
    /// Footer aggregates.
    #[serde(default)]
    pub footer_aggs: BTreeMap<Id, AggFn>,
    /// Collapsed group keys.
    #[serde(default)]
    pub collapsed_groups: Vec<String>,
    /// Where rows open.
    #[serde(default)]
    pub open_in: OpenIn,
}

impl ViewPayload {
    /// A default view.
    #[must_use]
    pub fn new(name: &str, layout: Layout, visible_props: Vec<Id>) -> Self {
        Self {
            v: 1,
            name: name.to_owned(),
            icon: None,
            layout,
            filter: None,
            sorts: Vec::new(),
            group_by: None,
            visible_props,
            prop_widths: BTreeMap::new(),
            wrap: BTreeMap::new(),
            card: None,
            calendar: None,
            chart: None,
            footer_aggs: BTreeMap::new(),
            collapsed_groups: Vec::new(),
            open_in: OpenIn::SidePeek,
        }
    }

    /// The IPC view.
    #[must_use]
    pub fn into_view(self, id: &str, sort_key: &str) -> View {
        View {
            id: id.to_owned(),
            name: self.name,
            icon: self.icon,
            layout: self.layout,
            filter: self.filter,
            sorts: self.sorts,
            group_by: self.group_by,
            visible_props: self.visible_props,
            prop_widths: self.prop_widths,
            wrap: self.wrap,
            card: self.card,
            calendar: self.calendar,
            chart: self.chart,
            footer_aggs: self.footer_aggs,
            collapsed_groups: self.collapsed_groups,
            open_in: self.open_in,
            sort_key: sort_key.to_owned(),
        }
    }
}

/// `View` IPC DTO.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[allow(missing_docs)]
pub struct View {
    pub id: Id,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    pub layout: Layout,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    pub sorts: Vec<Sort>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub group_by: Option<GroupBy>,
    pub visible_props: Vec<Id>,
    pub prop_widths: BTreeMap<Id, f64>,
    pub wrap: BTreeMap<Id, bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub card: Option<CardSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub calendar: Option<CalendarSettings>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chart: Option<ChartSpec>,
    pub footer_aggs: BTreeMap<Id, AggFn>,
    pub collapsed_groups: Vec<String>,
    pub open_in: OpenIn,
    pub sort_key: String,
}

/// `db_view_update.patch` (every field optional; nullable fields accept `null` to clear).
#[derive(Clone, Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[allow(missing_docs)]
pub struct ViewPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub icon: Option<Option<String>>,
    #[serde(default)]
    pub layout: Option<Layout>,
    #[serde(default, deserialize_with = "double_option")]
    pub filter: Option<Option<Filter>>,
    #[serde(default)]
    pub sorts: Option<Vec<Sort>>,
    #[serde(default, deserialize_with = "double_option")]
    pub group_by: Option<Option<GroupBy>>,
    #[serde(default)]
    pub visible_props: Option<Vec<Id>>,
    #[serde(default)]
    pub prop_widths: Option<BTreeMap<Id, f64>>,
    #[serde(default)]
    pub wrap: Option<BTreeMap<Id, bool>>,
    #[serde(default, deserialize_with = "double_option")]
    pub card: Option<Option<CardSettings>>,
    #[serde(default, deserialize_with = "double_option")]
    pub calendar: Option<Option<CalendarSettings>>,
    #[serde(default, deserialize_with = "double_option")]
    pub chart: Option<Option<ChartSpec>>,
    #[serde(default)]
    pub footer_aggs: Option<BTreeMap<Id, AggFn>>,
    #[serde(default)]
    pub collapsed_groups: Option<Vec<String>>,
    #[serde(default)]
    pub open_in: Option<OpenIn>,
}

/// `db_query.override`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryOverride {
    /// Replaces the view filter.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub filter: Option<Filter>,
    /// Replaces the view sorts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sorts: Option<Vec<Sort>>,
    /// Replaces the grouping (`null` removes it).
    #[serde(
        default,
        deserialize_with = "double_option",
        skip_serializing_if = "Option::is_none"
    )]
    pub group_by: Option<Option<GroupBy>>,
    /// Database search (title and text properties).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub search: Option<String>,
}

/// Query window.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct QueryWindow {
    /// Offset.
    pub offset: usize,
    /// Limit (≤ 500).
    pub limit: usize,
}

/// `db_query` request.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QueryRequest {
    /// Database.
    pub database_id: Id,
    /// View.
    #[serde(default)]
    pub view_id: Option<Id>,
    /// Overrides.
    #[serde(rename = "override", default)]
    pub override_: Option<QueryOverride>,
    /// Window.
    pub window: QueryWindow,
    /// Restricts the window to one group (board columns).
    #[serde(default)]
    pub group: Option<String>,
    /// Properties to return (default: all).
    #[serde(default)]
    pub props: Option<Vec<Id>>,
    /// Query rev the client holds.
    #[serde(default)]
    pub known_query_rev: Option<String>,
    /// Request id echoed back.
    pub req_id: i64,
}

impl QueryRequest {
    /// A request for the first `limit` rows.
    #[must_use]
    pub fn new(database_id: &str, view_id: Option<&str>, limit: usize) -> Self {
        Self {
            database_id: database_id.to_owned(),
            view_id: view_id.map(str::to_owned),
            override_: None,
            window: QueryWindow { offset: 0, limit },
            group: None,
            props: None,
            known_query_rev: None,
            req_id: 0,
        }
    }
}

/// One group of a query result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryGroup {
    /// Group key (`""` is the "No value" group).
    pub key: String,
    /// Label.
    pub label: String,
    /// Colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<BlockColor>,
    /// Rows in the group.
    pub count: usize,
    /// Aggregates by property.
    pub aggs: BTreeMap<Id, String>,
}

/// `db_query` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(untagged)]
pub enum QueryResponse {
    /// The client's `knownQueryRev` is current.
    #[serde(rename_all = "camelCase")]
    NotModified {
        /// Echoed request id.
        req_id: i64,
        /// Always `true`.
        not_modified: bool,
    },
    /// Rows.
    Rows(QueryResult),
}

/// The rows variant of [`QueryResponse`].
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    /// Echoed request id.
    pub req_id: i64,
    /// Fingerprint of the inputs; equal revs mean equal results.
    pub query_rev: String,
    /// Matching rows (in the requested group, if any).
    pub total: usize,
    /// The window.
    pub rows: Vec<RowDto>,
    /// Groups (when grouped).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub groups: Option<Vec<QueryGroup>>,
    /// Footer aggregates.
    pub aggs: BTreeMap<Id, String>,
    /// Time taken.
    pub took_ms: u64,
}

/// `db_chart_data` result.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ChartData {
    /// X values (bucket labels or numbers).
    pub x: Vec<Value>,
    /// Series.
    pub series: Vec<ChartSeriesData>,
    /// Currency of money measures.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub currency: Option<String>,
}

/// One series of [`ChartData`].
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ChartSeriesData {
    /// Key.
    pub key: String,
    /// Label.
    pub label: String,
    /// Colour.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    /// Values per X.
    pub values: Vec<Option<f64>>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn cell_values_match_the_ipc_shape() {
        let cases = [
            json!({"t":"text","v":[{"text":"Hi"}]}),
            json!({"t":"number","v":null}),
            json!({"t":"money","v":"12.50","cur":"USD"}),
            json!({"t":"select","v":"opt1"}),
            json!({"t":"multi","v":["a","b"]}),
            json!({"t":"date","v":{"start":"2026-11-26","time":false}}),
            json!({"t":"check","v":true}),
            json!({"t":"files","v":[{"assetId":"x","name":"a.png"}]}),
            json!({"t":"recurrence","v":{"rrule":"FREQ=DAILY","dtstart":"2026-01-01","mode":"schedule"}}),
            json!({"t":"computed","v":{"kind":"number","value":3,"display":"3"}}),
            json!({"t":"ts","v":5}),
        ];
        for c in cases {
            let v: CellValue = serde_json::from_value(c.clone()).unwrap();
            assert_eq!(serde_json::to_value(&v).unwrap(), c);
        }
    }

    #[test]
    fn filters_parse_untagged() {
        let f: Filter = serde_json::from_value(json!({
            "and": [{"prop":"p1","op":"eq","value":3},{"or":[{"prop":"$created","op":"within","value":"today"}]}]
        }))
        .unwrap();
        match f {
            Filter::And { and } => assert_eq!(and.len(), 2),
            _ => panic!("expected and"),
        }
    }

    #[test]
    fn template_values_accept_tokens() {
        let t: RowTemplate = serde_json::from_value(json!({
            "id":"t","name":"T","values":{"d":"@today+3d","n":{"t":"number","v":1}}
        }))
        .unwrap();
        assert!(matches!(t.values["d"], TemplateValue::Token(_)));
        assert!(matches!(t.values["n"], TemplateValue::Cell(_)));
    }
}

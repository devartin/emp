/**
 * EMP IPC types — hand-transcribed from SPEC §11.2 / §11.3 (plus the §15.6 tax and §16.1 life-app shapes
 * that §11.3 references). Rust DTOs use `#[serde(rename_all = "camelCase")]` and MUST match these shapes.
 *
 * Naming: shared/named types keep their SPEC names. Inline request/response shapes from §11.3 get a
 * `<Thing>Req` / `<Thing>Result` name here when other modules are likely to reference them. Every
 * command's exact request/response pair is available through `Req<'cmd'>` / `Res<'cmd'>` in `contract.ts`.
 */

// ───────────────────────────────────────────────────────────────────────────── §11.2 shared

export type Id = string;
export type Ts = number;
export type Rev = number;
export type SortKey = string;

export type ErrorCode =
  | 'LOCKED' | 'BAD_PASSWORD' | 'RATE_LIMITED' | 'REAUTH_REQUIRED' | 'NOT_FOUND' | 'CONFLICT' | 'INVALID' | 'CRYPTO'
  | 'INTEGRITY' | 'IO' | 'NETWORK' | 'OFFLINE' | 'AUTH_REQUIRED' | 'PROVIDER' | 'QUOTA' | 'CANCELLED' | 'UNSUPPORTED'
  | 'SCHEMA_TOO_NEW' | 'TOO_LARGE' | 'INTERNAL';

export interface ApiErrorDetails {
  field?: string;
  retryAfterMs?: number;
  currentRev?: Rev;
  correlationId?: string;
}

/** Wire shape of every rejected command. At runtime the facade rejects with `BackendError` (see errors.ts). */
export interface ApiError {
  code: ErrorCode;
  message: string;
  details?: ApiErrorDetails;
}

export type JobEvent<R = unknown> =
  | { kind: 'progress'; done: number; total: number; label?: string }
  | { kind: 'done'; result: R }
  | { kind: 'error'; error: ApiError };

export interface JobRef {
  jobId: Id;
}

export type Channel<T> = import('@tauri-apps/api/core').Channel<T>;

export type BlockColor = 'gray' | 'brown' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple' | 'pink' | 'red';
export type Icon =
  | { t: 'emoji'; v: string }
  | { t: 'lucide'; v: string; color?: BlockColor | 'accent' }
  | { t: 'asset'; assetId: Id };
export type CoverGradient = 'aurora' | 'dusk' | 'mint' | 'sand' | 'slate' | 'rose';
export type Cover = { t: 'gradient'; v: CoverGradient } | { t: 'asset'; assetId: Id; posY: number /* 0..1 */ };
export type PageKind = 'doc' | 'database' | 'sheet' | 'app' | 'dashboard';
export type PageFont = 'sans' | 'serif' | 'mono';

export interface PageFlags {
  fullWidth?: boolean;
  smallText?: boolean;
  font?: PageFont;
  locked?: boolean;
  template?: boolean;
  inline?: boolean;
}

export interface PageMeta {
  id: Id;
  workspaceId: Id;
  parentId: Id | null;
  kind: PageKind;
  sortKey: SortKey;
  title: string;
  icon?: Icon;
  cover?: Cover;
  createdAt: Ts;
  updatedAt: Ts;
  deletedAt?: Ts;
  rev: Rev;
  flags: PageFlags;
  appInstanceId?: Id;
  hasChildren: boolean;
}

export interface TipTapMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface TipTapNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: TipTapNode[];
  marks?: TipTapMark[];
  text?: string;
}

export interface TipTapDoc {
  type: 'doc';
  attrs: { schemaVersion: number };
  content: TipTapNode[];
}

export type RichTextMarkType =
  | 'bold' | 'italic' | 'underline' | 'strike' | 'code' | 'link' | 'mention' | 'textColor' | 'highlight';
export type RichText = { text: string; marks?: { type: RichTextMarkType; attrs?: Record<string, unknown> }[] }[];

export type Money = { amount: string; currency: string };
/** start/end: 'YYYY-MM-DD' if !time else RFC3339 */
export type DateValue = { start: string; end?: string; time: boolean; tz?: string };

/** Inclusive, 0-based. */
export interface Rect {
  r0: number;
  c0: number;
  r1: number;
  c1: number;
}

export interface FileGrant {
  grantId: Id;
  displayName: string;
  size: number;
}

/** 'AAPL:XNAS', 'VOD:XLON', 'BTC:CRYPTO', 'EURUSD:FX' */
export type SymbolKey = string;

export interface InsightMath {
  label: string;
  value: string;
  source?: string;
}

export interface Insight {
  id: string;
  appInstanceId: Id;
  ruleId: string;
  severity: 'info' | 'tip' | 'warn' | 'critical';
  title: string;
  body: string;
  math?: InsightMath[];
  actions: { label: string; route: Route }[];
  mutedUntil?: Ts;
}

export type Route =
  | { t: 'page'; id: Id; blockId?: string }
  | { t: 'row'; id: Id }
  | { t: 'db'; id: Id; viewId?: Id }
  | { t: 'sheet'; id: Id; sheetId?: Id }
  | { t: 'app'; instanceId: Id; tab?: string }
  | { t: 'home' }
  | { t: 'today' }
  | { t: 'markets'; symbol?: SymbolKey }
  | { t: 'settings'; section: string }
  | { t: 'trash' }
  | { t: 'lifeapps'; appId?: string }
  | { t: 'lock' }
  | { t: 'onboarding' };

/** File-dialog filter, shared by file_pick / file_save_grant. */
export interface FileFilter {
  name: string;
  extensions: string[];
}

// ───────────────────────────────────────────────────────────────────────────── App, windows, network

export type Platform = 'macos' | 'windows' | 'linux';
export type AppFeature = 'reduced-transparency' | 'vibrancy' | 'mica' | 'keychain' | 'biometrics' | 'eyedropper';

export interface AppInfo {
  version: string;
  commit: string;
  platform: Platform;
  arch: string;
  webview: string;
  features: AppFeature[];
}

export interface UpdateCheck {
  available: boolean;
  version?: string;
  notes?: string;
}

export type FilePickPurpose = 'import' | 'attach' | 'restore' | 'image';
export type FileSavePurpose = 'export' | 'backup';

export interface NetworkLogEntry {
  at: Ts;
  connector: string;
  method: string;
  host: string;
  path: string;
  status: number;
  bytes: number;
}

// ───────────────────────────────────────────────────────────────────────────── Vault and security

export interface AutoLock {
  idleMinutes: number | null;
  onSleep: boolean;
  onScreenLock: boolean;
  onBlurMinutes: number | null;
  maxSessionHours: number | null;
}

export interface KdfInfo {
  mKiB: number;
  t: number;
  p: number;
  estMs: number;
  belowStandard: boolean;
}

export interface VaultStatus {
  state: 'uninitialized' | 'locked' | 'unlocked';
  encrypted: boolean;
  vaultId?: string;
  kdf?: KdfInfo;
  recoveryConfirmed: boolean;
  autoLock: AutoLock;
  failedAttempts: number;
  retryAfterMs: number;
  schemaVersion: number;
  pendingMigrations: number;
  keychainAvailable: boolean;
  integrity: 'ok' | 'warning' | 'unchecked';
  reauthValidUntil?: Ts;
}

export type VaultProfile = 'standard' | 'high';
export type LockReason = 'manual' | 'idle' | 'sleep' | 'screen' | 'blur' | 'session_max' | 'panic';

export interface VaultCreateResult {
  status: VaultStatus;
  recoveryWords?: string[];
}

export interface KdfBenchmark {
  mKiB: number;
  t: number;
  p: number;
  ms: number;
}

export interface IntegrityReport {
  ok: boolean;
  damaged: { table: string; id: string }[];
  msetMismatch: boolean;
}

export type SecurityEvent =
  | 'unlock_ok' | 'unlock_fail' | 'lock' | 'pw_change' | 'recovery_regen' | 'recovery_unlock' | 'enc_on' | 'enc_off'
  | 'export_plain' | 'backup_create' | 'backup_restore' | 'integrity_fail' | 'reseal' | 'secret_reveal'
  | 'integration_connect';

export interface SecurityLogEntry {
  at: Ts;
  event: SecurityEvent | string;
}

export interface PasswordStrength {
  score: 0 | 1 | 2 | 3 | 4;
  crackTime: string;
  warning?: string;
  suggestions: string[];
  common: boolean;
}

export interface GeneratedPassphrase {
  passphrase: string;
  bits: number;
}

// ───────────────────────────────────────────────────────────────────────────── Secrets

export type SecretKind = 'api_key' | 'oauth' | 'client' | 'field';

export interface SecretInfo {
  id: Id;
  provider: string;
  label: string;
  kind: SecretKind;
  last4?: string;
  createdAt: Ts;
  lastUsedAt?: Ts;
}

// ───────────────────────────────────────────────────────────────────────────── Settings and kv

export type ThemeSetting = 'system' | 'light' | 'dark' | 'midnight';
export type ResolvedTheme = 'light' | 'dark' | 'midnight';
export type Accent = 'iris' | 'ocean' | 'jade' | 'amber' | 'ruby' | 'orchid' | 'graphite';
export type Density = 'comfortable' | 'compact';
export type TextSize = 's' | 'm' | 'l';
export type MotionSetting = 'system' | 'reduced' | 'full';
export type EffectsSetting = 'auto' | 'full' | 'reduced';
export type NumberColors = 'standard' | 'cvd' | 'eastasian' | 'mono';

export interface DeviceSettings {
  theme: ThemeSetting;
  accent: Accent;
  density: Density;
  textSize: TextSize;
  motion: MotionSetting;
  effects: EffectsSetting;
  contrast: 'system' | 'more';
  numberColors: NumberColors;
  readableFont: boolean;
  letterSpacing: boolean;
  updates: 'off' | 'check';
  language: string;
}

export interface SnapshotSettings {
  enabled: boolean;
  folderGrantLabel?: string;
  keepDaily: number;
  keepWeekly: number;
  keepMonthly: number;
}

export interface VaultSettings {
  profileName: string;
  baseCurrency: string;
  locale: string;
  timezone: string;
  weekStart: 0 | 1 | 6;
  dateFormat: 'full' | 'mdy' | 'dmy' | 'ymd';
  clock: 12 | 24;
  spellcheck: boolean;
  typography: boolean;
  markdownShortcuts: boolean;
  stripImageLocation: boolean;
  remoteImages: 'ask' | 'allow' | 'block';
  trashRetentionDays: number;
  hideNumbersOnLaunch: boolean;
  blurWhenInactive: boolean;
  clipboardClearSeconds: number;
  celebrations: boolean;
  startPage: 'home' | 'last' | Id;
  snapshots: SnapshotSettings;
  marketProviders: { order: string[]; refreshSeconds: number };
  offline: boolean;
}

export interface SettingsBundle {
  device: DeviceSettings;
  vault?: VaultSettings;
}

export type KvNamespace = `ui.${string}`;

// ───────────────────────────────────────────────────────────────────────────── Backup, import, export

export interface SnapshotInfo {
  id: string;
  at: Ts;
  bytes: number;
  schemaVersion: number;
  location: 'local' | 'folder';
}

export type ImportKind =
  | 'markdown' | 'markdown_folder' | 'notion_zip' | 'csv' | 'xlsx' | 'ofx' | 'qfx' | 'qif' | 'ics' | 'empbackup' | 'unknown';

export interface ImportDetectResult {
  kind: ImportKind;
  details: Record<string, unknown>;
}

export interface NotionImportResult {
  pages: number;
  databases: number;
  rows: number;
  assets: number;
  unresolved: { title: string; ref: string }[];
  warnings: string[];
}

export type ExportFormat = 'markdown' | 'json' | 'pdf';

// ───────────────────────────────────────────────────────────────────────────── Workspaces

export interface WorkspaceDefaults {
  font: PageFont;
  fullWidth: boolean;
  smallText: boolean;
}

export interface Workspace {
  id: Id;
  name: string;
  icon?: Icon;
  favorites: Id[];
  defaults: WorkspaceDefaults;
}

export interface WorkspaceOpenResult {
  workspace: Workspace;
  pages: PageMeta[];
  recents: Id[];
  lastRoute?: Route;
  lifeapps: LifeAppInstance[];
}

// ───────────────────────────────────────────────────────────────────────────── Pages and docs

export interface Breadcrumb {
  id: Id;
  title: string;
  icon?: Icon;
}

export interface PageGetResult {
  meta: PageMeta;
  doc: TipTapDoc | null;
  docRev: Rev;
  breadcrumbs: Breadcrumb[];
}

export interface PageMetaPatch {
  title?: string;
  icon?: Icon | null;
  cover?: Cover | null;
  flags?: Partial<PageFlags>;
}

export interface Backlink {
  sourceId: Id;
  sourceTitle: string;
  sourceIcon?: Icon;
  blockId?: string;
  snippet: string;
}

export interface OutlineItem {
  blockId: string;
  level: 1 | 2 | 3;
  text: string;
}

export interface TemplateInfo {
  id: string;
  title: string;
  icon?: Icon;
  builtin: boolean;
  category: string;
  kind: PageKind;
}

// ───────────────────────────────────────────────────────────────────────────── Versions

export type VersionTargetKind = 'page_doc' | 'db_row' | 'db_schema' | 'sheet' | 'workbook';
export type VersionReason = 'auto' | 'manual' | 'pre_restore' | 'pre_import' | 'pre_bulk' | 'pre_migration' | 'pre_lifeapp';

export interface VersionMeta {
  id: Id;
  createdAt: Ts;
  reason: VersionReason | string;
  label?: string;
  size: number;
}

// ───────────────────────────────────────────────────────────────────────────── Databases

export type PropType =
  | 'title' | 'text' | 'number' | 'money' | 'select' | 'multi_select' | 'status' | 'date' | 'checkbox' | 'url' | 'email'
  | 'phone' | 'files' | 'relation' | 'rollup' | 'formula' | 'created_time' | 'updated_time' | 'unique_id' | 'rating'
  | 'progress' | 'ticker' | 'recurrence' | 'secret' | 'computed';

export interface RecurrenceValue {
  rrule: string;
  dtstart: string;
  tz?: string;
  mode: 'schedule' | 'completion';
}

export type ComputedKind = 'number' | 'money' | 'text' | 'bool' | 'date' | 'list' | 'error';

export type CellValue =
  | { t: 'text'; v: RichText }
  | { t: 'number'; v: number | null }
  | { t: 'money'; v: string | null; cur: string }
  | { t: 'select' | 'status'; v: Id | null }
  | { t: 'multi'; v: Id[] }
  | { t: 'date'; v: DateValue | null }
  | { t: 'check'; v: boolean }
  | { t: 'url' | 'email' | 'phone'; v: string | null }
  | { t: 'files'; v: { assetId: Id; name: string }[] }
  | { t: 'relation'; v: Id[] }
  | { t: 'uid'; v: string }
  | { t: 'rating' | 'progress'; v: number | null }
  | { t: 'ticker'; v: SymbolKey | null }
  | { t: 'recurrence'; v: RecurrenceValue | null }
  | { t: 'secret'; v: { masked: string } | null }
  | { t: 'computed'; v: { kind: ComputedKind; value: unknown; display: string } }
  | { t: 'ts'; v: Ts };

export interface Property {
  id: Id;
  name: string;
  type: PropType;
  config: Record<string, unknown>;
  role?: string;
  hidden: boolean;
  sortKey: SortKey;
  description?: string;
}

export type FilterOp =
  | 'eq' | 'neq' | 'contains' | 'not_contains' | 'starts_with' | 'ends_with' | 'empty' | 'not_empty' | 'gt' | 'gte' | 'lt'
  | 'lte' | 'between' | 'any_of' | 'none_of' | 'all_of' | 'group_eq' | 'before' | 'after' | 'on_or_before'
  | 'on_or_after' | 'within' | 'checked' | 'unchecked';

export type Filter =
  | { and: Filter[] }
  | { or: Filter[] }
  | { prop: Id | '$created' | '$updated'; op: FilterOp; value?: unknown };

export type Sort = { prop: Id | '$created' | '$updated' | '$manual'; dir: 'asc' | 'desc' };

export type GroupBy = {
  prop: Id;
  dateBucket?: 'relative' | 'day' | 'week' | 'month' | 'year';
  byStatusGroup?: boolean;
  hideEmpty?: boolean;
  order?: string[];
};

export type Layout = 'table' | 'board' | 'list' | 'gallery' | 'calendar' | 'chart';

export type AggFn =
  | 'count' | 'count_values' | 'count_unique' | 'empty' | 'not_empty' | 'pct_empty' | 'pct_not_empty' | 'sum' | 'avg'
  | 'median' | 'min' | 'max' | 'range' | 'earliest' | 'latest' | 'checked' | 'unchecked' | 'pct_checked';

export type ChartType =
  | 'bar' | 'hbar' | 'line' | 'area' | 'stacked_area' | 'donut' | 'combo' | 'waterfall' | 'sankey' | 'treemap' | 'heatmap';

export interface ChartSpec {
  type: ChartType;
  x: { prop: Id | '$created'; bucket?: 'day' | 'week' | 'month' | 'quarter' | 'year' };
  y: { agg: AggFn; prop?: Id; as?: 'bar' | 'line' }[];
  series?: { prop: Id };
  stacked?: boolean;
  cumulative?: boolean;
  labels?: boolean;
  smooth?: boolean;
  omitZero?: boolean;
  colors?: 'auto' | 'gainloss';
}

export interface CardSettings {
  preview: 'none' | 'cover' | 'content' | Id;
  size: 's' | 'm' | 'l';
  fit: boolean;
}

export interface View {
  id: Id;
  name: string;
  icon?: string;
  layout: Layout;
  filter?: Filter;
  sorts: Sort[];
  groupBy?: GroupBy;
  visibleProps: Id[];
  propWidths: Record<Id, number>;
  wrap: Record<Id, boolean>;
  card?: CardSettings;
  calendar?: { dateProp: Id; showWeekends: boolean };
  chart?: ChartSpec;
  footerAggs: Record<Id, AggFn>;
  collapsedGroups: string[];
  openIn: 'side_peek' | 'full_page';
  sortKey: SortKey;
}

export interface RowTemplate {
  id: Id;
  name: string;
  icon?: Icon;
  /** CellValue, or a string token such as '@today'. */
  values: Record<Id, CellValue | string>;
  doc?: TipTapDoc;
}

export interface DbInfo {
  id: Id;
  title: string;
  icon?: Icon;
  description?: RichText;
  primaryPropId: Id;
  schemaRev: Rev;
  dataRev: Rev;
  templates: RowTemplate[];
  defaultTemplateId?: Id;
  hideEmptyProps: boolean;
  roles: Record<string, Id>;
  appInstanceId?: Id;
}

export interface DbSchema {
  database: DbInfo;
  properties: Property[];
  views: View[];
}

export interface RowDTO {
  id: Id;
  rev: Rev;
  sortKey: SortKey;
  createdAt: Ts;
  updatedAt: Ts;
  values: Record<Id, CellValue>;
  hasBody: boolean;
  icon?: Icon;
  sample?: boolean;
}

export interface SelectOptionInput {
  id?: Id;
  name: string;
  color: BlockColor;
  group?: 'todo' | 'in_progress' | 'complete';
}

export interface DbQueryOverride {
  filter?: Filter;
  sorts?: Sort[];
  groupBy?: GroupBy | null;
  search?: string;
}

export interface DbQueryReq {
  databaseId: Id;
  viewId?: Id;
  override?: DbQueryOverride;
  window: { offset: number; limit: number };
  group?: string;
  props?: Id[];
  knownQueryRev?: string;
  reqId: number;
}

export interface DbQueryGroup {
  key: string;
  label: string;
  color?: BlockColor;
  count: number;
  aggs: Record<Id, string>;
}

export type DbQueryResult =
  | { reqId: number; notModified: true }
  | {
      reqId: number;
      queryRev: string;
      total: number;
      rows: RowDTO[];
      groups?: DbQueryGroup[];
      aggs: Record<Id, string>;
      tookMs: number;
    };

export interface ChartData {
  x: (string | number)[];
  series: { key: string; label: string; color?: string; values: (number | null)[] }[];
  currency?: string;
  links?: { source: number; target: number; value: number }[];
}

export interface DbRowGetResult {
  row: RowDTO;
  doc: TipTapDoc | null;
  docRev: Rev;
  databaseId: Id;
  prevId?: Id;
  nextId?: Id;
}

export interface FormulaCheckResult {
  ok: boolean;
  type?: string;
  error?: { message: string; from: number; to: number };
  preview: string[];
}

export interface DbImportPreview {
  columns: { name: string; inferred: PropType; sample: string[] }[];
  rows: number;
  delimiter: string;
  encoding: string;
  sheets?: string[];
}

export type DbImportTarget =
  | { databaseId: Id; mapping: Record<string, Id | 'new' | 'skip'> }
  | { workspaceId: Id; parentId: Id | null; title: string };

// ───────────────────────────────────────────────────────────────────────────── Sheets

export interface SheetMeta {
  id: Id;
  name: string;
  color?: BlockColor;
  hidden: boolean;
  frozen: { rows: number; cols: number };
  maxRow: number;
  maxCol: number;
  sortKey: SortKey;
}

/** Column-oriented cell batch. k: 0 empty, 1 num, 2 text, 3 bool, 4 err, 5 pending. f: 1 formula, 2 spill child. */
export interface PackedCells {
  r: number[];
  c: number[];
  d: string[];
  k: number[];
  f: number[];
  s: number[];
}

export type BorderStyle = { style: 'thin' | 'medium' | 'thick' | 'dashed'; color: string };

export interface CellStyle {
  font?: { b?: boolean; i?: boolean; u?: boolean; s?: boolean; color?: string; size?: number };
  fill?: string;
  align?: { h?: 'left' | 'center' | 'right'; v?: 'top' | 'middle' | 'bottom'; wrap?: boolean };
  numFmt?: string;
  border?: Partial<Record<'t' | 'r' | 'b' | 'l', BorderStyle>>;
  role?: 'input' | 'output' | 'check';
}

export type CondFormatRule = {
  id?: Id;
  rect: Rect;
  kind: 'cell' | 'formula' | 'data_bar' | 'color_scale';
  op?: 'gt' | 'lt' | 'between' | 'eq' | 'text_contains';
  values?: string[];
  formula?: string;
  styleId?: number;
  colors?: string[];
};

export interface WorkbookInfo {
  sheets: SheetMeta[];
  styles: Record<number, CellStyle>;
  namedRanges: { name: string; ref: string }[];
  calc: { iterative: boolean; date1904: boolean };
}

export interface SheetRange {
  rev: Rev;
  cells: PackedCells;
  rowHeights: [number, number][];
  colWidths: [number, number][];
  merges: Rect[];
  cf: { r: number; c: number; styleId: number; bar?: number }[];
}

export interface SheetCellInfo {
  input: string;
  display: string;
  kind: number;
  error?: string;
  styleId: number;
  precedents: string[];
  spillOf?: string;
}

export interface DirtyRect {
  sheetId: Id;
  rect: Rect;
}

export interface SheetSetCellsResult {
  rev: Rev;
  changed: PackedCells;
  dirtyRects: DirtyRect[];
  recalcMs: number;
  errors?: { row: number; col: number; message: string }[];
}

export type SheetChartInput = { id?: Id; spec: ChartSpec & { range: string }; anchor: Rect } | { id: Id; delete: true };

export interface SheetFunctionInfo {
  name: string;
  category: string;
  signature: string;
  description: string;
  example: string;
  args: { name: string; optional: boolean; repeat: boolean }[];
}

export type SheetLintRule =
  | 'hardcoded_constant' | 'inconsistent_formula' | 'ref_error' | 'div0' | 'circular' | 'number_as_text'
  | 'merged_in_data' | 'unused_name' | 'volatile_heavy';

export interface SheetLintIssue {
  id: string;
  sheetId: Id;
  rect: Rect;
  rule: SheetLintRule;
  message: string;
  fix?: string;
}

// ───────────────────────────────────────────────────────────────────────────── Assets

export interface AssetDTO {
  id: Id;
  name: string;
  mime: string;
  size: number;
  width?: number;
  height?: number;
  url: string;
}

// ───────────────────────────────────────────────────────────────────────────── Search

export type SearchHitKind = 'page' | 'row' | 'database' | 'sheet' | 'block' | 'asset';

export interface SearchHit {
  id: Id;
  kind: SearchHitKind;
  title: string;
  icon?: Icon;
  path: string[];
  snippet?: { text: string; ranges: [number, number][] };
  blockId?: string;
  score: number;
  updatedAt: Ts;
}

export interface SearchFilters {
  in?: Id;
  type?: SearchHitKind[];
  db?: Id;
  edited?: { from?: Ts; to?: Ts };
}

export interface SearchQueryResult {
  reqId: number;
  hits: SearchHit[];
  indexReady: boolean;
  tookMs: number;
}

export interface SearchStatus {
  ready: boolean;
  docs: number;
  building: boolean;
  progress?: number;
}

// ───────────────────────────────────────────────────────────────────────────── Life apps (§11.3 + §16.1)

export interface LifeAppSummary {
  id: string;
  version: string;
  title: string;
  tagline: string;
  icon: string;
  color: string;
  category: string;
  estMinutes: number;
  installed: number;
  v1: boolean;
}

export interface LifeAppChecklistItem {
  id: string;
  label: string;
  done: boolean;
}

export interface LifeAppInstance {
  id: Id;
  appId: string;
  version: string;
  rootPageId: Id;
  installedAt: Ts;
  upgradeAvailable: boolean;
  detached: boolean;
  checklist: LifeAppChecklistItem[];
}

export type GenerationItemKind =
  | 'page' | 'database' | 'view' | 'dashboard' | 'reminder' | 'recurring' | 'sheet' | 'rule' | 'goal';

export interface GenerationPlanItem {
  key: string;
  kind: GenerationItemKind;
  title: string;
  parentKey?: string;
  optional: boolean;
  enabled: boolean;
  count?: number;
}

export interface GenerationPlan {
  items: GenerationPlanItem[];
  counts: Record<string, number>;
  recommendations: { stepId: string; value: unknown; why: string; source: string }[];
  warnings: string[];
}

export interface PlanDiff {
  add: GenerationPlan['items'];
  update: { key: string; fields: string[]; conflict: boolean }[];
  keep: string[];
}

export type LifeAppMode = 'quick' | 'guided';

export interface LifeAppMetric {
  value: unknown;
  display: string;
  math: InsightMath[];
  asOf: Ts;
}

export type LifeAppStepKind =
  | 'choice_cards' | 'multi_chips' | 'money' | 'percent' | 'number' | 'slider' | 'date' | 'recurrence' | 'list_builder'
  | 'file_import' | 'connect' | 'jurisdiction' | 'text' | 'toggle' | 'review';

export interface Step {
  id: string;
  kind: LifeAppStepKind;
  title: string;
  help?: string;
  why?: string;
  quick: boolean;
  skippable: boolean;
  when?: string;
  default?: unknown;
  /** rust fn id */
  recommend?: string;
  options?: { value: string; label: string; description?: string; icon?: string }[];
  itemSchema?: Record<string, string>;
  min?: number;
  max?: number;
  step?: number;
}

export interface Template {
  key: string;
  kind: 'page' | 'database' | 'view' | 'dashboard' | 'workbook' | 'reminder' | 'recurring' | 'rule' | 'row';
  parentKey?: string;
  optional: boolean;
  when?: string;
  /** typed per kind: PageSpec, DatabaseSpec{properties, roles, views, templates, seedRows}, DashboardSpec{tiles} … */
  spec: unknown;
}

export interface LifeAppManifest {
  id: string;
  /** semver */
  version: string;
  title: string;
  tagline: string;
  icon: string;
  color: string;
  category: 'finance' | 'investing' | 'tax' | 'sheets' | 'planning' | 'health';
  sensitivity: 'normal' | 'high';
  estMinutes: number;
  disclaimer?: string;
  steps: Step[];
  templates: Template[];
  metrics: { name: string; kind: 'rust' | 'expr'; fn?: string; expr?: string; /* templateKey.role */ deps: string[] }[];
  advisor: {
    id: string;
    /** Metric dialect */
    when: string;
    severity: 'info' | 'tip' | 'warn' | 'critical';
    title: string;
    body: string;
    mathMetrics: string[];
    actions: { label: string; route: string }[];
  }[];
  checklist: { id: string; label: string; autoTick?: { event: string; where?: string } }[];
  migrations: { to: string; ops: unknown[] }[];
  sample: { generator: string; seed: number };
}

// ───────────────────────────────────────────────────────────────────────────── Finance

export interface BudgetLine {
  categoryId: Id;
  name: string;
  group: string;
  color: BlockColor;
  assigned: Money;
  activity: Money;
  available: Money;
  pace: number;
}

export interface FinanceOverview {
  /**
   * Net worth as of today = `assets − liabilities`. One definition on both backends (mock `netWorthAt`, Rust
   * `emp_finance::networth::point`): open accounts in the base currency, balances as of today (future-dated rows
   * excluded), positive balances are assets and negative ones liabilities whatever the account type, and the open
   * investment accounts are replaced by Portfolio's market value when Portfolio is installed (§16.8).
   */
  netWorth: Money;
  netWorthDelta30d: Money;
  /** Total assets (≥ 0) behind `netWorth`. */
  assets: Money;
  /** Total liabilities (≥ 0) behind `netWorth`. */
  liabilities: Money;
  /** Portfolio market value counted in `assets` in place of the investment accounts; absent without Portfolio. */
  investments?: Money;
  /** `efMonths = efBalance / essentialMonthly` — the emergency-fund balance (the emergency goal's account, else the
   * goal's saved amount, else the open savings accounts) … */
  efBalance?: Money;
  /** … and the median of the three trailing 30-day essential-spending sums. */
  essentialMonthly?: Money;
  toBeAssigned?: Money;
  leftToSpend?: Money;
  savingsRate3m: number;
  efMonths: number;
  debtFreeDate?: string;
  budget: BudgetLine[];
  upcoming: { rowId: Id; name: string; due: string; amount: Money; autopay: boolean }[];
  uncategorized: number;
  asOf: Ts;
}

export interface NetWorthSeries {
  t: string[];
  assets: number[];
  liabilities: number[];
  net: number[];
  currency: string;
}

export interface SpendingSlice {
  key: string;
  label: string;
  color?: string;
  amount: string;
  pct: number;
  deltaPct?: number;
}

export interface SankeyData {
  nodes: { name: string; color?: string }[];
  links: { source: number; target: number; value: number }[];
}

export interface BudgetMonth {
  categories: { categoryId: Id; assigned: string; activity: string; available: string; rollover: string }[];
  toBeAssigned: string;
  currency: string;
}

export interface ImportMapping {
  date?: number;
  amount?: number;
  debit?: number;
  credit?: number;
  payee?: number;
  memo?: number;
  balance?: number;
  dateFormat?: string;
  invert: boolean;
  decimalComma: boolean;
}

export interface FinanceImportStart {
  importId: Id;
  format: 'csv' | 'ofx' | 'qfx' | 'qif';
  columns?: string[];
  sample: string[][];
  mappingGuess: ImportMapping;
  profileMatch?: { id: Id; name: string };
  accountGuess?: Id;
  rowCount: number;
  encoding: string;
}

export interface FinanceImportPreviewRow {
  idx: number;
  date: string;
  payee: string;
  rawPayee: string;
  amount: string;
  categoryId?: Id;
  confidence: 'rule' | 'learned' | 'none';
  ruleId?: Id;
  duplicateOf?: Id;
  possibleDuplicate?: Id;
  transferPair?: Id;
}

/**
 * The closing balance the statement file itself reports (PROGRAMME-v3 K5 contract delta, additive). OFX/QFX:
 * `<LEDGERBAL>` of the statement section; CSV: the mapped balance column on the latest-dated row (last such row in
 * file order). QIF carries no balance, so it is absent there, as it is when the file has none.
 */
export interface FinanceImportStatement {
  /**
   * Decimal string in the account's currency, e.g. "10900.99" (same format as row amounts), in the **ledger's sign**:
   * an asset's balance is positive, a liability owed is negative (a card owing $80 → "-80.00"), so it compares
   * directly with the account's cleared balance. CSV: the balance column follows the mapping's `invert` like the
   * amounts; it is the closing row of the latest date whatever the file's order. OFX: `LEDGERBAL` as sent (OFX signs
   * amounts from the account holder's side, so an owed card balance is negative).
   */
  balance: string;
  /** YYYY-MM-DD the balance is as of (OFX `DTASOF`, else the latest row date). */
  asOf?: string;
  /** ISO 4217 code the file states (OFX `CURDEF`); absent when the file does not say. */
  currency?: string;
  source: 'ofx' | 'csv';
}

export interface FinanceImportPreview {
  rows: FinanceImportPreviewRow[];
  newCount: number;
  duplicates: number;
  categorized: number;
  statement?: FinanceImportStatement;
}

export interface RuleCondition {
  field: 'payee' | 'raw' | 'memo' | 'amount' | 'abs_amount' | 'account' | 'day_of_month';
  op: 'contains' | 'equals' | 'starts_with' | 'regex' | 'lt' | 'gt' | 'between' | 'in';
  value: unknown;
}

export interface Rule {
  id: Id;
  name: string;
  priority: number;
  when: { all: RuleCondition[] };
  then: {
    categoryId?: Id;
    renamePayee?: string;
    tags?: string[];
    markTransfer?: boolean;
    split?: { categoryId: Id; pct?: number; amount?: string }[];
  };
  continue: boolean;
  timesApplied: number;
}

export type RecurringCadence = 'weekly' | 'biweekly' | 'monthly' | 'quarterly' | 'yearly';

export interface RecurringCandidate {
  payee: string;
  cadence: RecurringCadence;
  amount: Money;
  nextDue: string;
  confidence: number;
  rowIds: Id[];
  priceChange?: { from: string; to: string };
}

export type DebtStrategy = 'avalanche' | 'snowball' | 'hybrid' | 'custom';

export interface DebtInput {
  name: string;
  balance: string;
  aprPct: string;
  minPayment: string;
}

export interface DebtPlan {
  strategies: { strategy: string; months: number; payoffDate: string; totalInterest: string; interestSavedVsMin: string }[];
  /** schedule for the requested strategy */
  schedule: { month: string; balances: Record<string, string>; payments: Record<string, string> }[];
}

export interface Forecast {
  t: string[];
  balance: number[];
  p10?: number[];
  p90?: number[];
  threshold?: number;
  breaches: { date: string; accountId: Id; amount: string; topOutflows: string[] }[];
}

export interface Amortization {
  payment: string;
  totalInterest: string;
  payoffDate: string;
  rows: { n: number; date: string; payment: string; principal: string; interest: string; balance: string }[];
}

// ───────────────────────────────────────────────────────────────────────────── Portfolio and tax

export interface Holding {
  symbol: SymbolKey;
  name: string;
  qty: string;
  price: number | null;
  value: Money;
  costBasis: Money;
  gain: Money;
  gainPct: number;
  weight: number;
  dayPct?: number;
  stale: boolean;
  assetClass: string;
}

export interface AllocationRow {
  assetClass: string;
  current: number;
  target: number;
  drift: number;
  status: 'ok' | 'outside_band';
}

export interface PortfolioSummary {
  totalValue: Money;
  dayChange: Money;
  dayChangePct: number;
  unrealized: Money;
  unrealizedPct: number;
  xirrYtd?: number;
  xirrAll?: number;
  divTtm: Money;
  divFwd12m: Money;
  maxDrift: number;
  feesPerYear: Money;
  holdings: Holding[];
  allocation: AllocationRow[];
  asOf: Ts;
}

export type PerfRange = '1m' | '3m' | 'ytd' | '1y' | '5y' | 'all';

export interface PortfolioPerformance {
  t: number[];
  value: number[];
  contributions: number[];
  twr: number[];
  benchmark?: number[];
  xirr?: number;
}

export interface RebalanceTrade {
  accountId: Id;
  symbol: SymbolKey;
  side: 'buy' | 'sell';
  qty: string;
  amount: string;
  estRealizedGain?: string;
}

export interface RebalancePlan {
  trades: RebalanceTrade[];
  after: { assetClass: string; pct: number }[];
  estRealizedGain: string;
}

export interface DividendMonth {
  month: string;
  paid: string;
  projected: string;
}

export interface RealizedLot {
  symbol: SymbolKey;
  acquired: string;
  sold: string;
  qty: string;
  proceeds: string;
  basis: string;
  gain: string;
  term: 'short' | 'long';
}

export interface RealizedReport {
  lots: RealizedLot[];
  totals: { short: string; long: string };
}

export interface TaxPackInfo {
  id: string;
  name: string;
  year: number;
  tier: 'estimator' | 'organizer' | 'custom';
  version: string;
  verifiedOn: string;
  stale: boolean;
}

export type TaxIncomeKind =
  | 'wages' | 'self_employment' | 'interest' | 'ordinary_dividends' | 'qualified_dividends' | 'stcg' | 'ltcg'
  | 'retirement' | 'social_security' | 'unemployment' | 'rental' | 'other';

/** §15.6 */
export interface TaxInput {
  packId: string;
  year: number;
  filingStatus: string;
  dependents: number;
  age65OrBlind?: number;
  incomes: { kind: TaxIncomeKind; amount: string; source?: string }[];
  adjustments: { kind: 'ira' | 'hsa' | 'student_loan_interest' | 'se_health' | 'other'; amount: string }[];
  /**
   * Bare `'standard'` / `'auto'` carry no entries (no non-itemiser charitable deduction, no `itemizedWouldBe`).
   * `{ itemized, mode? }` (`mode` additive, PROGRAMME-v3 K5): the entries are itemisable candidates (`kind` =
   * `charity` | `medical` | `salt` | `mortgage` | …, see `TAX_DEDUCTION_CATEGORIES`); `mode` `auto` (default) takes
   * the larger of itemised and standard + the non-itemiser charitable deduction, `standard` the latter, `itemized`
   * itemises even when smaller (IRC §63(e)). Every mode reports `standardWouldBe` and `itemizedWouldBe`.
   */
  deductions: 'standard' | 'auto' | { itemized: { kind: string; amount: string }[]; mode?: 'auto' | 'standard' | 'itemized' };
  credits: { id: string; amount?: string }[];
  withheld: string;
  estimatedPaid: string;
  custom?: Record<string, unknown>;
}

/** §15.6 */
export interface TaxEstimate {
  gross: string;
  agi: string;
  /**
   * `itemizedWouldBe` (additive): the itemized total after the pack's floors and caps (medical 7.5% AGI floor,
   * SALT cap, 0.5% AGI charitable floor), present whenever any itemizable entry exists, whatever the chosen mode.
   */
  deduction: { kind: 'standard' | 'itemized'; amount: string; standardWouldBe: string; itemizedWouldBe?: string };
  taxable: string;
  ordinaryTax: string;
  preferentialTax: string;
  seTax: string;
  niit: string;
  credits: string;
  totalTax: string;
  brackets: { rate: string; from: string; to: string | null; taxed: string }[];
  /** total tax ÷ AGI (0 when AGI ≤ 0), a fraction (0.161 = 16.1%). Same definition in the mock and Rust. */
  effectiveRate: number;
  marginalRate: number;
  /** positive = estimated balance due, negative = estimated refund */
  balance: string;
  range?: { low: string; high: string };
  lines: { label: string; value: string; packRef?: string }[];
  packVersion: string;
  verifiedOn: string;
  stale: boolean;
  disclaimer: string;
}

export type QuarterlyMethod = 'safe_harbor' | 'current_90' | 'even_split';

export interface QuarterlyPlan {
  due: { period: string; date: string; suggested: string; paid: string; status: 'upcoming' | 'due_soon' | 'paid' | 'late' }[];
  method: string;
  note: string;
}

// ───────────────────────────────────────────────────────────────────────────── Markets

export type MarketState = 'pre' | 'open' | 'post' | 'closed';
export type Freshness = 'live' | 'delayed' | 'eod';

export interface Quote {
  symbol: SymbolKey;
  price: number;
  change: number;
  changePct: number;
  open?: number;
  high?: number;
  low?: number;
  prevClose?: number;
  volume?: number;
  currency: string;
  marketState: MarketState;
  asOf: Ts;
  source: string;
  freshness: Freshness;
  delayedMin: number;
}

export type ProviderCap = 'quote' | 'daily' | 'intraday' | 'search' | 'fx' | 'crypto' | 'dividends';

export interface ProviderInfo {
  id: string;
  name: string;
  needsKey: boolean;
  configured: boolean;
  enabled: boolean;
  termsUrl: string;
  community: boolean;
  caps: ProviderCap[];
  rateLimit: string;
  health: 'ok' | 'degraded' | 'down' | 'unknown';
}

export type InstrumentType = 'equity' | 'etf' | 'fund' | 'crypto' | 'fx' | 'index';

export interface MarketSearchResult {
  symbol: SymbolKey;
  name: string;
  exchange: string;
  type: InstrumentType;
  currency: string;
}

export type BarInterval = '1d' | '1wk' | '1mo';

export interface Bars {
  t: number[];
  o: number[];
  h: number[];
  l: number[];
  c: number[];
  v: number[];
  currency: string;
  source: string;
  stale: boolean;
}

export interface IndicatorSpec {
  kind: 'sma' | 'ema' | 'bollinger' | 'rsi' | 'macd';
  period: number;
}

export interface WatchlistSymbol {
  key: SymbolKey;
  alertAbove?: number;
  alertBelow?: number;
  alertPct?: number;
}

export interface Watchlist {
  id: Id;
  name: string;
  symbols: WatchlistSymbol[];
}

export interface FxRates {
  base: string;
  date: string;
  rates: Record<string, number>;
  source: string;
  stale: boolean;
}

// ───────────────────────────────────────────────────────────────────────────── Google and calendars

export interface GoogleAccount {
  id: Id;
  email: string;
  scopes: string[];
  connectedAt: Ts;
  status: 'ok' | 'reauth_required';
}

export interface CalendarEvent {
  id: Id;
  source: 'google' | 'ics' | 'db';
  calendarId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  tz?: string;
  location?: string;
  description?: string;
  color: string;
  recurring: boolean;
  link?: Route;
}

export interface GoogleCalendarInfo {
  id: string;
  summary: string;
  color: string;
  primary: boolean;
  selected: boolean;
}

export type GoogleFeature = 'calendar' | 'docs_import' | 'sheets_import' | 'export';

export interface ImportedPageResult {
  page: PageMeta;
  warnings: string[];
}

export interface GoogleExportResult {
  fileId: string;
  webViewLink: string;
}

// ───────────────────────────────────────────────────────────────────────────── Reminders and jobs

export type ReminderTargetKind = 'page' | 'row' | 'block';

export interface Reminder {
  id: Id;
  fireAt: Ts;
  targetKind: ReminderTargetKind;
  targetId: Id;
  text: string;
  fired: boolean;
}

export interface JobInfo {
  jobId: Id;
  kind: string;
  done: number;
  total: number;
  startedAt: Ts;
  cancellable: boolean;
}

// ───────────────────────────────────────────────────────────────────────────── §11.4 events

export interface EventMap {
  'vault:will-lock': { reason: LockReason | string };
  'vault:locked': { reason: LockReason };
  'vault:status': VaultStatus;
  'vault:autolock-soon': { secondsLeft: number };
  'tree:changed': { workspaceId: Id; upserted: PageMeta[]; removed: Id[] };
  'page:changed': { id: Id; metaRev?: Rev; docRev?: Rev };
  'db:changed': { databaseId: Id; dataRev: Rev; schemaRev: Rev; rowIds?: Id[] };
  'sheet:changed': { workbookId: Id; sheetId: Id; rects: Rect[] };
  'search:ready': { docs: number };
  'file:dropped': { grants: FileGrant[]; x: number; y: number };
  'open-external:confirm': { requestId: Id; url: string; host: string; punycode: boolean };
  'reminder:due': { id: Id; text: string };
  'insight:new': Insight;
  'sync:status': { provider: string; state: 'idle' | 'syncing' | 'error'; lastSync?: Ts; error?: string };
  'net:activity': { connector: string; host: string };
  'market:alert': { symbol: SymbolKey; kind: 'above' | 'below' | 'pct'; price: number };
  'update:available': { version: string };
  'integrity:warning': { damaged: number; msetMismatch: boolean };
  'clipboard:cleared': Record<string, never>;
}

export type EventName = keyof EventMap;

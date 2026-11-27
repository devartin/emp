/**
 * EMP backend contract (SPEC §11.3). One entry per command in `ALL_COMMANDS`.
 *
 * - `Commands` maps every snake_case command name to its request and response.
 *   Job commands (marked `job: true`) are listed WITHOUT their `onEvent` channel: the facade adds an optional
 *   `onEvent` listener and returns a `JobHandle` (the `JobRef` plus a `result` promise).
 * - `COMMAND_FLAGS` is the runtime list (exhaustive by type), carrying the (job)/(reauth)/pre-unlock markers.
 * - `EmpBackend` is the namespaced facade: `api.<namespace>.<method>(req)` where the namespace is the first
 *   snake segment and the method is the rest in camelCase, e.g. `page_get_meta` → `api.page.getMeta`,
 *   `daily_note_open` → `api.daily.noteOpen`, `open_external_confirm` → `api.open.externalConfirm`.
 */
import type * as T from './types';

type Id = T.Id;
type Ts = T.Ts;
type Rev = T.Rev;

/** A command entry. */
interface C<Rq, Rs> {
  req: Rq;
  res: Rs;
}
/** A (job) command entry: `res` is the value delivered by the final `done` JobEvent. */
interface J<Rq, Rs> {
  req: Rq;
  res: Rs;
  job: true;
}

type Empty = Record<string, never>;

export interface Commands {
  // ── App, windows, network
  app_info: C<Empty, T.AppInfo>;
  app_ready: C<{ marks: Record<string, number> }, void>;
  app_reveal_data_dir: C<Empty, void>;
  /** Opens `<data>/logs` in the file manager (Settings › About). */
  app_reveal_logs: C<Empty, void>;
  app_quit: C<Empty, void>;
  app_check_update: C<Empty, T.UpdateCheck>;
  app_install_update: J<Empty, void>;
  open_external: C<{ url: string }, void>;
  open_external_confirm: C<{ requestId: Id; allow: boolean; rememberHost: boolean }, void>;
  file_pick: C<{ purpose: T.FilePickPurpose; filters: T.FileFilter[]; multiple: boolean }, T.FileGrant[]>;
  file_save_grant: C<{ purpose: T.FileSavePurpose; suggestedName: string; filters: T.FileFilter[] }, T.FileGrant | null>;
  network_activity: C<{ limit: number }, T.NetworkLogEntry[]>;
  network_set_offline: C<{ offline: boolean }, { offline: boolean }>;

  // ── Vault and security
  vault_status: C<Empty, T.VaultStatus>;
  vault_create: C<{ password?: string; profile: T.VaultProfile; autoLock: T.AutoLock }, T.VaultCreateResult>;
  vault_unlock: C<{ password: string }, T.VaultStatus>;
  vault_unlock_recovery: C<{ words: string[]; newPassword: string }, T.VaultStatus>;
  vault_lock: C<{ reason?: 'manual' }, void>;
  vault_activity_ping: C<Empty, void>;
  vault_reauth: C<{ password: string }, { validUntil: Ts }>;
  vault_set_auto_lock: C<T.AutoLock, T.VaultStatus>;
  vault_benchmark_kdf: C<Empty, T.KdfBenchmark>;
  vault_strengthen_kdf: C<{ password: string }, T.VaultStatus>;
  vault_change_password: C<{ oldPassword: string; newPassword: string }, T.VaultStatus>;
  vault_enable_encryption: J<{ password: string }, { recoveryWords: string[] }>;
  vault_disable_encryption: J<{ password: string; confirm: 'DECRYPT' }, void>;
  vault_recovery_view: C<Empty, { words: string[] }>;
  vault_recovery_regenerate: C<Empty, { words: string[] }>;
  vault_recovery_confirm: C<{ positions: number[]; words: string[] }, { confirmed: boolean }>;
  vault_integrity_check: J<Empty, T.IntegrityReport>;
  vault_integrity_reseal: C<Empty, void>;
  security_log: C<{ limit: number }, T.SecurityLogEntry[]>;
  password_strength: C<{ password: string }, T.PasswordStrength>;
  password_generate: C<Empty, T.GeneratedPassphrase>;
  /** Native save dialog, then writes the recovery key as a text file (1.0 brief §2.5). `saved: false` = cancelled. */
  vault_recovery_save_file: C<{ words: string[] }, { saved: boolean; fileName?: string }>;

  // ── Secrets
  secret_list: C<Empty, T.SecretInfo[]>;
  secret_set: C<
    { id?: Id; provider: string; label: string; kind: 'api_key' | 'client'; value: string; showLast4: boolean },
    T.SecretInfo
  >;
  secret_delete: C<{ id: Id }, void>;

  // ── Settings and kv
  settings_get: C<Empty, T.SettingsBundle>;
  settings_set_device: C<{ patch: Partial<T.DeviceSettings> }, T.DeviceSettings>;
  settings_set_vault: C<{ patch: Partial<T.VaultSettings> }, T.VaultSettings>;
  kv_get: C<{ ns: T.KvNamespace; key: string }, unknown | null>;
  kv_set: C<{ ns: T.KvNamespace; key: string; value: unknown }, void>;
  kv_get_many: C<{ ns: T.KvNamespace; keys: string[] }, Record<string, unknown>>;
  /**
   * Region from the OS (time zone) and the webview/OS locale; week start, clock and currency follow the region.
   * Works locked and before a vault exists. `apply` (unlocked) saves it once per vault while locale, time zone,
   * week start and clock still hold the built-in defaults (1.0 brief §2.5). The settings store calls it on load.
   */
  settings_detect_region: C<{ locale?: string; timeZone?: string; apply?: boolean }, T.RegionInfo>;

  // ── Backup, import, export
  backup_create: J<{ grantId: Id; password?: string }, { bytes: number }>;
  backup_restore: J<{ grantId: Id; password?: string; recoveryWords?: string[] }, { vaultId: string; pages: number }>;
  snapshot_list: C<Empty, T.SnapshotInfo[]>;
  snapshot_now: J<Empty, { id: string }>;
  snapshot_set_folder: C<{ grantId: Id | null }, void>;
  snapshot_verify: J<{ id: string }, { ok: boolean }>;
  snapshot_status: C<Empty, T.SnapshotStatus>;
  /** Unencrypted workspaces only: the password automatic snapshots are sealed with (≥ 10 chars); `null` removes it. */
  snapshot_set_backup_password: C<{ password: string | null }, T.SnapshotStatus>;
  /** Native folder dialog (Rust); `null` when cancelled. */
  snapshot_choose_folder: C<Empty, T.SnapshotStatus | null>;
  snapshot_reveal: C<Empty, void>;
  import_detect: C<{ grantId: Id }, T.ImportDetectResult>;
  import_markdown: J<{ grantId: Id; workspaceId: Id; parentId: Id | null }, { pages: number; warnings: string[] }>;
  import_notion: J<{ grantId: Id; workspaceId: Id; parentId: Id | null }, T.NotionImportResult>;
  import_ics: J<{ grantId: Id; target: 'calendar' | { databaseId: Id } }, { events: number }>;
  import_undo: C<{ importJobId: Id }, { removed: number }>;
  export_pages: J<
    { pageIds: Id[]; format: T.ExportFormat; includeChildren: boolean; includeAssets: boolean; grantId: Id },
    { files: number }
  >;
  export_everything: J<{ grantId: Id }, { bytes: number }>;

  // ── Workspaces
  workspace_list: C<Empty, T.Workspace[]>;
  workspace_create: C<{ name: string; icon?: T.Icon }, T.Workspace>;
  workspace_update: C<
    { id: Id; patch: { name?: string; icon?: T.Icon | null; favorites?: Id[]; defaults?: T.WorkspaceDefaults } },
    T.Workspace
  >;
  workspace_open: C<{ id: Id }, T.WorkspaceOpenResult>;

  // ── Pages and docs
  page_get: C<{ id: Id }, T.PageGetResult>;
  page_get_meta: C<{ ids: Id[] }, T.PageMeta[]>;
  page_create: C<
    {
      workspaceId: Id;
      parentId: Id | null;
      kind: 'doc' | 'dashboard';
      title?: string;
      icon?: T.Icon;
      afterId?: Id;
      templatePageId?: Id;
      doc?: T.TipTapDoc;
      /** Initial flags, e.g. `{ project: true }` (brief §3). */
      flags?: Partial<T.PageFlags>;
    },
    { meta: T.PageMeta; docRev: Rev }
  >;
  page_update_meta: C<{ id: Id; patch: T.PageMetaPatch }, T.PageMeta>;
  page_save_doc: C<{ ownerId: Id; ownerKind: 'page' | 'row'; doc: T.TipTapDoc; baseRev: Rev }, { rev: Rev }>;
  page_move: C<{ id: Id; parentId: Id | null; beforeId?: Id; afterId?: Id }, T.PageMeta>;
  page_duplicate: J<{ id: Id; deep: boolean }, T.PageMeta>;
  page_turn_into_page: C<{ sourceId: Id; blockIds: string[]; title: string }, { meta: T.PageMeta; newSourceRev: Rev }>;
  page_delete: C<{ ids: Id[] }, void>;
  page_restore: C<{ ids: Id[] }, T.PageMeta[]>;
  page_purge: C<{ ids: Id[] }, void>;
  trash_list: C<{ workspaceId: Id; q?: string }, T.PageMeta[]>;
  trash_empty: J<{ workspaceId: Id }, { purged: number }>;
  page_backlinks: C<{ id: Id }, T.Backlink[]>;
  page_outline: C<{ id: Id }, T.OutlineItem[]>;
  page_get_block: C<{ pageId: Id; blockId: string }, { node: T.TipTapNode } | null>;
  template_list: C<{ workspaceId: Id }, T.TemplateInfo[]>;
  template_apply: C<{ templateId: string; workspaceId: Id; parentId: Id | null }, T.PageMeta>;
  page_set_template: C<{ id: Id; template: boolean }, T.PageMeta>;
  daily_note_open: C<{ date: string }, T.PageMeta>;

  // ── Versions
  version_list: C<{ targetId: Id; targetKind: T.VersionTargetKind }, T.VersionMeta[]>;
  version_get: C<{ id: Id }, { snapshot: unknown }>;
  version_create: C<{ targetId: Id; targetKind: 'page_doc' | 'workbook'; label: string }, T.VersionMeta>;
  version_restore: C<{ id: Id }, { rev: Rev }>;
  version_delete: C<{ id: Id }, void>;

  // ── Databases
  db_create: C<
    {
      workspaceId: Id;
      parentId: Id | null;
      title: string;
      inline: boolean;
      properties?: { name: string; type: T.PropType; config?: Record<string, unknown> }[];
      afterId?: Id;
    },
    { page: T.PageMeta; schema: T.DbSchema }
  >;
  db_get_schema: C<{ id: Id }, T.DbSchema>;
  db_update: C<
    {
      id: Id;
      patch: {
        description?: T.RichText;
        templates?: T.RowTemplate[];
        defaultTemplateId?: Id | null;
        hideEmptyProps?: boolean;
        inline?: boolean;
      };
    },
    T.DbSchema
  >;
  db_duplicate: J<{ id: Id; withRows: boolean }, { page: T.PageMeta }>;
  db_property_create: C<
    { databaseId: Id; name: string; type: T.PropType; config?: Record<string, unknown>; afterId?: Id },
    T.Property
  >;
  db_property_update: C<
    { id: Id; patch: { name?: string; config?: Record<string, unknown>; hidden?: boolean; description?: string } },
    T.Property
  >;
  db_property_convert: J<{ id: Id; to: T.PropType; config?: Record<string, unknown> }, T.Property>;
  db_property_delete: C<{ id: Id; alsoDual?: boolean }, void>;
  db_property_reorder: C<{ id: Id; beforeId?: Id; afterId?: Id }, T.Property>;
  db_select_option_upsert: C<{ propertyId: Id; option: T.SelectOptionInput }, T.Property>;
  db_select_option_delete: C<{ propertyId: Id; optionId: Id }, T.Property>;
  db_query: C<T.DbQueryReq, T.DbQueryResult>;
  db_query_range: C<{ databaseId: Id; viewId: Id; dateProp: Id; from: string; to: string }, T.RowDTO[]>;
  db_chart_data: C<
    { databaseId: Id; viewId?: Id; filter?: T.Filter; spec: T.ChartSpec; maxPoints?: number },
    T.ChartData
  >;
  db_row_get: C<{ id: Id }, T.DbRowGetResult>;
  db_row_create: C<
    { databaseId: Id; values?: Record<Id, T.CellValue>; afterId?: Id; viewId?: Id; templateId?: Id },
    T.RowDTO
  >;
  db_rows_update: C<{ updates: { id: Id; values: Record<Id, T.CellValue | null>; baseRev?: Rev }[] }, T.RowDTO[]>;
  db_rows_delete: C<{ ids: Id[] }, void>;
  db_rows_restore: C<{ ids: Id[] }, T.RowDTO[]>;
  db_rows_move: C<
    { ids: Id[]; beforeId?: Id; afterId?: Id; groupValue?: { prop: Id; value: T.CellValue } },
    T.RowDTO[]
  >;
  db_rows_duplicate: C<{ ids: Id[] }, T.RowDTO[]>;
  db_view_create: C<{ databaseId: Id; name: string; layout: T.Layout; fromViewId?: Id }, T.View>;
  db_view_update: C<{ id: Id; patch: Partial<Omit<T.View, 'id' | 'sortKey'>> }, T.View>;
  db_view_delete: C<{ id: Id }, void>;
  db_view_reorder: C<{ id: Id; beforeId?: Id; afterId?: Id }, T.View>;
  db_relation_options: C<{ propertyId: Id; search: string; limit: number }, { id: Id; title: string; icon?: T.Icon }[]>;
  db_formula_check: C<{ databaseId: Id; expression: string }, T.FormulaCheckResult>;
  db_import_csv: J<{ grantId: Id; target: T.DbImportTarget }, { databaseId: Id; inserted: number }>;
  db_import_preview: C<{ grantId: Id }, T.DbImportPreview>;
  db_export: J<{ databaseId: Id; viewId?: Id; format: 'csv' | 'xlsx'; grantId: Id }, { rows: number }>;
  row_secret_reveal: C<{ rowId: Id; propertyId: Id }, { value: string }>;

  // ── Sheets
  sheet_workbook_create: C<
    { workspaceId: Id; parentId: Id | null; title: string; template?: string },
    { page: T.PageMeta; sheets: T.SheetMeta[] }
  >;
  sheet_workbook_get: C<{ id: Id }, T.WorkbookInfo>;
  sheet_get_range: C<{ sheetId: Id; rect: T.Rect }, T.SheetRange>;
  sheet_get_cell: C<{ sheetId: Id; row: number; col: number }, T.SheetCellInfo>;
  sheet_set_cells: C<
    { sheetId: Id; edits: { row: number; col: number; input: string | null }[]; visible: T.Rect; undoGroup?: string },
    T.SheetSetCellsResult
  >;
  sheet_set_style: C<
    { sheetId: Id; rects: T.Rect[]; patch: Partial<T.CellStyle> },
    { styles: Record<number, T.CellStyle>; changed: T.PackedCells }
  >;
  sheet_clear: C<
    { sheetId: Id; rects: T.Rect[]; what: 'all' | 'contents' | 'formats' },
    { changed: T.PackedCells; dirtyRects: T.DirtyRect[] }
  >;
  sheet_insert: C<{ sheetId: Id; axis: 'rows' | 'cols'; at: number; count: number }, { rev: Rev }>;
  sheet_delete_span: C<{ sheetId: Id; axis: 'rows' | 'cols'; at: number; count: number }, { rev: Rev }>;
  sheet_resize: C<{ sheetId: Id; axis: 'rows' | 'cols'; indices: number[]; size: number | 'auto' }, void>;
  sheet_merge: C<{ sheetId: Id; rect: T.Rect; merge: boolean }, void>;
  sheet_freeze: C<{ sheetId: Id; rows: number; cols: number }, T.SheetMeta>;
  sheet_copy: C<{ sheetId: Id; rect: T.Rect }, { tsv: string; html: string; clip: string }>;
  sheet_paste: C<
    {
      sheetId: Id;
      at: { row: number; col: number };
      clip?: string;
      tsv?: string;
      html?: string;
      mode: 'all' | 'values' | 'formats' | 'formulas';
      visible: T.Rect;
    },
    { changed: T.PackedCells; dirtyRects: T.DirtyRect[] }
  >;
  sheet_fill: C<{ sheetId: Id; source: T.Rect; target: T.Rect; mode: 'series' | 'copy' }, { changed: T.PackedCells }>;
  sheet_sort: C<
    { sheetId: Id; rect: T.Rect; keys: { col: number; dir: 'asc' | 'desc' }[]; hasHeader: boolean },
    { changed: T.PackedCells }
  >;
  sheet_find: C<
    { workbookId: Id; query: string; matchCase: boolean; wholeCell: boolean; inFormulas: boolean },
    { sheetId: Id; row: number; col: number }[]
  >;
  sheet_replace: C<
    { workbookId: Id; query: string; replacement: string; matchCase: boolean; wholeCell: boolean },
    { count: number }
  >;
  sheet_add: C<{ workbookId: Id; name?: string; afterId?: Id }, T.SheetMeta>;
  sheet_update: C<{ id: Id; patch: { name?: string; color?: T.BlockColor | null; hidden?: boolean } }, T.SheetMeta>;
  sheet_remove: C<{ id: Id }, void>;
  sheet_reorder: C<{ id: Id; beforeId?: Id; afterId?: Id }, T.SheetMeta>;
  sheet_named_range_set: C<{ workbookId: Id; name: string; ref: string | null }, void>;
  sheet_cond_format_set: C<{ sheetId: Id; rules: T.CondFormatRule[] }, void>;
  sheet_chart_set: C<{ sheetId: Id; chart: T.SheetChartInput }, void>;
  sheet_undo: C<{ workbookId: Id }, { changedSheets: Id[] }>;
  sheet_redo: C<{ workbookId: Id }, { changedSheets: Id[] }>;
  sheet_eval: C<{ workbookId?: Id; sheetId?: Id; formula: string }, { display: string; value: unknown; error?: string }>;
  sheet_functions: C<Empty, T.SheetFunctionInfo[]>;
  sheet_lint: C<{ workbookId: Id }, T.SheetLintIssue[]>;
  sheet_import_file: J<
    { grantId: Id; workspaceId: Id; parentId: Id | null; asDatabase: boolean },
    T.ImportedPageResult
  >;
  sheet_export: J<{ workbookId: Id; format: 'xlsx' | 'csv'; sheetId?: Id; grantId: Id }, { bytes: number }>;
  sheet_to_database: C<
    { sheetId: Id; rect: T.Rect; hasHeader: boolean; workspaceId: Id; parentId: Id | null },
    { page: T.PageMeta }
  >;

  // ── Assets
  asset_import_grants: J<{ grantIds: Id[]; workspaceId: Id }, T.AssetDTO[]>;
  /** Raw-body upload. Over Tauri, `body` travels as the raw invoke payload and the rest as `x-emp-*` headers. */
  asset_import_bytes: C<{ body: Uint8Array | ArrayBuffer; workspaceId: Id; name: string; mime: string }, T.AssetDTO>;
  asset_get: C<{ ids: Id[] }, T.AssetDTO[]>;
  asset_open_external: C<{ id: Id }, void>;
  asset_save_as: C<{ id: Id; grantId: Id }, void>;
  asset_import_url: C<{ workspaceId: Id; url: string }, T.AssetDTO>;

  // ── Search
  search_query: C<{ q: string; filters?: T.SearchFilters; limit: number; reqId: number }, T.SearchQueryResult>;
  search_status: C<Empty, T.SearchStatus>;
  search_reindex: J<Empty, void>;

  // ── Life apps
  lifeapp_list: C<Empty, T.LifeAppSummary[]>;
  lifeapp_manifest: C<{ id: string }, T.LifeAppManifest>;
  lifeapp_recommend: C<
    { appId: string; stepId: string; answers: Record<string, unknown> },
    { value: unknown; why: string; source: string }
  >;
  lifeapp_preview: C<
    { appId: string; answers: Record<string, unknown>; mode: T.LifeAppMode; disabledKeys: string[] },
    T.GenerationPlan
  >;
  lifeapp_install: J<
    {
      appId: string;
      answers: Record<string, unknown>;
      mode: T.LifeAppMode;
      disabledKeys: string[];
      workspaceId: Id;
      sampleData: boolean;
      /** Create the hub inside this document or project (1.0 brief §3; a live doc page of the workspace). */
      parentId?: Id;
    },
    { instanceId: Id; rootPageId: Id; created: Id[] }
  >;
  lifeapp_instances: C<{ workspaceId: Id }, T.LifeAppInstance[]>;
  lifeapp_tuneup_preview: C<{ instanceId: Id; answers: Record<string, unknown> }, T.PlanDiff>;
  lifeapp_tuneup_apply: J<
    { instanceId: Id; answers: Record<string, unknown>; acceptConflicts: string[] },
    { changed: Id[] }
  >;
  lifeapp_detach: C<{ instanceId: Id }, void>;
  lifeapp_uninstall: C<{ instanceId: Id; keepContent: boolean }, void>;
  lifeapp_metrics: C<{ instanceId: Id; names: string[] }, Record<string, T.LifeAppMetric>>;
  lifeapp_insights: C<{ instanceId?: Id }, T.Insight[]>;
  lifeapp_insight_mute: C<{ instanceId: Id; ruleId: string; until: Ts | null }, void>;
  lifeapp_sample_data: C<{ instanceId: Id; on: boolean }, { rows: number }>;
  lifeapp_checklist_tick: C<{ instanceId: Id; itemId: string }, void>;
  /** UI-only checklist events (`ips.signed`, `tax.status_confirmed`, `sheet.exported`, …); returns what was ticked. */
  lifeapp_event: C<{ event: string; data?: Record<string, unknown> }, { instanceId: Id; itemId: string }[]>;
  /** A new spreadsheet from a Spreadsheet Studio template (`intent` = a value of its `intent` step, not `import`). */
  lifeapp_add_workbook: C<{ instanceId: Id; intent: string }, T.PageMeta>;

  // ── Finance
  finance_overview: C<{ instanceId: Id; month: string }, T.FinanceOverview>;
  finance_networth_series: C<{ instanceId: Id; range: '6m' | '1y' | '3y' | '5y' | 'all' }, T.NetWorthSeries>;
  finance_spending_breakdown: C<
    { instanceId: Id; from: string; to: string; by: 'category' | 'group' | 'payee' | 'account' },
    T.SpendingSlice[]
  >;
  finance_cashflow_sankey: C<{ instanceId: Id; month: string }, T.SankeyData>;
  finance_budget_month: C<{ instanceId: Id; month: string }, T.BudgetMonth>;
  finance_budget_assign: C<
    { instanceId: Id; month: string; categoryId: Id; amount: string },
    { available: string; toBeAssigned: string }
  >;
  finance_import_start: C<{ instanceId: Id; grantId: Id }, T.FinanceImportStart>;
  finance_import_preview: C<{ importId: Id; mapping: T.ImportMapping; accountId: Id }, T.FinanceImportPreview>;
  finance_import_commit: J<
    {
      importId: Id;
      mapping: T.ImportMapping;
      accountId: Id;
      skip: number[];
      overrides: Record<number, { categoryId?: Id; payee?: string }>;
      saveProfileAs?: string;
    },
    /** `openingBalance`: set when the first statement into an empty account gave its opening balance. */
    { inserted: number; skipped: number; transfersLinked: number; openingBalance?: string }
  >;
  finance_rules_list: C<{ instanceId: Id }, T.Rule[]>;
  finance_rule_upsert: C<{ instanceId: Id; rule: Omit<T.Rule, 'id' | 'timesApplied'> & { id?: Id } }, T.Rule>;
  finance_rule_delete: C<{ instanceId: Id; id: Id }, void>;
  finance_rules_apply: J<
    { instanceId: Id; scope: 'uncategorized' | 'all'; dryRun: boolean },
    { changed: number; sample: { rowId: Id; from?: string; to: string }[] }
  >;
  finance_recurring_detect: C<{ instanceId: Id }, T.RecurringCandidate[]>;
  finance_recurring_accept: C<
    {
      instanceId: Id;
      items: { payee: string; cadence: string; amount: T.Money; nextDue: string; kind: 'bill' | 'subscription' | 'income' }[];
    },
    { created: Id[] }
  >;
  finance_debt_plan: C<
    { debts: T.DebtInput[]; strategy: T.DebtStrategy; extraMonthly: string; order?: string[]; startMonth: string },
    T.DebtPlan
  >;
  finance_forecast: C<{ instanceId: Id; horizonDays: number; band: boolean }, T.Forecast>;
  finance_amortization: C<
    { principal: string; annualRatePct: string; termMonths: number; extraMonthly?: string; startDate: string },
    T.Amortization
  >;
  finance_goal_plan: C<
    { target: string; by: string; current: string; annualYieldPct: string },
    { monthlyRequired: string; onTrack: boolean }
  >;
  finance_ledger: C<{ instanceId: Id }, T.FinanceLedger>;
  finance_txns_query: C<
    { instanceId: Id; filter?: T.FinanceTxnFilter; accountId?: Id; search?: string; offset: number; limit: number },
    T.FinanceTxnPage
  >;
  finance_txns_update: C<
    {
      instanceId: Id;
      updates: { id: Id; categoryId?: Id | null; memo?: string; date?: string; amount?: string; cleared?: T.ClearedState; reviewed?: boolean }[];
    },
    { updated: number }
  >;
  finance_txn_create: C<
    { instanceId: Id; date: string; payee: string; amount: string; accountId: Id; categoryId?: Id; memo?: string },
    { id: Id }
  >;
  finance_txn_split: C<{ instanceId: Id; parentId: Id; parts: { categoryId: Id; amount: string }[] }, { parts: number }>;
  finance_reconcile: C<
    { instanceId: Id; accountId: Id; asOf: string; commit: boolean },
    { cleared: string; count: number; reconciled: string | null }
  >;
  finance_goal_upsert: C<
    { instanceId: Id; id?: Id; name?: string; target?: string; date?: string | null; kind?: 'emergency' | 'sinking' | 'savings'; saved?: string },
    { id: Id }
  >;
  finance_budget_assign_many: C<
    { instanceId: Id; month: string; items: { categoryId: Id; amount: string }[] },
    { toBeAssigned: string; categories: { categoryId: Id; available: string }[] }
  >;
  finance_account_create: C<
    { instanceId: Id; name: string; type: string; opening?: string; institution?: string; apr?: number; limit?: string; minPayment?: string; onBudget?: boolean },
    { id: Id }
  >;

  // ── Portfolio and tax
  portfolio_rebuild: J<{ instanceId: Id }, { lots: number; realizedEvents: number }>;
  portfolio_summary: C<{ instanceId: Id }, T.PortfolioSummary>;
  portfolio_performance: C<{ instanceId: Id; range: T.PerfRange; benchmark?: T.SymbolKey }, T.PortfolioPerformance>;
  portfolio_rebalance_plan: C<
    { instanceId: Id; newCash: string; allowTaxableSells: boolean; minTrade: string; fractional: boolean; cashAccountId?: Id },
    T.RebalancePlan
  >;
  portfolio_dividends: C<{ instanceId: Id; year: number }, T.DividendMonth[]>;
  portfolio_realized: C<{ instanceId: Id; year: number }, T.RealizedReport>;
  portfolio_book: C<{ instanceId: Id }, T.PortfolioBook>;
  portfolio_trade: C<
    {
      instanceId: Id;
      date: string;
      type: T.PortfolioTradeType;
      symbol?: string;
      name?: string;
      assetClass?: string;
      accountId?: Id;
      qty?: string;
      price?: string;
      amount?: string;
      fees?: string;
    },
    { id: Id; accountId: Id; securityId: Id | null }
  >;
  tax_packs: C<Empty, T.TaxPackInfo[]>;
  tax_estimate: C<T.TaxInput, T.TaxEstimate>;
  tax_quarterly_plan: C<
    {
      packId: string;
      year: number;
      method: T.QuarterlyMethod;
      estimate: T.TaxEstimate;
      priorYearTax?: string;
      priorYearAgi?: string;
      paid: { date: string; amount: string }[];
    },
    T.QuarterlyPlan
  >;
  tax_records: C<{ instanceId: Id; year: number }, T.TaxRecords>;
  tax_doc_status: C<{ instanceId: Id; id: Id; status: T.TaxDocStatus }, void>;
  tax_payment_record: C<
    { instanceId: Id; period: string; amount: string; date: string; method?: 'online' | 'check' | 'withholding' },
    { id: Id }
  >;
  tax_deduction_add: C<
    { instanceId: Id; desc: string; date: string; category: string; amount: string; payee?: string; receipt?: boolean; year: number },
    { id: Id }
  >;

  // ── Markets
  market_providers: C<Empty, T.ProviderInfo[]>;
  market_provider_configure: C<
    { id: string; enabled: boolean; apiKey?: string | null; priority?: number },
    T.ProviderInfo
  >;
  market_provider_test: C<{ id: string }, { ok: boolean; latencyMs: number; error?: string }>;
  market_search: C<{ q: string; limit: number; reqId: number }, { reqId: number; results: T.MarketSearchResult[] }>;
  market_quotes: C<{ symbols: T.SymbolKey[] }, T.Quote[]>;
  market_bars: C<
    { symbol: T.SymbolKey; interval: T.BarInterval; from: string; to: string; adjusted: boolean },
    T.Bars
  >;
  market_indicators: C<
    { symbol: T.SymbolKey; from: string; to: string; ind: T.IndicatorSpec[] },
    Record<string, (number | null)[]>
  >;
  /** `onQuote` is a listener here; over Tauri it becomes a `Channel<Quote[]>`. */
  market_subscribe: C<{ symbols: T.SymbolKey[]; onQuote: (quotes: T.Quote[]) => void }, { subId: Id }>;
  market_unsubscribe: C<{ subId: Id }, void>;
  watchlist_list: C<Empty, T.Watchlist[]>;
  watchlist_save: C<{ id?: Id; name: string; symbols: T.WatchlistSymbol[] }, { id: Id }>;
  fx_rates: C<{ base: string; symbols?: string[]; date?: string }, T.FxRates>;

  // ── Google and calendars
  google_status: C<Empty, { clientConfigured: boolean; accounts: T.GoogleAccount[] }>;
  google_set_client: C<{ clientId: string; clientSecret?: string }, void>;
  google_connect: J<{ feature: T.GoogleFeature; accountId?: Id }, T.GoogleAccount>;
  google_disconnect: C<{ accountId: Id; revoke: boolean; deleteCache: boolean }, void>;
  gcal_calendars: C<{ accountId: Id }, T.GoogleCalendarInfo[]>;
  gcal_set_sync: C<{ accountId: Id; calendarIds: string[]; intervalMin: 5 | 15 | 30 | 60 }, void>;
  gcal_sync_now: J<{ accountId?: Id }, { added: number; updated: number; deleted: number }>;
  calendar_events: C<{ from: string; to: string; sources?: ('google' | 'ics' | 'db')[] }, T.CalendarEvent[]>;
  gdocs_import: J<{ accountId: Id; url: string; workspaceId: Id; parentId: Id | null }, T.ImportedPageResult>;
  gdocs_export: J<{ accountId: Id; pageId: Id }, T.GoogleExportResult>;
  gsheets_import: J<
    { accountId: Id; url: string; workspaceId: Id; parentId: Id | null; asDatabase: boolean },
    T.ImportedPageResult
  >;
  gsheets_export: J<
    { accountId: Id; source: { workbookId: Id } | { databaseId: Id; viewId?: Id } },
    T.GoogleExportResult
  >;
  ics_export: C<{ source: { databaseId: Id; dateProp: Id } | { pageIds: Id[] }; grantId: Id }, { events: number }>;

  // ── Reminders and jobs
  reminder_list: C<{ from: Ts; to: Ts }, T.Reminder[]>;
  reminder_upsert: C<
    { id?: Id; fireAt: Ts; targetKind: T.ReminderTargetKind; targetId: Id; blockId?: string; text: string },
    { id: Id }
  >;
  reminder_delete: C<{ id: Id }, void>;
  reminder_snooze: C<{ id: Id; minutes: 5 | 15 | 60 | 1440 }, void>;
  job_list: C<Empty, T.JobInfo[]>;
  job_cancel: C<{ jobId: Id }, void>;
}

export type CommandName = keyof Commands;
export type Req<K extends CommandName> = Commands[K]['req'];
export type Res<K extends CommandName> = Commands[K]['res'];
export type JobCommandName = { [K in CommandName]: Commands[K] extends { job: true } ? K : never }[CommandName];

// ───────────────────────────────────────────────────────────────────────────── runtime flags

export interface CommandFlags {
  /** Returns JobRef immediately and streams JobEvent over `onEvent`. */
  job?: true;
  /** Always requires `vault_reauth` within the last 5 minutes (when the vault is encrypted). */
  reauth?: true;
  /** Callable while the vault is locked or uninitialized (no `state.session()?`). */
  preUnlock?: true;
}

const job = { job: true } as const;
const reauth = { reauth: true } as const;
const pre = { preUnlock: true } as const;
const none = {} as const;

/** Exhaustive: adding a command to `Commands` without a flag entry is a type error, and vice versa. */
export const COMMAND_FLAGS: { readonly [K in CommandName]: CommandFlags & (Commands[K] extends { job: true } ? { job: true } : { job?: never }) } = {
  app_info: pre,
  app_ready: pre,
  app_reveal_data_dir: pre,
  app_reveal_logs: pre,
  app_quit: pre,
  app_check_update: pre,
  app_install_update: { job: true, preUnlock: true },
  open_external: pre,
  open_external_confirm: pre,
  file_pick: none,
  file_save_grant: none,
  network_activity: none,
  network_set_offline: none,

  vault_status: pre,
  vault_create: pre,
  vault_unlock: pre,
  vault_unlock_recovery: pre,
  vault_lock: pre,
  vault_activity_ping: none,
  vault_reauth: none,
  vault_set_auto_lock: none,
  vault_benchmark_kdf: pre,
  vault_strengthen_kdf: none,
  vault_change_password: reauth,
  vault_enable_encryption: job,
  vault_disable_encryption: { job: true, reauth: true },
  vault_recovery_view: reauth,
  vault_recovery_regenerate: reauth,
  vault_recovery_confirm: none,
  vault_integrity_check: job,
  vault_integrity_reseal: reauth,
  security_log: none,
  password_strength: pre,
  password_generate: pre,
  vault_recovery_save_file: none,

  secret_list: none,
  secret_set: none,
  secret_delete: none,

  settings_get: pre,
  settings_set_device: pre,
  settings_set_vault: none,
  kv_get: none,
  kv_set: none,
  kv_get_many: none,
  settings_detect_region: pre,

  backup_create: job,
  backup_restore: { job: true, preUnlock: true },
  snapshot_list: none,
  snapshot_now: job,
  snapshot_set_folder: none,
  snapshot_verify: job,
  snapshot_status: none,
  snapshot_set_backup_password: none,
  snapshot_choose_folder: none,
  snapshot_reveal: none,
  import_detect: none,
  import_markdown: job,
  import_notion: job,
  import_ics: job,
  import_undo: none,
  export_pages: job,
  export_everything: { job: true, reauth: true },

  workspace_list: none,
  workspace_create: none,
  workspace_update: none,
  workspace_open: none,

  page_get: none,
  page_get_meta: none,
  page_create: none,
  page_update_meta: none,
  page_save_doc: none,
  page_move: none,
  page_duplicate: job,
  page_turn_into_page: none,
  page_delete: none,
  page_restore: none,
  page_purge: none,
  trash_list: none,
  trash_empty: job,
  page_backlinks: none,
  page_outline: none,
  page_get_block: none,
  template_list: none,
  template_apply: none,
  page_set_template: none,
  daily_note_open: none,

  version_list: none,
  version_get: none,
  version_create: none,
  version_restore: none,
  version_delete: none,

  db_create: none,
  db_get_schema: none,
  db_update: none,
  db_duplicate: job,
  db_property_create: none,
  db_property_update: none,
  db_property_convert: job,
  db_property_delete: none,
  db_property_reorder: none,
  db_select_option_upsert: none,
  db_select_option_delete: none,
  db_query: none,
  db_query_range: none,
  db_chart_data: none,
  db_row_get: none,
  db_row_create: none,
  db_rows_update: none,
  db_rows_delete: none,
  db_rows_restore: none,
  db_rows_move: none,
  db_rows_duplicate: none,
  db_view_create: none,
  db_view_update: none,
  db_view_delete: none,
  db_view_reorder: none,
  db_relation_options: none,
  db_formula_check: none,
  db_import_csv: job,
  db_import_preview: none,
  db_export: job,
  row_secret_reveal: reauth,

  sheet_workbook_create: none,
  sheet_workbook_get: none,
  sheet_get_range: none,
  sheet_get_cell: none,
  sheet_set_cells: none,
  sheet_set_style: none,
  sheet_clear: none,
  sheet_insert: none,
  sheet_delete_span: none,
  sheet_resize: none,
  sheet_merge: none,
  sheet_freeze: none,
  sheet_copy: none,
  sheet_paste: none,
  sheet_fill: none,
  sheet_sort: none,
  sheet_find: none,
  sheet_replace: none,
  sheet_add: none,
  sheet_update: none,
  sheet_remove: none,
  sheet_reorder: none,
  sheet_named_range_set: none,
  sheet_cond_format_set: none,
  sheet_chart_set: none,
  sheet_undo: none,
  sheet_redo: none,
  sheet_eval: none,
  sheet_functions: none,
  sheet_lint: none,
  sheet_import_file: job,
  sheet_export: job,
  sheet_to_database: none,

  asset_import_grants: job,
  asset_import_bytes: none,
  asset_get: none,
  asset_open_external: none,
  asset_save_as: none,
  asset_import_url: none,

  search_query: none,
  search_status: none,
  search_reindex: job,

  lifeapp_list: none,
  lifeapp_manifest: none,
  lifeapp_recommend: none,
  lifeapp_preview: none,
  lifeapp_install: job,
  lifeapp_instances: none,
  lifeapp_tuneup_preview: none,
  lifeapp_tuneup_apply: job,
  lifeapp_detach: none,
  lifeapp_uninstall: none,
  lifeapp_metrics: none,
  lifeapp_insights: none,
  lifeapp_insight_mute: none,
  lifeapp_sample_data: none,
  lifeapp_checklist_tick: none,
  lifeapp_event: none,
  lifeapp_add_workbook: none,

  finance_overview: none,
  finance_networth_series: none,
  finance_spending_breakdown: none,
  finance_cashflow_sankey: none,
  finance_budget_month: none,
  finance_budget_assign: none,
  finance_import_start: none,
  finance_import_preview: none,
  finance_import_commit: job,
  finance_rules_list: none,
  finance_rule_upsert: none,
  finance_rule_delete: none,
  finance_rules_apply: job,
  finance_recurring_detect: none,
  finance_recurring_accept: none,
  finance_debt_plan: none,
  finance_forecast: none,
  finance_amortization: none,
  finance_goal_plan: none,
  finance_ledger: none,
  finance_txns_query: none,
  finance_txns_update: none,
  finance_txn_create: none,
  finance_txn_split: none,
  finance_reconcile: none,
  finance_goal_upsert: none,
  finance_budget_assign_many: none,
  finance_account_create: none,

  portfolio_rebuild: job,
  portfolio_summary: none,
  portfolio_performance: none,
  portfolio_rebalance_plan: none,
  portfolio_dividends: none,
  portfolio_realized: none,
  portfolio_book: none,
  portfolio_trade: none,
  tax_packs: none,
  tax_estimate: none,
  tax_quarterly_plan: none,
  tax_records: none,
  tax_doc_status: none,
  tax_payment_record: none,
  tax_deduction_add: none,

  market_providers: none,
  market_provider_configure: none,
  market_provider_test: none,
  market_search: none,
  market_quotes: none,
  market_bars: none,
  market_indicators: none,
  market_subscribe: none,
  market_unsubscribe: none,
  watchlist_list: none,
  watchlist_save: none,
  fx_rates: none,

  google_status: none,
  google_set_client: reauth,
  google_connect: { job: true, reauth: true },
  google_disconnect: none,
  gcal_calendars: none,
  gcal_set_sync: none,
  gcal_sync_now: job,
  calendar_events: none,
  gdocs_import: job,
  gdocs_export: job,
  gsheets_import: job,
  gsheets_export: job,
  ics_export: none,

  reminder_list: none,
  reminder_upsert: none,
  reminder_delete: none,
  reminder_snooze: none,
  job_list: none,
  job_cancel: none,
};

/** SPEC §11.3 normative list (must match `src-tauri/src/commands/mod.rs::ALL_COMMANDS`). */
export const ALL_COMMANDS = Object.keys(COMMAND_FLAGS) as CommandName[];

export function isCommandName(name: string): name is CommandName {
  return Object.prototype.hasOwnProperty.call(COMMAND_FLAGS, name);
}

// ───────────────────────────────────────────────────────────────────────────── namespaced facade

type CamelTail<S extends string> = S extends `${infer H}_${infer R}` ? `${H}${Capitalize<CamelTail<R>>}` : S;
/** `page_get_meta` → `page` */
export type NamespaceOf<K extends string> = K extends `${infer N}_${string}` ? N : never;
/** `page_get_meta` → `getMeta` */
export type MethodOf<K extends string> = K extends `${string}_${infer R}` ? CamelTail<R> : never;
export type Namespace = NamespaceOf<CommandName>;

export type JobListener<R = unknown> = (event: T.JobEvent<R>) => void;

/** What a (job) facade call resolves to: the JobRef plus helpers. `result` settles with the `done`/`error` event. */
export interface JobHandle<R> extends T.JobRef {
  /** The command that started the job. */
  command: CommandName;
  result: Promise<R>;
  cancel(): Promise<void>;
}

/** Facade request for a (job) command: the channel is an optional listener. */
export type JobReq<Rq> = Rq & { onEvent?: JobListener };

type MethodFor<K extends CommandName> = Commands[K] extends { job: true }
  ? Empty extends Req<K>
    ? (req?: JobReq<Req<K>>) => Promise<JobHandle<Res<K>>>
    : (req: JobReq<Req<K>>) => Promise<JobHandle<Res<K>>>
  : Empty extends Req<K>
    ? (req?: Req<K>) => Promise<Res<K>>
    : (req: Req<K>) => Promise<Res<K>>;

type BackendShape = {
  [N in Namespace]: { [K in CommandName as NamespaceOf<K> extends N ? MethodOf<K> : never]: MethodFor<K> };
};

/** `api.vault.status()`, `api.page.get({ id })`, `api.db.query(req)` … */
export interface EmpBackend extends BackendShape {}

/** `'page_get_meta'` → `['page', 'getMeta']` */
export function splitCommand(name: string): [namespace: string, method: string] {
  const i = name.indexOf('_');
  if (i < 0) return [name, ''];
  const rest = name.slice(i + 1).replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
  return [name.slice(0, i), rest];
}

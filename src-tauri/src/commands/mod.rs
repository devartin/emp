//! IPC commands (SPEC §11.3).
//!
//! Conventions (§11.1): every command takes exactly one argument named `req`, a `#[serde(rename_all = "camelCase",
//! deny_unknown_fields)]` struct (the one exception is `asset_import_bytes`, which uses a raw-body invoke). Data
//! commands start with `state.session()?` (`LOCKED` while locked; stamps activity); *(reauth)* commands call
//! `state.require_reauth()?`; *(job)* commands return a [`crate::jobs::JobRef`] and stream over `req.onEvent`.
//!
//! [`ALL_COMMANDS`] is the normative allowlist: `build.rs` turns it into the Tauri `AppManifest`,
//! `capabilities/main.json` and the isolation hook's list. A command missing from it cannot be called from JS.

use std::sync::Arc;

use serde::Deserialize;
use tauri::ipc::JavaScriptChannelId;

use crate::jobs::{JobEvent, JobSink};

pub mod app;
pub mod assets;
pub mod backup;
pub mod pages;
pub mod reminders;
pub mod search;
pub mod secrets;
pub mod settings;
pub mod vault;
pub mod versions;
pub mod workspaces;

// Domain command groups (written by the domain team).
pub mod db;
pub mod export;
pub mod finance;
pub mod google;
pub mod ics;
pub mod import;
pub mod lifeapp;
pub mod market;
pub mod portfolio;
pub mod sheet;
pub mod tax;

/// Every IPC command, in SPEC §11.3 order. Keep in sync with `src/backend/contract.ts` (a unit test checks).
pub const ALL_COMMANDS: &[&str] = &[
    // ── App, windows, network
    "app_info",
    "app_ready",
    "app_reveal_data_dir",
    "app_reveal_logs",
    "app_quit",
    "app_check_update",
    "app_install_update",
    "open_external",
    "open_external_confirm",
    "file_pick",
    "file_save_grant",
    "network_activity",
    "network_set_offline",
    // ── Vault and security
    "vault_status",
    "vault_create",
    "vault_unlock",
    "vault_unlock_recovery",
    "vault_lock",
    "vault_activity_ping",
    "vault_reauth",
    "vault_set_auto_lock",
    "vault_benchmark_kdf",
    "vault_strengthen_kdf",
    "vault_change_password",
    "vault_enable_encryption",
    "vault_disable_encryption",
    "vault_recovery_view",
    "vault_recovery_regenerate",
    "vault_recovery_confirm",
    "vault_integrity_check",
    "vault_integrity_reseal",
    "security_log",
    "password_strength",
    "password_generate",
    "vault_recovery_save_file",
    // ── Secrets
    "secret_list",
    "secret_set",
    "secret_delete",
    // ── Settings and kv
    "settings_get",
    "settings_set_device",
    "settings_set_vault",
    "kv_get",
    "kv_set",
    "kv_get_many",
    "settings_detect_region",
    // ── Backup, import, export
    "backup_create",
    "backup_restore",
    "snapshot_list",
    "snapshot_now",
    "snapshot_set_folder",
    "snapshot_verify",
    "snapshot_status",
    "snapshot_set_backup_password",
    "snapshot_choose_folder",
    "snapshot_reveal",
    "import_detect",
    "import_markdown",
    "import_notion",
    "import_ics",
    "import_undo",
    "export_pages",
    "export_everything",
    // ── Workspaces
    "workspace_list",
    "workspace_create",
    "workspace_update",
    "workspace_open",
    // ── Pages and docs
    "page_get",
    "page_get_meta",
    "page_create",
    "page_update_meta",
    "page_save_doc",
    "page_move",
    "page_duplicate",
    "page_turn_into_page",
    "page_delete",
    "page_restore",
    "page_purge",
    "trash_list",
    "trash_empty",
    "page_backlinks",
    "page_outline",
    "page_get_block",
    "template_list",
    "template_apply",
    "page_set_template",
    "daily_note_open",
    // ── Versions
    "version_list",
    "version_get",
    "version_create",
    "version_restore",
    "version_delete",
    // ── Databases
    "db_create",
    "db_get_schema",
    "db_update",
    "db_duplicate",
    "db_property_create",
    "db_property_update",
    "db_property_convert",
    "db_property_delete",
    "db_property_reorder",
    "db_select_option_upsert",
    "db_select_option_delete",
    "db_query",
    "db_query_range",
    "db_chart_data",
    "db_row_get",
    "db_row_create",
    "db_rows_update",
    "db_rows_delete",
    "db_rows_restore",
    "db_rows_move",
    "db_rows_duplicate",
    "db_view_create",
    "db_view_update",
    "db_view_delete",
    "db_view_reorder",
    "db_relation_options",
    "db_formula_check",
    "db_import_csv",
    "db_import_preview",
    "db_export",
    "row_secret_reveal",
    // ── Sheets
    "sheet_workbook_create",
    "sheet_workbook_get",
    "sheet_get_range",
    "sheet_get_cell",
    "sheet_set_cells",
    "sheet_set_style",
    "sheet_clear",
    "sheet_insert",
    "sheet_delete_span",
    "sheet_resize",
    "sheet_merge",
    "sheet_freeze",
    "sheet_copy",
    "sheet_paste",
    "sheet_fill",
    "sheet_sort",
    "sheet_find",
    "sheet_replace",
    "sheet_add",
    "sheet_update",
    "sheet_remove",
    "sheet_reorder",
    "sheet_named_range_set",
    "sheet_cond_format_set",
    "sheet_chart_set",
    "sheet_undo",
    "sheet_redo",
    "sheet_eval",
    "sheet_functions",
    "sheet_lint",
    "sheet_import_file",
    "sheet_export",
    "sheet_to_database",
    // ── Assets
    "asset_import_grants",
    "asset_import_bytes",
    "asset_get",
    "asset_open_external",
    "asset_save_as",
    "asset_import_url",
    // ── Search
    "search_query",
    "search_status",
    "search_reindex",
    // ── Life apps
    "lifeapp_list",
    "lifeapp_manifest",
    "lifeapp_recommend",
    "lifeapp_preview",
    "lifeapp_install",
    "lifeapp_instances",
    "lifeapp_tuneup_preview",
    "lifeapp_tuneup_apply",
    "lifeapp_detach",
    "lifeapp_uninstall",
    "lifeapp_metrics",
    "lifeapp_insights",
    "lifeapp_insight_mute",
    "lifeapp_sample_data",
    "lifeapp_checklist_tick",
    "lifeapp_event",
    "lifeapp_add_workbook",
    // ── Finance
    "finance_overview",
    "finance_networth_series",
    "finance_spending_breakdown",
    "finance_cashflow_sankey",
    "finance_budget_month",
    "finance_budget_assign",
    "finance_import_start",
    "finance_import_preview",
    "finance_import_commit",
    "finance_rules_list",
    "finance_rule_upsert",
    "finance_rule_delete",
    "finance_rules_apply",
    "finance_recurring_detect",
    "finance_recurring_accept",
    "finance_debt_plan",
    "finance_forecast",
    "finance_amortization",
    "finance_goal_plan",
    "finance_ledger",
    "finance_txns_query",
    "finance_txns_update",
    "finance_txn_create",
    "finance_txn_split",
    "finance_reconcile",
    "finance_goal_upsert",
    "finance_budget_assign_many",
    "finance_account_create",
    // ── Portfolio and tax
    "portfolio_rebuild",
    "portfolio_summary",
    "portfolio_performance",
    "portfolio_rebalance_plan",
    "portfolio_dividends",
    "portfolio_realized",
    "portfolio_book",
    "portfolio_trade",
    "tax_packs",
    "tax_estimate",
    "tax_quarterly_plan",
    "tax_records",
    "tax_doc_status",
    "tax_payment_record",
    "tax_deduction_add",
    // ── Markets
    "market_providers",
    "market_provider_configure",
    "market_provider_test",
    "market_search",
    "market_quotes",
    "market_bars",
    "market_indicators",
    "market_subscribe",
    "market_unsubscribe",
    "watchlist_list",
    "watchlist_save",
    "fx_rates",
    // ── Google and calendars
    "google_status",
    "google_set_client",
    "google_connect",
    "google_disconnect",
    "gcal_calendars",
    "gcal_set_sync",
    "gcal_sync_now",
    "calendar_events",
    "gdocs_import",
    "gdocs_export",
    "gsheets_import",
    "gsheets_export",
    "ics_export",
    // ── Reminders and jobs
    "reminder_list",
    "reminder_upsert",
    "reminder_delete",
    "reminder_snooze",
    "job_list",
    "job_cancel",
];

/// The request of commands that take `{}`.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Empty {}

/// The `Channel<JobEvent>` behind a request's `onEvent` field, as a [`JobSink`].
#[must_use]
pub fn job_sink(webview: &tauri::Webview, channel: &JavaScriptChannelId) -> Arc<dyn JobSink> {
    Arc::new(channel.channel_on::<tauri::Wry, JobEvent>(webview.clone()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_commands_are_unique_snake_case() {
        let mut seen = std::collections::HashSet::new();
        for c in ALL_COMMANDS {
            assert!(seen.insert(*c), "duplicate {c}");
            assert!(
                c.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_'),
                "{c}"
            );
        }
        assert_eq!(ALL_COMMANDS.len(), 255);
    }

    /// The command names in SPEC §11.3 code blocks (`name(` at the start of a line).
    fn spec_commands() -> Option<Vec<String>> {
        let spec = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../docs/SPEC.md"))
            .ok()?;
        let start = spec.find("### 11.3 Commands")?;
        let end = spec[start..].find("### 11.4")? + start;
        Some(
            spec[start..end]
                .lines()
                .filter_map(|l| {
                    let name: String = l
                        .chars()
                        .take_while(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '_')
                        .collect();
                    (!name.is_empty() && l[name.len()..].starts_with('(')).then_some(name)
                })
                .collect(),
        )
    }

    #[test]
    fn matches_spec_section_11_3() {
        let Some(spec) = spec_commands() else {
            return;
        };
        let ours: Vec<String> = ALL_COMMANDS.iter().map(|s| (*s).to_owned()).collect();
        assert_eq!(ours, spec);
    }

    #[test]
    fn matches_frontend_contract() {
        let Ok(ts) = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../src/backend/contract.ts"
        )) else {
            return;
        };
        let missing: Vec<&str> = ALL_COMMANDS
            .iter()
            .copied()
            .filter(|c| !ts.contains(&format!("{c}:")) && !ts.contains(&format!("'{c}'")))
            .collect();
        assert!(missing.is_empty(), "missing in contract.ts: {missing:?}");
    }

    #[test]
    fn capability_file_grants_every_command() {
        let cap = std::fs::read_to_string(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/capabilities/main.json"
        ))
        .unwrap();
        let v: serde_json::Value = serde_json::from_str(&cap).unwrap();
        let perms: Vec<&str> = v["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|p| p.as_str())
            .collect();
        for c in ALL_COMMANDS {
            let p = format!("allow-{}", c.replace('_', "-"));
            assert!(perms.contains(&p.as_str()), "{p}");
        }
        for banned in ["shell:", "fs:", "http:", "opener:", "dialog:", "deep-link:"] {
            assert!(!perms.iter().any(|p| p.starts_with(banned)), "{banned}");
        }
        assert!(
            !perms
                .iter()
                .any(|p| p.starts_with("clipboard-manager:allow-read"))
        );
        assert_eq!(v["windows"], serde_json::json!(["main"]));
        assert_eq!(v["local"], serde_json::json!(true));
    }

    #[test]
    fn isolation_hook_lists_every_command() {
        let js =
            std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/isolation/index.js"))
                .unwrap();
        for c in ALL_COMMANDS {
            assert!(js.contains(&format!("'{c}',")), "{c}");
        }
    }
}

//! # emp-app (`emp_lib`)
//!
//! The Tauri application core of EMP: window and webview security (SPEC §9.12–§9.13), the IPC command surface
//! (§11), vault session and auto-lock (§9.9), file grants (§9.14), the `emp-asset` protocol (D-09), jobs with
//! progress channels, events (§11.4), logging without secrets (§9.23) and process hardening (§9.11).
//!
//! ## Layout
//! * [`state`] — [`state::AppState`]: the open [`emp_store::Store`], session checks, re-auth and the lock sequence.
//! * [`commands`] — one module per §11.3 group; [`commands::ALL_COMMANDS`] is the normative allowlist.
//! * [`jobs`], [`grants`], [`events`], [`autolock`], [`navigation`], [`protocol`], [`keychain`], [`clipboard`],
//!   [`logging`], [`validate`], [`error`] — the building blocks commands use.
//! * [`background`] (ticker) and [`system_events`] (native sleep / screen-lock signals) drive automatic work.
//!
//! ## Adding domain commands
//! Write the command in its `commands/<group>.rs` module, then add its path to the marked block in
//! [`run`]'s `generate_handler!`. The name must already be in [`commands::ALL_COMMANDS`] (it is the SPEC list).

#![deny(unsafe_code)]
#![warn(missing_docs)]

pub mod autolock;
pub mod background;
pub mod clipboard;
pub mod commands;
pub mod error;
pub mod events;
pub mod grants;
pub mod jobs;
pub mod keychain;
pub mod logging;
pub mod navigation;
pub mod platform;
pub mod protocol;
pub mod state;
pub mod system_events;
pub mod validate;

use tauri::utils::config::{Csp, CspDirectiveSources};
use tauri::webview::{NewWindowResponse, PermissionResponse};
use tauri::{AppHandle, Manager, RunEvent, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_window_state::StateFlags;

use crate::events::MAIN_WINDOW;
use crate::grants::{GrantMode, GrantPurpose};
use crate::state::AppState;

/// How long to wait for `app_ready` before showing the window anyway.
pub const SHOW_FALLBACK: std::time::Duration = std::time::Duration::from_secs(8);

/// The origin of the isolation iframe for a build's random isolation schema.
#[must_use]
pub fn isolation_frame_origin(schema: &str, windows: bool) -> String {
    if windows {
        format!("http://{schema}.localhost")
    } else {
        format!("{schema}:")
    }
}

/// Replaces `frame-src` with exactly the isolation iframe's origin. SPEC §9.12 sets `frame-src 'none'`, which would
/// also block the isolation frame Tauri injects; this keeps every other frame blocked (D-13).
pub fn allow_isolation_frame(csp: &mut Option<Csp>, origin: &str) {
    if let Some(Csp::DirectiveMap(map)) = csp {
        map.insert(
            "frame-src".into(),
            CspDirectiveSources::List(vec![origin.to_owned()]),
        );
    }
}

fn patch_context_csp(context: &mut tauri::Context<tauri::Wry>) {
    #[allow(irrefutable_let_patterns)]
    let origin = if let tauri::Pattern::Isolation { schema, .. } = context.pattern() {
        Some(isolation_frame_origin(schema, cfg!(windows)))
    } else {
        None
    };
    if let Some(origin) = origin {
        let security = &mut context.config_mut().app.security;
        allow_isolation_frame(&mut security.csp, &origin);
        allow_isolation_frame(&mut security.dev_csp, &origin);
    }
}

fn focus_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_WINDOW) {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Builds the main window from its config entry (`create: false`) with the navigation policy of §9.13.
fn create_main_window(app: &tauri::App) -> tauri::Result<()> {
    let Some(config) = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == MAIN_WINDOW)
        .cloned()
    else {
        return Err(tauri::Error::WindowNotFound);
    };
    let nav_app = app.handle().clone();
    let dev_origin = app.config().build.dev_url.clone();
    let builder = WebviewWindowBuilder::from_config(app.handle(), &config)?
        .on_navigation(move |url| {
            if navigation::is_app_url(url, dev_origin.as_ref()) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                // Route web links to the confirmation flow instead of navigating the app webview.
                if let Ok(target) = navigation::classify_external(url.as_str()) {
                    let state = nav_app.state::<AppState>();
                    if let Err(e) = commands::app::request_open(&nav_app, &state, target) {
                        tracing::debug!(code = e.code.as_str(), "navigation link refused");
                    }
                }
            }
            false
        })
        .on_new_window(|_url, _features| NewWindowResponse::Deny)
        .on_download(|_webview, _event| false)
        // §9.13: every webview permission request (camera, microphone, geolocation, notifications, clipboard-read,
        // display capture, …) is denied on every platform; OS features are driven from Rust only.
        .on_permission_request(|_webview, kind| {
            tracing::debug!(kind = ?kind, "webview permission request denied");
            PermissionResponse::Deny
        });
    #[cfg(windows)]
    let builder = builder.decorations(false);
    builder.build()?;
    Ok(())
}

fn on_window_event(window: &tauri::Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    let app = window.app_handle().clone();
    match event {
        WindowEvent::Focused(focused) => {
            let focused = *focused;
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                state
                    .activity
                    .focus_changed(focused, std::time::Instant::now());
                if focused {
                    background::on_focus_regained(&app);
                } else {
                    state.check_auto_lock(false);
                }
            });
        }
        WindowEvent::DragDrop(tauri::DragDropEvent::Drop { paths, position }) => {
            let scale = window.scale_factor().unwrap_or(1.0);
            let pos = position.to_logical::<f64>(scale);
            let paths = paths.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                if state.session().is_err() {
                    return;
                }
                let mut grants = Vec::new();
                for p in paths.into_iter().take(validate::MAX_LIST) {
                    let Ok(path) = grants::canonicalize_for(&p, GrantMode::Read) else {
                        continue;
                    };
                    if !path.is_file() {
                        continue;
                    }
                    if let Ok(g) = state
                        .grants
                        .issue(path, GrantPurpose::Drop, GrantMode::Read)
                    {
                        grants.push(g);
                    }
                }
                if !grants.is_empty() {
                    state.events.emit(
                        events::FILE_DROPPED,
                        events::FileDropped {
                            grants,
                            x: pos.x,
                            y: pos.y,
                        },
                    );
                }
            });
        }
        _ => {}
    }
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let data_dir = app.path().app_data_dir()?;
    logging::init(&data_dir.join("logs"));
    logging::install_panic_hook();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        platform = commands::app::platform(),
        "EMP starting"
    );
    let state = AppState::new(app.handle(), data_dir)?;
    app.manage(state);
    create_main_window(app)?;
    background::start(app.handle().clone());
    system_events::start(app.handle());
    // The window starts hidden and is shown by `app_ready`; show it anyway if the frontend never reports ready.
    let handle = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(SHOW_FALLBACK).await;
        if let Some(w) = handle.get_webview_window(MAIN_WINDOW)
            && !w.is_visible().unwrap_or(true)
        {
            tracing::warn!("frontend did not report ready; showing the window");
            let _ = w.show();
        }
    });
    Ok(())
}

fn on_exit(app: &AppHandle) {
    let state = app.state::<AppState>();
    if let Some(store) = state.store_opt() {
        background::snapshot_on_quit(&state);
        state.persist_net_log(&store);
        if let Err(e) = store.close() {
            tracing::warn!(code = e.code(), "closing the vault failed");
        }
    }
    tracing::info!("EMP exiting");
}

/// Runs the application.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    platform::harden_process();
    let mut context = tauri::generate_context!();
    patch_context_csp(&mut context);

    let builder = tauri::Builder::default()
        // Must be the first plugin: a second launch focuses the running instance instead.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            focus_main(app);
        }))
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_process::init())
        .register_asynchronous_uri_scheme_protocol("emp-asset", |ctx, request, responder| {
            if ctx.webview_label() != MAIN_WINDOW {
                responder.respond(
                    tauri::http::Response::builder()
                        .status(tauri::http::StatusCode::FORBIDDEN)
                        .body(Vec::new())
                        .unwrap_or_default(),
                );
                return;
            }
            let app = ctx.app_handle().clone();
            tauri::async_runtime::spawn_blocking(move || {
                let state = app.state::<AppState>();
                let store = state.store_opt();
                responder.respond(protocol::serve(store.as_ref(), &request));
            });
        })
        // Defence in depth for any webview created later: deny every web permission request (§9.13).
        .on_permission_request(|_webview, _kind| PermissionResponse::Deny)
        .setup(setup)
        .on_window_event(on_window_event)
        .invoke_handler(tauri::generate_handler![
            // ── App, windows, network
            commands::app::app_info,
            commands::app::app_ready,
            commands::app::app_reveal_data_dir,
            commands::app::app_quit,
            commands::app::app_check_update,
            commands::app::app_install_update,
            commands::app::open_external,
            commands::app::open_external_confirm,
            commands::app::file_pick,
            commands::app::file_save_grant,
            commands::app::network_activity,
            commands::app::network_set_offline,
            // ── Vault and security
            commands::vault::vault_status,
            commands::vault::vault_create,
            commands::vault::vault_unlock,
            commands::vault::vault_unlock_recovery,
            commands::vault::vault_lock,
            commands::vault::vault_activity_ping,
            commands::vault::vault_reauth,
            commands::vault::vault_set_auto_lock,
            commands::vault::vault_benchmark_kdf,
            commands::vault::vault_strengthen_kdf,
            commands::vault::vault_change_password,
            commands::vault::vault_enable_encryption,
            commands::vault::vault_disable_encryption,
            commands::vault::vault_recovery_view,
            commands::vault::vault_recovery_regenerate,
            commands::vault::vault_recovery_confirm,
            commands::vault::vault_integrity_check,
            commands::vault::vault_integrity_reseal,
            commands::vault::security_log,
            commands::vault::password_strength,
            commands::vault::password_generate,
            // ── Secrets
            commands::secrets::secret_list,
            commands::secrets::secret_set,
            commands::secrets::secret_delete,
            // ── Settings and kv
            commands::settings::settings_get,
            commands::settings::settings_set_device,
            commands::settings::settings_set_vault,
            commands::settings::kv_get,
            commands::settings::kv_set,
            commands::settings::kv_get_many,
            // ── Backup and snapshots
            commands::backup::backup_create,
            commands::backup::backup_restore,
            commands::backup::snapshot_list,
            commands::backup::snapshot_now,
            commands::backup::snapshot_set_folder,
            commands::backup::snapshot_verify,
            // ── Workspaces
            commands::workspaces::workspace_list,
            commands::workspaces::workspace_create,
            commands::workspaces::workspace_update,
            commands::workspaces::workspace_open,
            // ── Pages and docs
            commands::pages::page_get,
            commands::pages::page_get_meta,
            commands::pages::page_create,
            commands::pages::page_update_meta,
            commands::pages::page_save_doc,
            commands::pages::page_move,
            commands::pages::page_duplicate,
            commands::pages::page_turn_into_page,
            commands::pages::page_delete,
            commands::pages::page_restore,
            commands::pages::page_purge,
            commands::pages::trash_list,
            commands::pages::trash_empty,
            commands::pages::page_backlinks,
            commands::pages::page_outline,
            commands::pages::page_get_block,
            commands::pages::template_list,
            commands::pages::template_apply,
            commands::pages::page_set_template,
            commands::pages::daily_note_open,
            // ── Versions
            commands::versions::version_list,
            commands::versions::version_get,
            commands::versions::version_create,
            commands::versions::version_restore,
            commands::versions::version_delete,
            // ── Assets
            commands::assets::asset_import_grants,
            commands::assets::asset_import_bytes,
            commands::assets::asset_get,
            commands::assets::asset_open_external,
            commands::assets::asset_save_as,
            commands::assets::asset_import_url,
            // ── Search
            commands::search::search_query,
            commands::search::search_status,
            commands::search::search_reindex,
            // ── Reminders and jobs
            commands::reminders::reminder_list,
            commands::reminders::reminder_upsert,
            commands::reminders::reminder_delete,
            commands::reminders::reminder_snooze,
            commands::reminders::job_list,
            commands::reminders::job_cancel,
            // ── BEGIN DOMAIN COMMANDS ─────────────────────────────────────────────────────────────────────────
            // Domain team: append `commands::<group>::<command>,` lines here (db, sheet, lifeapp, finance,
            // portfolio, tax, market, google, ics, import, export). Names must be in `commands::ALL_COMMANDS`.
            // ── Databases
            commands::db::db_create,
            commands::db::db_get_schema,
            commands::db::db_update,
            commands::db::db_duplicate,
            commands::db::db_property_create,
            commands::db::db_property_update,
            commands::db::db_property_convert,
            commands::db::db_property_delete,
            commands::db::db_property_reorder,
            commands::db::db_select_option_upsert,
            commands::db::db_select_option_delete,
            commands::db::db_query,
            commands::db::db_query_range,
            commands::db::db_chart_data,
            commands::db::db_row_get,
            commands::db::db_row_create,
            commands::db::db_rows_update,
            commands::db::db_rows_delete,
            commands::db::db_rows_restore,
            commands::db::db_rows_move,
            commands::db::db_rows_duplicate,
            commands::db::db_view_create,
            commands::db::db_view_update,
            commands::db::db_view_delete,
            commands::db::db_view_reorder,
            commands::db::db_relation_options,
            commands::db::db_formula_check,
            commands::db::db_import_csv,
            commands::db::db_import_preview,
            commands::db::db_export,
            commands::db::row_secret_reveal,
            // ── Import
            commands::import::import_detect,
            commands::import::import_markdown,
            commands::import::import_notion,
            commands::import::import_ics,
            commands::import::import_undo,
            // ── ICS
            commands::ics::ics_export,
            // ── Markets
            commands::market::market_providers,
            commands::market::market_provider_configure,
            commands::market::market_provider_test,
            commands::market::market_search,
            commands::market::market_quotes,
            commands::market::market_bars,
            commands::market::market_indicators,
            commands::market::market_subscribe,
            commands::market::market_unsubscribe,
            commands::market::watchlist_list,
            commands::market::watchlist_save,
            commands::market::fx_rates,
            // ── Sheets
            commands::sheet::sheet_workbook_create,
            commands::sheet::sheet_workbook_get,
            commands::sheet::sheet_get_range,
            commands::sheet::sheet_get_cell,
            commands::sheet::sheet_set_cells,
            commands::sheet::sheet_set_style,
            commands::sheet::sheet_clear,
            commands::sheet::sheet_insert,
            commands::sheet::sheet_delete_span,
            commands::sheet::sheet_resize,
            commands::sheet::sheet_merge,
            commands::sheet::sheet_freeze,
            commands::sheet::sheet_copy,
            commands::sheet::sheet_paste,
            commands::sheet::sheet_fill,
            commands::sheet::sheet_sort,
            commands::sheet::sheet_find,
            commands::sheet::sheet_replace,
            commands::sheet::sheet_add,
            commands::sheet::sheet_update,
            commands::sheet::sheet_remove,
            commands::sheet::sheet_reorder,
            commands::sheet::sheet_named_range_set,
            commands::sheet::sheet_cond_format_set,
            commands::sheet::sheet_chart_set,
            commands::sheet::sheet_undo,
            commands::sheet::sheet_redo,
            commands::sheet::sheet_eval,
            commands::sheet::sheet_functions,
            commands::sheet::sheet_lint,
            commands::sheet::sheet_import_file,
            commands::sheet::sheet_export,
            commands::sheet::sheet_to_database,
            // ── Life apps
            commands::lifeapp::lifeapp_list,
            commands::lifeapp::lifeapp_manifest,
            commands::lifeapp::lifeapp_recommend,
            commands::lifeapp::lifeapp_preview,
            commands::lifeapp::lifeapp_install,
            commands::lifeapp::lifeapp_instances,
            commands::lifeapp::lifeapp_tuneup_preview,
            commands::lifeapp::lifeapp_tuneup_apply,
            commands::lifeapp::lifeapp_detach,
            commands::lifeapp::lifeapp_uninstall,
            commands::lifeapp::lifeapp_metrics,
            commands::lifeapp::lifeapp_insights,
            commands::lifeapp::lifeapp_insight_mute,
            commands::lifeapp::lifeapp_sample_data,
            commands::lifeapp::lifeapp_checklist_tick,
            // ── Finance
            commands::finance::finance_overview,
            commands::finance::finance_networth_series,
            commands::finance::finance_spending_breakdown,
            commands::finance::finance_cashflow_sankey,
            commands::finance::finance_budget_month,
            commands::finance::finance_budget_assign,
            commands::finance::finance_import_start,
            commands::finance::finance_import_preview,
            commands::finance::finance_import_commit,
            commands::finance::finance_rules_list,
            commands::finance::finance_rule_upsert,
            commands::finance::finance_rule_delete,
            commands::finance::finance_rules_apply,
            commands::finance::finance_recurring_detect,
            commands::finance::finance_recurring_accept,
            commands::finance::finance_debt_plan,
            commands::finance::finance_forecast,
            commands::finance::finance_amortization,
            commands::finance::finance_goal_plan,
            // ── Tax
            commands::tax::tax_packs,
            commands::tax::tax_estimate,
            commands::tax::tax_quarterly_plan,
            // ── Portfolio
            commands::portfolio::portfolio_rebuild,
            commands::portfolio::portfolio_summary,
            commands::portfolio::portfolio_performance,
            commands::portfolio::portfolio_rebalance_plan,
            commands::portfolio::portfolio_dividends,
            commands::portfolio::portfolio_realized,
            // ── Export
            commands::export::export_pages,
            commands::export::export_everything,
            // ── Google and calendars
            commands::google::google_status,
            commands::google::google_set_client,
            commands::google::google_connect,
            commands::google::google_disconnect,
            commands::google::gcal_calendars,
            commands::google::gcal_set_sync,
            commands::google::gcal_sync_now,
            commands::google::calendar_events,
            commands::google::gdocs_import,
            commands::google::gdocs_export,
            commands::google::gsheets_import,
            commands::google::gsheets_export,
            // ── END DOMAIN COMMANDS ───────────────────────────────────────────────────────────────────────────
        ]);

    let app = match builder.build(context) {
        Ok(app) => app,
        Err(e) => {
            tracing::error!(error = %e, "failed to start");
            eprintln!("EMP failed to start: {e}");
            std::process::exit(1);
        }
    };
    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            on_exit(handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn isolation_origin_per_platform() {
        assert_eq!(
            isolation_frame_origin("isolation-abc", false),
            "isolation-abc:"
        );
        assert_eq!(
            isolation_frame_origin("isolation-abc", true),
            "http://isolation-abc.localhost"
        );
    }

    #[test]
    fn frame_src_only_allows_isolation() {
        let mut map = HashMap::new();
        map.insert(
            "frame-src".to_owned(),
            CspDirectiveSources::Inline("'none'".into()),
        );
        map.insert(
            "child-src".to_owned(),
            CspDirectiveSources::Inline("'none'".into()),
        );
        let mut csp = Some(Csp::DirectiveMap(map));
        allow_isolation_frame(&mut csp, "isolation-x:");
        let s = csp.unwrap().to_string();
        assert!(s.contains("frame-src isolation-x:"), "{s}");
        assert!(s.contains("child-src 'none'"), "{s}");
        assert!(!s.contains("frame-src 'none'"), "{s}");
    }

    #[test]
    fn release_config_matches_spec() {
        let raw = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/tauri.conf.json"))
            .unwrap();
        let v: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(v["productName"], "EMP");
        assert_eq!(v["identifier"], "com.devartin.emp");
        let w = &v["app"]["windows"][0];
        assert_eq!(w["title"], "EMP");
        assert_eq!(
            (w["width"].as_u64(), w["height"].as_u64()),
            (Some(1280), Some(820))
        );
        assert_eq!(
            (w["minWidth"].as_u64(), w["minHeight"].as_u64()),
            (Some(800), Some(560))
        );
        let sec = &v["app"]["security"];
        assert_eq!(sec["pattern"]["use"], "isolation");
        assert_eq!(sec["freezePrototype"], true);
        assert_eq!(sec["assetProtocol"]["enable"], false);
        let csp = sec["csp"].to_string();
        assert!(
            !csp.contains("localhost:"),
            "release CSP must not contain dev origins"
        );
        assert!(!csp.contains("unsafe-eval"));
        assert_eq!(sec["csp"]["script-src"], "'self'");
        assert_eq!(sec["csp"]["connect-src"], "ipc: http://ipc.localhost");
        assert_eq!(v["bundle"]["macOS"]["minimumSystemVersion"], "12.0");
        let targets: Vec<&str> = v["bundle"]["targets"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|t| t.as_str())
            .collect();
        for t in ["app", "dmg", "nsis", "msi", "deb", "rpm", "appimage"] {
            assert!(targets.contains(&t), "{t}");
        }
    }
}

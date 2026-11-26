//! Search commands (SPEC §11.3 "Search"). The index is built in memory after unlock and never persisted.

use emp_store::model::{SearchFilters, SearchQueryResult, SearchStatus};
use serde::Deserialize;
use tauri::{AppHandle, Manager, State, Webview};

use super::vault::JobOnlyReq;
use super::{Empty, job_sink};
use crate::error::ApiResult;
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// Most hits per query.
pub const MAX_HITS: usize = 200;

/// `search_query` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SearchQueryReq {
    q: String,
    #[serde(default)]
    filters: Option<SearchFilters>,
    limit: u32,
    req_id: u64,
}

fn check_filters(f: &SearchFilters) -> ApiResult<()> {
    validate::opt_id("filters.in", f.within.as_deref())?;
    validate::opt_id("filters.db", f.db.as_deref())?;
    if let Some(k) = &f.kinds {
        validate::list_len("filters.type", k.len(), 16)?;
    }
    if let Some(e) = &f.edited {
        if let Some(t) = e.from {
            validate::ts("filters.edited.from", t)?;
        }
        if let Some(t) = e.to {
            validate::ts("filters.edited.to", t)?;
        }
    }
    Ok(())
}

/// `search_query({ q, filters?, limit, reqId }) → { reqId, hits, indexReady, tookMs }`. Also parses
/// `in:` / `type:` / `db:` / `edited:` operators inside `q`.
#[tauri::command]
pub async fn search_query(app: AppHandle, req: SearchQueryReq) -> ApiResult<SearchQueryResult> {
    validate::query("q", &req.q)?;
    let limit = validate::limit("limit", req.limit, MAX_HITS)?;
    if let Some(f) = &req.filters {
        check_filters(f)?;
    }
    blocking(move || {
        Ok(app.state::<AppState>().session()?.search_query(
            &req.q,
            req.filters.as_ref(),
            limit,
            req.req_id,
        )?)
    })
    .await
}

/// `search_status({}) → { ready, docs, building, progress? }`.
#[tauri::command]
pub async fn search_status(app: AppHandle, req: Empty) -> ApiResult<SearchStatus> {
    let _ = req;
    blocking(move || Ok(app.state::<AppState>().session()?.search_status()?)).await
}

/// `search_reindex({ onEvent })` (job) ⇒ `void`.
#[tauri::command]
pub async fn search_reindex(
    webview: Webview,
    state: State<'_, AppState>,
    req: JobOnlyReq,
) -> ApiResult<JobRef> {
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    Ok(state
        .jobs
        .spawn("search_reindex", true, now, sink, move |ctx| {
            store.search_reindex(ctx)?;
            Ok(())
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn query_request_shape() {
        let r: SearchQueryReq = serde_json::from_value(serde_json::json!({
            "q": "budget in:abc", "limit": 20, "reqId": 7
        }))
        .unwrap();
        assert_eq!(r.req_id, 7);
        assert!(
            serde_json::from_value::<SearchQueryReq>(serde_json::json!({
                "q": "x", "limit": 20, "reqId": 7, "sql": "drop"
            }))
            .is_err()
        );
    }
}

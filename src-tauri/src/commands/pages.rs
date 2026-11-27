//! Pages and docs commands (SPEC §11.3 "Pages and docs").

use emp_store::model::{
    Backlink, DocOwnerKind, Icon, OutlineItem, PageCreate, PageCreated, PageFlags, PageGet,
    PageKind, PageMeta, PageMetaPatch, TemplateInfo, TipTapDoc, TipTapNode,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State, Webview};

use super::job_sink;
use super::workspaces::{IdReq, check_icon};
use crate::error::{ApiError, ApiResult};
use crate::jobs::JobRef;
use crate::state::{AppState, blocking};
use crate::validate;

/// `page_get({ id }) → { meta, doc, docRev, breadcrumbs }`.
#[tauri::command]
pub async fn page_get(app: AppHandle, req: IdReq) -> ApiResult<PageGet> {
    validate::id("id", &req.id)?;
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let got = store.page_get(&req.id)?;
        if let Err(e) = store.workspace_touch_recent(&got.meta.workspace_id, &got.meta.id) {
            tracing::debug!(code = e.code(), "recents not updated");
        }
        Ok(got)
    })
    .await
}

/// An `{ ids }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IdsReq {
    ids: Vec<String>,
}

/// `page_get_meta({ ids }) → PageMeta[]`.
#[tauri::command]
pub async fn page_get_meta(app: AppHandle, req: IdsReq) -> ApiResult<Vec<PageMeta>> {
    validate::ids("ids", &req.ids, true)?;
    blocking(move || Ok(app.state::<AppState>().session()?.page_get_meta(&req.ids)?)).await
}

/// `page_create` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PageCreateReq {
    workspace_id: String,
    parent_id: Option<String>,
    kind: CreateKind,
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    icon: Option<Icon>,
    #[serde(default)]
    after_id: Option<String>,
    #[serde(default)]
    template_page_id: Option<String>,
    #[serde(default)]
    doc: Option<TipTapDoc>,
    /// Initial flags, e.g. `{ project: true }` (Ultranote 1.0 brief §3).
    #[serde(default)]
    flags: Option<PageFlags>,
}

/// Page kinds `page_create` may create (databases, sheets and apps have their own commands).
#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CreateKind {
    /// A document page.
    Doc,
    /// A dashboard page.
    Dashboard,
}

/// `page_create({ workspaceId, parentId, kind: 'doc'|'dashboard', title?, icon?, afterId?, templatePageId?, doc?, flags? })
/// → { meta, docRev }`.
#[tauri::command]
pub async fn page_create(app: AppHandle, req: PageCreateReq) -> ApiResult<PageCreated> {
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    validate::opt_id("afterId", req.after_id.as_deref())?;
    validate::opt_id("templatePageId", req.template_page_id.as_deref())?;
    if let Some(t) = &req.title {
        validate::title("title", t)?;
    }
    if let Some(i) = &req.icon {
        check_icon("icon", i)?;
    }
    let kind = match req.kind {
        CreateKind::Doc => PageKind::Doc,
        CreateKind::Dashboard => PageKind::Dashboard,
    };
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        Ok(store.page_create(PageCreate {
            workspace_id: req.workspace_id,
            parent_id: req.parent_id,
            kind,
            title: req.title,
            icon: req.icon,
            after_id: req.after_id,
            template_page_id: req.template_page_id,
            doc: req.doc,
            flags: req.flags,
        })?)
    })
    .await
}

/// `page_update_meta` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateMetaReq {
    id: String,
    patch: PageMetaPatch,
}

/// `page_update_meta({ id, patch: { title?, icon?, cover?, flags? } }) → PageMeta`.
#[tauri::command]
pub async fn page_update_meta(app: AppHandle, req: UpdateMetaReq) -> ApiResult<PageMeta> {
    validate::id("id", &req.id)?;
    if let Some(t) = &req.patch.title {
        validate::title("patch.title", t)?;
    }
    if let Some(Some(i)) = &req.patch.icon {
        check_icon("patch.icon", i)?;
    }
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .page_update_meta(&req.id, req.patch)?)
    })
    .await
}

/// `page_save_doc` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SaveDocReq {
    owner_id: String,
    owner_kind: DocOwnerKind,
    doc: TipTapDoc,
    base_rev: i64,
}

/// A `{ rev }` result.
#[derive(Debug, Serialize)]
pub struct RevDto {
    /// The new revision.
    pub rev: i64,
}

/// `page_save_doc({ ownerId, ownerKind, doc, baseRev }) → { rev }`: `CONFLICT { currentRev }` on a stale base.
#[tauri::command]
pub async fn page_save_doc(app: AppHandle, req: SaveDocReq) -> ApiResult<RevDto> {
    validate::id("ownerId", &req.owner_id)?;
    if req.base_rev < 0 {
        return Err(ApiError::invalid("baseRev", "must not be negative"));
    }
    blocking(move || {
        let store = app.state::<AppState>().session()?;
        let rev = store.page_save_doc(&req.owner_id, req.owner_kind, req.doc, req.base_rev)?;
        Ok(RevDto { rev })
    })
    .await
}

/// `page_move` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MoveReq {
    id: String,
    parent_id: Option<String>,
    #[serde(default)]
    before_id: Option<String>,
    #[serde(default)]
    after_id: Option<String>,
}

/// `page_move({ id, parentId, beforeId?, afterId? }) → PageMeta` (cycle-checked in the store).
#[tauri::command]
pub async fn page_move(app: AppHandle, req: MoveReq) -> ApiResult<PageMeta> {
    validate::id("id", &req.id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    validate::opt_id("beforeId", req.before_id.as_deref())?;
    validate::opt_id("afterId", req.after_id.as_deref())?;
    if req.parent_id.as_deref() == Some(req.id.as_str()) {
        return Err(ApiError::invalid(
            "parentId",
            "a page cannot contain itself",
        ));
    }
    blocking(move || {
        Ok(app.state::<AppState>().session()?.page_move(
            &req.id,
            req.parent_id.as_deref(),
            req.before_id.as_deref(),
            req.after_id.as_deref(),
        )?)
    })
    .await
}

/// `page_duplicate` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DuplicateReq {
    id: String,
    deep: bool,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `page_duplicate({ id, deep, onEvent })` (job) ⇒ `PageMeta`.
#[tauri::command]
pub async fn page_duplicate(
    webview: Webview,
    state: State<'_, AppState>,
    req: DuplicateReq,
) -> ApiResult<JobRef> {
    validate::id("id", &req.id)?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    Ok(state
        .jobs
        .spawn("page_duplicate", false, now, sink, move |ctx| {
            ctx.report(0, 1, Some("pages"));
            let meta = store.page_duplicate(&req.id, req.deep)?;
            ctx.report(1, 1, Some("pages"));
            Ok(meta)
        }))
}

/// `page_turn_into_page` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnIntoPageReq {
    source_id: String,
    block_ids: Vec<String>,
    title: String,
}

/// `page_turn_into_page` result.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnedIntoPage {
    meta: PageMeta,
    new_source_rev: i64,
}

/// `page_turn_into_page({ sourceId, blockIds, title }) → { meta, newSourceRev }`.
#[tauri::command]
pub async fn page_turn_into_page(
    app: AppHandle,
    req: TurnIntoPageReq,
) -> ApiResult<TurnedIntoPage> {
    validate::id("sourceId", &req.source_id)?;
    validate::title("title", &req.title)?;
    if req.block_ids.is_empty() {
        return Err(ApiError::invalid("blockIds", "must not be empty"));
    }
    validate::list_len("blockIds", req.block_ids.len(), 10_000)?;
    for b in &req.block_ids {
        validate::block_id("blockIds", b)?;
    }
    blocking(move || {
        let (meta, new_source_rev) = app.state::<AppState>().session()?.page_turn_into_page(
            &req.source_id,
            &req.block_ids,
            &req.title,
        )?;
        Ok(TurnedIntoPage {
            meta,
            new_source_rev,
        })
    })
    .await
}

/// `page_delete({ ids })`: moves pages (and their subtrees) to the trash.
#[tauri::command]
pub async fn page_delete(app: AppHandle, req: IdsReq) -> ApiResult<()> {
    validate::ids("ids", &req.ids, false)?;
    blocking(move || Ok(app.state::<AppState>().session()?.page_delete(&req.ids)?)).await
}

/// `page_restore({ ids }) → PageMeta[]`: restores to the root if the parent is gone.
#[tauri::command]
pub async fn page_restore(app: AppHandle, req: IdsReq) -> ApiResult<Vec<PageMeta>> {
    validate::ids("ids", &req.ids, false)?;
    blocking(move || Ok(app.state::<AppState>().session()?.page_restore(&req.ids)?)).await
}

/// `page_purge({ ids })`: deletes trashed pages permanently.
#[tauri::command]
pub async fn page_purge(app: AppHandle, req: IdsReq) -> ApiResult<()> {
    validate::ids("ids", &req.ids, false)?;
    blocking(move || Ok(app.state::<AppState>().session()?.page_purge(&req.ids)?)).await
}

/// `trash_list` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashListReq {
    workspace_id: String,
    #[serde(default)]
    q: Option<String>,
}

/// `trash_list({ workspaceId, q? }) → PageMeta[]`.
#[tauri::command]
pub async fn trash_list(app: AppHandle, req: TrashListReq) -> ApiResult<Vec<PageMeta>> {
    validate::id("workspaceId", &req.workspace_id)?;
    if let Some(q) = &req.q {
        validate::query("q", q)?;
    }
    blocking(move || {
        Ok(app.state::<AppState>().session()?.trash_list(
            &req.workspace_id,
            req.q.as_deref().filter(|q| !q.trim().is_empty()),
        )?)
    })
    .await
}

/// `trash_empty` request.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TrashEmptyReq {
    workspace_id: String,
    on_event: tauri::ipc::JavaScriptChannelId,
}

/// `trash_empty({ workspaceId, onEvent })` (job) ⇒ `{ purged }`.
#[tauri::command]
pub async fn trash_empty(
    webview: Webview,
    state: State<'_, AppState>,
    req: TrashEmptyReq,
) -> ApiResult<JobRef> {
    validate::id("workspaceId", &req.workspace_id)?;
    let store = state.session()?;
    let sink = job_sink(&webview, &req.on_event);
    let now = store.now();
    Ok(state
        .jobs
        .spawn("trash_empty", true, now, sink, move |ctx| {
            let purged = store.trash_empty(&req.workspace_id, ctx)?;
            Ok(serde_json::json!({ "purged": purged }))
        }))
}

/// `page_backlinks({ id }) → { sourceId, sourceTitle, sourceIcon?, blockId?, snippet }[]`.
#[tauri::command]
pub async fn page_backlinks(app: AppHandle, req: IdReq) -> ApiResult<Vec<Backlink>> {
    validate::id("id", &req.id)?;
    blocking(move || Ok(app.state::<AppState>().session()?.page_backlinks(&req.id)?)).await
}

/// `page_outline({ id }) → { blockId, level, text }[]`.
#[tauri::command]
pub async fn page_outline(app: AppHandle, req: IdReq) -> ApiResult<Vec<OutlineItem>> {
    validate::id("id", &req.id)?;
    blocking(move || Ok(app.state::<AppState>().session()?.page_outline(&req.id)?)).await
}

/// `page_get_block` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GetBlockReq {
    page_id: String,
    block_id: String,
}

/// `page_get_block` result.
#[derive(Debug, Serialize)]
pub struct BlockDto {
    node: TipTapNode,
}

/// `page_get_block({ pageId, blockId }) → { node } | null`.
#[tauri::command]
pub async fn page_get_block(app: AppHandle, req: GetBlockReq) -> ApiResult<Option<BlockDto>> {
    validate::id("pageId", &req.page_id)?;
    validate::block_id("blockId", &req.block_id)?;
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .page_get_block(&req.page_id, &req.block_id)?
            .map(|node| BlockDto { node }))
    })
    .await
}

/// A `{ workspaceId }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceReq {
    workspace_id: String,
}

/// `template_list({ workspaceId }) → { id, title, icon?, builtin, category, kind }[]`.
#[tauri::command]
pub async fn template_list(app: AppHandle, req: WorkspaceReq) -> ApiResult<Vec<TemplateInfo>> {
    validate::id("workspaceId", &req.workspace_id)?;
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .template_list(&req.workspace_id)?)
    })
    .await
}

/// `template_apply` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TemplateApplyReq {
    template_id: String,
    workspace_id: String,
    parent_id: Option<String>,
}

/// `template_apply({ templateId, workspaceId, parentId }) → PageMeta`.
#[tauri::command]
pub async fn template_apply(app: AppHandle, req: TemplateApplyReq) -> ApiResult<PageMeta> {
    validate::id("templateId", &req.template_id)?;
    validate::id("workspaceId", &req.workspace_id)?;
    validate::opt_id("parentId", req.parent_id.as_deref())?;
    blocking(move || {
        Ok(app.state::<AppState>().session()?.template_apply(
            &req.template_id,
            &req.workspace_id,
            req.parent_id.as_deref(),
        )?)
    })
    .await
}

/// `page_set_template` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SetTemplateReq {
    id: String,
    template: bool,
}

/// `page_set_template({ id, template }) → PageMeta`.
#[tauri::command]
pub async fn page_set_template(app: AppHandle, req: SetTemplateReq) -> ApiResult<PageMeta> {
    validate::id("id", &req.id)?;
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .page_set_template(&req.id, req.template)?)
    })
    .await
}

/// `daily_note_open` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DailyNoteReq {
    date: String,
}

/// `daily_note_open({ date: 'YYYY-MM-DD' }) → PageMeta` (created from the template if missing).
#[tauri::command]
pub async fn daily_note_open(app: AppHandle, req: DailyNoteReq) -> ApiResult<PageMeta> {
    validate::ymd("date", &req.date)?;
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .daily_note_open(&req.date)?)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_only_allows_doc_and_dashboard() {
        let base =
            |kind: &str| serde_json::json!({ "workspaceId": "w", "parentId": null, "kind": kind });
        assert!(serde_json::from_value::<PageCreateReq>(base("doc")).is_ok());
        assert!(serde_json::from_value::<PageCreateReq>(base("dashboard")).is_ok());
        assert!(serde_json::from_value::<PageCreateReq>(base("database")).is_err());
        assert!(serde_json::from_value::<PageCreateReq>(base("sheet")).is_err());
    }
}

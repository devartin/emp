//! Reminders and jobs commands (SPEC §11.3 "Reminders and jobs"). Reminders fire only while the app runs (v1); the
//! scheduler tick lives in `crate::background`.

use emp_store::repo::reminders::{Reminder, ReminderUpsert};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use super::Empty;
use crate::error::{ApiError, ApiResult};
use crate::jobs::JobInfo;
use crate::state::{AppState, blocking};
use crate::validate;

/// `reminder_list` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderListReq {
    from: i64,
    to: i64,
}

/// `reminder_list({ from, to }) → { id, fireAt, targetKind, targetId, text, fired }[]`.
#[tauri::command]
pub async fn reminder_list(app: AppHandle, req: ReminderListReq) -> ApiResult<Vec<Reminder>> {
    validate::ts("from", req.from)?;
    validate::ts("to", req.to)?;
    if req.to < req.from {
        return Err(ApiError::invalid("to", "must not be before from"));
    }
    blocking(move || {
        let mut list = app
            .state::<AppState>()
            .session()?
            .reminder_list(req.from, req.to)?;
        list.truncate(validate::MAX_LIST);
        Ok(list)
    })
    .await
}

/// `reminder_upsert` result.
#[derive(Debug, Serialize)]
pub struct IdDto {
    id: String,
}

/// `reminder_upsert({ id?, fireAt, targetKind, targetId, blockId?, text }) → { id }`.
#[tauri::command]
pub async fn reminder_upsert(app: AppHandle, req: ReminderUpsert) -> ApiResult<IdDto> {
    validate::opt_id("id", req.id.as_deref())?;
    validate::ts("fireAt", req.fire_at)?;
    validate::id("targetId", &req.target_id)?;
    if let Some(b) = &req.block_id {
        validate::block_id("blockId", b)?;
    }
    validate::bounded("text", &req.text, validate::MAX_TITLE)?;
    blocking(move || {
        let id = app.state::<AppState>().session()?.reminder_upsert(req)?;
        Ok(IdDto { id })
    })
    .await
}

/// An `{ id }` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReminderIdReq {
    id: String,
}

/// `reminder_delete({ id })`.
#[tauri::command]
pub async fn reminder_delete(app: AppHandle, req: ReminderIdReq) -> ApiResult<()> {
    validate::id("id", &req.id)?;
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .reminder_delete(&req.id)?)
    })
    .await
}

/// `reminder_snooze` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnoozeReq {
    id: String,
    minutes: u32,
}

/// The snooze options of §11.3.
pub const SNOOZE_MINUTES: [u32; 4] = [5, 15, 60, 1440];

/// `reminder_snooze({ id, minutes: 5|15|60|1440 })`.
#[tauri::command]
pub async fn reminder_snooze(app: AppHandle, req: SnoozeReq) -> ApiResult<()> {
    validate::id("id", &req.id)?;
    if !SNOOZE_MINUTES.contains(&req.minutes) {
        return Err(ApiError::invalid("minutes", "must be 5, 15, 60 or 1440"));
    }
    blocking(move || {
        Ok(app
            .state::<AppState>()
            .session()?
            .reminder_snooze(&req.id, req.minutes)?)
    })
    .await
}

/// `job_list({}) → { jobId, kind, done, total, startedAt, cancellable }[]`.
#[tauri::command]
pub async fn job_list(state: State<'_, AppState>, req: Empty) -> ApiResult<Vec<JobInfo>> {
    let _ = req;
    Ok(state.jobs.list())
}

/// `job_cancel` request.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct JobCancelReq {
    job_id: String,
}

/// `job_cancel({ jobId })`.
#[tauri::command]
pub async fn job_cancel(state: State<'_, AppState>, req: JobCancelReq) -> ApiResult<()> {
    validate::id("jobId", &req.job_id)?;
    state.jobs.cancel(&req.job_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snooze_options() {
        assert!(SNOOZE_MINUTES.contains(&15));
        assert!(!SNOOZE_MINUTES.contains(&10));
    }
}

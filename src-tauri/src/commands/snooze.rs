//! Snooze + mute commands. Snooze flips INBOX off and records a row in
//! the `snoozes` table; the timer in lib.rs scans for fire-due entries
//! and calls `unsnooze_now`. Mute applies an analogous "archive every
//! message in this thread now and on future delivery" rule via the
//! muted_threads table.

use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::gmail;

use super::auth::with_token;
use super::{update_message_labels, AppState};

#[tauri::command]
pub async fn snooze_message(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    message_id: String,
    fire_at_ms: i64,
) -> Result<(), String> {
    let labels = with_token(&state, &email, |http, token| {
        let mid = message_id.clone();
        Box::pin(async move {
            gmail::messages::modify_labels(http, token, &mid, &[], &["INBOX"]).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, error = %format!("{e:#}"), "snooze: modify failed");
        format!("{e:#}")
    })?;
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO snoozes (account_email, message_id, fire_at_ms)
             VALUES (?1, ?2, ?3)",
            params![email, message_id, fire_at_ms],
        )
        .map_err(|e| e.to_string())?;
    }
    update_message_labels(&state.db, &email, &message_id, &labels)?;
    let _ = app.emit("messages:changed", &message_id);
    Ok(())
}

#[tauri::command]
pub async fn unsnooze_message(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    message_id: String,
) -> Result<(), String> {
    let labels = with_token(&state, &email, |http, token| {
        let mid = message_id.clone();
        Box::pin(async move {
            gmail::messages::modify_labels(http, token, &mid, &["INBOX"], &[]).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, error = %format!("{e:#}"), "unsnooze: modify failed");
        format!("{e:#}")
    })?;
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM snoozes WHERE account_email = ?1 AND message_id = ?2",
            params![email, message_id],
        )
        .map_err(|e| e.to_string())?;
    }
    update_message_labels(&state.db, &email, &message_id, &labels)?;
    let _ = app.emit("messages:changed", &message_id);
    Ok(())
}

#[derive(Debug, Serialize, Clone)]
pub struct SnoozedRow {
    pub message_id: String,
    pub account_email: String,
    pub fire_at_ms: i64,
}

#[tauri::command]
pub fn list_snoozed(
    state: State<'_, AppState>,
    email: Option<String>,
) -> Result<Vec<SnoozedRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let sql = match email.as_deref() {
        Some(_) => "SELECT message_id, account_email, fire_at_ms FROM snoozes
                    WHERE account_email = ?1 ORDER BY fire_at_ms ASC",
        None => "SELECT message_id, account_email, fire_at_ms FROM snoozes
                 ORDER BY fire_at_ms ASC",
    };
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let map_row = |r: &rusqlite::Row| {
        Ok(SnoozedRow {
            message_id: r.get(0)?,
            account_email: r.get(1)?,
            fire_at_ms: r.get(2)?,
        })
    };
    let rows: Vec<SnoozedRow> = if let Some(e) = email {
        stmt.query_map(params![e], map_row)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect()
    } else {
        stmt.query_map([], map_row)
            .map_err(|e| e.to_string())?
            .filter_map(Result::ok)
            .collect()
    };
    Ok(rows)
}

#[tauri::command]
pub async fn mute_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    thread_id: String,
) -> Result<(), String> {
    // Pull every cached message_id in the thread that still sits in Inbox.
    let ids: Vec<String> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id FROM messages
                 WHERE account_email = ?1 AND thread_id = ?2",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![email, thread_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // Record the mute first so concurrent sync hooks also apply it.
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO muted_threads (account_email, thread_id, muted_at_ms)
             VALUES (?1, ?2, ?3)",
            params![email, thread_id, Utc::now().timestamp_millis()],
        )
        .map_err(|e| e.to_string())?;
    }

    for id in ids {
        let labels = with_token(&state, &email, |http, token| {
            let mid = id.clone();
            Box::pin(async move {
                gmail::messages::modify_labels(http, token, &mid, &[], &["INBOX"]).await
            })
        })
        .await
        .map_err(|e| {
            tracing::error!(%email, %id, error = %format!("{e:#}"), "mute: archive failed");
            format!("{e:#}")
        })?;
        update_message_labels(&state.db, &email, &id, &labels)?;
    }
    let _ = app.emit("messages:changed", &thread_id);
    Ok(())
}

#[tauri::command]
pub fn unmute_thread(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    thread_id: String,
) -> Result<(), String> {
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "DELETE FROM muted_threads WHERE account_email = ?1 AND thread_id = ?2",
            params![email, thread_id],
        )
        .map_err(|e| e.to_string())?;
    }
    let _ = app.emit("messages:changed", &thread_id);
    Ok(())
}

/// Called from the snooze timer in lib.rs. Returns INBOX to a snoozed
/// message and removes the snooze row. Uses anyhow::Result instead of
/// String so it plays nice with the timer plumbing.
pub async fn unsnooze_now(
    state: &AppState,
    email: &str,
    message_id: &str,
) -> anyhow::Result<()> {
    let labels = with_token(state, email, |http, token| {
        let mid = message_id.to_string();
        Box::pin(async move {
            gmail::messages::modify_labels(http, token, &mid, &["INBOX"], &[]).await
        })
    })
    .await?;
    {
        let conn = state
            .db
            .lock()
            .map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
        conn.execute(
            "DELETE FROM snoozes WHERE account_email = ?1 AND message_id = ?2",
            params![email, message_id],
        )?;
    }
    update_message_labels(&state.db, email, message_id, &labels)
        .map_err(|e| anyhow::anyhow!("{e}"))?;
    Ok(())
}

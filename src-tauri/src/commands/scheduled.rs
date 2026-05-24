//! Scheduled-send commands. schedule_send writes to scheduled_sends;
//! the timer in lib.rs scans for fire-due rows and calls into
//! commands::fire_scheduled_send. list/cancel give the UI a way to
//! inspect and prune the pending queue.

use chrono::Utc;
use rusqlite::params;
use serde::Serialize;
use tauri::State;

use super::compose::SendRequest;
use super::AppState;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleSendRequest {
    pub fire_at_ms: i64,
    #[serde(flatten)]
    pub send: SendRequest,
}

#[tauri::command]
pub async fn schedule_send(
    state: State<'_, AppState>,
    request: ScheduleSendRequest,
) -> Result<String, String> {
    let id = format!("sch_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0));
    let payload = serde_json::to_string(&serde_json::json!(request.send))
        .map_err(|e| e.to_string())?;
    let account_email = request.send.from_account.clone();
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO scheduled_sends
             (id, account_email, payload_json, fire_at_ms, created_at, sent)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![
                id,
                account_email,
                payload,
                request.fire_at_ms,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(id)
}

#[derive(Debug, Serialize, Clone)]
pub struct ScheduledRow {
    pub id: String,
    pub account_email: String,
    pub fire_at_ms: i64,
    pub subject: String,
    pub to: String,
}

#[tauri::command]
pub fn list_scheduled(state: State<'_, AppState>) -> Result<Vec<ScheduledRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT id, account_email, fire_at_ms, payload_json FROM scheduled_sends
             WHERE sent = 0 ORDER BY fire_at_ms ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let account: String = r.get(1)?;
            let fire: i64 = r.get(2)?;
            let payload: String = r.get(3)?;
            Ok((id, account, fire, payload))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        let (id, account, fire, payload) = r;
        let subject = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| v.get("subject").and_then(|s| s.as_str().map(String::from)))
            .unwrap_or_default();
        let to = serde_json::from_str::<serde_json::Value>(&payload)
            .ok()
            .and_then(|v| {
                v.get("to").and_then(|arr| arr.as_array()).map(|arr| {
                    arr.iter()
                        .filter_map(|x| x.as_str())
                        .collect::<Vec<_>>()
                        .join(", ")
                })
            })
            .unwrap_or_default();
        out.push(ScheduledRow {
            id,
            account_email: account,
            fire_at_ms: fire,
            subject,
            to,
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn cancel_scheduled(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM scheduled_sends WHERE id = ?1 AND sent = 0",
        params![id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

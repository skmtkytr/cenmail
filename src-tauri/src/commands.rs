use chrono::Utc;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

use crate::{config::OAuthConfig, oauth, secret};

pub struct AppState {
    pub db: Mutex<Connection>,
    pub oauth_config: OAuthConfig,
}

#[derive(Debug, Serialize, Clone)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub display_name: Option<String>,
    pub provider: String,
    pub created_at: String,
}

#[tauri::command]
pub async fn add_account(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Account, String> {
    let oauth_config = state.oauth_config.clone();
    let result = oauth::run_flow(&oauth_config, &app).await.map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "oauth flow failed");
        format!("{e:#}")
    })?;

    secret::save_refresh_token(&result.email, &result.refresh_token).map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "save refresh token failed");
        format!("save refresh token: {e:#}")
    })?;

    let now = Utc::now().to_rfc3339();
    let account = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO accounts (email, display_name, provider, created_at)
             VALUES (?1, ?2, 'gmail', ?3)
             ON CONFLICT(email) DO UPDATE SET display_name = excluded.display_name",
            params![result.email, result.display_name, now],
        )
        .map_err(|e| format!("db insert: {e}"))?;
        load_account_by_email(&conn, &result.email).map_err(|e| e.to_string())?
    };

    app.emit("accounts:changed", &account).ok();
    Ok(account)
}

#[tauri::command]
pub fn list_accounts(state: State<'_, AppState>) -> Result<Vec<Account>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT id, email, display_name, provider, created_at FROM accounts ORDER BY id")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Account {
                id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                provider: r.get(3)?,
                created_at: r.get(4)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn remove_account(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let email: Option<String> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let email = conn
            .query_row(
                "SELECT email FROM accounts WHERE id = ?1",
                params![id],
                |r| r.get::<_, String>(0),
            )
            .ok();
        conn.execute("DELETE FROM accounts WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        email
    };
    if let Some(email) = email {
        if let Err(e) = secret::delete_refresh_token(&email) {
            tracing::warn!(%email, error = %e, "failed to remove keyring entry");
        }
    }
    app.emit("accounts:changed", id).ok();
    Ok(())
}

fn load_account_by_email(conn: &Connection, email: &str) -> rusqlite::Result<Account> {
    conn.query_row(
        "SELECT id, email, display_name, provider, created_at FROM accounts WHERE email = ?1",
        params![email],
        |r| {
            Ok(Account {
                id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                provider: r.get(3)?,
                created_at: r.get(4)?,
            })
        },
    )
}

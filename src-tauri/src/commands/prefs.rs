//! Runtime preferences the backend must read while the GUI window (and its
//! `localStorage`) may be closed. The frontend mirrors the notification-
//! relevant subset of its settings here through `set_runtime_prefs` so the
//! background timer can fire notifications without a live webview.

use std::collections::HashMap;
use std::sync::atomic::Ordering;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::State;

use super::AppState;

fn default_true() -> bool {
    true
}

fn default_buckets() -> Vec<String> {
    vec!["personal".to_string()]
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NotificationPrefs {
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_buckets")]
    pub buckets: Vec<String>,
    /// Per-account override; missing key means "on" (matches the frontend's
    /// `notificationsEnabledFor`).
    #[serde(default)]
    pub per_account: HashMap<String, bool>,
}

impl Default for NotificationPrefs {
    fn default() -> Self {
        Self {
            enabled: true,
            buckets: default_buckets(),
            per_account: HashMap::new(),
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RuntimePrefs {
    #[serde(default)]
    pub notifications: NotificationPrefs,
    #[serde(default = "default_true")]
    pub close_to_tray: bool,
}

impl Default for RuntimePrefs {
    fn default() -> Self {
        Self {
            notifications: NotificationPrefs::default(),
            close_to_tray: true,
        }
    }
}

impl NotificationPrefs {
    /// Whether a message in `bucket` from `email` should raise a notification.
    /// Mirrors `notificationsEnabledFor` in `src/settings.ts`.
    pub fn allows(&self, email: &str, bucket: &str) -> bool {
        if !self.enabled {
            return false;
        }
        if !self.buckets.iter().any(|b| b == bucket) {
            return false;
        }
        self.per_account.get(email).copied().unwrap_or(true)
    }
}

const RUNTIME_PREFS_KEY: &str = "runtime_prefs";

/// Read the persisted runtime prefs, falling back to defaults when nothing has
/// been written yet (fresh install, or GUI never opened).
pub fn load_runtime_prefs(conn: &Connection) -> RuntimePrefs {
    let raw: Option<String> = conn
        .query_row(
            "SELECT value FROM app_settings WHERE key = ?1",
            params![RUNTIME_PREFS_KEY],
            |r| r.get(0),
        )
        .optional()
        .ok()
        .flatten();
    raw.and_then(|j| serde_json::from_str(&j).ok())
        .unwrap_or_default()
}

/// Persist the runtime prefs pushed from the frontend and update the live
/// `close_to_tray` flag the window-close handler consults.
#[tauri::command]
pub fn set_runtime_prefs(state: State<'_, AppState>, prefs: RuntimePrefs) -> Result<(), String> {
    let json = serde_json::to_string(&prefs).map_err(|e| e.to_string())?;
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO app_settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![RUNTIME_PREFS_KEY, json],
        )
        .map_err(|e| e.to_string())?;
    }
    state
        .close_to_tray
        .store(prefs.close_to_tray, Ordering::Relaxed);
    Ok(())
}

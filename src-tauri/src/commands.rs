use chrono::{TimeZone, Utc};
use futures::stream::{self, StreamExt};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, State};

use crate::{
    config::OAuthConfig,
    gcal,
    gmail::{
        self,
        auth::TokenCache,
        compose::Compose,
        messages::{MessageDetail, MessageMeta},
    },
    oauth, secret,
};

const SYNC_PARALLEL: usize = 8;
const SYNC_BATCH: usize = 100;
const SYNC_PROGRESS_EVERY: usize = 50;
const AUTH_RETRY_DELAY: Duration = Duration::from_millis(500);
const RATE_LIMIT_BASE_DELAY: Duration = Duration::from_millis(800);

pub struct AppState {
    pub db: Mutex<Connection>,
    pub oauth_config: OAuthConfig,
    pub token_cache: Arc<TokenCache>,
    pub http: reqwest::Client,
    /// Per-account wall-clock of the last successful sync. Consulted by the
    /// background timer to decide whether an account is overdue for an
    /// incremental sync.
    pub last_sync_at: Mutex<HashMap<String, Instant>>,
}

#[derive(Debug, Serialize, Clone)]
pub struct Account {
    pub id: i64,
    pub email: String,
    pub display_name: Option<String>,
    pub picture_url: Option<String>,
    pub provider: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncProgress {
    pub email: String,
    pub fetched: usize,
    pub total: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncDone {
    pub email: String,
    pub total: usize,
}

#[derive(Debug, Serialize, Clone)]
pub struct SyncError {
    pub email: String,
    pub error: String,
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
            "INSERT INTO accounts (email, display_name, picture_url, provider, created_at)
             VALUES (?1, ?2, ?3, 'gmail', ?4)
             ON CONFLICT(email) DO UPDATE SET
                display_name = excluded.display_name,
                picture_url  = excluded.picture_url",
            params![result.email, result.display_name, result.picture_url, now],
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
        .prepare(
            "SELECT id, email, display_name, picture_url, provider, created_at
             FROM accounts ORDER BY id",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Account {
                id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                picture_url: r.get(3)?,
                provider: r.get(4)?,
                created_at: r.get(5)?,
            })
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn refresh_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
) -> Result<Account, String> {
    let userinfo = with_token(&state, &email, |http, token| {
        Box::pin(crate::oauth::fetch_userinfo(http, token))
    })
    .await
    .map_err(|e| format!("{e:#}"))?;

    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE accounts SET display_name = ?1, picture_url = ?2 WHERE email = ?3",
            params![userinfo.name, userinfo.picture, email],
        )
        .map_err(|e| e.to_string())?;
    }
    let account = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        load_account_by_email(&conn, &email).map_err(|e| e.to_string())?
    };
    let _ = app.emit("accounts:changed", &account);
    Ok(account)
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
        if let Some(ref e) = email {
            conn.execute("DELETE FROM messages WHERE account_email = ?1", params![e])
                .map_err(|err| err.to_string())?;
            conn.execute(
                "DELETE FROM message_bodies WHERE account_email = ?1",
                params![e],
            )
            .map_err(|err| err.to_string())?;
        }
        email
    };
    if let Some(email) = &email {
        state.token_cache.invalidate(email);
        if let Err(e) = secret::delete_refresh_token(email) {
            tracing::warn!(%email, error = %e, "failed to remove keyring entry");
        }
    }
    app.emit("accounts:changed", id).ok();
    Ok(())
}

#[tauri::command]
pub async fn sync_account(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
) -> Result<usize, String> {
    // Bootstrap path runs the first time we sync an account or whenever
    // Gmail's history watermark has been GC'd (history records expire after
    // ~7 days). Incremental path replaces it for steady-state sync, costing
    // O(diff) instead of O(mailbox).
    let stored_history_id: Option<u64> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT history_id FROM accounts WHERE email = ?1",
            params![email],
            |r| r.get::<_, Option<i64>>(0),
        )
        .ok()
        .flatten()
        .map(|v| v as u64)
    };

    let result = if let Some(start) = stored_history_id {
        match incremental_sync(&app, &state, &email, start).await {
            Ok(touched) => Ok(touched),
            Err(SyncErr::Expired) => {
                tracing::info!(%email, "sync: history expired, falling through to bootstrap");
                bootstrap_sync(&app, &state, &email).await
            }
            Err(SyncErr::Other(e)) => Err(e),
        }
    } else {
        bootstrap_sync(&app, &state, &email).await
    };

    // Stamp the last-successful-sync time so the periodic timer knows the
    // account isn't due again for a while. We mark even on no-op syncs so a
    // failing account doesn't get retried every tick (use err path to clear
    // the stamp if we want aggressive retry on failure).
    if result.is_ok() {
        if let Ok(mut map) = state.last_sync_at.lock() {
            map.insert(email.clone(), Instant::now());
        }
    }
    result
}

enum SyncErr {
    Expired,
    Other(String),
}

/// Fetch only the diff since `start_history_id` via Gmail's history.list. New
/// messages are pulled in parallel via the existing metadata fetcher; label
/// updates and deletions are applied without any extra round trips because
/// the history payload already carries the post-change labelIds.
async fn incremental_sync(
    app: &AppHandle,
    state: &AppState,
    email: &str,
    start_history_id: u64,
) -> Result<usize, SyncErr> {
    let outcome = with_token(state, email, move |http, token| {
        Box::pin(async move {
            gmail::messages::fetch_history(http, token, start_history_id).await
        })
    })
    .await
    .map_err(|e| SyncErr::Other(format!("history.list: {e:#}")))?;

    let (latest_id, records) = match outcome {
        gmail::messages::HistoryOutcome::Expired => return Err(SyncErr::Expired),
        gmail::messages::HistoryOutcome::Synced {
            latest_history_id,
            records,
        } => (latest_history_id, records),
    };

    use std::collections::{HashMap, HashSet};
    let mut added_ids: HashSet<String> = HashSet::new();
    let mut deleted_ids: HashSet<String> = HashSet::new();
    // For label changes, the API returns the *resulting* label_ids on each
    // message, so we just take the last value we see and overwrite.
    let mut relabeled: HashMap<String, Vec<String>> = HashMap::new();

    for rec in &records {
        for ma in &rec.messages_added {
            added_ids.insert(ma.message.id.clone());
            if let Some(labels) = &ma.message.label_ids {
                relabeled.insert(ma.message.id.clone(), labels.clone());
            }
        }
        for md in &rec.messages_deleted {
            // Gmail can both add then delete in the same history window;
            // honor the latest signal.
            added_ids.remove(&md.message.id);
            relabeled.remove(&md.message.id);
            deleted_ids.insert(md.message.id.clone());
        }
        for la in rec.labels_added.iter().chain(rec.labels_removed.iter()) {
            if deleted_ids.contains(&la.message.id) {
                continue;
            }
            if let Some(labels) = &la.message.label_ids {
                relabeled.insert(la.message.id.clone(), labels.clone());
            }
        }
    }

    // Apply deletions immediately (cheap, no network).
    if !deleted_ids.is_empty() {
        let conn = state
            .db
            .lock()
            .map_err(|e| SyncErr::Other(format!("db lock: {e}")))?;
        for id in &deleted_ids {
            let _ = conn.execute(
                "DELETE FROM messages WHERE account_email = ?1 AND id = ?2",
                params![email, id],
            );
            let _ = conn.execute(
                "DELETE FROM message_bodies WHERE account_email = ?1 AND id = ?2",
                params![email, id],
            );
        }
    }

    // Apply label-only updates against cached rows.
    if !relabeled.is_empty() {
        let conn = state
            .db
            .lock()
            .map_err(|e| SyncErr::Other(format!("db lock: {e}")))?;
        for (id, labels) in &relabeled {
            // Skip rows we don't have cached yet — they'll be inserted below
            // via the metadata fetch.
            if added_ids.contains(id) {
                continue;
            }
            let labels_json = serde_json::to_string(labels).unwrap_or_else(|_| "[]".into());
            let unread = labels.iter().any(|l| l == "UNREAD") as i64;
            let (bi, bs, bt, bsp, bse, bd, bc) = label_bits(labels);
            let _ = conn.execute(
                "UPDATE messages SET label_ids = ?1, unread = ?2,
                    has_inbox = ?3, has_starred = ?4, has_trash = ?5, has_spam = ?6,
                    has_sent = ?7, has_draft = ?8, has_chat = ?9
                 WHERE account_email = ?10 AND id = ?11",
                params![
                    labels_json, unread, bi, bs, bt, bsp, bse, bd, bc, email, id
                ],
            );
        }
    }

    // Fetch metadata for genuinely-new messages in parallel.
    let new_ids: Vec<String> = added_ids.into_iter().collect();
    let total = new_ids.len();
    let _ = app.emit(
        "sync:progress",
        &SyncProgress {
            email: email.to_string(),
            fetched: 0,
            total,
        },
    );
    if total > 0 {
        fetch_and_flush(app, state, email, new_ids)
            .await
            .map_err(SyncErr::Other)?;
    }

    if let Some(id) = latest_id {
        let conn = state
            .db
            .lock()
            .map_err(|e| SyncErr::Other(format!("db lock: {e}")))?;
        let _ = conn.execute(
            "UPDATE accounts SET history_id = ?1 WHERE email = ?2",
            params![id as i64, email],
        );
    }

    let touched = total + deleted_ids.len() + relabeled.len();
    let _ = app.emit(
        "sync:done",
        &SyncDone {
            email: email.to_string(),
            total: touched,
        },
    );
    tracing::info!(
        %email,
        added = total,
        deleted = deleted_ids.len(),
        relabeled = relabeled.len(),
        "sync: history applied"
    );
    Ok(touched)
}

/// Full bootstrap: list all message ids (with an `after:` filter to keep the
/// initial round-trip bounded), fetch metadata for the diff, and persist the
/// current historyId so subsequent calls use the incremental path.
async fn bootstrap_sync(
    app: &AppHandle,
    state: &AppState,
    email: &str,
) -> Result<usize, String> {
    // If we already have messages for this account, ask Gmail only for
    // anything newer than the freshest one we know about (with a 1-hour
    // safety buffer for clock skew / late deliveries).
    let after_seconds: Option<i64> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let max_ms: Option<i64> = conn
            .query_row(
                "SELECT MAX(date_millis) FROM messages WHERE account_email = ?1",
                params![email],
                |r| r.get::<_, Option<i64>>(0),
            )
            .ok()
            .flatten();
        max_ms.map(|ms| (ms / 1000) - 3600)
    };
    let query = after_seconds.map(|s| format!("after:{s}"));
    let query_param = query.clone();

    let all_ids = with_token(state, email, move |http, token| {
        let q = query_param.clone();
        Box::pin(async move {
            gmail::messages::list_message_ids(http, token, q.as_deref()).await
        })
    })
    .await
    .map_err(|e| {
        let msg = format!("list ids: {e:#}");
        tracing::error!(%email, error = %msg, "sync: list failed");
        let _ = app.emit(
            "sync:error",
            &SyncError {
                email: email.to_string(),
                error: msg.clone(),
            },
        );
        msg
    })?;
    tracing::info!(%email, query = ?query, listed = all_ids.len(), "sync: bootstrap listed ids");

    let ids: Vec<String> = {
        use std::collections::HashSet;
        let known: HashSet<String> = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn
                .prepare("SELECT id FROM messages WHERE account_email = ?1")
                .map_err(|e| e.to_string())?;
            let rows: rusqlite::Result<HashSet<String>> = stmt
                .query_map(params![email], |r| r.get::<_, String>(0))
                .map_err(|e| e.to_string())?
                .collect();
            rows.map_err(|e| e.to_string())?
        };
        all_ids.into_iter().filter(|id| !known.contains(id)).collect()
    };

    let total = ids.len();
    tracing::info!(%email, total, "sync: bootstrap fetching new messages");
    let _ = app.emit(
        "sync:progress",
        &SyncProgress {
            email: email.to_string(),
            fetched: 0,
            total,
        },
    );

    if total > 0 {
        fetch_and_flush(app, state, email, ids).await?;
    }

    // Capture the current historyId now so future syncs go through the
    // incremental path. Best-effort: if profile fetch fails we'll just
    // bootstrap again next time.
    let profile = with_token(state, email, |http, token| {
        Box::pin(async move { gmail::messages::fetch_profile(http, token).await })
    })
    .await
    .ok();
    if let Some(p) = profile {
        if let Some(id) = p.history_id.as_deref().and_then(|s| s.parse::<u64>().ok()) {
            if let Ok(conn) = state.db.lock() {
                let _ = conn.execute(
                    "UPDATE accounts SET history_id = ?1 WHERE email = ?2",
                    params![id as i64, email],
                );
            }
        }
    }

    let _ = app.emit(
        "sync:done",
        &SyncDone {
            email: email.to_string(),
            total,
        },
    );
    Ok(total)
}

/// Parallel-fetch metadata for `ids` and persist into `messages`. Emits
/// `sync:progress` every `SYNC_PROGRESS_EVERY` items.
async fn fetch_and_flush(
    app: &AppHandle,
    state: &AppState,
    email: &str,
    ids: Vec<String>,
) -> Result<(), String> {
    let total = ids.len();
    let mut buf: Vec<MessageMeta> = Vec::with_capacity(SYNC_BATCH);
    let mut fetched = 0usize;

    let http = state.http.clone();
    let cache = state.token_cache.clone();
    let config = state.oauth_config.clone();
    let email_owned = email.to_string();

    let mut stream = stream::iter(ids)
        .map(move |id| {
            let http = http.clone();
            let cache = cache.clone();
            let config = config.clone();
            let email = email_owned.clone();
            async move { fetch_metadata_with_retry(&http, &cache, &config, &email, &id).await }
        })
        .buffered(SYNC_PARALLEL);

    while let Some(item) = stream.next().await {
        if let Some(meta) = item {
            buf.push(meta);
        }
        fetched += 1;
        if buf.len() >= SYNC_BATCH {
            flush_messages(&state.db, &mut buf)?;
        }
        if fetched % SYNC_PROGRESS_EVERY == 0 || fetched == total {
            let _ = app.emit(
                "sync:progress",
                &SyncProgress {
                    email: email.to_string(),
                    fetched,
                    total,
                },
            );
        }
    }
    flush_messages(&state.db, &mut buf)?;
    Ok(())
}

#[tauri::command]
pub fn list_messages(
    state: State<'_, AppState>,
    email: Option<String>,
    folder: Option<String>,
    query: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
) -> Result<Vec<MessageMeta>, String> {
    let limit = limit.unwrap_or(500).clamp(1, 5000);
    let offset = offset.unwrap_or(0).max(0);
    let folder_filter = folder
        .as_deref()
        .map(folder_where_clause)
        .unwrap_or("");
    let q_pattern = query
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(escape_like);
    let query_filter = if q_pattern.is_some() {
        " AND (subject LIKE ? ESCAPE '\\' \
              OR from_header LIKE ? ESCAPE '\\' \
              OR snippet LIKE ? ESCAPE '\\')"
    } else {
        ""
    };
    let email_filter = if email.is_some() {
        " AND account_email = ?"
    } else {
        ""
    };

    let sql = format!(
        "SELECT id, account_email, thread_id, from_header, subject, snippet,
                date_millis, unread, label_ids
         FROM messages
         WHERE 1=1 {email_filter} {folder_filter} {query_filter}
         ORDER BY date_millis DESC
         LIMIT ? OFFSET ?"
    );

    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(e) = email {
        params_vec.push(Box::new(e));
    }
    if let Some(q) = q_pattern {
        params_vec.push(Box::new(q.clone()));
        params_vec.push(Box::new(q.clone()));
        params_vec.push(Box::new(q));
    }
    params_vec.push(Box::new(limit));
    params_vec.push(Box::new(offset));

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(&sql).map_err(|err| err.to_string())?;
    let rows: rusqlite::Result<Vec<MessageMeta>> = stmt
        .query_map(
            rusqlite::params_from_iter(params_vec.iter().map(|b| b.as_ref())),
            |r| {
                let labels_json: String = r.get(8)?;
                Ok(MessageMeta {
                    id: r.get(0)?,
                    account_email: r.get(1)?,
                    thread_id: r.get(2)?,
                    from: r.get(3)?,
                    subject: r.get(4)?,
                    snippet: r.get(5)?,
                    date_millis: r.get(6)?,
                    unread: r.get::<_, i64>(7)? != 0,
                    label_ids: serde_json::from_str(&labels_json).unwrap_or_default(),
                })
            },
        )
        .map_err(|err| err.to_string())?
        .collect();
    rows.map_err(|err| err.to_string())
}

#[derive(Debug, Serialize, Clone)]
pub struct UnreadCount {
    pub account_email: String,
    pub folder: String,
    pub count: i64,
}

/// Per-account unread counts for each folder the sidebar surfaces. The cost is
/// O(matching rows) thanks to the `msg_unread` partial index combined with
/// the has_inbox / has_starred / has_trash / has_spam bit columns.
#[tauri::command]
pub fn unread_counts(state: State<'_, AppState>) -> Result<Vec<UnreadCount>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT account_email,
                    SUM(CASE WHEN has_inbox = 1   THEN 1 ELSE 0 END) AS inbox,
                    SUM(CASE WHEN has_starred = 1 THEN 1 ELSE 0 END) AS pinned,
                    SUM(CASE WHEN has_spam = 1    THEN 1 ELSE 0 END) AS spam,
                    SUM(CASE WHEN has_trash = 1   THEN 1 ELSE 0 END) AS trash
             FROM messages
             WHERE unread = 1
             GROUP BY account_email",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            let acc: String = r.get(0)?;
            let inbox: i64 = r.get(1)?;
            let pinned: i64 = r.get(2)?;
            let spam: i64 = r.get(3)?;
            let trash: i64 = r.get(4)?;
            Ok((acc, inbox, pinned, spam, trash))
        })
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for r in rows.flatten() {
        let (acc, inbox, pinned, spam, trash) = r;
        for (folder, count) in [
            ("inbox", inbox),
            ("pinned", pinned),
            ("spam", spam),
            ("trash", trash),
        ] {
            if count > 0 {
                out.push(UnreadCount {
                    account_email: acc.clone(),
                    folder: folder.to_string(),
                    count,
                });
            }
        }
    }
    Ok(out)
}

fn escape_like(input: &str) -> String {
    let mut out = String::with_capacity(input.len() + 2);
    out.push('%');
    for c in input.chars() {
        match c {
            '\\' | '%' | '_' => {
                out.push('\\');
                out.push(c);
            }
            other => out.push(other),
        }
    }
    out.push('%');
    out
}

fn folder_where_clause(folder: &str) -> &'static str {
    // Bit columns are populated by `label_bits` whenever we INSERT or UPDATE a
    // message; see flush_messages / update_message_labels. They are indexed
    // (partial indexes per flag) so the queries below cost O(matching rows).
    match folder {
        "inbox" => " AND has_inbox = 1",
        "pinned" => " AND has_starred = 1",
        "sent" => " AND has_sent = 1",
        "drafts" => " AND has_draft = 1",
        "snoozed" => {
            " AND EXISTS (
                SELECT 1 FROM snoozes s
                WHERE s.account_email = messages.account_email
                  AND s.message_id = messages.id
            )"
        }
        "archive" => {
            " AND has_inbox = 0 AND has_sent = 0 AND has_trash = 0 \
              AND has_draft = 0 AND has_spam = 0 AND has_chat = 0 \
              AND NOT EXISTS (
                SELECT 1 FROM snoozes s
                WHERE s.account_email = messages.account_email
                  AND s.message_id = messages.id
              )"
        }
        "trash" => " AND has_trash = 1",
        "spam" => " AND has_spam = 1",
        _ => "",
    }
}

/// Map a labels slice into the seven bit columns we store on `messages`.
/// Returns `(inbox, starred, trash, spam, sent, draft, chat)`.
fn label_bits(labels: &[String]) -> (i64, i64, i64, i64, i64, i64, i64) {
    let has = |name: &str| labels.iter().any(|l| l == name) as i64;
    (
        has("INBOX"),
        has("STARRED"),
        has("TRASH"),
        has("SPAM"),
        has("SENT"),
        has("DRAFT"),
        has("CHAT"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn open_in_memory() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE messages (
                id TEXT NOT NULL,
                account_email TEXT NOT NULL,
                thread_id TEXT,
                from_header TEXT NOT NULL DEFAULT '',
                subject TEXT NOT NULL DEFAULT '',
                snippet TEXT NOT NULL DEFAULT '',
                date_millis INTEGER NOT NULL DEFAULT 0,
                unread INTEGER NOT NULL DEFAULT 0,
                label_ids TEXT NOT NULL DEFAULT '[]',
                fetched_at TEXT NOT NULL,
                has_inbox INTEGER NOT NULL DEFAULT 0,
                has_starred INTEGER NOT NULL DEFAULT 0,
                has_trash INTEGER NOT NULL DEFAULT 0,
                has_spam INTEGER NOT NULL DEFAULT 0,
                has_sent INTEGER NOT NULL DEFAULT 0,
                has_draft INTEGER NOT NULL DEFAULT 0,
                has_chat INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (account_email, id)
            );
            CREATE TABLE snoozes (
                account_email TEXT NOT NULL,
                message_id    TEXT NOT NULL,
                fire_at_ms    INTEGER NOT NULL,
                PRIMARY KEY (account_email, message_id)
            );
            "#,
        )
        .unwrap();
        conn
    }

    fn insert(conn: &Connection, id: &str, subject: &str, labels: &[&str], unread: i64) {
        let labels_json = serde_json::to_string(labels).unwrap();
        let has = |n: &str| labels.iter().any(|l| *l == n) as i64;
        conn.execute(
            "INSERT INTO messages
             (id, account_email, thread_id, from_header, subject, snippet,
              date_millis, unread, label_ids, fetched_at,
              has_inbox, has_starred, has_trash, has_spam, has_sent,
              has_draft, has_chat)
             VALUES (?1, 'a@example.com', NULL, 'A <a@example.com>', ?2, '',
                     0, ?3, ?4, 'now', ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                id, subject, unread, labels_json,
                has("INBOX"), has("STARRED"), has("TRASH"), has("SPAM"),
                has("SENT"), has("DRAFT"), has("CHAT"),
            ],
        )
        .unwrap();
    }

    #[test]
    fn folder_where_inbox_uses_bit_column() {
        assert_eq!(folder_where_clause("inbox"), " AND has_inbox = 1");
    }

    #[test]
    fn folder_where_archive_excludes_system_bits_and_snoozes() {
        let archive = folder_where_clause("archive");
        for col in [
            "has_inbox = 0",
            "has_sent = 0",
            "has_trash = 0",
            "has_draft = 0",
            "has_spam = 0",
            "has_chat = 0",
        ] {
            assert!(archive.contains(col), "missing predicate {col}");
        }
        assert!(archive.contains("NOT EXISTS"));
        assert!(archive.contains("snoozes"));
    }

    #[test]
    fn label_bits_maps_known_labels() {
        let labels = vec![
            "INBOX".to_string(),
            "STARRED".to_string(),
            "CATEGORY_PROMOTIONS".to_string(),
        ];
        let (i, s, t, sp, se, d, c) = label_bits(&labels);
        assert_eq!((i, s, t, sp, se, d, c), (1, 1, 0, 0, 0, 0, 0));
    }

    #[test]
    fn label_bits_empty() {
        let (i, s, t, sp, se, d, c) = label_bits(&[]);
        assert_eq!((i, s, t, sp, se, d, c), (0, 0, 0, 0, 0, 0, 0));
    }

    #[test]
    fn folder_where_unknown_returns_empty() {
        assert_eq!(folder_where_clause("nonsense"), "");
        assert_eq!(folder_where_clause(""), "");
    }

    #[test]
    fn escape_like_quotes_wildcards_and_wraps() {
        let pat = escape_like("100%");
        assert_eq!(pat, "%100\\%%");
    }

    #[test]
    fn escape_like_quotes_underscore_and_backslash() {
        let pat = escape_like("a_b\\c");
        assert_eq!(pat, "%a\\_b\\\\c%");
    }

    #[test]
    fn folder_clauses_compile_against_sqlite() {
        // The hand-rolled folder SQL has to be valid against an in-memory schema.
        let conn = open_in_memory();
        insert(&conn, "m1", "in inbox", &["INBOX", "UNREAD"], 1);
        insert(&conn, "m2", "starred only", &["STARRED"], 0);
        insert(&conn, "m3", "sent", &["SENT"], 0);
        insert(&conn, "m4", "archived", &["CATEGORY_PERSONAL"], 0);
        insert(&conn, "m5", "in trash", &["TRASH"], 0);
        insert(&conn, "m6", "in spam", &["SPAM"], 0);

        for (folder, expected) in [
            ("inbox", vec!["m1"]),
            ("pinned", vec!["m2"]),
            ("sent", vec!["m3"]),
            ("archive", vec!["m2", "m4"]),
            ("trash", vec!["m5"]),
            ("spam", vec!["m6"]),
        ] {
            let sql = format!(
                "SELECT id FROM messages WHERE 1=1 {clause} ORDER BY id",
                clause = folder_where_clause(folder)
            );
            let mut stmt = conn.prepare(&sql).unwrap();
            let rows: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .unwrap()
                .map(Result::unwrap)
                .collect();
            let mut expected_sorted = expected.clone();
            expected_sorted.sort();
            assert_eq!(rows, expected_sorted, "folder {folder} mismatch");
        }
    }
}

#[tauri::command]
pub async fn get_message(
    state: State<'_, AppState>,
    email: String,
    message_id: String,
    force_refresh: Option<bool>,
) -> Result<MessageDetail, String> {
    let force = force_refresh.unwrap_or(false);

    if !force {
        let cached = {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT detail_json FROM message_bodies
                 WHERE account_email = ?1 AND id = ?2",
                params![email, message_id],
                |r| r.get::<_, String>(0),
            )
            .ok()
        };
        if let Some(json) = cached {
            if let Ok(detail) = serde_json::from_str::<MessageDetail>(&json) {
                return Ok(detail);
            }
        }
    }

    let detail = fetch_full_with_retry(&state, &email, &message_id)
        .await
        .map_err(|e| {
            tracing::error!(%email, %message_id, error = %format!("{e:#}"), "get_message failed");
            format!("{e:#}")
        })?;

    if let Ok(json) = serde_json::to_string(&detail) {
        if let Ok(conn) = state.db.lock() {
            let _ = conn.execute(
                "INSERT OR REPLACE INTO message_bodies
                 (account_email, id, detail_json, fetched_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![email, message_id, json, Utc::now().to_rfc3339()],
            );
        }
    }
    Ok(detail)
}

#[tauri::command]
pub async fn get_attachment(
    state: State<'_, AppState>,
    email: String,
    message_id: String,
    attachment_id: String,
) -> Result<String, String> {
    let mid = message_id.clone();
    let aid = attachment_id.clone();
    with_token(&state, &email, move |http, token| {
        let mid = mid.clone();
        let aid = aid.clone();
        Box::pin(async move {
            gmail::messages::fetch_attachment(http, token, &mid, &aid).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, %message_id, error = %format!("{e:#}"), "get_attachment failed");
        format!("{e:#}")
    })
}

#[tauri::command]
pub async fn get_thread(
    state: State<'_, AppState>,
    email: String,
    thread_id: String,
) -> Result<Vec<MessageDetail>, String> {
    // Cached message ids in the thread, in delivery order. We use this both to
    // decide if we even need to hit Gmail (fully cached threads avoid an HTTP
    // round-trip) and to filter cached rows out of the per-message fetch.
    let cached_ids: Vec<String> = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT id FROM messages
                 WHERE account_email = ?1 AND thread_id = ?2
                 ORDER BY date_millis ASC",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![email, thread_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect()
    };

    // If every cached id has a full body cached, return them straight from
    // sqlite without touching Gmail.
    if !cached_ids.is_empty() {
        let mut all_cached = Vec::with_capacity(cached_ids.len());
        let mut missed = false;
        {
            let conn = state.db.lock().map_err(|e| e.to_string())?;
            for id in &cached_ids {
                let row: Option<String> = conn
                    .query_row(
                        "SELECT detail_json FROM message_bodies
                         WHERE account_email = ?1 AND id = ?2",
                        params![email, id],
                        |r| r.get::<_, String>(0),
                    )
                    .ok();
                match row.and_then(|j| serde_json::from_str::<MessageDetail>(&j).ok()) {
                    Some(d) => all_cached.push(d),
                    None => {
                        missed = true;
                        break;
                    }
                }
            }
        }
        if !missed {
            return Ok(all_cached);
        }
    }

    // Otherwise pull the whole thread in a single Gmail call (one HTTP
    // round-trip per thread, vs one per message in the old impl) and write
    // each message body back into the cache.
    let tid_owned = thread_id.clone();
    let details = with_token(&state, &email, move |http, token| {
        let tid = tid_owned.clone();
        Box::pin(
            async move { gmail::messages::fetch_thread_full(http, token, &tid).await },
        )
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, %thread_id, error = %format!("{e:#}"), "get_thread failed");
        format!("{e:#}")
    })?;

    if !details.is_empty() {
        if let Ok(conn) = state.db.lock() {
            let now = Utc::now().to_rfc3339();
            for d in &details {
                if let Ok(json) = serde_json::to_string(d) {
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO message_bodies
                         (account_email, id, detail_json, fetched_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![email, d.id, json, now],
                    );
                }
            }
        }
    }
    Ok(details)
}

async fn fetch_metadata_with_retry(
    http: &reqwest::Client,
    cache: &TokenCache,
    config: &OAuthConfig,
    email: &str,
    id: &str,
) -> Option<MessageMeta> {
    const MAX_ATTEMPTS: u32 = 4;
    let mut attempt: u32 = 0;
    let mut last_err: Option<String> = None;
    while attempt < MAX_ATTEMPTS {
        attempt += 1;
        let token = match gmail::auth::access_token(cache, config, http, email).await {
            Ok(t) => t,
            Err(e) => {
                last_err = Some(format!("{e:#}"));
                break;
            }
        };
        match gmail::messages::fetch_metadata(http, &token, email, id).await {
            Ok(meta) => return Some(meta),
            Err(e) if is_unauthorized(&e) => {
                tracing::debug!(id, attempt, "metadata fetch 401, refreshing token");
                cache.invalidate(email);
                tokio::time::sleep(AUTH_RETRY_DELAY).await;
            }
            Err(e) if is_rate_limited(&e) => {
                let backoff = RATE_LIMIT_BASE_DELAY * 2u32.pow(attempt - 1);
                tracing::debug!(id, attempt, ?backoff, "metadata fetch rate-limited");
                tokio::time::sleep(backoff).await;
            }
            Err(e) => {
                tracing::warn!(id, error = %e, "metadata fetch failed (non-retryable)");
                return None;
            }
        }
    }
    if let Some(err) = last_err {
        tracing::warn!(id, error = %err, "metadata fetch gave up after retries");
    } else {
        tracing::warn!(id, "metadata fetch gave up after retries");
    }
    None
}

async fn fetch_full_with_retry(
    state: &AppState,
    email: &str,
    message_id: &str,
) -> anyhow::Result<MessageDetail> {
    with_token(state, email, |http, token| {
        let mid = message_id.to_string();
        Box::pin(async move { gmail::messages::fetch_full(http, token, &mid).await })
    })
    .await
}

type BoxFut<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<T>> + Send + 'a>>;

async fn with_token<T, F>(state: &AppState, email: &str, op: F) -> anyhow::Result<T>
where
    F: for<'a> Fn(&'a reqwest::Client, &'a str) -> BoxFut<'a, T>,
{
    const MAX_ATTEMPTS: u32 = 4;
    let mut attempt: u32 = 0;
    let mut last_err: Option<anyhow::Error> = None;
    while attempt < MAX_ATTEMPTS {
        attempt += 1;
        let token = gmail::auth::access_token(
            &state.token_cache,
            &state.oauth_config,
            &state.http,
            email,
        )
        .await?;
        match op(&state.http, &token).await {
            Ok(v) => return Ok(v),
            Err(e) if is_unauthorized(&e) => {
                tracing::debug!(%email, attempt, "401 from Gmail, refreshing token");
                state.token_cache.invalidate(email);
                tokio::time::sleep(AUTH_RETRY_DELAY).await;
                last_err = Some(e);
            }
            Err(e) if is_rate_limited(&e) => {
                let backoff = RATE_LIMIT_BASE_DELAY * 2u32.pow(attempt - 1);
                tracing::debug!(%email, attempt, ?backoff, "rate limited by Gmail");
                tokio::time::sleep(backoff).await;
                last_err = Some(e);
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("with_token: max retries exceeded")))
}

fn is_unauthorized(e: &anyhow::Error) -> bool {
    for src in e.chain() {
        if let Some(req_err) = src.downcast_ref::<reqwest::Error>() {
            if req_err.status() == Some(reqwest::StatusCode::UNAUTHORIZED) {
                return true;
            }
        }
    }
    false
}

fn is_rate_limited(e: &anyhow::Error) -> bool {
    for src in e.chain() {
        if let Some(req_err) = src.downcast_ref::<reqwest::Error>() {
            if let Some(s) = req_err.status() {
                if s == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || s == reqwest::StatusCode::FORBIDDEN
                {
                    return true;
                }
            }
        }
    }
    false
}

#[tauri::command]
pub async fn modify_message(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    message_id: String,
    add_labels: Vec<String>,
    remove_labels: Vec<String>,
) -> Result<(), String> {
    let labels = with_token(&state, &email, |http, token| {
        let mid = message_id.clone();
        let add = add_labels.clone();
        let remove = remove_labels.clone();
        Box::pin(async move {
            let add_refs: Vec<&str> = add.iter().map(String::as_str).collect();
            let remove_refs: Vec<&str> = remove.iter().map(String::as_str).collect();
            gmail::messages::modify_labels(http, token, &mid, &add_refs, &remove_refs)
                .await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, error = %format!("{e:#}"), "modify failed");
        format!("{e:#}")
    })?;

    update_message_labels(&state.db, &email, &message_id, &labels)?;
    let _ = app.emit("messages:changed", &message_id);
    Ok(())
}

#[tauri::command]
pub async fn trash_message(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    message_id: String,
) -> Result<(), String> {
    let labels = with_token(&state, &email, |http, token| {
        let mid = message_id.clone();
        Box::pin(async move { gmail::messages::trash(http, token, &mid).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, error = %format!("{e:#}"), "trash failed");
        format!("{e:#}")
    })?;

    update_message_labels(&state.db, &email, &message_id, &labels)?;
    let _ = app.emit("messages:changed", &message_id);
    Ok(())
}

#[tauri::command]
pub async fn untrash_message(
    app: AppHandle,
    state: State<'_, AppState>,
    email: String,
    message_id: String,
) -> Result<(), String> {
    let labels = with_token(&state, &email, |http, token| {
        let mid = message_id.clone();
        Box::pin(async move { gmail::messages::untrash(http, token, &mid).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, error = %format!("{e:#}"), "untrash failed");
        format!("{e:#}")
    })?;

    update_message_labels(&state.db, &email, &message_id, &labels)?;
    let _ = app.emit("messages:changed", &message_id);
    Ok(())
}

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    /// Standard base64 (with padding) of the attachment bytes.
    pub data_b64: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub from_account: String,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub html_body: Option<String>,
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

fn to_compose_attachments(
    items: Vec<OutgoingAttachment>,
) -> Vec<gmail::compose::ComposeAttachment> {
    items
        .into_iter()
        .map(|a| gmail::compose::ComposeAttachment {
            filename: a.filename,
            mime_type: a.mime_type,
            data_b64: a.data_b64,
        })
        .collect()
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    request: SendRequest,
) -> Result<String, String> {
    let display_name = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT display_name FROM accounts WHERE email = ?1",
            params![request.from_account],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };

    let compose = Compose {
        from: request.from_account.clone(),
        from_name: display_name,
        to: request.to,
        cc: request.cc,
        bcc: request.bcc,
        subject: request.subject,
        body: request.body,
        html_body: request.html_body,
        attachments: to_compose_attachments(request.attachments),
        in_reply_to: request.in_reply_to,
        references: request.references,
    };
    let from_account = request.from_account.clone();

    with_token(&state, &from_account, |http, token| {
        let c = compose.clone();
        Box::pin(async move { gmail::compose::send(http, token, &c).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "send_message failed");
        format!("{e:#}")
    })
}

fn compose_from_request(state: &AppState, request: &SendRequest) -> Compose {
    let display_name = state
        .db
        .lock()
        .ok()
        .and_then(|conn| {
            conn.query_row(
                "SELECT display_name FROM accounts WHERE email = ?1",
                params![request.from_account],
                |r| r.get::<_, Option<String>>(0),
            )
            .ok()
            .flatten()
        });
    Compose {
        from: request.from_account.clone(),
        from_name: display_name,
        to: request.to.clone(),
        cc: request.cc.clone(),
        bcc: request.bcc.clone(),
        subject: request.subject.clone(),
        body: request.body.clone(),
        html_body: request.html_body.clone(),
        attachments: to_compose_attachments(request.attachments.clone()),
        in_reply_to: request.in_reply_to.clone(),
        references: request.references.clone(),
    }
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftRequest {
    /// When set, update an existing draft in place rather than creating a
    /// new one. The frontend stashes the value returned by `save_draft` and
    /// hands it back on subsequent autosaves.
    pub draft_id: Option<String>,
    #[serde(flatten)]
    pub send: SendRequest,
}

#[tauri::command]
pub async fn save_draft(
    state: State<'_, AppState>,
    request: SaveDraftRequest,
) -> Result<String, String> {
    let compose = compose_from_request(&state, &request.send);
    let from_account = request.send.from_account.clone();
    let existing = request.draft_id.clone();
    with_token(&state, &from_account, move |http, token| {
        let c = compose.clone();
        let existing = existing.clone();
        Box::pin(async move {
            match existing {
                Some(id) => gmail::compose::update_draft(http, token, &id, &c).await,
                None => gmail::compose::create_draft(http, token, &c).await,
            }
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "save_draft failed");
        format!("{e:#}")
    })
}

#[tauri::command]
pub async fn delete_draft(
    state: State<'_, AppState>,
    email: String,
    draft_id: String,
) -> Result<(), String> {
    let did = draft_id.clone();
    with_token(&state, &email, move |http, token| {
        let id = did.clone();
        Box::pin(async move { gmail::compose::delete_draft(http, token, &id).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "delete_draft failed");
        format!("{e:#}")
    })
}

#[tauri::command]
pub async fn send_draft(
    state: State<'_, AppState>,
    email: String,
    draft_id: String,
) -> Result<String, String> {
    let did = draft_id.clone();
    with_token(&state, &email, move |http, token| {
        let id = did.clone();
        Box::pin(async move { gmail::compose::send_draft(http, token, &id).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "send_draft failed");
        format!("{e:#}")
    })
}

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
    let payload =
        serde_json::to_string(&serde_json::json!(request.send)).map_err(|e| e.to_string())?;
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
                v.get("to")
                    .and_then(|arr| arr.as_array())
                    .map(|arr| {
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

// ────────────── Calendar ──────────────

#[derive(Debug, Serialize, Clone)]
pub struct CalendarRow {
    pub account_email: String,
    pub id: String,
    pub summary: String,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
    pub is_primary: bool,
    pub selected: bool,
}

#[tauri::command]
pub async fn list_calendars(
    state: State<'_, AppState>,
    email: String,
    refresh: Option<bool>,
) -> Result<Vec<CalendarRow>, String> {
    if refresh.unwrap_or(false) {
        let cals = with_token(&state, &email, |http, token| {
            Box::pin(async move { gcal::calendars::list_calendars(http, token).await })
        })
        .await
        .map_err(|e| {
            tracing::error!(%email, error = %format!("{e:#}"), "list_calendars failed");
            format!("{e:#}")
        })?;
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for c in &cals {
            tx.execute(
                "INSERT OR REPLACE INTO calendars
                 (account_email, id, summary, description, time_zone,
                  background_color, foreground_color, is_primary, selected)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    email,
                    c.id,
                    c.summary,
                    c.description,
                    c.time_zone,
                    c.background_color,
                    c.foreground_color,
                    c.primary.unwrap_or(false) as i64,
                    c.selected.unwrap_or(true) as i64,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT account_email, id, summary, description, time_zone,
                    background_color, foreground_color, is_primary, selected
             FROM calendars WHERE account_email = ?1 ORDER BY is_primary DESC, summary ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<CalendarRow> = stmt
        .query_map(params![email], |r| {
            Ok(CalendarRow {
                account_email: r.get(0)?,
                id: r.get(1)?,
                summary: r.get(2)?,
                description: r.get(3)?,
                time_zone: r.get(4)?,
                background_color: r.get(5)?,
                foreground_color: r.get(6)?,
                is_primary: r.get::<_, i64>(7)? != 0,
                selected: r.get::<_, i64>(8)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn sync_calendar_events(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    from_ms: i64,
    to_ms: i64,
) -> Result<usize, String> {
    let from_dt = chrono::Utc
        .timestamp_millis_opt(from_ms)
        .single()
        .ok_or_else(|| "invalid from_ms".to_string())?;
    let to_dt = chrono::Utc
        .timestamp_millis_opt(to_ms)
        .single()
        .ok_or_else(|| "invalid to_ms".to_string())?;
    let cid_owned = calendar_id.clone();
    let evs = with_token(&state, &email, move |http, token| {
        let cid = cid_owned.clone();
        Box::pin(async move {
            gcal::events::list_events(http, token, &cid, from_dt, to_dt).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, %calendar_id, error = %format!("{e:#}"), "sync_calendar_events failed");
        format!("{e:#}")
    })?;

    let count = evs.len();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Purge stale rows in this window so cancelled / moved events disappear.
    tx.execute(
        "DELETE FROM events
         WHERE account_email = ?1 AND calendar_id = ?2
           AND start_ms >= ?3 AND start_ms < ?4",
        params![email, calendar_id, from_ms, to_ms],
    )
    .map_err(|e| e.to_string())?;
    for ev in &evs {
        let (start_ms, end_ms, all_day) = match gcal::events::event_time_range(ev) {
            Ok(t) => t,
            Err(e) => {
                tracing::debug!(error = %format!("{e:#}"), id = %ev.id, "skip event without times");
                continue;
            }
        };
        let attendees_json = serde_json::to_string(&ev.attendees).unwrap_or_else(|_| "[]".into());
        let (org_email, org_name) = match &ev.organizer {
            Some(o) => (o.email.clone(), o.display_name.clone()),
            None => (None, None),
        };
        let self_status = ev
            .attendees
            .iter()
            .find(|a| a.self_field == Some(true))
            .and_then(|a| a.response_status.clone());
        let conf_uri = ev.conference_data.as_ref().and_then(|c| {
            c.entry_points
                .iter()
                .find(|p| p.entry_point_type.as_deref() == Some("video"))
                .and_then(|p| p.uri.clone())
        });
        tx.execute(
            "INSERT OR REPLACE INTO events
             (account_email, calendar_id, id, ical_uid, summary, description, location,
              organizer_email, organizer_name, start_ms, end_ms, all_day,
              attendees_json, response_status, html_link, conference_uri,
              status, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                email,
                calendar_id,
                ev.id,
                ev.ical_uid,
                ev.summary.clone().unwrap_or_default(),
                ev.description,
                ev.location,
                org_email,
                org_name,
                start_ms,
                end_ms,
                all_day as i64,
                attendees_json,
                self_status,
                ev.html_link,
                conf_uri,
                ev.status,
                chrono::Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[derive(Debug, Serialize, Clone)]
pub struct EventRow {
    pub account_email: String,
    pub calendar_id: String,
    pub id: String,
    pub ical_uid: Option<String>,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub organizer_email: Option<String>,
    pub organizer_name: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub attendees_json: String,
    pub response_status: Option<String>,
    pub html_link: Option<String>,
    pub conference_uri: Option<String>,
    pub status: Option<String>,
}

#[tauri::command]
pub fn list_events_cached(
    state: State<'_, AppState>,
    email: Option<String>,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<EventRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (sql, mut bind): (String, Vec<Box<dyn rusqlite::ToSql>>) = match email {
        Some(e) => (
            "SELECT account_email, calendar_id, id, ical_uid, summary, description, location,
                    organizer_email, organizer_name, start_ms, end_ms, all_day,
                    attendees_json, response_status, html_link, conference_uri, status
             FROM events
             WHERE account_email = ?1 AND start_ms < ?2 AND end_ms > ?3
             ORDER BY start_ms ASC"
                .to_string(),
            vec![Box::new(e), Box::new(to_ms), Box::new(from_ms)],
        ),
        None => (
            "SELECT account_email, calendar_id, id, ical_uid, summary, description, location,
                    organizer_email, organizer_name, start_ms, end_ms, all_day,
                    attendees_json, response_status, html_link, conference_uri, status
             FROM events
             WHERE start_ms < ?1 AND end_ms > ?2
             ORDER BY start_ms ASC"
                .to_string(),
            vec![Box::new(to_ms), Box::new(from_ms)],
        ),
    };
    let _ = &mut bind;
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<EventRow> = stmt
        .query_map(
            rusqlite::params_from_iter(bind.iter().map(|b| b.as_ref())),
            |r| {
                Ok(EventRow {
                    account_email: r.get(0)?,
                    calendar_id: r.get(1)?,
                    id: r.get(2)?,
                    ical_uid: r.get(3)?,
                    summary: r.get(4)?,
                    description: r.get(5)?,
                    location: r.get(6)?,
                    organizer_email: r.get(7)?,
                    organizer_name: r.get(8)?,
                    start_ms: r.get(9)?,
                    end_ms: r.get(10)?,
                    all_day: r.get::<_, i64>(11)? != 0,
                    attendees_json: r.get(12)?,
                    response_status: r.get(13)?,
                    html_link: r.get(14)?,
                    conference_uri: r.get(15)?,
                    status: r.get(16)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn respond_to_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event_id: String,
    status: String,
) -> Result<(), String> {
    let cid_owned = calendar_id.clone();
    let eid_owned = event_id.clone();
    let self_email = email.clone();
    let status_owned = status.clone();
    let ev = with_token(&state, &email, move |http, token| {
        let cid = cid_owned.clone();
        let eid = eid_owned.clone();
        let me = self_email.clone();
        let st = status_owned.clone();
        Box::pin(async move {
            gcal::events::respond_to_event(http, token, &cid, &eid, &me, &st).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, %calendar_id, %event_id, error = %format!("{e:#}"), "respond failed");
        format!("{e:#}")
    })?;

    // Update the cached row's response_status.
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let self_status = ev
        .attendees
        .iter()
        .find(|a| a.self_field == Some(true) || a.email.eq_ignore_ascii_case(&email))
        .and_then(|a| a.response_status.clone());
    conn.execute(
        "UPDATE events SET response_status = ?1
         WHERE account_email = ?2 AND calendar_id = ?3 AND id = ?4",
        params![self_status, email, calendar_id, event_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventRequest {
    pub email: String,
    pub calendar_id: String,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
}

#[tauri::command]
pub async fn respond_to_invite(
    state: State<'_, AppState>,
    email: String,
    ical_uid: String,
    status: String,
) -> Result<(), String> {
    let uid_owned = ical_uid.clone();
    let ev = with_token(&state, &email, move |http, token| {
        let uid = uid_owned.clone();
        Box::pin(async move {
            gcal::events::find_by_ical_uid(http, token, "primary", &uid)
                .await
                .map_err(|e| e.context("find invite"))
                .and_then(|o| {
                    o.ok_or_else(|| anyhow::anyhow!("invite not found in primary calendar"))
                })
        })
    })
    .await
    .map_err(|e| format!("{e:#}"))?;
    let event_id = ev.id.clone();
    let self_email = email.clone();
    let status_owned = status.clone();
    let _ = with_token(&state, &email, move |http, token| {
        let eid = event_id.clone();
        let me = self_email.clone();
        let st = status_owned.clone();
        Box::pin(async move {
            gcal::events::respond_to_event(http, token, "primary", &eid, &me, &st).await
        })
    })
    .await
    .map_err(|e| format!("{e:#}"))?;
    Ok(())
}

#[tauri::command]
pub async fn create_event(
    state: State<'_, AppState>,
    request: CreateEventRequest,
) -> Result<String, String> {
    let cid_owned = request.calendar_id.clone();
    let input = gcal::events::CreateEventInput {
        summary: request.summary.clone(),
        description: request.description.clone(),
        location: request.location.clone(),
        start_ms: request.start_ms,
        end_ms: request.end_ms,
        all_day: request.all_day,
        attendees: request.attendees.clone(),
        time_zone: request.time_zone.clone(),
    };
    let ev = with_token(&state, &request.email, move |http, token| {
        let cid = cid_owned.clone();
        let inp = gcal::events::CreateEventInput {
            summary: input.summary.clone(),
            description: input.description.clone(),
            location: input.location.clone(),
            start_ms: input.start_ms,
            end_ms: input.end_ms,
            all_day: input.all_day,
            attendees: input.attendees.clone(),
            time_zone: input.time_zone.clone(),
        };
        Box::pin(async move { gcal::events::create_event(http, token, &cid, &inp).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "create_event failed");
        format!("{e:#}")
    })?;
    Ok(ev.id)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEventRequest {
    pub email: String,
    pub calendar_id: String,
    pub event_id: String,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
}

#[tauri::command]
pub async fn update_event(
    state: State<'_, AppState>,
    request: UpdateEventRequest,
) -> Result<(), String> {
    let cid_owned = request.calendar_id.clone();
    let eid_owned = request.event_id.clone();
    let input = gcal::events::CreateEventInput {
        summary: request.summary.clone(),
        description: request.description.clone(),
        location: request.location.clone(),
        start_ms: request.start_ms,
        end_ms: request.end_ms,
        all_day: request.all_day,
        attendees: request.attendees.clone(),
        time_zone: request.time_zone.clone(),
    };
    let _ = with_token(&state, &request.email, move |http, token| {
        let cid = cid_owned.clone();
        let eid = eid_owned.clone();
        let inp = gcal::events::CreateEventInput {
            summary: input.summary.clone(),
            description: input.description.clone(),
            location: input.location.clone(),
            start_ms: input.start_ms,
            end_ms: input.end_ms,
            all_day: input.all_day,
            attendees: input.attendees.clone(),
            time_zone: input.time_zone.clone(),
        };
        Box::pin(async move {
            gcal::events::update_event(http, token, &cid, &eid, &inp).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "update_event failed");
        format!("{e:#}")
    })?;
    // Drop cached row; the next list_events_cached call will pick the fresh
    // copy once sync_calendar_events repopulates it.
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM events WHERE account_email = ?1 AND calendar_id = ?2 AND id = ?3",
        params![request.email, request.calendar_id, request.event_id],
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event_id: String,
) -> Result<(), String> {
    let cid_owned = calendar_id.clone();
    let eid_owned = event_id.clone();
    let _ = with_token(&state, &email, move |http, token| {
        let cid = cid_owned.clone();
        let eid = eid_owned.clone();
        Box::pin(async move { gcal::events::delete_event(http, token, &cid, &eid).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "delete_event failed");
        format!("{e:#}")
    })?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM events WHERE account_email = ?1 AND calendar_id = ?2 AND id = ?3",
        params![email, calendar_id, event_id],
    );
    Ok(())
}

// Called from the timer task — runs the same logic as the user-initiated
// unsnooze, but without an AppHandle for event emission and using anyhow
// errors instead of String to play nice with the timer plumbing.
pub async fn unsnooze_now(
    state: &AppState,
    email: &str,
    message_id: &str,
) -> anyhow::Result<()> {
    let labels = with_token(state, email, |http, token| {
        let mid = message_id.to_string();
        Box::pin(
            async move { gmail::messages::modify_labels(http, token, &mid, &["INBOX"], &[]).await },
        )
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

pub async fn fire_scheduled_send(
    state: &AppState,
    email: &str,
    payload_json: &str,
) -> anyhow::Result<()> {
    let req: SendRequest = serde_json::from_str(payload_json)
        .map_err(|e| anyhow::anyhow!("parse scheduled payload: {e}"))?;
    let display_name = {
        let conn = state
            .db
            .lock()
            .map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
        conn.query_row(
            "SELECT display_name FROM accounts WHERE email = ?1",
            params![email],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    let compose = Compose {
        from: req.from_account.clone(),
        from_name: display_name,
        to: req.to,
        cc: req.cc,
        bcc: req.bcc,
        subject: req.subject,
        body: req.body,
        html_body: req.html_body,
        attachments: to_compose_attachments(req.attachments),
        in_reply_to: req.in_reply_to,
        references: req.references,
    };
    let from = req.from_account.clone();
    with_token(state, &from, |http, token| {
        let c = compose.clone();
        Box::pin(async move { gmail::compose::send(http, token, &c).await })
    })
    .await?;
    Ok(())
}

fn update_message_labels(
    db: &Mutex<Connection>,
    email: &str,
    message_id: &str,
    labels: &[String],
) -> Result<(), String> {
    let conn = db.lock().map_err(|e| e.to_string())?;
    let json_labels = serde_json::to_string(labels).unwrap_or_else(|_| "[]".into());
    let unread = if labels.iter().any(|l| l == "UNREAD") {
        1
    } else {
        0
    };
    let (b_inbox, b_starred, b_trash, b_spam, b_sent, b_draft, b_chat) = label_bits(labels);
    conn.execute(
        "UPDATE messages SET label_ids = ?1, unread = ?2,
            has_inbox = ?3, has_starred = ?4, has_trash = ?5, has_spam = ?6,
            has_sent = ?7, has_draft = ?8, has_chat = ?9
         WHERE account_email = ?10 AND id = ?11",
        params![
            json_labels, unread,
            b_inbox, b_starred, b_trash, b_spam, b_sent, b_draft, b_chat,
            email, message_id
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn flush_messages(
    db: &Mutex<Connection>,
    buf: &mut Vec<MessageMeta>,
) -> Result<(), String> {
    if buf.is_empty() {
        return Ok(());
    }
    let conn = db.lock().map_err(|e| e.to_string())?;
    let now = Utc::now().to_rfc3339();
    conn.execute("BEGIN", []).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare_cached(
            "INSERT OR REPLACE INTO messages
             (id, account_email, thread_id, from_header, subject, snippet,
              date_millis, unread, label_ids, fetched_at,
              has_inbox, has_starred, has_trash, has_spam, has_sent,
              has_draft, has_chat)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10,
                     ?11, ?12, ?13, ?14, ?15, ?16, ?17)",
        )
        .map_err(|e| e.to_string())?;
    for m in buf.iter() {
        let labels_json = serde_json::to_string(&m.label_ids).unwrap_or_else(|_| "[]".into());
        let (b_inbox, b_starred, b_trash, b_spam, b_sent, b_draft, b_chat) =
            label_bits(&m.label_ids);
        stmt.execute(params![
            m.id,
            m.account_email,
            m.thread_id,
            m.from,
            m.subject,
            m.snippet,
            m.date_millis,
            if m.unread { 1 } else { 0 },
            labels_json,
            now,
            b_inbox,
            b_starred,
            b_trash,
            b_spam,
            b_sent,
            b_draft,
            b_chat,
        ])
        .map_err(|e| e.to_string())?;
    }
    drop(stmt);
    conn.execute("COMMIT", []).map_err(|e| e.to_string())?;
    buf.clear();
    Ok(())
}

fn load_account_by_email(conn: &Connection, email: &str) -> rusqlite::Result<Account> {
    conn.query_row(
        "SELECT id, email, display_name, picture_url, provider, created_at
         FROM accounts WHERE email = ?1",
        params![email],
        |r| {
            Ok(Account {
                id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                picture_url: r.get(3)?,
                provider: r.get(4)?,
                created_at: r.get(5)?,
            })
        },
    )
}

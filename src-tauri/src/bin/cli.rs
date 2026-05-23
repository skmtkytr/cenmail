//! cenmail-cli — headless interface to the same SQLite cache and Gmail
//! credentials the GUI uses. Designed to be called directly by external agents
//! (Claude Code etc.) without MCP overhead.

use std::io::Read;
use std::sync::{Arc, Mutex};

use anyhow::{anyhow, Context, Result};
use cenmail_lib::{
    commands::AppState,
    config::OAuthConfig,
    db,
    gmail::{self, auth::TokenCache, messages::MessageMeta},
};
use chrono::{DateTime, Utc};
use clap::{Parser, Subcommand};
use rusqlite::params;
use serde::Serialize;

#[derive(Parser)]
#[command(
    name = "cenmail-cli",
    version,
    about = "Headless interface to cenmail's local cache and Gmail accounts.\n\
             Designed for direct use from shell scripts and LLM agents.",
    long_about = None,
)]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List configured accounts (offline; reads SQLite).
    Accounts {
        #[arg(long)]
        json: bool,
    },
    /// List messages from the local cache.
    List {
        /// Filter to a single account.
        #[arg(long)]
        email: Option<String>,
        /// Folder: inbox / pinned / sent / snoozed / archive / trash.
        #[arg(long, default_value = "inbox")]
        folder: String,
        /// Smart Inbox bucket: personal / newsletters / notifications.
        #[arg(long)]
        bucket: Option<String>,
        /// Free-text query (LIKE-matches subject/from/snippet).
        #[arg(long)]
        query: Option<String>,
        /// Only show unread.
        #[arg(long)]
        unread: bool,
        #[arg(long, default_value_t = 50)]
        limit: i64,
        #[arg(long)]
        json: bool,
    },
    /// Print one message's headers + body.
    Get {
        message_id: String,
        #[arg(long)]
        email: String,
        /// text / html / json.
        #[arg(long, default_value = "text")]
        format: String,
        /// Refuse to call Gmail API; only show if cached.
        #[arg(long)]
        cached_only: bool,
    },
    /// Print all messages in a thread (text body each).
    Thread {
        thread_id: String,
        #[arg(long)]
        email: String,
        #[arg(long)]
        json: bool,
    },
    /// Classify a single message via cenmail's heuristic (personal / newsletters / notifications).
    Classify {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// List currently snoozed messages with their fire times.
    Snoozed {
        #[arg(long)]
        email: Option<String>,
        #[arg(long)]
        json: bool,
    },
    /// List pending scheduled sends.
    Scheduled {
        #[arg(long)]
        json: bool,
    },
    /// Snooze a message until a future time.
    /// --until accepts humantime durations ("1h", "30m", "2d") or absolute RFC3339.
    Snooze {
        message_id: String,
        #[arg(long)]
        email: String,
        #[arg(long)]
        until: String,
    },
    /// Manually unsnooze (puts back in Inbox now).
    Unsnooze {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// Mute a thread (archive all current messages + record the mute).
    Mute {
        thread_id: String,
        #[arg(long)]
        email: String,
    },
    /// Remove a thread from the muted set (doesn't move messages back).
    Unmute {
        thread_id: String,
        #[arg(long)]
        email: String,
    },
    /// Archive (remove INBOX).
    Archive {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// Move to Trash.
    Trash {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// Mark read.
    MarkRead {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// Mark unread.
    MarkUnread {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// Add star.
    Star {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// Remove star.
    Unstar {
        message_id: String,
        #[arg(long)]
        email: String,
    },
    /// Send a message right now.
    Send(SendArgs),
    /// Schedule a send for later (--at).
    Schedule(ScheduleArgs),
}

#[derive(clap::Args)]
struct SendArgs {
    #[arg(long)]
    from: String,
    #[arg(long, value_delimiter = ',')]
    to: Vec<String>,
    #[arg(long, value_delimiter = ',')]
    cc: Vec<String>,
    #[arg(long, value_delimiter = ',')]
    bcc: Vec<String>,
    #[arg(long)]
    subject: String,
    /// Body text. If absent, read from stdin.
    #[arg(long)]
    body: Option<String>,
    #[arg(long)]
    in_reply_to: Option<String>,
    #[arg(long)]
    references: Option<String>,
}

#[derive(clap::Args)]
struct ScheduleArgs {
    /// When to send. Humantime duration ("1h", "2d") or RFC3339.
    #[arg(long)]
    at: String,
    #[command(flatten)]
    send: SendArgs,
}

fn build_state() -> Result<AppState> {
    let oauth_config = OAuthConfig::load()?;
    let conn = db::open()?;
    let http = reqwest::Client::builder()
        .user_agent(concat!("cenmail-cli/", env!("CARGO_PKG_VERSION")))
        .build()?;
    Ok(AppState {
        db: Mutex::new(conn),
        oauth_config,
        token_cache: Arc::new(TokenCache::new()),
        http,
    })
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    let state = build_state().context("initialize cenmail state")?;
    match cli.cmd {
        Cmd::Accounts { json } => cmd_accounts(&state, json),
        Cmd::List {
            email,
            folder,
            bucket,
            query,
            unread,
            limit,
            json,
        } => cmd_list(&state, email, &folder, bucket.as_deref(), query.as_deref(), unread, limit, json),
        Cmd::Get {
            message_id,
            email,
            format,
            cached_only,
        } => cmd_get(&state, &email, &message_id, &format, cached_only).await,
        Cmd::Thread {
            thread_id,
            email,
            json,
        } => cmd_thread(&state, &email, &thread_id, json).await,
        Cmd::Classify { message_id, email } => cmd_classify(&state, &email, &message_id),
        Cmd::Snoozed { email, json } => cmd_snoozed(&state, email.as_deref(), json),
        Cmd::Scheduled { json } => cmd_scheduled(&state, json),
        Cmd::Snooze {
            message_id,
            email,
            until,
        } => cmd_snooze(&state, &email, &message_id, &until).await,
        Cmd::Unsnooze { message_id, email } => cmd_unsnooze(&state, &email, &message_id).await,
        Cmd::Mute { thread_id, email } => cmd_mute(&state, &email, &thread_id).await,
        Cmd::Unmute { thread_id, email } => cmd_unmute(&state, &email, &thread_id),
        Cmd::Archive { message_id, email } => modify_labels_cmd(&state, &email, &message_id, &[], &["INBOX"]).await,
        Cmd::Trash { message_id, email } => cmd_trash(&state, &email, &message_id).await,
        Cmd::MarkRead { message_id, email } => modify_labels_cmd(&state, &email, &message_id, &[], &["UNREAD"]).await,
        Cmd::MarkUnread { message_id, email } => modify_labels_cmd(&state, &email, &message_id, &["UNREAD"], &[]).await,
        Cmd::Star { message_id, email } => modify_labels_cmd(&state, &email, &message_id, &["STARRED"], &[]).await,
        Cmd::Unstar { message_id, email } => modify_labels_cmd(&state, &email, &message_id, &[], &["STARRED"]).await,
        Cmd::Send(args) => cmd_send(&state, args).await,
        Cmd::Schedule(args) => cmd_schedule(&state, args).await,
    }
}

// ----- Helpers -----

fn parse_when(s: &str) -> Result<i64> {
    // First try humantime duration.
    if let Ok(dur) = humantime::parse_duration(s) {
        let ms = (Utc::now().timestamp_millis() as u128)
            .saturating_add(dur.as_millis()) as i64;
        return Ok(ms);
    }
    // Then RFC3339 absolute.
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return Ok(dt.timestamp_millis());
    }
    Err(anyhow!(
        "could not parse `{s}` as duration or RFC3339 timestamp"
    ))
}

fn read_body_from_stdin() -> Result<String> {
    let mut buf = String::new();
    std::io::stdin()
        .read_to_string(&mut buf)
        .context("read body from stdin")?;
    Ok(buf)
}

fn print_json<T: Serialize>(v: &T) -> Result<()> {
    let s = serde_json::to_string_pretty(v)?;
    println!("{s}");
    Ok(())
}

fn classify_bucket_for(m: &MessageMeta) -> &'static str {
    let has = |l: &str| m.label_ids.iter().any(|x| x == l);
    if has("CATEGORY_PROMOTIONS") || has("CATEGORY_UPDATES") || has("CATEGORY_FORUMS") {
        return "newsletters";
    }
    if has("CATEGORY_SOCIAL") {
        return "notifications";
    }
    let from_lower = m.from.to_lowercase();
    let local = from_lower
        .split('<')
        .last()
        .unwrap_or(&from_lower)
        .split('@')
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| c == '"' || c.is_whitespace())
        .to_string();
    for k in [
        "no-reply",
        "noreply",
        "no_reply",
        "donotreply",
        "do-not-reply",
        "do_not_reply",
        "notification",
        "notifications",
        "alert",
        "alerts",
        "mailer-daemon",
        "mailerdaemon",
        "postmaster",
        "bounce",
        "bounces",
        "automated",
    ] {
        if local == k
            || local.starts_with(&format!("{k}-"))
            || local.starts_with(&format!("{k}_"))
            || local.ends_with(&format!("-{k}"))
            || local.ends_with(&format!("_{k}"))
        {
            return "notifications";
        }
    }
    for k in [
        "newsletter",
        "newsletters",
        "news",
        "digest",
        "updates",
        "marketing",
        "promo",
        "promotions",
        "info",
        "hello",
        "hi",
        "team",
        "community",
    ] {
        if local == k
            || local.starts_with(&format!("{k}-"))
            || local.starts_with(&format!("{k}_"))
            || local.ends_with(&format!("-{k}"))
            || local.ends_with(&format!("_{k}"))
        {
            return "newsletters";
        }
    }
    "personal"
}

// ----- Read commands -----

#[derive(Serialize)]
struct AccountRow {
    id: i64,
    email: String,
    display_name: Option<String>,
    provider: String,
    created_at: String,
}

fn cmd_accounts(state: &AppState, json: bool) -> Result<()> {
    let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
    let mut stmt = conn.prepare(
        "SELECT id, email, display_name, provider, created_at
         FROM accounts ORDER BY id",
    )?;
    let rows: Vec<AccountRow> = stmt
        .query_map([], |r| {
            Ok(AccountRow {
                id: r.get(0)?,
                email: r.get(1)?,
                display_name: r.get(2)?,
                provider: r.get(3)?,
                created_at: r.get(4)?,
            })
        })?
        .filter_map(Result::ok)
        .collect();
    if json {
        return print_json(&rows);
    }
    if rows.is_empty() {
        println!("(no accounts — add one from the GUI)");
        return Ok(());
    }
    for a in rows {
        println!("[{}] {} ({})", a.id, a.email, a.provider);
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn cmd_list(
    state: &AppState,
    email: Option<String>,
    folder: &str,
    bucket: Option<&str>,
    query: Option<&str>,
    unread_only: bool,
    limit: i64,
    json: bool,
) -> Result<()> {
    let folder_clause = match folder {
        "inbox" => " AND label_ids LIKE '%\"INBOX\"%'",
        "pinned" => " AND label_ids LIKE '%\"STARRED\"%'",
        "sent" => " AND label_ids LIKE '%\"SENT\"%'",
        "trash" => " AND label_ids LIKE '%\"TRASH\"%'",
        "snoozed" => " AND EXISTS (
            SELECT 1 FROM snoozes s
            WHERE s.account_email = messages.account_email AND s.message_id = messages.id
        )",
        "archive" => " AND label_ids NOT LIKE '%\"INBOX\"%' \
                       AND label_ids NOT LIKE '%\"SENT\"%' \
                       AND label_ids NOT LIKE '%\"TRASH\"%' \
                       AND label_ids NOT LIKE '%\"DRAFT\"%' \
                       AND label_ids NOT LIKE '%\"SPAM\"%' \
                       AND label_ids NOT LIKE '%\"CHAT\"%'",
        _ => "",
    };
    let mut sql = String::from(
        "SELECT id, account_email, thread_id, from_header, subject, snippet,
                date_millis, unread, label_ids
         FROM messages WHERE 1=1",
    );
    if email.is_some() {
        sql.push_str(" AND account_email = ?");
    }
    sql.push_str(folder_clause);
    if unread_only {
        sql.push_str(" AND unread = 1");
    }
    let q_pattern = query.map(|q| {
        let mut out = String::from("%");
        for c in q.chars() {
            if matches!(c, '\\' | '%' | '_') {
                out.push('\\');
            }
            out.push(c);
        }
        out.push('%');
        out
    });
    if q_pattern.is_some() {
        sql.push_str(
            " AND (subject LIKE ? ESCAPE '\\' \
             OR from_header LIKE ? ESCAPE '\\' \
             OR snippet LIKE ? ESCAPE '\\')",
        );
    }
    sql.push_str(" ORDER BY date_millis DESC LIMIT ?");

    let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
    let mut stmt = conn.prepare(&sql)?;
    let mut params_vec: Vec<Box<dyn rusqlite::ToSql>> = Vec::new();
    if let Some(e) = email {
        params_vec.push(Box::new(e));
    }
    if let Some(q) = &q_pattern {
        params_vec.push(Box::new(q.clone()));
        params_vec.push(Box::new(q.clone()));
        params_vec.push(Box::new(q.clone()));
    }
    // Over-fetch a little when bucket-filtering, since we filter in Rust.
    let fetch_limit = if bucket.is_some() { limit * 4 } else { limit };
    params_vec.push(Box::new(fetch_limit));
    let rows: Vec<MessageMeta> = stmt
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
        )?
        .filter_map(Result::ok)
        .collect();
    let filtered: Vec<MessageMeta> = match bucket {
        Some(b) => rows
            .into_iter()
            .filter(|m| classify_bucket_for(m) == b)
            .take(limit as usize)
            .collect(),
        None => rows,
    };
    if json {
        return print_json(&filtered);
    }
    for m in &filtered {
        let dt = DateTime::<Utc>::from_timestamp_millis(m.date_millis)
            .map(|d| d.format("%Y-%m-%d %H:%M").to_string())
            .unwrap_or_else(|| "?".into());
        let unread = if m.unread { "•" } else { " " };
        println!(
            "{unread} {dt}  {id:18}  {from:30.30}  {subj}",
            id = m.id,
            from = m.from,
            subj = m.subject,
        );
    }
    Ok(())
}

async fn cmd_get(
    state: &AppState,
    email: &str,
    message_id: &str,
    format: &str,
    cached_only: bool,
) -> Result<()> {
    let cached = {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        conn.query_row(
            "SELECT detail_json FROM message_bodies WHERE account_email = ?1 AND id = ?2",
            params![email, message_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    };
    let detail: gmail::messages::MessageDetail = if let Some(json) = cached {
        serde_json::from_str(&json).context("parse cached detail")?
    } else if cached_only {
        return Err(anyhow!("not in cache; rerun without --cached-only"));
    } else {
        let token =
            gmail::auth::access_token(&state.token_cache, &state.oauth_config, &state.http, email)
                .await?;
        let d = gmail::messages::fetch_full(&state.http, &token, message_id).await?;
        if let Ok(json) = serde_json::to_string(&d) {
            if let Ok(conn) = state.db.lock() {
                let _ = conn.execute(
                    "INSERT OR REPLACE INTO message_bodies
                     (account_email, id, detail_json, fetched_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![email, message_id, json, Utc::now().to_rfc3339()],
                );
            }
        }
        d
    };
    match format {
        "json" => print_json(&detail)?,
        "html" => {
            println!("Subject: {}", detail.subject);
            println!("From: {}", detail.from);
            println!("Date: {}", detail.date);
            println!();
            println!("{}", detail.html_body.unwrap_or_default());
        }
        _ => {
            // text (default)
            println!("Subject: {}", detail.subject);
            println!("From: {}", detail.from);
            println!("To: {}", detail.to);
            if !detail.cc.is_empty() {
                println!("Cc: {}", detail.cc);
            }
            println!("Date: {}", detail.date);
            println!();
            if let Some(text) = detail.text_body {
                println!("{text}");
            } else if let Some(html) = detail.html_body {
                // Crude: strip tags
                let stripped = strip_html(&html);
                println!("{stripped}");
            } else {
                println!("(no body)");
            }
        }
    }
    Ok(())
}

fn strip_html(html: &str) -> String {
    let mut out = String::new();
    let mut in_tag = false;
    for c in html.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn cmd_thread(
    state: &AppState,
    email: &str,
    thread_id: &str,
    json: bool,
) -> Result<()> {
    let ids: Vec<String> = {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT id FROM messages WHERE account_email = ?1 AND thread_id = ?2
             ORDER BY date_millis ASC",
        )?;
        let out: Vec<String> = stmt
            .query_map(params![email, thread_id], |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
        out
    };
    if ids.is_empty() {
        return Err(anyhow!("no cached messages for thread {thread_id}"));
    }
    let mut details = Vec::with_capacity(ids.len());
    for id in &ids {
        let cached = {
            let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
            conn.query_row(
                "SELECT detail_json FROM message_bodies WHERE account_email = ?1 AND id = ?2",
                params![email, id],
                |r| r.get::<_, String>(0),
            )
            .ok()
        };
        let detail: gmail::messages::MessageDetail = if let Some(j) = cached {
            serde_json::from_str(&j).context("parse cached detail")?
        } else {
            let token = gmail::auth::access_token(
                &state.token_cache,
                &state.oauth_config,
                &state.http,
                email,
            )
            .await?;
            let d = gmail::messages::fetch_full(&state.http, &token, id).await?;
            if let Ok(json) = serde_json::to_string(&d) {
                if let Ok(conn) = state.db.lock() {
                    let _ = conn.execute(
                        "INSERT OR REPLACE INTO message_bodies
                         (account_email, id, detail_json, fetched_at)
                         VALUES (?1, ?2, ?3, ?4)",
                        params![email, id, json, Utc::now().to_rfc3339()],
                    );
                }
            }
            d
        };
        details.push(detail);
    }
    if json {
        return print_json(&details);
    }
    for (i, d) in details.iter().enumerate() {
        println!("─── [{i}] {} | {}", d.from, d.date);
        if let Some(t) = &d.text_body {
            println!("{t}");
        } else if let Some(h) = &d.html_body {
            println!("{}", strip_html(h));
        }
        println!();
    }
    Ok(())
}

fn cmd_classify(state: &AppState, email: &str, message_id: &str) -> Result<()> {
    let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
    let row = conn.query_row(
        "SELECT id, account_email, thread_id, from_header, subject, snippet,
                date_millis, unread, label_ids
         FROM messages WHERE account_email = ?1 AND id = ?2",
        params![email, message_id],
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
    )?;
    println!("{}", classify_bucket_for(&row));
    Ok(())
}

#[derive(Serialize)]
struct SnoozedRow {
    account_email: String,
    message_id: String,
    fire_at: String,
    fire_at_ms: i64,
}

fn cmd_snoozed(state: &AppState, email: Option<&str>, json: bool) -> Result<()> {
    let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
    let sql = match email {
        Some(_) => "SELECT account_email, message_id, fire_at_ms FROM snoozes
                    WHERE account_email = ?1 ORDER BY fire_at_ms ASC",
        None => "SELECT account_email, message_id, fire_at_ms FROM snoozes
                 ORDER BY fire_at_ms ASC",
    };
    let mut stmt = conn.prepare(sql)?;
    let map = |r: &rusqlite::Row| -> rusqlite::Result<SnoozedRow> {
        let acct: String = r.get(0)?;
        let mid: String = r.get(1)?;
        let ms: i64 = r.get(2)?;
        Ok(SnoozedRow {
            account_email: acct,
            message_id: mid,
            fire_at: DateTime::<Utc>::from_timestamp_millis(ms)
                .map(|d| d.to_rfc3339())
                .unwrap_or_default(),
            fire_at_ms: ms,
        })
    };
    let rows: Vec<SnoozedRow> = match email {
        Some(e) => stmt
            .query_map(params![e], map)?
            .filter_map(Result::ok)
            .collect(),
        None => stmt.query_map([], map)?.filter_map(Result::ok).collect(),
    };
    if json {
        return print_json(&rows);
    }
    for r in rows {
        println!("{}  {}  {}", r.fire_at, r.account_email, r.message_id);
    }
    Ok(())
}

#[derive(Serialize)]
struct ScheduledRow {
    id: String,
    account_email: String,
    fire_at: String,
    fire_at_ms: i64,
    subject: String,
}

fn cmd_scheduled(state: &AppState, json: bool) -> Result<()> {
    let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
    let mut stmt = conn.prepare(
        "SELECT id, account_email, fire_at_ms, payload_json
         FROM scheduled_sends WHERE sent = 0 ORDER BY fire_at_ms ASC",
    )?;
    let rows: Vec<ScheduledRow> = stmt
        .query_map([], |r| {
            let id: String = r.get(0)?;
            let acct: String = r.get(1)?;
            let ms: i64 = r.get(2)?;
            let payload: String = r.get(3)?;
            let subject = serde_json::from_str::<serde_json::Value>(&payload)
                .ok()
                .and_then(|v| v.get("subject").and_then(|x| x.as_str().map(String::from)))
                .unwrap_or_default();
            Ok(ScheduledRow {
                id,
                account_email: acct,
                fire_at: DateTime::<Utc>::from_timestamp_millis(ms)
                    .map(|d| d.to_rfc3339())
                    .unwrap_or_default(),
                fire_at_ms: ms,
                subject,
            })
        })?
        .filter_map(Result::ok)
        .collect();
    if json {
        return print_json(&rows);
    }
    for r in rows {
        println!("{}  {}  {}  {}", r.fire_at, r.account_email, r.id, r.subject);
    }
    Ok(())
}

// ----- Write commands -----

async fn modify_labels_cmd(
    state: &AppState,
    email: &str,
    message_id: &str,
    add: &[&str],
    remove: &[&str],
) -> Result<()> {
    let token =
        gmail::auth::access_token(&state.token_cache, &state.oauth_config, &state.http, email)
            .await?;
    let labels =
        gmail::messages::modify_labels(&state.http, &token, message_id, add, remove).await?;
    update_cached_labels(state, email, message_id, &labels)?;
    println!("ok");
    Ok(())
}

fn update_cached_labels(
    state: &AppState,
    email: &str,
    message_id: &str,
    labels: &[String],
) -> Result<()> {
    let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
    let labels_json = serde_json::to_string(labels)?;
    let unread = if labels.iter().any(|l| l == "UNREAD") { 1 } else { 0 };
    conn.execute(
        "UPDATE messages SET label_ids = ?1, unread = ?2
         WHERE account_email = ?3 AND id = ?4",
        params![labels_json, unread, email, message_id],
    )?;
    Ok(())
}

async fn cmd_snooze(
    state: &AppState,
    email: &str,
    message_id: &str,
    until: &str,
) -> Result<()> {
    let fire_at = parse_when(until)?;
    let token =
        gmail::auth::access_token(&state.token_cache, &state.oauth_config, &state.http, email)
            .await?;
    let labels =
        gmail::messages::modify_labels(&state.http, &token, message_id, &[], &["INBOX"]).await?;
    {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO snoozes (account_email, message_id, fire_at_ms)
             VALUES (?1, ?2, ?3)",
            params![email, message_id, fire_at],
        )?;
    }
    update_cached_labels(state, email, message_id, &labels)?;
    let when = DateTime::<Utc>::from_timestamp_millis(fire_at)
        .map(|d| d.to_rfc3339())
        .unwrap_or_default();
    println!("snoozed until {when}");
    Ok(())
}

async fn cmd_unsnooze(state: &AppState, email: &str, message_id: &str) -> Result<()> {
    let token =
        gmail::auth::access_token(&state.token_cache, &state.oauth_config, &state.http, email)
            .await?;
    let labels =
        gmail::messages::modify_labels(&state.http, &token, message_id, &["INBOX"], &[]).await?;
    {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        conn.execute(
            "DELETE FROM snoozes WHERE account_email = ?1 AND message_id = ?2",
            params![email, message_id],
        )?;
    }
    update_cached_labels(state, email, message_id, &labels)?;
    println!("ok");
    Ok(())
}

async fn cmd_mute(state: &AppState, email: &str, thread_id: &str) -> Result<()> {
    let ids: Vec<String> = {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT id FROM messages WHERE account_email = ?1 AND thread_id = ?2",
        )?;
        let out: Vec<String> = stmt
            .query_map(params![email, thread_id], |r| r.get::<_, String>(0))?
            .filter_map(Result::ok)
            .collect();
        out
    };
    {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        conn.execute(
            "INSERT OR REPLACE INTO muted_threads (account_email, thread_id, muted_at_ms)
             VALUES (?1, ?2, ?3)",
            params![email, thread_id, Utc::now().timestamp_millis()],
        )?;
    }
    for id in ids {
        let token = gmail::auth::access_token(
            &state.token_cache,
            &state.oauth_config,
            &state.http,
            email,
        )
        .await?;
        let labels =
            gmail::messages::modify_labels(&state.http, &token, &id, &[], &["INBOX"]).await?;
        update_cached_labels(state, email, &id, &labels)?;
    }
    println!("ok");
    Ok(())
}

fn cmd_unmute(state: &AppState, email: &str, thread_id: &str) -> Result<()> {
    let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
    conn.execute(
        "DELETE FROM muted_threads WHERE account_email = ?1 AND thread_id = ?2",
        params![email, thread_id],
    )?;
    println!("ok");
    Ok(())
}

async fn cmd_trash(state: &AppState, email: &str, message_id: &str) -> Result<()> {
    let token =
        gmail::auth::access_token(&state.token_cache, &state.oauth_config, &state.http, email)
            .await?;
    let labels = gmail::messages::trash(&state.http, &token, message_id).await?;
    update_cached_labels(state, email, message_id, &labels)?;
    println!("ok");
    Ok(())
}

async fn cmd_send(state: &AppState, args: SendArgs) -> Result<()> {
    let body = match args.body {
        Some(b) => b,
        None => read_body_from_stdin()?,
    };
    let display_name = {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        conn.query_row(
            "SELECT display_name FROM accounts WHERE email = ?1",
            params![args.from],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    let compose = gmail::compose::Compose {
        from: args.from.clone(),
        from_name: display_name,
        to: args.to,
        cc: args.cc,
        bcc: args.bcc,
        subject: args.subject,
        body,
        in_reply_to: args.in_reply_to,
        references: args.references,
    };
    let token = gmail::auth::access_token(
        &state.token_cache,
        &state.oauth_config,
        &state.http,
        &args.from,
    )
    .await?;
    let id = gmail::compose::send(&state.http, &token, &compose).await?;
    println!("{id}");
    Ok(())
}

async fn cmd_schedule(state: &AppState, args: ScheduleArgs) -> Result<()> {
    let fire_at_ms = parse_when(&args.at)?;
    let body = match args.send.body {
        Some(b) => b,
        None => read_body_from_stdin()?,
    };
    // Same payload shape as scheduled_send tauri command expects.
    let payload = serde_json::json!({
        "fromAccount": args.send.from,
        "to": args.send.to,
        "cc": args.send.cc,
        "bcc": args.send.bcc,
        "subject": args.send.subject,
        "body": body,
        "inReplyTo": args.send.in_reply_to,
        "references": args.send.references,
    });
    let id = format!("sch_{}", Utc::now().timestamp_nanos_opt().unwrap_or(0));
    {
        let conn = state.db.lock().map_err(|e| anyhow!("db lock: {e}"))?;
        conn.execute(
            "INSERT INTO scheduled_sends
             (id, account_email, payload_json, fire_at_ms, created_at, sent)
             VALUES (?1, ?2, ?3, ?4, ?5, 0)",
            params![
                id,
                args.send.from,
                payload.to_string(),
                fire_at_ms,
                Utc::now().to_rfc3339(),
            ],
        )?;
    }
    println!("{id}");
    Ok(())
}

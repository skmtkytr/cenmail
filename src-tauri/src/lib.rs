pub mod commands;
pub mod config;
pub mod db;
pub mod gmail;
mod oauth;
pub mod secret;

use std::sync::{Arc, Mutex};
use std::time::Duration;

use rusqlite::params;
use tauri::Manager;

use commands::{
    add_account, cancel_scheduled, get_message, get_thread, list_accounts, list_messages,
    list_scheduled, list_snoozed, modify_message, mute_thread, refresh_account, remove_account,
    schedule_send, send_message, snooze_message, sync_account, trash_message, unmute_thread,
    unsnooze_message, untrash_message, AppState,
};

const TIMER_TICK: Duration = Duration::from_secs(60);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "cenmail=info,warn".parse().unwrap());
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let oauth_config = match config::OAuthConfig::load() {
        Ok(c) => c,
        Err(e) => {
            // Write a launch-time error so desktop-menu launches that crash
            // before any UI appears still leave a breadcrumb the user can find.
            let msg = format!("OAuth config error: {e:#}\n");
            eprintln!("{msg}");
            if let Some(dir) = dirs::data_local_dir() {
                let log_dir = dir.join("cenmail");
                let _ = std::fs::create_dir_all(&log_dir);
                let _ = std::fs::write(log_dir.join("launch_error.log"), &msg);
            }
            std::process::exit(2);
        }
    };
    let conn = db::open().expect("init sqlite database");

    let http = reqwest::Client::builder()
        .user_agent(concat!("cenmail/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("build reqwest client");

    let state = AppState {
        db: Mutex::new(conn),
        oauth_config,
        token_cache: Arc::new(gmail::auth::TokenCache::new()),
        http,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(state)
        .setup(|app| {
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(TIMER_TICK).await;
                    if let Err(e) = timer_tick(&handle).await {
                        tracing::warn!(error = %format!("{e:#}"), "timer tick failed");
                    }
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            add_account,
            list_accounts,
            remove_account,
            refresh_account,
            sync_account,
            list_messages,
            get_message,
            get_thread,
            modify_message,
            trash_message,
            untrash_message,
            send_message,
            snooze_message,
            unsnooze_message,
            list_snoozed,
            mute_thread,
            unmute_thread,
            schedule_send,
            list_scheduled,
            cancel_scheduled,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

async fn timer_tick(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let now_ms = chrono::Utc::now().timestamp_millis();

    // Snoozes
    let due_snoozes: Vec<(String, String)> = {
        let conn = state
            .db
            .lock()
            .map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT account_email, message_id FROM snoozes WHERE fire_at_ms <= ?1",
        )?;
        let rows = stmt.query_map(params![now_ms], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (email, message_id) in due_snoozes {
        match commands::unsnooze_now(&state, &email, &message_id).await {
            Ok(()) => {
                tracing::info!(%email, %message_id, "timer: snooze fired");
                let _ = tauri::Emitter::emit(app, "snooze:fired", &message_id);
            }
            Err(e) => {
                tracing::warn!(%email, %message_id, error = %format!("{e:#}"), "timer: unsnooze failed");
            }
        }
    }

    // Scheduled sends
    let due_sends: Vec<(String, String, String)> = {
        let conn = state
            .db
            .lock()
            .map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
        let mut stmt = conn.prepare(
            "SELECT id, account_email, payload_json FROM scheduled_sends
             WHERE sent = 0 AND fire_at_ms <= ?1",
        )?;
        let rows = stmt.query_map(params![now_ms], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.filter_map(|r| r.ok()).collect()
    };
    for (id, email, payload) in due_sends {
        match commands::fire_scheduled_send(&state, &email, &payload).await {
            Ok(()) => {
                tracing::info!(%id, %email, "timer: scheduled send fired");
                {
                    let conn = state
                        .db
                        .lock()
                        .map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
                    let _ = conn.execute(
                        "UPDATE scheduled_sends SET sent = 1 WHERE id = ?1",
                        params![id],
                    );
                }
                let _ = tauri::Emitter::emit(app, "schedule:sent", &id);
            }
            Err(e) => {
                tracing::warn!(%id, %email, error = %format!("{e:#}"), "timer: scheduled send failed");
            }
        }
    }

    Ok(())
}

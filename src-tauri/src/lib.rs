pub mod classify;
pub mod commands;
pub mod config;
pub mod constants;
pub mod db;
pub mod gcal;
pub mod gmail;
pub mod notify;
mod oauth;
pub mod secret;

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rusqlite::params;
use tauri::Manager;

use commands::{
    add_account, cancel_scheduled, create_event, delete_draft, delete_event, get_attachment,
    get_message, get_thread, list_accounts, list_calendars, list_events_cached, open_attachment,
    save_attachment,
    list_messages, list_scheduled, list_snoozed, modify_message, mute_thread,
    refresh_account, remove_account, respond_to_event, respond_to_invite, save_draft,
    schedule_send, send_draft, send_message, set_runtime_prefs, snooze_message, sync_account,
    take_pending_open,
    sync_calendar_events, trash_message, unmute_thread, unread_counts, unsnooze_message,
    untrash_message, update_event, AppState,
};

use constants::{PERIODIC_SYNC_INTERVAL, TIMER_TICK};

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
        last_sync_at: Mutex::new(HashMap::new()),
        close_to_tray: AtomicBool::new(true),
        quitting: AtomicBool::new(false),
        notify_warmed: AtomicBool::new(false),
        pending_open: Mutex::new(None),
    };

    tauri::Builder::default()
        // Must be the first plugin. When the user relaunches cenmail while it
        // is still resident in the tray, the second process exits and this
        // callback fires in the running instance — reveal its window instead
        // of spawning a duplicate (which would double the timer/tray/notifs).
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            reveal_window_deferred(app);
        }))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(state)
        .setup(|app| {
            build_tray(app.handle())?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(TIMER_TICK).await;
                    if let Err(e) = timer_tick(&handle).await {
                        tracing::warn!(error = %format!("{e:#}"), "timer tick failed");
                    }
                }
            });

            // Tray residency keeps the process alive after the window closes,
            // so we must exit promptly on termination signals — otherwise at
            // logout/shutdown the session manager waits on us and force-kills,
            // stalling the whole shutdown. Exit immediately; DB writes are
            // already committed (rusqlite autocommit) and tokens live in the
            // keyring, so there's nothing to flush.
            #[cfg(unix)]
            tauri::async_runtime::spawn(async move {
                use tokio::signal::unix::{signal, SignalKind};
                let (mut term, mut intr) = match (
                    signal(SignalKind::terminate()),
                    signal(SignalKind::interrupt()),
                ) {
                    (Ok(t), Ok(i)) => (t, i),
                    _ => return,
                };
                tokio::select! {
                    _ = term.recv() => {}
                    _ = intr.recv() => {}
                }
                tracing::info!("received termination signal; exiting");
                std::process::exit(0);
            });

            Ok(())
        })
        .on_window_event(|window, event| {
            // Closing the main window keeps it resident instead of exiting, so
            // the background timer keeps syncing and firing notifications. The
            // tray "Quit" item flips `quitting` first to allow a real exit.
            //
            // We *minimize* rather than hide(): on Wayland, hide() unmaps the
            // surface and the compositor re-places it (KWin centers it) on the
            // next show, losing the user's window position. Minimizing keeps
            // the toplevel mapped so unminimize restores the same geometry.
            // skip_taskbar drops the taskbar entry while it's tucked away
            // (best-effort — Wayland compositors may ignore it).
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<AppState>();
                let quitting = state.quitting.load(Ordering::Relaxed);
                let close_to_tray = state.close_to_tray.load(Ordering::Relaxed);
                if close_to_tray && !quitting {
                    api.prevent_close();
                    let _ = window.set_skip_taskbar(true);
                    let _ = window.minimize();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            add_account,
            list_accounts,
            remove_account,
            refresh_account,
            sync_account,
            list_messages,
            unread_counts,
            get_message,
            get_thread,
            get_attachment,
            open_attachment,
            save_attachment,
            modify_message,
            trash_message,
            untrash_message,
            send_message,
            save_draft,
            delete_draft,
            send_draft,
            snooze_message,
            unsnooze_message,
            list_snoozed,
            mute_thread,
            unmute_thread,
            schedule_send,
            list_scheduled,
            cancel_scheduled,
            list_calendars,
            sync_calendar_events,
            list_events_cached,
            respond_to_event,
            respond_to_invite,
            create_event,
            update_event,
            delete_event,
            set_runtime_prefs,
            take_pending_open,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// Build the system-tray icon with an Open / Quit menu. Left-clicking the icon
/// reopens the window; "Quit" sets the `quitting` flag so the window-close
/// handler lets the app actually exit.
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let open_i = MenuItem::with_id(app, "open", "Open cenmail", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open_i, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("cenmail")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => reveal_window_deferred(app),
            "quit" => {
                let state = app.state::<AppState>();
                state.quitting.store(true, Ordering::Relaxed);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                reveal_window_deferred(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

/// Reveal and focus the main window, restoring it if it was minimized to the
/// tray. Mirror of the close handler: undo skip_taskbar, then unminimize in
/// place (which keeps the window's last position). Must run on the main thread.
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.set_skip_taskbar(false);
        let _ = win.unminimize();
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Reveal the main window on the next event-loop tick instead of immediately.
///
/// The tray menu (and the relaunch handoff) fire their callback while a pointer
/// grab is still held by the menu. Showing + activating the window during that
/// grab leaves it visible but unable to receive input on KWin/Wayland — the
/// titlebar's close button doesn't respond. Sleeping briefly lets the grab
/// release, then we hop back to the main thread to touch the GTK window.
fn reveal_window_deferred(app: &tauri::AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
        let handle = app.clone();
        let _ = app.run_on_main_thread(move || show_main_window(&handle));
    });
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

    // Periodic incremental sync: keep the mailbox fresh while the window
    // is open. Gating on PERIODIC_SYNC_INTERVAL prevents the timer from
    // racing with the user's startup syncAll() and from re-firing every
    // minute when nothing is actually new.
    let now = Instant::now();
    let due_accounts: Vec<String> = {
        let emails: Vec<String> = {
            let conn = state
                .db
                .lock()
                .map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
            let mut stmt = conn.prepare("SELECT email FROM accounts")?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let map = state
            .last_sync_at
            .lock()
            .map_err(|e| anyhow::anyhow!("last_sync_at lock: {e}"))?;
        emails
            .into_iter()
            .filter(|email| match map.get(email) {
                Some(t) => now.duration_since(*t) >= PERIODIC_SYNC_INTERVAL,
                None => true,
            })
            .collect()
    };
    for email in due_accounts {
        // Fire-and-forget so a flaky-network sync_account on one account
        // can't delay snoozes / scheduled sends on the same tick.
        let app_for_task = app.clone();
        tokio::spawn(async move {
            let st = app_for_task.state::<AppState>();
            match commands::sync_account(app_for_task.clone(), st, email.clone()).await {
                Ok(n) => {
                    if n > 0 {
                        tracing::debug!(%email, applied = n, "periodic sync");
                    }
                }
                Err(e) => {
                    tracing::warn!(%email, error = %e, "periodic sync failed");
                }
            }
        });
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

    // New-mail notifications. Runs last so it sees rows written by syncs that
    // completed earlier in this (or a prior) tick.
    if let Err(e) = notify_new_mail(app) {
        tracing::warn!(error = %format!("{e:#}"), "notification pass failed");
    }

    Ok(())
}

/// Per-account new-mail notification pass. Reads each account's high-water mark
/// from `notification_state`, finds unread inbox messages past it, and fires a
/// coalesced OS notification for the ones the user's prefs allow. The first
/// pass after launch only advances the high-water marks (warm-up) so we don't
/// notify for mail that was already sitting in the inbox at startup.
fn notify_new_mail(app: &tauri::AppHandle) -> anyhow::Result<()> {
    let state = app.state::<AppState>();
    let warmed = state.notify_warmed.load(Ordering::Relaxed);
    let now_ms = chrono::Utc::now().timestamp_millis();

    let prefs = {
        let conn = state.db.lock().map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
        commands::load_runtime_prefs(&conn)
    };

    let emails: Vec<String> = {
        let conn = state.db.lock().map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
        let mut stmt = conn.prepare("SELECT email FROM accounts")?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        rows.filter_map(|r| r.ok()).collect()
    };

    for email in emails {
        let last = {
            let conn = state.db.lock().map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
            conn.query_row(
                "SELECT last_notified_ms FROM notification_state WHERE account_email = ?1",
                params![email],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0)
        };
        let candidates = unread_inbox_since(&state, &email, last)?;
        let outcome = notify::select_notifications(&prefs, &candidates, last);

        if outcome.new_high_water > last {
            let conn = state.db.lock().map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
            conn.execute(
                "INSERT INTO notification_state (account_email, last_notified_ms)
                 VALUES (?1, ?2)
                 ON CONFLICT(account_email) DO UPDATE SET last_notified_ms = ?2",
                params![email, outcome.new_high_water],
            )?;
        }

        if !warmed {
            continue;
        }
        if let Some(content) = notify::format_notification(&outcome.to_notify) {
            // Single-message notifications deep-link; coalesced ones just open
            // the app (no unambiguous target).
            if let [m] = outcome.to_notify.as_slice() {
                if let Ok(mut guard) = state.pending_open.lock() {
                    *guard = Some(commands::PendingOpen {
                        account_email: m.account_email.clone(),
                        message_id: m.id.clone(),
                        fired_at_ms: now_ms,
                    });
                }
            }
            show_notification(app, &content.title, &content.body);
        }
    }

    state.notify_warmed.store(true, Ordering::Relaxed);
    Ok(())
}

/// Fire a desktop notification.
///
/// On Linux we go straight to notify-rust instead of the Tauri plugin: the
/// plugin omits the `desktop-entry` hint, so KDE/Plasma shows the toast but
/// drops it from the notification history. Setting it to our installed
/// `.desktop` id restores history retention and proper app identity/icon.
fn show_notification(app: &tauri::AppHandle, title: &str, body: &str) {
    #[cfg(target_os = "linux")]
    {
        let _ = app;
        let title = title.to_string();
        let body = body.to_string();
        // show() blocks on a D-Bus round-trip; run it off the main thread.
        tauri::async_runtime::spawn(async move {
            let _ = notify_rust::Notification::new()
                .summary(&title)
                .body(&body)
                .appname("cenmail")
                .hint(notify_rust::Hint::DesktopEntry("dev.cenmail.app".to_string()))
                .show();
        });
    }
    #[cfg(not(target_os = "linux"))]
    {
        use tauri_plugin_notification::NotificationExt;
        if let Err(e) = app.notification().builder().title(title).body(body).show() {
            tracing::warn!(error = %format!("{e:#}"), "show notification failed");
        }
    }
}

/// Unread inbox messages for `email` newer than `since_ms`, oldest first.
fn unread_inbox_since(
    state: &tauri::State<'_, AppState>,
    email: &str,
    since_ms: i64,
) -> anyhow::Result<Vec<crate::gmail::messages::MessageMeta>> {
    use crate::gmail::messages::MessageMeta;
    let conn = state.db.lock().map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
    let mut stmt = conn.prepare(
        "SELECT id, account_email, thread_id, from_header, subject, snippet,
                date_millis, unread, label_ids
         FROM messages
         WHERE account_email = ?1 AND unread = 1 AND has_inbox = 1
               AND date_millis > ?2
         ORDER BY date_millis ASC",
    )?;
    let rows = stmt.query_map(params![email, since_ms], |r| {
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
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

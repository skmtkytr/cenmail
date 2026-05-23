mod commands;
mod config;
mod db;
mod gmail;
mod oauth;
mod secret;

use std::sync::{Arc, Mutex};

use commands::{
    add_account, get_message, list_accounts, list_messages, modify_message, refresh_account,
    remove_account, send_message, sync_account, trash_message, untrash_message, AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "cenmail=info,warn".parse().unwrap());
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let oauth_config = config::OAuthConfig::from_env().expect("load OAuth config from env");
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
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            add_account,
            list_accounts,
            remove_account,
            refresh_account,
            sync_account,
            list_messages,
            get_message,
            modify_message,
            trash_message,
            untrash_message,
            send_message,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

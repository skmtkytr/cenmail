mod commands;
mod config;
mod db;
mod oauth;
mod secret;

use std::sync::Mutex;

use commands::{add_account, list_accounts, remove_account, AppState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let filter = tracing_subscriber::EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| "cenmail=info,warn".parse().unwrap());
    tracing_subscriber::fmt().with_env_filter(filter).init();

    let oauth_config = config::OAuthConfig::from_env().expect("load OAuth config from env");
    let conn = db::open().expect("init sqlite database");

    let state = AppState {
        db: Mutex::new(conn),
        oauth_config,
    };

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(state)
        .invoke_handler(tauri::generate_handler![
            add_account,
            list_accounts,
            remove_account
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

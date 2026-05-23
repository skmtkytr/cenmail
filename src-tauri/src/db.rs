use anyhow::{Context, Result};
use rusqlite::Connection;
use std::path::PathBuf;

pub fn data_dir() -> Result<PathBuf> {
    let base = dirs::data_local_dir().context("could not resolve XDG_DATA_HOME")?;
    let dir = base.join("cenmail");
    std::fs::create_dir_all(&dir).with_context(|| format!("create {}", dir.display()))?;
    Ok(dir)
}

pub fn open() -> Result<Connection> {
    let path = data_dir()?.join("cenmail.db");
    let conn =
        Connection::open(&path).with_context(|| format!("open sqlite at {}", path.display()))?;
    conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;")?;
    init_schema(&conn)?;
    Ok(conn)
}

fn init_schema(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS accounts (
            id            INTEGER PRIMARY KEY AUTOINCREMENT,
            email         TEXT NOT NULL UNIQUE,
            display_name  TEXT,
            picture_url   TEXT,
            provider      TEXT NOT NULL DEFAULT 'gmail',
            created_at    TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS messages (
            id            TEXT NOT NULL,
            account_email TEXT NOT NULL,
            thread_id     TEXT,
            from_header   TEXT NOT NULL DEFAULT '',
            subject       TEXT NOT NULL DEFAULT '',
            snippet       TEXT NOT NULL DEFAULT '',
            date_millis   INTEGER NOT NULL DEFAULT 0,
            unread        INTEGER NOT NULL DEFAULT 0,
            label_ids     TEXT NOT NULL DEFAULT '[]',
            fetched_at    TEXT NOT NULL,
            PRIMARY KEY (account_email, id)
        );

        CREATE INDEX IF NOT EXISTS messages_account_date
          ON messages (account_email, date_millis DESC);
        CREATE INDEX IF NOT EXISTS messages_date
          ON messages (date_millis DESC);

        CREATE TABLE IF NOT EXISTS message_bodies (
            account_email TEXT NOT NULL,
            id            TEXT NOT NULL,
            detail_json   TEXT NOT NULL,
            fetched_at    TEXT NOT NULL,
            PRIMARY KEY (account_email, id)
        );
        "#,
    )?;
    // Best-effort migration: existing accounts table created before
    // `picture_url` was added. ADD COLUMN errors out if it already exists.
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN picture_url TEXT", []);
    Ok(())
}

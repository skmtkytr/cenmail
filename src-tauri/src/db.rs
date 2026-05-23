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
            provider      TEXT NOT NULL DEFAULT 'gmail',
            created_at    TEXT NOT NULL
        );
        "#,
    )?;
    Ok(())
}

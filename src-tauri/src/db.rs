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

        CREATE TABLE IF NOT EXISTS snoozes (
            account_email TEXT NOT NULL,
            message_id    TEXT NOT NULL,
            fire_at_ms    INTEGER NOT NULL,
            PRIMARY KEY (account_email, message_id)
        );
        CREATE INDEX IF NOT EXISTS snoozes_fire_at ON snoozes (fire_at_ms);

        CREATE TABLE IF NOT EXISTS muted_threads (
            account_email TEXT NOT NULL,
            thread_id     TEXT NOT NULL,
            muted_at_ms   INTEGER NOT NULL,
            PRIMARY KEY (account_email, thread_id)
        );

        CREATE TABLE IF NOT EXISTS calendars (
            account_email     TEXT NOT NULL,
            id                TEXT NOT NULL,
            summary           TEXT NOT NULL DEFAULT '',
            description       TEXT,
            time_zone         TEXT,
            background_color  TEXT,
            foreground_color  TEXT,
            is_primary        INTEGER NOT NULL DEFAULT 0,
            selected          INTEGER NOT NULL DEFAULT 1,
            PRIMARY KEY (account_email, id)
        );

        CREATE TABLE IF NOT EXISTS events (
            account_email   TEXT NOT NULL,
            calendar_id     TEXT NOT NULL,
            id              TEXT NOT NULL,
            ical_uid        TEXT,
            summary         TEXT NOT NULL DEFAULT '',
            description     TEXT,
            location        TEXT,
            organizer_email TEXT,
            organizer_name  TEXT,
            start_ms        INTEGER NOT NULL,
            end_ms          INTEGER NOT NULL,
            all_day         INTEGER NOT NULL DEFAULT 0,
            attendees_json  TEXT NOT NULL DEFAULT '[]',
            response_status TEXT,
            html_link       TEXT,
            conference_uri  TEXT,
            status          TEXT,
            fetched_at      TEXT NOT NULL,
            PRIMARY KEY (account_email, calendar_id, id)
        );
        CREATE INDEX IF NOT EXISTS events_start
          ON events (account_email, start_ms);

        CREATE TABLE IF NOT EXISTS scheduled_sends (
            id            TEXT PRIMARY KEY,
            account_email TEXT NOT NULL,
            payload_json  TEXT NOT NULL,
            fire_at_ms    INTEGER NOT NULL,
            created_at    TEXT NOT NULL,
            sent          INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS scheduled_sends_fire_at
          ON scheduled_sends (fire_at_ms) WHERE sent = 0;

        CREATE TABLE IF NOT EXISTS notification_state (
            account_email      TEXT PRIMARY KEY,
            last_notified_ms   INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS label_ids (
            account_email TEXT NOT NULL,
            label_name    TEXT NOT NULL,
            label_id      TEXT NOT NULL,
            PRIMARY KEY (account_email, label_name)
        );
        "#,
    )?;
    // Best-effort column migrations BEFORE any index referencing the new
    // columns. ADD COLUMN errors out if the column already exists, which we
    // swallow.
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN picture_url TEXT", []);
    let _ = conn.execute("ALTER TABLE events ADD COLUMN ical_uid TEXT", []);
    // Per-account Gmail historyId. NULL = needs a bootstrap (full list walk);
    // any other value lets sync_account pull only the diff via history.list.
    let _ = conn.execute("ALTER TABLE accounts ADD COLUMN history_id INTEGER", []);
    // Per-label bit columns: avoid `LIKE '%"INBOX"%'` scans on the JSON-encoded
    // label_ids. Each bit gets a partial index keyed on date so folder views
    // collapse to a covered range scan.
    for col in [
        "has_inbox",
        "has_starred",
        "has_trash",
        "has_spam",
        "has_sent",
        "has_draft",
        "has_chat",
    ] {
        let _ = conn.execute(
            &format!("ALTER TABLE messages ADD COLUMN {col} INTEGER NOT NULL DEFAULT 0"),
            [],
        );
    }
    // Backfill bits for any row that still has label_ids populated but every
    // flag at 0 (i.e. predates this migration). Runs once; subsequent calls
    // skip work because flags will have been set by writers.
    let _ = conn.execute(
        "UPDATE messages SET
            has_inbox   = (label_ids LIKE '%\"INBOX\"%'),
            has_starred = (label_ids LIKE '%\"STARRED\"%'),
            has_trash   = (label_ids LIKE '%\"TRASH\"%'),
            has_spam    = (label_ids LIKE '%\"SPAM\"%'),
            has_sent    = (label_ids LIKE '%\"SENT\"%'),
            has_draft   = (label_ids LIKE '%\"DRAFT\"%'),
            has_chat    = (label_ids LIKE '%\"CHAT\"%')
         WHERE has_inbox = 0 AND has_starred = 0 AND has_trash = 0
           AND has_spam  = 0 AND has_sent    = 0 AND has_draft  = 0
           AND has_chat  = 0
           AND label_ids != '[]'",
        [],
    );

    // Indexes on the new columns — safe to run after the migration succeeded
    // (or noop'd because the column already existed).
    conn.execute_batch(
        "CREATE INDEX IF NOT EXISTS events_ical_uid
           ON events (account_email, ical_uid);
         CREATE INDEX IF NOT EXISTS msg_inbox
           ON messages (account_email, date_millis DESC) WHERE has_inbox = 1;
         CREATE INDEX IF NOT EXISTS msg_starred
           ON messages (account_email, date_millis DESC) WHERE has_starred = 1;
         CREATE INDEX IF NOT EXISTS msg_sent
           ON messages (account_email, date_millis DESC) WHERE has_sent = 1;
         CREATE INDEX IF NOT EXISTS msg_trash
           ON messages (account_email, date_millis DESC) WHERE has_trash = 1;
         CREATE INDEX IF NOT EXISTS msg_spam
           ON messages (account_email, date_millis DESC) WHERE has_spam = 1;
         CREATE INDEX IF NOT EXISTS msg_unread
           ON messages (account_email) WHERE unread = 1;",
    )?;
    Ok(())
}

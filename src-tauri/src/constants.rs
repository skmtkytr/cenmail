//! Tunables shared across the backend. Centralised here so changing
//! parallelism / cadence / retry behaviour is one edit, not a grep
//! and a guessing game.

use std::time::Duration;

// ── Sync ────────────────────────────────────────────────────────────

/// Parallel `messages.get` requests during bootstrap. Higher numbers
/// finish faster but burn quota.
pub const SYNC_PARALLEL: usize = 8;

/// Insert this many rows per transaction during bootstrap.
pub const SYNC_BATCH: usize = 100;

/// Emit a `sync:progress` event every N fetched messages.
pub const SYNC_PROGRESS_EVERY: usize = 50;

// ── Auth retries ────────────────────────────────────────────────────

/// Wait this long after a 401 before retrying with a fresh token.
pub const AUTH_RETRY_DELAY: Duration = Duration::from_millis(500);

/// First sleep when Gmail returns 429 / 403. Doubles per retry.
pub const RATE_LIMIT_BASE_DELAY: Duration = Duration::from_millis(800);

// ── Background timer ────────────────────────────────────────────────

/// Frequency of the global background tick (snoozes, scheduled sends,
/// periodic sync gate).
pub const TIMER_TICK: Duration = Duration::from_secs(60);

/// Minimum wall-clock gap between automatic incremental syncs for the
/// same account. Roughly matches Gmail web's polling cadence.
pub const PERIODIC_SYNC_INTERVAL: Duration = Duration::from_secs(180);

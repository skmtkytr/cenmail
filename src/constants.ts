/// Shared front-end tunables. Centralised so adjusting cadence /
/// limits / storage namespacing is one edit instead of a grep across
/// the codebase.

// ── localStorage keys ────────────────────────────────────────────────

export const DRAFT_STORAGE_KEY = "cenmail:compose-draft";
export const NOTIFY_LAST_SEEN_KEY = "cenmail:last-notified-ms";
export const SETTINGS_STORAGE_KEY = "cenmail:settings";
export const CALENDAR_HOUR_PX_KEY = "cenmail:calendar-hour-px";
export const CALENDAR_VIEW_KEY = "cenmail:calendar-view";

// ── Debounce / interval (milliseconds) ───────────────────────────────

/// Coalesce sync:progress-driven list refetches so a 100-msg sync
/// doesn't paint the list 100 times.
export const LIST_RELOAD_DEBOUNCE_MS = 1500;

/// Wait this long after the last keystroke before uploading the
/// current compose to Gmail Drafts.
export const DRAFT_AUTOSAVE_DEBOUNCE_MS = 1500;

/// Wait this long after a messages:changed burst before reloading
/// the visible folder.
export const MESSAGES_CHANGED_DEBOUNCE_MS = 300;

/// Re-arm the search query after the user stops typing.
export const SEARCH_DEBOUNCE_MS = 200;

// ── Virtualized list ─────────────────────────────────────────────────

/// All message rows render at this height so the windowing layer
/// can skip measurement. Must match the rendered MessageRow exactly
/// — bump together with row padding changes.
export const ROW_HEIGHT_PX = 76;

/// Rows kept rendered above/below the visible window so quick
/// scrolling doesn't flash blank.
export const OVERSCAN_ROWS = 6;

// ── Compose ──────────────────────────────────────────────────────────

/// Gmail's per-message attachment limit (sum of all parts).
export const ATTACHMENT_LIMIT_MB = 25;

// ── Pane sizes ───────────────────────────────────────────────────────

export const PANE_DEFAULTS = { sidebar: 240, list: 384 } as const;
export const PANE_MIN = { sidebar: 160, list: 240 } as const;
export const PANE_MAX = { sidebar: 480, list: 800 } as const;

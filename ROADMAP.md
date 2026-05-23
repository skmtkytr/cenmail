# cenmail Roadmap — Spark-like Features

Prioritized list of Spark-inspired features. Items 1–5 from the original
sweep landed first; calendar (CAL) and CLI (#9) followed; 6–8 remain.

## Shipped

1. **Snooze + Mute thread** — Snooze persists in SQLite and is restored by a
   60s tokio timer that re-adds `INBOX`. Mute archives the thread and records
   it. Mark as Done is folded into Archive.
2. **Smart Inbox classification** — Frontend heuristic over `CATEGORY_*`
   labels + sender local-part patterns. Personal / Newsletters /
   Notifications tabs above the message list when in Inbox.
3. **Threaded conversation view** — `get_thread` backend command, frontend
   renders a stack with the latest message expanded and earlier ones
   collapsed.
4. **Smart Notifications + desktop notifications** — `tauri-plugin-notification`.
   Filtered by per-account toggle + bucket setting; localStorage watermark
   prevents re-notifying on relaunch and a first-tick warmup swallows the
   initial inbox burst.
5. **Undo Send + Schedule send** — Configurable client-side buffer (0/5/10/
   30s) with "Sending… · Undo" toast. Schedule via SQLite-backed queue that
   the tokio timer fires.
9. **`cenmail-cli`** — Headless companion binary in the same Cargo package.
   Direct-to-shell invocation for LLM agents (no MCP overhead).
   - Mail: `accounts`, `list`, `get`, `thread`, `search`, `classify`,
     `snoozed`, `scheduled`, `snooze`, `unsnooze`, `mute`, `unmute`,
     `archive`, `trash`, `mark-read`, `mark-unread`, `star`, `unstar`,
     `send`, `schedule`
   - Calendar: `calendar list`, `calendar sync`, `calendar events`,
     `calendar rsvp`
- **Spam handling** — Right-click → Mark as Spam (with Undo) and Not spam
   (in Spam folder). Spam folder in sidebar. CLI folder filter supports it.
- **Settings UI** (⚙ in sidebar) — Notifications (master / buckets / per-
   account), Appearance (System/Light/Dark), Compose (Undo Send window,
   default sending account), Inbox (mark-as-read-on-open, default bucket),
   Privacy (always-load-remote-images).
- **HTML preview hardening** — sanitizes ICS / scripts / event handlers,
   blocks remote images by default (one-click "Show images"), opens links in
   the OS browser, dark-mode-aware.
- **Calendar (CAL)** — Full Day / Week / Month views.
   - Per-calendar event colour from Google's `backgroundColor` with
     automatic readable text colour
   - Per-account visibility menu grouped by account, persisted
   - Smart packing for overlapping events (Google-style: events expand to
     fill empty sub-columns)
   - Multi-day spanning bars (all-day in week, events in month)
   - Time-axis zoom (Ctrl+scroll or +/-), persisted
   - iCalUID-based dedup when the same logical event appears on multiple
     calendars (primary copy wins)
   - Event detail modal with location / video link / attendees + RSVP
     (hidden for self-organised events)
   - Inline RSVP buttons in the mail preview when a message contains a
     meeting invite (`text/calendar` METHOD:REQUEST)
   - Backend: new `gcal` module, OAuth scope `calendar`, SQLite tables
     `calendars` + `events` (with iCalUID column)

## Remaining

6. **Command Center (Cmd+K)** — Spotlight-style palette listing every action
   with its hotkey. Doubles as a discoverability surface so users find
   features without reading docs.
7. **Saved searches (Smart Folders)** — Persist a Gmail `q` query as a named
   sidebar entry.
8. **Multiple signatures + send-as alias + Templates** — Per-account default
   signature, Gmail send-as alias list in the From picker, reusable body
   templates.

10. ~~Local LLM integration~~ — descoped. AI work is delegated to whatever
    agent is using the host shell (Claude Code, etc.); cenmail exposes its
    state via `cenmail-cli` and lets the agent reason. Raw Gmail / Calendar
    operations that cenmail-cli doesn't cover go through `gws` (Google
    Workspace CLI).

## Out of scope (need hosted infra)

- Shared Inbox / Shared Drafts / Shared Threads / Team Comments / Assignments
- Shared Links (publishing an email as a public URL)
- My Writing Style personalization (training on sent corpus)
- AI Meeting Notes (meeting bot + STT pipeline)
- Cross-device settings sync
- HubSpot CRM integration
- IMAP / non-Gmail providers

## Internal refactor backlog

- `App.tsx` is currently ~1.6k LOC. Phase 1 split off Sidebar, MessageList,
  MessagePreview, ComposeModal, ContextMenu, ShortcutsHelp. Phase 2 should
  lift state into hooks (`useMessages`, `useCompose`, `useShortcuts`,
  `useNotifications`) and expose them via context to drop prop drilling.

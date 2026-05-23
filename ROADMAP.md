# cenmail Roadmap — Spark-like Features

Prioritized list of Spark-inspired features. Items 1–5 landed in the first
sweep; 6–10 are next.

## In scope

1. **Snooze + Mute thread** — ✅ shipped (Snooze + Mute; Mark as Done is folded
   into existing Archive for now). Background tokio timer ticks every 60s and
   restores snoozed messages by re-adding the `INBOX` label.
2. **Smart Inbox classification** — ✅ shipped. Frontend heuristic over
   `CATEGORY_*` labels plus sender local-part patterns; tabs above the message
   list when in Inbox.
3. **Threaded conversation view** — ✅ shipped (preview pane). New
   `get_thread` backend command, frontend renders a stack with the latest
   message expanded and earlier ones collapsed to a single-line header.
4. **Smart Notifications + desktop notifications** — ✅ shipped via
   `tauri-plugin-notification`. Notifies only for new Personal-bucket unread
   messages; localStorage watermark prevents re-notifying on relaunch and a
   first-tick warmup swallows the initial inbox burst.
5. **Undo Send + Schedule send** — ✅ shipped. Undo: 5s client-side buffer
   with a "Sending… · Undo" toast. Schedule: SQLite-backed queue with preset
   times in compose footer; same tokio timer fires sends at their target time.
6. **Command Center (Cmd+K)** — Spotlight-style palette listing every action
   with its hotkey. Doubles as a discoverability surface so users find features
   without reading docs.
7. **Saved searches (Smart Folders)** — Persist a Gmail `q` query as a named
   sidebar entry. Power-user staple.
8. **Multiple signatures + send-as alias + Templates** — Per-account default
   signature, Gmail send-as alias list in the From picker, reusable body
   templates.
9. **`cenmail-cli` — shell-callable surface for LLM agents** — ✅ shipped.
   Installed as a separate binary in the same Cargo package; reuses the
   library's DB / Gmail / keyring code. Designed for direct invocation from
   Claude Code's Bash tool, sidestepping MCP overhead.
   - Read: `accounts`, `list`, `get`, `thread`, `search`, `classify`,
     `snoozed`, `scheduled`
   - Write: `snooze`, `unsnooze`, `mute`, `unmute`, `archive`, `trash`,
     `mark-read`, `mark-unread`, `star`, `unstar`, `send`, `schedule`
10. ~~Local LLM integration~~ — descoped. AI work is delegated to whatever
    agent is using the host shell (Claude Code, etc.); cenmail exposes its
    state via `cenmail-cli` and lets the agent reason. Raw Gmail operations
    that cenmail-cli doesn't cover go through `gws` (Google Workspace CLI).

## Out of scope (need hosted infra)

- Shared Inbox / Shared Drafts / Shared Threads / Team Comments / Assignments
- Shared Links (publishing an email as a public URL)
- My Writing Style personalization (training on sent corpus)
- AI Meeting Notes (meeting bot + STT pipeline)
- Cross-device settings sync
- HubSpot CRM integration

# cenmail repo notes (for Claude Code)

## Operating on the user's mail and calendar

Two CLIs are available — choose by what you need.

### `cenmail-cli`  — cenmail-state-aware operations

Use this whenever the user's intent touches cenmail's local state: the SQLite
cache, snoozes, scheduled sends, the muted-thread set, cenmail's bucket
classifier, or the per-account calendar visibility. Reads are ~free (local
SQLite) and don't burn Google API quota.

#### Mail

```fish
cenmail-cli --help
cenmail-cli accounts
cenmail-cli list --bucket personal --limit 20           # uses cenmail's classifier
cenmail-cli list --folder snoozed                       # cenmail-only state
cenmail-cli list --folder spam                          # spam folder
cenmail-cli get <message_id> --email you@gmail.com      # cached first, falls back to Gmail API
cenmail-cli thread <thread_id> --email you@gmail.com
cenmail-cli classify <message_id> --email you@gmail.com
cenmail-cli snoozed                                     # what's queued to come back
cenmail-cli scheduled                                   # what's queued to send
cenmail-cli snooze <message_id> --email you@gmail.com --until 2h   # humantime or RFC3339
cenmail-cli mute <thread_id> --email you@gmail.com
cenmail-cli archive <message_id> --email you@gmail.com
cenmail-cli trash <message_id> --email you@gmail.com
cenmail-cli mark-read <message_id> --email you@gmail.com
cenmail-cli star <message_id> --email you@gmail.com
cenmail-cli send --from you@gmail.com --to a@b.com --subject ... --body "…"
cenmail-cli schedule --at 2026-05-24T09:00:00Z --from you@gmail.com --to ... --subject ... --body "…"
```

(Spam mutation is not yet a dedicated subcommand — go via `gws` or the GUI.)

#### Calendar

```fish
cenmail-cli calendar list --email you@gmail.com         # cached list (--refresh to refetch)
cenmail-cli calendar sync --email you@gmail.com --from now --to 30d
cenmail-cli calendar events --from now --to 7d --json   # cached events
cenmail-cli calendar rsvp <event_id> --email you@gmail.com --calendar primary --status accepted
```

Output is human-readable by default; pass `--json` on the read commands when
piping into `jq` or feeding back into the model.

The cenmail GUI must have been launched at least once for the OAuth refresh
tokens to exist in the system keyring.

### `gws`  — raw Google API (no cenmail state)

Use this for things cenmail doesn't track or when you want the Google
server's view directly (e.g., labels you created outside cenmail,
attachments, raw MIME, admin operations, calendar features cenmail-cli
doesn't expose).

```fish
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'
gws gmail users labels list --params '{"userId": "me"}'
gws calendar events list --params '{"calendarId": "primary", "maxResults": 10}'
gws schema gmail.users.messages.send
```

`gws` doesn't know about cenmail's snoozes / muted threads / calendar
visibility. If you mutate via `gws`, the cenmail cache won't refresh until
the next background sync.

### Picking between them

| You want… | Use |
|---|---|
| List of snoozed / scheduled-send queue | `cenmail-cli` |
| Bucket classification (Personal/Newsletters/Notifications) | `cenmail-cli` |
| Fast read of cached metadata / events without hitting Google | `cenmail-cli` |
| Send / reply / archive / trash a specific message | `cenmail-cli` (writes Gmail + cache atomically) |
| RSVP to a meeting | `cenmail-cli calendar rsvp` |
| Attachments, multipart MIME inspection, label CRUD, raw API | `gws` |
| Anything not in cenmail-cli's subcommand list | `gws` |

## Data locations

- SQLite cache: `~/.local/share/cenmail/cenmail.db`
- OAuth credentials (env file format): `~/.config/cenmail/credentials.env`
- Refresh tokens: system keyring, service `cenmail`

You can `sqlite3` the cache directly for ad-hoc queries. The schema is in
`src-tauri/src/db.rs`; current tables are:

- `accounts` — registered Google accounts
- `messages` — message metadata (one row per message per account)
- `message_bodies` — full HTML/text bodies, fetched on-demand
- `snoozes` — pending snooze restorations (account_email, message_id, fire_at_ms)
- `scheduled_sends` — pending scheduled sends (id, payload_json, fire_at_ms)
- `muted_threads` — muted thread set
- `calendars` — Google Calendar metadata (id, summary, colors, primary flag)
- `events` — Google Calendar events with `ical_uid` for cross-calendar dedup

## Building

```fish
pnpm install
pnpm app                                      # GUI dev (Tauri + Vite + 1Password env)
cargo build --release --manifest-path src-tauri/Cargo.toml
install -m 755 src-tauri/target/release/cenmail     ~/.local/bin/cenmail
install -m 755 src-tauri/target/release/cenmail-cli ~/.local/bin/cenmail-cli
```

The Cargo package has `default-run = "cenmail"` so plain `cargo run` targets
the GUI. The CLI binary is at `src-tauri/src/bin/cli.rs`.

## Testing

```fish
pnpm test                                                  # frontend (vitest)
pnpm exec tsc --noEmit                                     # type check
cargo test --manifest-path src-tauri/Cargo.toml            # backend
```

## Frontend structure

- `src/App.tsx` — orchestrator: shared state + action wiring + mount points
- `src/sidebar.tsx`, `messageList.tsx`, `messagePreview.tsx`,
  `composeModal.tsx`, `contextMenu.tsx`, `shortcutsHelp.tsx` —
  presentational components
- `src/calendarPane.tsx` — calendar view (Day/Week/Month + picker + modal)
- `src/settings.ts` + `settingsModal.tsx` — settings store + UI
- `src/toast.tsx`, `modal.tsx` — toast + confirm primitives
- `src/htmlSanitize.ts` — message-body sanitizer (remote images, scripts, links)
- `src/utils.ts` — date / from-header / bucket helpers + matchesFolder
- `src/types.ts` — shared types + folder list + snooze presets

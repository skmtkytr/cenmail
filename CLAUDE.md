# cenmail repo notes (for Claude Code)

## Operating on the user's mail from this repo

Two CLIs are available — choose by what you need.

### `cenmail-cli`  — cenmail-state-aware operations

Use this whenever the user's intent touches cenmail's local state: the SQLite
cache, snoozes, scheduled sends, the muted-thread set, or cenmail's bucket
classifier. Reads are ~free (local SQLite) and don't burn Gmail API quota.

```fish
cenmail-cli --help
cenmail-cli accounts
cenmail-cli list --bucket personal --limit 20         # uses cenmail's classifier
cenmail-cli list --folder snoozed                     # cenmail-only state
cenmail-cli get <message_id> --email you@gmail.com    # cached first, falls back to Gmail API
cenmail-cli thread <thread_id> --email you@gmail.com
cenmail-cli classify <message_id> --email you@gmail.com
cenmail-cli snoozed                                   # what's queued to come back
cenmail-cli scheduled                                 # what's queued to send
cenmail-cli snooze <message_id> --email you@gmail.com --until 2h   # humantime or RFC3339
cenmail-cli mute <thread_id> --email you@gmail.com
cenmail-cli archive <message_id> --email you@gmail.com
cenmail-cli send --from you@gmail.com --to a@b.com --subject ... --body "…"
cenmail-cli schedule --at 2026-05-24T09:00:00Z --from you@gmail.com --to ... --subject ... --body "…"
```

Output is human-readable by default; pass `--json` on the read commands when
piping into `jq` or feeding back into the model.

The cenmail GUI must have been launched at least once for the OAuth refresh
tokens to exist in the system keyring.

### `gws`  — raw Gmail API (no cenmail state)

Use this for things cenmail doesn't track or when you want the Gmail server's
view directly (e.g., labels you created outside cenmail, attachments, raw MIME,
multi-account admin operations).

```fish
gws gmail users messages list --params '{"userId": "me", "maxResults": 10}'
gws gmail users labels list --params '{"userId": "me"}'
gws schema gmail.users.messages.send
```

`gws` doesn't know about cenmail's snoozes or muted threads. If you mutate
labels via `gws`, the cenmail cache won't refresh until the next background
sync.

### Picking between them

| You want… | Use |
|---|---|
| List of snoozed / scheduled-send queue | `cenmail-cli` |
| Bucket classification (Personal/Newsletters/Notifications) | `cenmail-cli` |
| Fast read of cached metadata without hitting Gmail | `cenmail-cli` |
| Send / reply / archive / trash a specific message | either (cenmail-cli writes both Gmail + cache atomically) |
| Attachments, multipart MIME inspection, label CRUD | `gws` |
| Anything not in cenmail-cli's subcommand list | `gws` |

## Data locations

- SQLite cache: `~/.local/share/cenmail/cenmail.db`
- OAuth credentials (env file format): `~/.config/cenmail/credentials.env`
- Refresh tokens: system keyring, service `cenmail`

You can `sqlite3` the cache directly for ad-hoc queries. The schema is in
`src-tauri/src/db.rs`; key tables are `accounts`, `messages`, `message_bodies`,
`snoozes`, `scheduled_sends`, `muted_threads`.

## Building

```fish
pnpm install
pnpm app                                      # GUI dev (Tauri + Vite)
cargo build --release --manifest-path src-tauri/Cargo.toml
install -m 755 src-tauri/target/release/cenmail     ~/.local/bin/cenmail
install -m 755 src-tauri/target/release/cenmail-cli ~/.local/bin/cenmail-cli
```

## Testing

```fish
pnpm test                                                          # frontend (vitest)
cargo test --manifest-path src-tauri/Cargo.toml                    # backend
pnpm exec tsc --noEmit                                             # type check
```

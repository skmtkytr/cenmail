# cenmail

**cen**tralized **mail** — a Spark-inspired desktop mail client for Linux.

Built with Tauri 2 (Rust) + Solid.js + TypeScript + Tailwind v4. Gmail-only for now.

## Features

- Multiple Google accounts in a unified inbox (per-account view also available)
- Google OAuth Desktop flow (PKCE, loopback redirect); refresh token stored in the OS keyring
- SQLite cache with incremental sync (message metadata + on-demand full bodies)
- 3-pane layout (account/label list · message list · preview)
- Compose / reply / reply-all / forward / send
- Archive, trash / untrash, star, mark read / unread, label modify
- Full-text search (Gmail `q` syntax passed through)
- Keyboard-driven UI

### Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | Next / previous message |
| `e` | Archive |
| `#` / `Del` | Move to Trash |
| `s` | Toggle star |
| `u` | Toggle read / unread |
| `r` / `a` / `f` | Reply / Reply all / Forward |
| `c` | Compose new |
| `/` | Search |
| `?` | Show shortcut help |
| `Esc` | Close modal / deselect |

## Requirements

- Rust toolchain
- Node 20+ and pnpm
- Linux: `webkit2gtk-4.1`
- A Google Cloud OAuth client (Desktop app type) with the Gmail and userinfo scopes enabled
- [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) for the dev script, or substitute your own way of providing the env vars

## Setup

1. Copy `.env.op.example` to `.env.op` and point the `op://` references at your vault entry (or replace them with plain values if you don't use 1Password — then run without `op run`).
2. Install deps and launch:

```fish
pnpm install
pnpm app   # = op run --env-file=.env.op -- env WEBKIT_DISABLE_DMABUF_RENDERER=1 tauri dev
```

`pnpm app` injects `CENMAIL_GOOGLE_CLIENT_ID` / `CENMAIL_GOOGLE_CLIENT_SECRET` from 1Password into the Tauri process.

> On NVIDIA + Wayland, WebKit2GTK's DMABuf renderer conflicts with the compositor and the window fails to open with Gdk error 71. `WEBKIT_DISABLE_DMABUF_RENDERER=1` (already in `pnpm app`) works around it.

## Data locations

- SQLite cache: `$XDG_DATA_HOME/cenmail/cenmail.db` (typically `~/.local/share/cenmail/cenmail.db`)
- OAuth refresh tokens: system keyring (Secret Service on Linux) under service `cenmail`

## Tests

```fish
pnpm test         # vitest (frontend)
cargo test --manifest-path src-tauri/Cargo.toml
```

## Roadmap

- IMAP / non-Gmail providers
- Threaded conversation view
- Offline send queue
- Attachments in compose

## License

MIT

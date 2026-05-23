# cenmail

**cen**tralized **mail** — a Spark-inspired desktop mail-and-calendar client
for Linux.

Built with Tauri 2 (Rust) + Solid.js + TypeScript + Tailwind v4. Google
(Gmail + Calendar) only for now.

## Features

### Mail

- Multiple Google accounts in a unified inbox (per-account view also available)
- Google OAuth Desktop flow (PKCE, loopback redirect); refresh token stored in
  the OS keyring
- SQLite cache with incremental sync (message metadata + on-demand full bodies)
- 3-pane layout (account/folder list · message list · preview)
- Smart Inbox: auto-classifies into Personal / Newsletters / Notifications tabs
- Threaded conversation view in the preview pane
- Compose / reply / reply-all / forward / send with **Undo Send** buffer
- **Schedule send** (local queue, presets: 1h / this evening / tomorrow /
  next Monday)
- Draft autosave to localStorage
- **Snooze** with presets; messages reappear via a 60-second background timer
- **Mute thread**, **Mark as Spam**, **Not spam**
- Archive, trash / untrash, star, mark read / unread, label modify
- HTML preview that blocks remote images by default (with one-click reveal)
  and opens links in the OS browser; dark-mode-aware
- **Desktop notifications** for new Personal-bucket mail
- Inline **RSVP** (Accept / Maybe / Decline) when an email contains a meeting
  invite (`text/calendar` METHOD:REQUEST)
- Full-text search (Gmail `q` syntax passed through)
- Keyboard-driven UI

### Calendar

- **Day / Week / Month** views (persisted)
- Multi-account, per-calendar visibility menu with per-account grouping
- Per-calendar event colour (Google's `backgroundColor` with automatic
  readable text colour)
- Smart packing for overlapping events (Google-style: events expand to fill
  empty sub-columns when nothing competes for the space)
- Multi-day spanning bars (all-day in week, events in month)
- Time-axis zoom (Ctrl+scroll or +/-), persisted
- iCalUID-based dedup when the same logical event appears in multiple
  calendars (primary calendar's copy wins)
- Event detail modal with location / video link / attendees / Accept-Maybe-
  Decline (hidden for self-organised events)

### Settings (⚙)

- Notifications: master toggle, bucket filter, per-account on/off
- Appearance: System / Light / Dark theme override
- Compose: Undo Send timer (0 / 5 / 10 / 30s), default sending account
- Inbox: mark-as-read-on-open, default bucket tab
- Privacy: always-load-remote-images
- About: paths for SQLite cache, credentials, keyring

### Keyboard shortcuts

| Key | Action |
|---|---|
| `j` / `k` | Next / previous message |
| `e` | Archive |
| `#` / `Del` | Move to Trash |
| `s` | Toggle star |
| `u` | Toggle read / unread |
| `z` | Snooze (1 hour) |
| `m` | Mute thread |
| `Ctrl`+`Z` | Undo last action (archive / trash / snooze / star / spam) |
| `r` / `a` / `f` | Reply / Reply all / Forward |
| `c` | Compose new |
| `Ctrl`+`K` | Command palette |
| `/` | Search |
| `Ctrl`+`Shift`+`R` | Sync now |
| `Ctrl`+`Shift`+`1` / `2` | Switch to Mail / Calendar |
| `?` | Show shortcut help |
| `Esc` | Close modal / deselect |

#### Inside the message body (vimium-style)

Click into the rendered message body once to give the iframe focus, then:

| Key | Action |
|---|---|
| `f` | Show link hints — type the label to open the link in the OS browser |
| `j` / `k` | Scroll down / up |
| `d` / `u` | Half-page down / up |
| `gg` / `G` | Scroll to top / bottom |
| `Esc` | Clear hints, or hand focus back to the list (so `j`/`k` resume navigating messages) |

The bindings only fire while the iframe itself has focus — outside the
message body the host's own shortcuts above keep working.

## Companion CLI: `cenmail-cli`

A headless binary that talks to the same SQLite cache and OAuth credentials.
Designed for direct invocation from shell scripts and LLM agents (instead of
wrapping the same surface in MCP). See [CLAUDE.md](CLAUDE.md) for the full
list of subcommands.

```fish
cenmail-cli list --bucket personal --json
cenmail-cli snoozed
cenmail-cli calendar events --from now --to 7d
cenmail-cli calendar rsvp <event_id> --email you@gmail.com --status accepted
```

## Requirements

- Rust toolchain
- Node 20+ and pnpm
- Linux: `webkit2gtk-4.1`
- A Google Cloud OAuth client (Desktop app type) with Gmail, Calendar, and
  userinfo scopes enabled
- [1Password CLI](https://developer.1password.com/docs/cli/) (`op`) for the
  dev script, or substitute your own way of providing the env vars

## Setup

1. Copy `.env.op.example` to `.env.op` and point the `op://` references at
   your vault entry (or replace them with plain values if you don't use
   1Password — then run without `op run`).
2. Install deps and launch:

```fish
pnpm install
pnpm app   # = op run --env-file=.env.op -- env WEBKIT_DISABLE_DMABUF_RENDERER=1 tauri dev
```

`pnpm app` injects `CENMAIL_GOOGLE_CLIENT_ID` /
`CENMAIL_GOOGLE_CLIENT_SECRET` from 1Password into the Tauri process.

When launched outside of `pnpm app` (e.g. from a desktop menu), cenmail falls
back to reading credentials from `~/.config/cenmail/credentials.env`.

> On NVIDIA + Wayland, WebKit2GTK's DMABuf renderer conflicts with the
> compositor and the window fails to open with Gdk error 71.
> `WEBKIT_DISABLE_DMABUF_RENDERER=1` (already in `pnpm app`) works around it.

## Data locations

- SQLite cache: `$XDG_DATA_HOME/cenmail/cenmail.db` (typically
  `~/.local/share/cenmail/cenmail.db`)
- OAuth credentials (env file): `$XDG_CONFIG_HOME/cenmail/credentials.env`
- OAuth refresh tokens: system keyring (Secret Service on Linux) under
  service `cenmail`

## Tests

```fish
pnpm test                                            # vitest (frontend)
pnpm exec tsc --noEmit                               # type check
cargo test --manifest-path src-tauri/Cargo.toml      # backend
```

## Roadmap

See [ROADMAP.md](ROADMAP.md). High-impact open items: Command Center (Cmd+K),
Saved Searches, multiple signatures + send-as alias + templates.

Out of scope: IMAP / non-Gmail providers, shared inbox / team features,
attachments in compose (yet).

## License

MIT

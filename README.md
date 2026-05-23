# cenmail

**cen**tralized **mail** — a Spark-inspired desktop mail client for Linux.

Built with Tauri (Rust backend) + Solid.js (web frontend). Currently in early Phase 0 scaffold.

## Goals

- 複数アカウントの統合受信トレイ
- キーボードショートカットによる高速操作 (read / archive / reply)
- プレビューペイン (3 ペインレイアウト)
- Gmail OAuth + Gmail API でまず動かす、IMAP は後追い

## Development

Requires: Rust toolchain, Node 20+, pnpm, `webkit2gtk-4.1` (Linux).

```fish
pnpm install
pnpm app   # WEBKIT_DISABLE_DMABUF_RENDERER=1 tauri dev
```

> NVIDIA + Wayland 環境では WebKit2GTK の DMABuf レンダラーが Wayland とぶつかるため
> `WEBKIT_DISABLE_DMABUF_RENDERER=1` を付けないと Gdk Error 71 で起動しません。
> `pnpm app` スクリプトに同梱済み。

## Status

| Phase | Description | Status |
|---|---|---|
| 0 | Scaffold (Tauri + Solid + TS + Tailwind) | in progress |
| 1 | Google OAuth Desktop flow + token storage | planned |
| 2 | Gmail API: fetch & display message list | planned |
| 3 | SQLite cache + History API incremental sync | planned |
| 4 | Keyboard shortcuts (j/k/e/r/c) | planned |
| 5 | Multi-account unified inbox | planned |
| 6 | Compose + reply + send | planned |

## License

MIT

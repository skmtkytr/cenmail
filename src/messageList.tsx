import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { formatRelativeDate, parseFromHeader, type Bucket } from "./utils";
import type { Account, MessageMeta } from "./types";

type BucketCounts = {
  personal: number;
  newsletters: number;
  notifications: number;
};

import { OVERSCAN_ROWS, ROW_HEIGHT_PX } from "./constants";

export function MessageList(props: {
  width: number;
  accounts: Account[];
  headerTitle: string;
  messages: MessageMeta[];
  messagesLoading: boolean;
  hasCache: boolean;
  messagesError: string | null;
  selectedMessageId: string | null;
  selectedFolder: string;
  selectedBucket: Bucket | "all";
  setSelectedBucket: (b: Bucket | "all") => void;
  bucketCounts: BucketCounts;
  searchQuery: string;
  onSearchInput: (v: string) => void;
  onClearSearch: () => void;
  setSearchInputRef: (el: HTMLInputElement) => void;
  syncingHint: boolean;
  onShowShortcuts: () => void;
  isSelected: (id: string) => boolean;
  onRowClick: (e: MouseEvent, m: MessageMeta) => void;
  onContextMenu: (e: MouseEvent, m: MessageMeta) => void;
  onSelectOnlyForContext: (m: MessageMeta) => void;
  onToggleStar: (m: MessageMeta) => void;
}) {
  return (
    <section
      class="flex shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg)]"
      style={{ width: `${props.width}px` }}
    >
      <header class="flex items-center justify-between gap-2 px-4 py-3">
        <h2 class="truncate text-sm font-semibold">{props.headerTitle}</h2>
        <div class="flex shrink-0 items-center gap-2 text-xs text-[color:var(--color-muted)]">
          <span>
            {props.messagesLoading
              ? `${props.messages.length} ↻`
              : `${props.messages.length.toLocaleString()} messages`}
          </span>
          <button
            type="button"
            onClick={props.onShowShortcuts}
            title="Keyboard shortcuts (?)"
            aria-label="Keyboard shortcuts"
            class="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] hover:bg-[color:var(--color-surface-hover)]"
          >
            ?
          </button>
        </div>
      </header>
      <div class="px-4 pb-2">
        <div class="flex items-center gap-2 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-sm focus-within:border-[color:var(--color-accent)]">
          <span class="text-[color:var(--color-muted)]">⌕</span>
          <input
            ref={props.setSearchInputRef}
            value={props.searchQuery}
            onInput={(e) => props.onSearchInput(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.stopPropagation();
                if (props.searchQuery.length > 0) {
                  props.onClearSearch();
                } else {
                  (e.currentTarget as HTMLInputElement).blur();
                }
              }
            }}
            placeholder="Search subject / from / snippet"
            class="flex-1 bg-transparent outline-none placeholder:text-[color:var(--color-muted)]"
          />
          <Show when={props.searchQuery.length > 0}>
            <button
              type="button"
              onClick={props.onClearSearch}
              class="text-xs text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]"
              aria-label="Clear search"
            >
              ×
            </button>
          </Show>
        </div>
      </div>
      <Show when={props.messagesError}>
        <div class="mx-4 mb-2 rounded border border-red-400 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
          {props.messagesError}
        </div>
      </Show>
      <Show when={props.selectedFolder === "inbox"}>
        <div class="flex shrink-0 gap-1 border-b border-[color:var(--color-border)] px-3 py-1.5 text-xs">
          <For
            each={
              [
                { id: "all" as const, label: "All", count: null },
                {
                  id: "personal" as const,
                  label: "Personal",
                  count: props.bucketCounts.personal,
                },
                {
                  id: "newsletters" as const,
                  label: "Newsletters",
                  count: props.bucketCounts.newsletters,
                },
                {
                  id: "notifications" as const,
                  label: "Notifications",
                  count: props.bucketCounts.notifications,
                },
              ]
            }
          >
            {(b) => {
              const active = () => props.selectedBucket === b.id;
              return (
                <button
                  type="button"
                  onClick={() => props.setSelectedBucket(b.id)}
                  class={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                    active()
                      ? "bg-[color:var(--color-accent-bg)] text-[color:var(--color-fg)] font-medium"
                      : "text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
                  }`}
                >
                  <span>{b.label}</span>
                  <Show when={b.count !== null && b.count > 0}>
                    <span class="text-[color:var(--color-muted)]">{b.count}</span>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
      <VirtualizedList
        messages={props.messages}
        messagesLoading={props.messagesLoading}
        hasCache={props.hasCache}
        accounts={props.accounts}
        syncingHint={props.syncingHint}
        selectedMessageId={props.selectedMessageId}
        isSelected={props.isSelected}
        onRowClick={props.onRowClick}
        onContextMenu={props.onContextMenu}
        onSelectOnlyForContext={props.onSelectOnlyForContext}
        onToggleStar={props.onToggleStar}
      />
    </section>
  );
}

function VirtualizedList(props: {
  messages: MessageMeta[];
  messagesLoading: boolean;
  hasCache: boolean;
  accounts: Account[];
  syncingHint: boolean;
  selectedMessageId: string | null;
  isSelected: (id: string) => boolean;
  onRowClick: (e: MouseEvent, m: MessageMeta) => void;
  onContextMenu: (e: MouseEvent, m: MessageMeta) => void;
  onSelectOnlyForContext: (m: MessageMeta) => void;
  onToggleStar: (m: MessageMeta) => void;
}) {
  let scrollEl: HTMLDivElement | undefined;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewportH, setViewportH] = createSignal(800);
  const accountsByEmail = createMemo(() => {
    const m = new Map<string, Account>();
    for (const a of props.accounts) m.set(a.email, a);
    return m;
  });

  onMount(() => {
    if (!scrollEl) return;
    setViewportH(scrollEl.clientHeight);
    const ro = new ResizeObserver((entries) => {
      const h = entries[0]?.contentRect.height;
      if (h) setViewportH(h);
    });
    ro.observe(scrollEl);
    onCleanup(() => ro.disconnect());
  });

  const range = createMemo(() => {
    const total = props.messages.length;
    if (total === 0) return { start: 0, end: 0 };
    const start = Math.max(
      0,
      Math.floor(scrollTop() / ROW_HEIGHT_PX) - OVERSCAN_ROWS,
    );
    const visible = Math.ceil(viewportH() / ROW_HEIGHT_PX) + OVERSCAN_ROWS * 2;
    const end = Math.min(total, start + visible);
    return { start, end };
  });

  const slice = createMemo(() =>
    props.messages.slice(range().start, range().end),
  );

  // Keep the selected row in view as the user steps j/k or clicks anywhere.
  // Without this the absolute-positioned rows happily render outside the
  // viewport (no native focus to follow) and j past the bottom leaves the
  // selection invisible.
  createEffect(() => {
    const id = props.selectedMessageId;
    if (!id || !scrollEl) return;
    const idx = props.messages.findIndex((m) => m.id === id);
    if (idx < 0) return;
    const rowTop = idx * ROW_HEIGHT_PX;
    const rowBottom = rowTop + ROW_HEIGHT_PX;
    const viewTop = scrollEl.scrollTop;
    const viewBottom = viewTop + viewportH();
    if (rowTop < viewTop) {
      scrollEl.scrollTop = rowTop;
    } else if (rowBottom > viewBottom) {
      scrollEl.scrollTop = rowBottom - viewportH();
    }
  });

  return (
    <div
      ref={(el) => (scrollEl = el)}
      onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      class="flex-1 overflow-y-auto"
    >
      <Show
        when={
          !props.messagesLoading &&
          props.hasCache &&
          props.messages.length === 0
        }
      >
        <div class="px-4 py-8 text-center text-sm text-[color:var(--color-muted)]">
          {props.accounts.length === 0
            ? "Add an account to get started."
            : props.syncingHint
              ? "Syncing…"
              : "No messages."}
        </div>
      </Show>
      <Show when={props.messagesLoading && !props.hasCache}>
        <div class="px-4 py-8 text-center text-sm text-[color:var(--color-muted)]">
          Loading…
        </div>
      </Show>
      <Show when={props.messages.length > 0}>
        <div
          style={{
            height: `${props.messages.length * ROW_HEIGHT_PX}px`,
            position: "relative",
          }}
        >
          <For each={slice()}>
            {(m, i) => (
              <MessageRow
                m={m}
                active={props.selectedMessageId === m.id}
                isSelected={props.isSelected(m.id)}
                accountsByEmail={accountsByEmail()}
                top={(range().start + i()) * ROW_HEIGHT_PX}
                height={ROW_HEIGHT_PX}
                onClick={(e) => props.onRowClick(e, m)}
                onContextMenu={(e) => {
                  if (!props.isSelected(m.id)) {
                    props.onSelectOnlyForContext(m);
                  }
                  props.onContextMenu(e, m);
                }}
                onToggleStar={() => props.onToggleStar(m)}
              />
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

function MessageRow(props: {
  m: MessageMeta;
  active: boolean;
  isSelected: boolean;
  accountsByEmail: Map<string, Account>;
  top: number;
  height: number;
  onClick: (e: MouseEvent) => void;
  onContextMenu: (e: MouseEvent) => void;
  onToggleStar: () => void;
}) {
  const fromParsed = () => parseFromHeader(props.m.from);
  const acct = () => props.accountsByEmail.get(props.m.account_email);
  const isStarred = () => props.m.label_ids.includes("STARRED");
  return (
    <div
      onClick={props.onClick}
      onContextMenu={props.onContextMenu}
      style={{
        position: "absolute",
        top: `${props.top}px`,
        left: "0",
        right: "0",
        height: `${props.height}px`,
      }}
      class={`group flex cursor-pointer select-none items-start gap-3 border-b border-[color:var(--color-border)] px-4 py-3 hover:bg-[color:var(--color-surface-hover)] ${
        props.isSelected ? "bg-[color:var(--color-accent-bg)]" : ""
      } ${
        props.active && !props.isSelected
          ? "ring-1 ring-inset ring-[color:var(--color-accent)]"
          : ""
      }`}
    >
      <Show
        when={acct()?.picture_url}
        fallback={
          <div
            class="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
            title={props.m.account_email}
          >
            {props.m.account_email.charAt(0).toUpperCase()}
          </div>
        }
      >
        <img
          src={acct()!.picture_url!}
          class="size-6 shrink-0 rounded-full object-cover"
          alt=""
          title={props.m.account_email}
          referrerpolicy="no-referrer"
        />
      </Show>
      <div
        class={`flex w-1.5 shrink-0 self-stretch items-center justify-center ${
          props.m.unread ? "" : "invisible"
        }`}
      >
        <span class="size-1.5 rounded-full bg-[color:var(--color-accent)]" />
      </div>
      <div
        class={`min-w-0 flex-1 ${
          props.m.unread ? "" : "text-[color:var(--color-muted)]"
        }`}
      >
        <div class="flex justify-between gap-2">
          <span
            class={`truncate text-sm ${
              props.m.unread
                ? "font-semibold text-[color:var(--color-fg)]"
                : ""
            }`}
          >
            {fromParsed().name}
          </span>
          <div class="flex shrink-0 items-center gap-1.5 text-xs">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onToggleStar();
              }}
              title={isStarred() ? "Remove star" : "Star"}
              aria-label={isStarred() ? "Remove star" : "Star"}
              class={`text-sm leading-none ${
                isStarred()
                  ? "text-yellow-500"
                  : "text-transparent group-hover:text-[color:var(--color-muted)] hover:!text-yellow-500"
              }`}
            >
              ★
            </button>
            <span title={new Date(props.m.date_millis).toLocaleString()}>
              {formatRelativeDate(props.m.date_millis)}
            </span>
          </div>
        </div>
        <div
          class={`truncate text-sm ${
            props.m.unread
              ? "font-medium text-[color:var(--color-fg)]"
              : ""
          }`}
        >
          {props.m.subject || "(no subject)"}
        </div>
        <div class="truncate text-xs text-[color:var(--color-muted)]">
          {props.m.snippet}
        </div>
      </div>
    </div>
  );
}

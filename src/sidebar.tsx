import { For, Show } from "solid-js";
import type { Account, Folder, SyncState } from "./types";
import type { AccountSelection } from "./utils";

export type ViewMode = "mail" | "calendar";

export type AggregateSync = { label: string; syncing: boolean } | null;

export function Sidebar(props: {
  width: number;
  accounts: Account[];
  folders: Folder[];
  viewMode: ViewMode;
  setViewMode: (v: ViewMode) => void;
  selectedAccount: AccountSelection;
  setSelectedAccount: (a: AccountSelection) => void;
  selectedFolder: string;
  setSelectedFolder: (f: string) => void;
  syncState: Record<string, SyncState>;
  aggregateSync: AggregateSync;
  addingAccount: boolean;
  addError: string | null;
  onAddAccount: () => void;
  onRemoveAccount: (id: number) => void;
  onCompose: () => void;
  onRefresh: () => void;
  onOpenSettings: () => void;
}) {
  return (
    <aside
      class="flex shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)]"
      style={{ width: `${props.width}px` }}
    >
      <div class="flex items-center justify-between px-4 py-3">
        <span class="text-sm font-semibold tracking-wide">cenmail</span>
        <div class="flex items-center gap-1">
          <button
            type="button"
            onClick={props.onOpenSettings}
            title="Settings"
            class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
            aria-label="Settings"
          >
            ⚙
          </button>
          <button
            type="button"
            onClick={props.onRefresh}
            title="Sync now"
            class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
            aria-label="Sync now"
          >
            ↻
          </button>
        </div>
      </div>
      <div class="flex shrink-0 gap-0.5 px-2 pb-2 text-xs">
        <button
          type="button"
          onClick={() => props.setViewMode("mail")}
          class={`flex-1 rounded px-2 py-1 ${
            props.viewMode === "mail"
              ? "bg-[color:var(--color-surface-active)] font-medium"
              : "text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
          }`}
        >
          Mail
        </button>
        <button
          type="button"
          onClick={() => props.setViewMode("calendar")}
          class={`flex-1 rounded px-2 py-1 ${
            props.viewMode === "calendar"
              ? "bg-[color:var(--color-surface-active)] font-medium"
              : "text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
          }`}
        >
          Calendar
        </button>
      </div>
      <Show when={props.viewMode === "mail"}>
        <div class="px-2 pb-2">
          <button
            type="button"
            onClick={props.onCompose}
            disabled={props.accounts.length === 0}
            class="flex w-full items-center justify-center gap-2 rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ✎ Compose
          </button>
        </div>
      </Show>

      <div class="px-2">
        <button
          type="button"
          onClick={() => props.setSelectedAccount("all")}
          class={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-hover)] ${
            props.selectedAccount === "all"
              ? "bg-[color:var(--color-surface-active)] font-medium"
              : ""
          }`}
        >
          <div class="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-400 text-xs text-white">
            ∞
          </div>
          <span class="truncate">All Inboxes</span>
        </button>
        <For each={props.accounts}>
          {(a) => {
            const isActive = () => props.selectedAccount === a.id;
            const state = (): SyncState | undefined => props.syncState[a.email];
            return (
              <div
                class={`group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)] ${
                  isActive()
                    ? "bg-[color:var(--color-surface-active)] font-medium"
                    : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => props.setSelectedAccount(a.id)}
                  class="flex flex-1 items-center gap-2 overflow-hidden text-left"
                >
                  <Show
                    when={a.picture_url}
                    fallback={
                      <div class="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                        {a.email.charAt(0).toUpperCase()}
                      </div>
                    }
                  >
                    <img
                      src={a.picture_url ?? ""}
                      class="size-6 shrink-0 rounded-full object-cover"
                      alt=""
                      referrerpolicy="no-referrer"
                    />
                  </Show>
                  <span class="truncate">{a.email}</span>
                  <Show when={state()?.status === "syncing"}>
                    <span class="ml-auto text-xs text-[color:var(--color-muted)]">
                      ↻
                    </span>
                  </Show>
                  <Show when={state()?.status === "error"}>
                    <span
                      class="ml-auto text-xs text-red-500"
                      title={state()?.error}
                    >
                      !
                    </span>
                  </Show>
                </button>
                <button
                  type="button"
                  title="Remove account"
                  onClick={() => props.onRemoveAccount(a.id)}
                  class="hidden text-[color:var(--color-muted)] hover:text-red-500 group-hover:block"
                  aria-label={`Remove ${a.email}`}
                >
                  ×
                </button>
              </div>
            );
          }}
        </For>
        <button
          type="button"
          onClick={props.onAddAccount}
          disabled={props.addingAccount}
          class="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
        >
          <span class="size-2 rounded-full border border-current" />
          <span>{props.addingAccount ? "Authorizing…" : "+ Add account"}</span>
        </button>
        <Show when={props.addError}>
          <div class="mt-2 rounded border border-red-400 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
            {props.addError}
          </div>
        </Show>
      </div>

      <Show
        when={props.viewMode === "mail"}
        fallback={<div class="mt-4 flex-1" />}
      >
        <nav class="mt-4 flex-1 overflow-y-auto px-2">
          <For each={props.folders}>
            {(f) => {
              const active = () => props.selectedFolder === f.id;
              return (
                <button
                  type="button"
                  onClick={() => props.setSelectedFolder(f.id)}
                  class={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-hover)] ${
                    active()
                      ? "bg-[color:var(--color-surface-active)] font-medium"
                      : ""
                  }`}
                >
                  <span>{f.label}</span>
                </button>
              );
            }}
          </For>
        </nav>
      </Show>
      <div class="border-t border-[color:var(--color-border)] px-4 py-2 text-xs text-[color:var(--color-muted)]">
        <Show when={props.aggregateSync} fallback={<span>Idle</span>}>
          {(s) => (
            <span class={s().syncing ? "text-[color:var(--color-accent)]" : ""}>
              {s().label}
            </span>
          )}
        </Show>
      </div>
    </aside>
  );
}

import { For, Show, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "./App.css";

type Account = {
  id: number;
  email: string;
  display_name: string | null;
  provider: string;
  created_at: string;
};

type Folder = { id: string; label: string; unread: number };
type MessagePreview = {
  id: string;
  accountId: string;
  from: string;
  subject: string;
  snippet: string;
  date: string;
  unread: boolean;
};

const folders: Folder[] = [
  { id: "inbox", label: "Inbox", unread: 0 },
  { id: "pinned", label: "Pinned", unread: 0 },
  { id: "sent", label: "Sent", unread: 0 },
  { id: "archive", label: "Archive", unread: 0 },
  { id: "trash", label: "Trash", unread: 0 },
];

const messages: MessagePreview[] = [];

function colorForEmail(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 65% 55%)`;
}

function App() {
  const [selectedFolder, setSelectedFolder] = createSignal("inbox");
  const [selectedMessage, setSelectedMessage] = createSignal<string | null>(null);
  const [selectedAccount, setSelectedAccount] = createSignal<number | "all">("all");
  const [addingAccount, setAddingAccount] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);

  const [accounts, { refetch: refetchAccounts }] = createResource<Account[]>(
    async () => await invoke<Account[]>("list_accounts"),
    { initialValue: [] },
  );

  let unlisten: UnlistenFn | undefined;
  onMount(async () => {
    unlisten = await listen("accounts:changed", () => {
      refetchAccounts();
    });
  });
  onCleanup(() => {
    unlisten?.();
  });

  async function handleAddAccount() {
    setAddError(null);
    setAddingAccount(true);
    try {
      await invoke("add_account");
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAddingAccount(false);
    }
  }

  async function handleRemoveAccount(id: number) {
    if (!confirm("Remove this account from cenmail?")) return;
    try {
      await invoke("remove_account", { id });
    } catch (err) {
      setAddError(String(err));
    }
  }

  return (
    <div class="flex h-full w-full text-[color:var(--color-fg)]">
      <aside class="flex w-60 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm font-semibold tracking-wide">cenmail</span>
        </div>

        <div class="px-2">
          <button
            type="button"
            onClick={() => setSelectedAccount("all")}
            class={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-hover)] ${
              selectedAccount() === "all"
                ? "bg-[color:var(--color-surface-active)] font-medium"
                : ""
            }`}
          >
            <span class="size-2 rounded-full bg-zinc-500" />
            <span class="truncate">All Inboxes</span>
          </button>
          <For each={accounts() ?? []}>
            {(a) => {
              const isActive = () => selectedAccount() === a.id;
              return (
                <div
                  class={`group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)] ${
                    isActive() ? "bg-[color:var(--color-surface-active)] font-medium" : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedAccount(a.id)}
                    class="flex flex-1 items-center gap-2 overflow-hidden text-left"
                  >
                    <span
                      class="size-2 shrink-0 rounded-full"
                      style={{ background: colorForEmail(a.email) }}
                    />
                    <span class="truncate">{a.display_name ?? a.email}</span>
                  </button>
                  <button
                    type="button"
                    title="Remove account"
                    onClick={() => handleRemoveAccount(a.id)}
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
            onClick={handleAddAccount}
            disabled={addingAccount()}
            class="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
          >
            <span class="size-2 rounded-full border border-current" />
            <span>{addingAccount() ? "Authorizing…" : "+ Add account"}</span>
          </button>
          <Show when={addError()}>
            <div class="mt-2 rounded border border-red-400 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
              {addError()}
            </div>
          </Show>
        </div>

        <nav class="mt-4 flex-1 overflow-y-auto px-2">
          <For each={folders}>
            {(f) => {
              const active = () => selectedFolder() === f.id;
              return (
                <button
                  type="button"
                  onClick={() => setSelectedFolder(f.id)}
                  class={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-hover)] ${
                    active()
                      ? "bg-[color:var(--color-surface-active)] font-medium"
                      : ""
                  }`}
                >
                  <span>{f.label}</span>
                  {f.unread > 0 && (
                    <span class="rounded-full bg-[color:var(--color-badge-bg)] px-2 py-0.5 text-xs">
                      {f.unread}
                    </span>
                  )}
                </button>
              );
            }}
          </For>
        </nav>
        <div class="border-t border-[color:var(--color-border)] px-4 py-2 text-xs text-[color:var(--color-muted)]">
          Phase 1 · accounts
        </div>
      </aside>

      <section class="flex w-96 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg)]">
        <header class="flex items-center justify-between px-4 py-3">
          <h2 class="text-sm font-semibold capitalize">{selectedFolder()}</h2>
          <span class="text-xs text-[color:var(--color-muted)]">
            {messages.length} messages
          </span>
        </header>
        <ul class="flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <li class="px-4 py-8 text-center text-sm text-[color:var(--color-muted)]">
              {(accounts() ?? []).length === 0
                ? "アカウントを追加してください。"
                : "Phase 2 で Gmail からメッセージを取得します。"}
            </li>
          ) : (
            <For each={messages}>
              {(m) => {
                const active = () => selectedMessage() === m.id;
                return (
                  <li
                    onClick={() => setSelectedMessage(m.id)}
                    class={`cursor-pointer border-b border-[color:var(--color-border)] px-4 py-3 hover:bg-[color:var(--color-surface-hover)] ${
                      active() ? "bg-[color:var(--color-accent-bg)]" : ""
                    }`}
                  >
                    <div class="flex justify-between gap-2">
                      <span
                        class={`truncate text-sm ${
                          m.unread ? "font-semibold" : ""
                        }`}
                      >
                        {m.from}
                      </span>
                      <span class="shrink-0 text-xs text-[color:var(--color-muted)]">
                        {m.date}
                      </span>
                    </div>
                    <div class="truncate text-sm">{m.subject}</div>
                    <div class="truncate text-xs text-[color:var(--color-muted)]">
                      {m.snippet}
                    </div>
                  </li>
                );
              }}
            </For>
          )}
        </ul>
      </section>

      <section class="flex flex-1 flex-col bg-[color:var(--color-surface)]">
        <div class="flex-1 overflow-y-auto p-8 text-sm text-[color:var(--color-muted)]">
          {selectedMessage() === null
            ? "メッセージを選択してください。"
            : `Message: ${selectedMessage()}`}
        </div>
      </section>
    </div>
  );
}

export default App;

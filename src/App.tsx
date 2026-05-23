import { For, createSignal } from "solid-js";
import "./App.css";

type Account = { id: string; label: string; email: string; color: string };
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

const accounts: Account[] = [
  { id: "all", label: "All Inboxes", email: "", color: "bg-zinc-500" },
];

const folders: Folder[] = [
  { id: "inbox", label: "Inbox", unread: 0 },
  { id: "pinned", label: "Pinned", unread: 0 },
  { id: "sent", label: "Sent", unread: 0 },
  { id: "archive", label: "Archive", unread: 0 },
  { id: "trash", label: "Trash", unread: 0 },
];

const messages: MessagePreview[] = [];

function App() {
  const [selectedFolder, setSelectedFolder] = createSignal("inbox");
  const [selectedMessage, setSelectedMessage] = createSignal<string | null>(null);

  return (
    <div class="flex h-full w-full text-[color:var(--color-fg)]">
      <aside class="flex w-56 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
        <div class="px-4 py-3 text-sm font-semibold tracking-wide">cenmail</div>
        <div class="px-2">
          <For each={accounts}>
            {(a) => (
              <div class="flex items-center gap-2 rounded px-2 py-1 text-sm">
                <span class={`size-2 rounded-full ${a.color}`} />
                <span class="truncate">{a.label}</span>
              </div>
            )}
          </For>
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
          Phase 0 · scaffold
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
              アカウント未追加。Phase 1 で OAuth フローを実装します。
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

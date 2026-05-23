import { For, Show, createSignal } from "solid-js";
import type { Account, ComposeState } from "./types";
import { snoozePresets } from "./types";

export function ComposeModal(props: {
  compose: ComposeState | null;
  accounts: Account[];
  sendError: string | null;
  onClose: () => void;
  onSend: () => void;
  onScheduleSend: (fireAtMs: number) => void;
  onUpdate: <K extends keyof ComposeState>(key: K, value: ComposeState[K]) => void;
}) {
  const [scheduleMenuOpen, setScheduleMenuOpen] = createSignal(false);
  return (
    <Show when={props.compose}>
      {(cs) => (
        <div
          class="fixed inset-0 z-40 flex items-end justify-end p-4 sm:items-center sm:justify-center sm:p-8"
          onClick={props.onClose}
        >
          <div
            class="absolute inset-0 bg-black/40"
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            class="relative flex h-[640px] w-full max-w-3xl flex-col rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header class="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-3">
              <span class="text-sm font-semibold">
                {cs().in_reply_to
                  ? "Reply"
                  : cs().subject.startsWith("Fwd:")
                    ? "Forward"
                    : "New message"}
              </span>
              <button
                type="button"
                onClick={props.onClose}
                class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
              <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                From
              </span>
              <select
                value={cs().from_account}
                onChange={(e) =>
                  props.onUpdate("from_account", e.currentTarget.value)
                }
                class="flex-1 bg-transparent outline-none"
              >
                <For each={props.accounts}>
                  {(a) => <option value={a.email}>{a.email}</option>}
                </For>
              </select>
            </div>

            <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
              <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                To
              </span>
              <input
                value={cs().to}
                onInput={(e) => props.onUpdate("to", e.currentTarget.value)}
                placeholder="recipient@example.com, another@example.com"
                class="flex-1 bg-transparent outline-none"
              />
              <Show when={!cs().show_cc_bcc}>
                <button
                  type="button"
                  onClick={() => props.onUpdate("show_cc_bcc", true)}
                  class="text-xs text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]"
                >
                  Cc / Bcc
                </button>
              </Show>
            </div>

            <Show when={cs().show_cc_bcc}>
              <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
                <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                  Cc
                </span>
                <input
                  value={cs().cc}
                  onInput={(e) => props.onUpdate("cc", e.currentTarget.value)}
                  class="flex-1 bg-transparent outline-none"
                />
              </div>
              <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
                <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                  Bcc
                </span>
                <input
                  value={cs().bcc}
                  onInput={(e) => props.onUpdate("bcc", e.currentTarget.value)}
                  class="flex-1 bg-transparent outline-none"
                />
              </div>
            </Show>

            <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
              <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                Subject
              </span>
              <input
                value={cs().subject}
                onInput={(e) =>
                  props.onUpdate("subject", e.currentTarget.value)
                }
                class="flex-1 bg-transparent outline-none"
              />
            </div>

            <textarea
              value={cs().body}
              onInput={(e) => props.onUpdate("body", e.currentTarget.value)}
              placeholder="Write your message…"
              class="flex-1 resize-none bg-transparent p-4 text-sm leading-relaxed outline-none"
            />

            <Show when={props.sendError}>
              <div class="mx-4 mb-2 rounded border border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
                {props.sendError}
              </div>
            </Show>

            <footer class="flex items-center justify-end gap-2 border-t border-[color:var(--color-border)] px-4 py-3">
              <div class="relative mr-auto">
                <button
                  type="button"
                  onClick={() => setScheduleMenuOpen(!scheduleMenuOpen())}
                  class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
                >
                  Send later ▾
                </button>
                <Show when={scheduleMenuOpen()}>
                  <ul class="absolute bottom-full left-0 mb-1 min-w-44 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-1 text-sm shadow-lg">
                    <For each={snoozePresets()}>
                      {(p) => (
                        <li>
                          <button
                            type="button"
                            class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                            onClick={() => {
                              setScheduleMenuOpen(false);
                              props.onScheduleSend(p.fireAt);
                            }}
                          >
                            {p.label}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <button
                type="button"
                onClick={props.onClose}
                class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={props.onSend}
                class="rounded bg-[color:var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Send
              </button>
            </footer>
          </div>
        </div>
      )}
    </Show>
  );
}

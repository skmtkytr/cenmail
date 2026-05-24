import { For, Show, createEffect, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { useEscClose } from "./modal";
import { showToast } from "./toast";

export type ScheduledRow = {
  id: string;
  account_email: string;
  fire_at_ms: number;
  subject: string;
  to: string;
};

export function ScheduledSendsModal(props: {
  open: boolean;
  onClose: () => void;
}) {
  useEscClose(() => props.open, () => props.onClose());
  const [rows, setRows] = createSignal<ScheduledRow[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await invoke<ScheduledRow[]>("list_scheduled");
      setRows(data);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  // Pull fresh data each time the modal opens so newly scheduled sends
  // (or already-fired ones the timer has consumed) reflect immediately.
  createEffect(() => {
    if (props.open) void refresh();
  });

  async function cancel(id: string) {
    try {
      await invoke("cancel_scheduled", { id });
      setRows(rows().filter((r) => r.id !== id));
      showToast({ message: "Scheduled send cancelled" });
    } catch (err) {
      showToast({ message: `Cancel failed: ${err}`, variant: "error" });
    }
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
        onClick={props.onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Scheduled sends"
          class="flex max-h-[70vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
            <h2 class="text-base font-semibold">Scheduled sends</h2>
            <button
              type="button"
              onClick={props.onClose}
              class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
              aria-label="Close"
            >
              ×
            </button>
          </header>
          <div class="flex-1 overflow-y-auto text-sm">
            <Show when={error()}>
              <div class="mx-5 mt-4 rounded border border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
                {error()}
              </div>
            </Show>
            <Show when={loading() && rows().length === 0}>
              <div class="px-5 py-8 text-center text-[color:var(--color-muted)]">
                Loading…
              </div>
            </Show>
            <Show when={!loading() && rows().length === 0 && !error()}>
              <div class="px-5 py-8 text-center text-[color:var(--color-muted)]">
                No scheduled sends pending.
              </div>
            </Show>
            <Show when={rows().length > 0}>
              <ul class="divide-y divide-[color:var(--color-border)]">
                <For each={rows()}>
                  {(row) => (
                    <li class="flex items-start gap-3 px-5 py-3">
                      <div class="min-w-0 flex-1">
                        <div class="truncate font-medium">
                          {row.subject || "(no subject)"}
                        </div>
                        <div class="truncate text-xs text-[color:var(--color-muted)]">
                          To {row.to || "(no recipient)"} · From{" "}
                          {row.account_email}
                        </div>
                        <div class="text-xs text-[color:var(--color-muted)]">
                          Sends at {new Date(row.fire_at_ms).toLocaleString()}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => cancel(row.id)}
                        class="shrink-0 rounded border border-[color:var(--color-border)] px-2 py-1 text-xs text-red-600 hover:bg-[color:var(--color-surface-hover)]"
                      >
                        Cancel
                      </button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>
          <footer class="flex justify-end gap-2 border-t border-[color:var(--color-border)] px-5 py-3">
            <button
              type="button"
              onClick={refresh}
              disabled={loading()}
              class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={props.onClose}
              class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
            >
              Close
            </button>
          </footer>
        </div>
      </div>
    </Show>
  );
}

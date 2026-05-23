import { For, Show, createSignal } from "solid-js";

export type Toast = {
  id: number;
  message: string;
  action?: { label: string; onClick: () => void };
  variant?: "default" | "error";
};

const [toasts, setToasts] = createSignal<Toast[]>([]);
let nextId = 1;

const DEFAULT_TIMEOUT_MS = 6000;

export function showToast(opts: {
  message: string;
  action?: { label: string; onClick: () => void };
  variant?: "default" | "error";
  timeoutMs?: number;
}): number {
  const id = nextId++;
  const toast: Toast = {
    id,
    message: opts.message,
    action: opts.action,
    variant: opts.variant ?? "default",
  };
  setToasts([...toasts(), toast]);
  const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (timeout > 0) {
    window.setTimeout(() => dismissToast(id), timeout);
  }
  return id;
}

export function dismissToast(id: number) {
  setToasts(toasts().filter((t) => t.id !== id));
}

// Fire the action of the most recent toast that has one. Returns true if it
// did. Use for Ctrl/Cmd+Z bindings — only the freshest action is undoable, by
// design (matches Spark/Gmail behavior).
export function triggerLastAction(): boolean {
  const list = toasts();
  for (let i = list.length - 1; i >= 0; i--) {
    const t = list[i];
    if (t.action) {
      t.action.onClick();
      dismissToast(t.id);
      return true;
    }
  }
  return false;
}

export function ToastContainer() {
  return (
    <div
      class="pointer-events-none fixed bottom-4 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2"
      aria-live="polite"
    >
      <For each={toasts()}>
        {(t) => (
          <div
            class={`pointer-events-auto flex items-center gap-3 rounded-lg border px-4 py-2 text-sm shadow-lg ${
              t.variant === "error"
                ? "border-red-400 bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-100"
                : "border-[color:var(--color-border)] bg-[color:var(--color-surface)] text-[color:var(--color-fg)]"
            }`}
            role="status"
          >
            <span class="max-w-xs truncate">{t.message}</span>
            <Show when={t.action}>
              {(a) => (
                <button
                  type="button"
                  onClick={() => {
                    a().onClick();
                    dismissToast(t.id);
                  }}
                  class="rounded px-2 py-0.5 text-xs font-semibold text-[color:var(--color-accent)] hover:bg-[color:var(--color-surface-hover)]"
                >
                  {a().label}
                </button>
              )}
            </Show>
            <button
              type="button"
              onClick={() => dismissToast(t.id)}
              class="text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]"
              aria-label="Dismiss"
            >
              ×
            </button>
          </div>
        )}
      </For>
    </div>
  );
}

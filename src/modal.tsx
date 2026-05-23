import { Show, createEffect, createSignal, onCleanup } from "solid-js";

/**
 * Close a modal on Escape. Registered at document level with capture phase so
 * the modal's handler beats the global App-level shortcuts handler. Pass an
 * `active` accessor (e.g. `() => props.open`) — when it becomes true the
 * listener attaches, when false the cleanup detaches it.
 */
export function useEscClose(active: () => boolean, onClose: () => void) {
  createEffect(() => {
    if (!active()) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("keydown", onEsc, true);
    onCleanup(() => document.removeEventListener("keydown", onEsc, true));
  });
}

export type ConfirmOptions = {
  title: string;
  body?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
};

type Pending = ConfirmOptions & {
  resolve: (ok: boolean) => void;
};

const [pending, setPending] = createSignal<Pending | null>(null);

export function confirmModal(opts: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    setPending({ ...opts, resolve });
  });
}

function close(ok: boolean) {
  const p = pending();
  if (!p) return;
  setPending(null);
  p.resolve(ok);
}

export function ConfirmHost() {
  useEscClose(() => pending() !== null, () => close(false));
  return (
    <Show when={pending()}>
      {(p) => (
        <div
          class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
          onClick={() => close(false)}
          onKeyDown={(e) => {
            if (e.key === "Enter") close(true);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={p().title}
            class="w-full max-w-sm rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="text-base font-semibold">{p().title}</h2>
            <Show when={p().body}>
              <p class="mt-2 text-sm text-[color:var(--color-muted)]">
                {p().body}
              </p>
            </Show>
            <div class="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => close(false)}
                class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
              >
                {p().cancelLabel ?? "Cancel"}
              </button>
              <button
                type="button"
                onClick={() => close(true)}
                class={`rounded px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 ${
                  p().destructive
                    ? "bg-red-600"
                    : "bg-[color:var(--color-accent)]"
                }`}
              >
                {p().confirmLabel ?? "OK"}
              </button>
            </div>
          </div>
        </div>
      )}
    </Show>
  );
}

import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { useEscClose } from "./modal";

export type Command = {
  /// Stable identifier — useful for testing and for skipping duplicates if
  /// the same command is registered by two sources.
  id: string;
  /// Primary display text. Used both as the click target and as match input.
  label: string;
  /// Optional category for grouping in the results list ("Mail", "Calendar",
  /// "Settings", "Accounts", "Theme"…).
  group?: string;
  /// Optional right-side hint (typically a hotkey).
  hint?: string;
  /// Extra match strings — synonyms / shorthand the user might type. The
  /// label is always matched too, so don't repeat it here.
  keywords?: string[];
  /// What to do when the user picks this command. The palette closes
  /// automatically before run() fires.
  run: () => void;
};

function scoreCommand(c: Command, q: string): number {
  if (!q) return 1;
  const hay = (c.label + " " + (c.keywords ?? []).join(" ") + " " + (c.group ?? ""))
    .toLowerCase();
  const lq = q.toLowerCase();
  if (hay.includes(lq)) {
    // Exact substring match. Lower index → better score.
    return 100 - hay.indexOf(lq);
  }
  // Subsequence match: every char of q appears in hay in order.
  let hi = 0;
  for (const ch of lq) {
    const found = hay.indexOf(ch, hi);
    if (found < 0) return 0;
    hi = found + 1;
  }
  return 1;
}

export function CommandPalette(props: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const [activeIdx, setActiveIdx] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;
  let listRef: HTMLUListElement | undefined;

  // Reset state every time the palette opens.
  createEffect(() => {
    if (props.open) {
      setQuery("");
      setActiveIdx(0);
      // Focus the input asynchronously so Solid has rendered the modal.
      queueMicrotask(() => inputRef?.focus());
    }
  });

  useEscClose(() => props.open, () => props.onClose());

  const filtered = createMemo(() => {
    const q = query().trim();
    const scored = props.commands
      .map((c) => ({ c, score: scoreCommand(c, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);
    return scored.map((x) => x.c).slice(0, 50);
  });

  // Keep activeIdx in range when results shrink.
  createEffect(() => {
    const n = filtered().length;
    if (activeIdx() >= n) setActiveIdx(Math.max(0, n - 1));
  });

  function runActive() {
    const list = filtered();
    const cmd = list[activeIdx()];
    if (!cmd) return;
    props.onClose();
    // Defer to next microtask so the modal close finishes before the
    // command's side effects (which often open another modal) fire.
    queueMicrotask(() => cmd.run());
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIdx((i) => Math.min(filtered().length - 1, i + 1));
      scrollActiveIntoView();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIdx((i) => Math.max(0, i - 1));
      scrollActiveIntoView();
    } else if (e.key === "Enter") {
      e.preventDefault();
      runActive();
    }
  }

  function scrollActiveIntoView() {
    queueMicrotask(() => {
      const ul = listRef;
      if (!ul) return;
      const child = ul.children[activeIdx()] as HTMLElement | undefined;
      child?.scrollIntoView({ block: "nearest" });
    });
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[70] flex items-start justify-center bg-black/40 p-4 pt-[12vh]"
        onClick={props.onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Command palette"
          class="flex max-h-[70vh] w-full max-w-xl flex-col overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2.5 text-sm">
            <span class="text-[color:var(--color-muted)]">⌘</span>
            <input
              ref={(el) => (inputRef = el)}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKeyDown}
              placeholder="Type a command…"
              class="flex-1 bg-transparent text-base outline-none placeholder:text-[color:var(--color-muted)]"
            />
          </div>
          <ul
            ref={(el) => (listRef = el)}
            class="flex-1 overflow-y-auto py-1 text-sm"
          >
            <For each={filtered()}>
              {(c, i) => {
                const active = () => i() === activeIdx();
                return (
                  <li>
                    <button
                      type="button"
                      onMouseEnter={() => setActiveIdx(i())}
                      onClick={() => {
                        props.onClose();
                        queueMicrotask(() => c.run());
                      }}
                      class={`flex w-full items-center justify-between gap-3 px-4 py-2 text-left ${
                        active()
                          ? "bg-[color:var(--color-accent-bg)] text-[color:var(--color-fg)]"
                          : "hover:bg-[color:var(--color-surface-hover)]"
                      }`}
                    >
                      <span class="flex min-w-0 flex-col">
                        <span class="truncate">{c.label}</span>
                        <Show when={c.group}>
                          <span class="text-[10px] uppercase tracking-wide text-[color:var(--color-muted)]">
                            {c.group}
                          </span>
                        </Show>
                      </span>
                      <Show when={c.hint}>
                        <span class="shrink-0 rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] text-[color:var(--color-muted)]">
                          {c.hint}
                        </span>
                      </Show>
                    </button>
                  </li>
                );
              }}
            </For>
            <Show when={filtered().length === 0}>
              <li class="px-4 py-6 text-center text-xs text-[color:var(--color-muted)]">
                No matches.
              </li>
            </Show>
          </ul>
        </div>
      </div>
    </Show>
  );
}

/// Register a Cmd/Ctrl+K global hotkey that toggles the palette. Returns a
/// cleanup that detaches the listener — useful from `onMount` /
/// `onCleanup`.
export function useCmdKHotkey(toggle: () => void): void {
  function onKey(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
      e.preventDefault();
      toggle();
    }
  }
  onMount(() => {
    document.addEventListener("keydown", onKey);
    onCleanup(() => document.removeEventListener("keydown", onKey));
  });
}

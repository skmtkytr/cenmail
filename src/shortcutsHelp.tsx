import { For, Show } from "solid-js";
import { useEscClose } from "./modal";

type Entry = {
  combo: string[];
  separator?: " / " | " + ";
  label: string;
};

const IFRAME_ENTRIES: Entry[] = [
  { combo: ["f"], label: "Show link hints" },
  { combo: ["j", "k"], separator: " / ", label: "Scroll down / up" },
  { combo: ["d", "u"], separator: " / ", label: "Half-page down / up" },
  { combo: ["gg"], label: "Scroll to top" },
  { combo: ["G"], label: "Scroll to bottom" },
  { combo: ["Esc"], label: "Return focus to list" },
];

const ENTRIES: Entry[] = [
  { combo: ["j", "k"], separator: " / ", label: "Next / previous message" },
  { combo: ["e"], label: "Archive" },
  { combo: ["#", "Del"], separator: " / ", label: "Move to Trash" },
  { combo: ["s"], label: "Toggle star" },
  { combo: ["z"], label: "Snooze 1h" },
  { combo: ["Ctrl", "Z"], separator: " + ", label: "Undo last action" },
  { combo: ["m"], label: "Mute thread" },
  { combo: ["u"], label: "Toggle read / unread" },
  {
    combo: ["r", "a", "f"],
    separator: " / ",
    label: "Reply / Reply all / Forward",
  },
  { combo: ["c"], label: "Compose new" },
  { combo: ["Ctrl", "K"], separator: " + ", label: "Command palette" },
  { combo: ["/"], label: "Search" },
  { combo: ["Ctrl", "Shift", "R"], separator: " + ", label: "Sync now" },
  {
    combo: ["Ctrl", "Shift", "1"],
    separator: " + ",
    label: "Switch to Mail",
  },
  {
    combo: ["Ctrl", "Shift", "2"],
    separator: " + ",
    label: "Switch to Calendar",
  },
  { combo: ["?"], label: "Show this help" },
  { combo: ["Esc"], label: "Close modal / deselect" },
];

const KBD_CLASS =
  "rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono";

export function ShortcutsHelpModal(props: {
  open: boolean;
  onClose: () => void;
}) {
  useEscClose(() => props.open, () => props.onClose());
  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={props.onClose}
      >
        <div
          role="dialog"
          aria-label="Keyboard shortcuts"
          class="w-full max-w-md rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-6 shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <h2 class="mb-4 text-lg font-semibold">Keyboard shortcuts</h2>
          <table class="w-full text-sm">
            <tbody>
              <For each={ENTRIES}>
                {(entry) => (
                  <tr>
                    <td
                      class={`py-1 pr-4 ${entry.separator === " + " ? "whitespace-nowrap" : ""}`}
                    >
                      <For each={entry.combo}>
                        {(key, i) => (
                          <>
                            <Show when={i() > 0}>{entry.separator}</Show>
                            <kbd class={KBD_CLASS}>{key}</kbd>
                          </>
                        )}
                      </For>
                    </td>
                    <td>{entry.label}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <h3 class="mt-5 mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
            Inside message body (click into preview first)
          </h3>
          <table class="w-full text-sm">
            <tbody>
              <For each={IFRAME_ENTRIES}>
                {(entry) => (
                  <tr>
                    <td class="py-1 pr-4">
                      <For each={entry.combo}>
                        {(key, i) => (
                          <>
                            <Show when={i() > 0}>{entry.separator}</Show>
                            <kbd class={KBD_CLASS}>{key}</kbd>
                          </>
                        )}
                      </For>
                    </td>
                    <td>{entry.label}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
          <div class="mt-4 text-right">
            <button
              type="button"
              onClick={props.onClose}
              class="rounded border border-[color:var(--color-border)] px-3 py-1 text-sm hover:bg-[color:var(--color-surface-hover)]"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </Show>
  );
}


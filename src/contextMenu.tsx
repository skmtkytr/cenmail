import { For, Show } from "solid-js";
import { snoozePresets, type MessageMeta } from "./types";
import { useEscClose } from "./modal";

export type TriageActions = {
  toggleRead: (m: MessageMeta) => void;
  toggleStar: (m: MessageMeta) => void;
  archive: (m: MessageMeta) => void;
  trash: (m: MessageMeta) => void;
  restoreFromTrash: (m: MessageMeta) => void;
  moveToInbox: (m: MessageMeta) => void;
  markSpam: (m: MessageMeta) => void;
  notSpam: (m: MessageMeta) => void;
  snooze: (m: MessageMeta, fireAtMs: number) => void;
  mute: (m: MessageMeta) => void;
};

export type ContextMenuState = {
  x: number;
  y: number;
  message: MessageMeta;
};

const ITEM_CLASS =
  "block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]";

export function ContextMenu(props: {
  menu: ContextMenuState | null;
  onClose: () => void;
  actions: TriageActions;
}) {
  useEscClose(() => props.menu !== null, () => props.onClose());
  return (
    <Show when={props.menu}>
      {(cm) => {
        const m = cm().message;
        const isStarred = () => m.label_ids.includes("STARRED");
        const inTrash = () => m.label_ids.includes("TRASH");
        const inInbox = () => m.label_ids.includes("INBOX");
        const inSpam = () => m.label_ids.includes("SPAM");
        const close = props.onClose;
        const run = (fn: () => void) => () => {
          close();
          fn();
        };
        return (
          <ul
            role="menu"
            class="fixed z-50 min-w-44 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-1 text-sm shadow-lg"
            style={{ left: `${cm().x}px`, top: `${cm().y}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <li>
              <button
                type="button"
                class={ITEM_CLASS}
                onClick={run(() => props.actions.toggleRead(m))}
              >
                {m.unread ? "Mark as read" : "Mark as unread"}
              </button>
            </li>
            <li>
              <button
                type="button"
                class={ITEM_CLASS}
                onClick={run(() => props.actions.toggleStar(m))}
              >
                {isStarred() ? "Remove star" : "Star"}
              </button>
            </li>
            <Show when={inInbox()}>
              <li>
                <button
                  type="button"
                  class={ITEM_CLASS}
                  onClick={run(() => props.actions.archive(m))}
                >
                  Archive
                </button>
              </li>
              <li class="mt-1 border-t border-[color:var(--color-border)] pt-1">
                <div class="px-3 pb-1 text-xs text-[color:var(--color-muted)]">
                  Snooze until
                </div>
                <For each={snoozePresets()}>
                  {(p) => (
                    <button
                      type="button"
                      class={ITEM_CLASS}
                      onClick={run(() => props.actions.snooze(m, p.fireAt))}
                    >
                      {p.label}
                    </button>
                  )}
                </For>
              </li>
              <li class="mt-1 border-t border-[color:var(--color-border)]">
                <button
                  type="button"
                  class={ITEM_CLASS}
                  onClick={run(() => props.actions.mute(m))}
                >
                  Mute thread
                </button>
              </li>
            </Show>
            <Show when={!inInbox() && !inTrash()}>
              <li>
                <button
                  type="button"
                  class={ITEM_CLASS}
                  onClick={run(() => props.actions.moveToInbox(m))}
                >
                  Move to Inbox
                </button>
              </li>
            </Show>
            <Show when={inSpam()}>
              <li>
                <button
                  type="button"
                  class={ITEM_CLASS}
                  onClick={run(() => props.actions.notSpam(m))}
                >
                  Not spam
                </button>
              </li>
            </Show>
            <Show when={!inSpam() && !inTrash()}>
              <li>
                <button
                  type="button"
                  class={`${ITEM_CLASS} text-red-500`}
                  onClick={run(() => props.actions.markSpam(m))}
                >
                  Mark as spam
                </button>
              </li>
            </Show>
            <li>
              <button
                type="button"
                class={`${ITEM_CLASS} text-red-500`}
                onClick={run(() => {
                  if (inTrash()) props.actions.restoreFromTrash(m);
                  else props.actions.trash(m);
                })}
              >
                {inTrash() ? "Restore from Trash" : "Move to Trash"}
              </button>
            </li>
          </ul>
        );
      }}
    </Show>
  );
}

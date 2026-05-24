import { batch } from "solid-js";
import { triggerLastAction } from "../toast";
import { isEditableTarget } from "../keyboardHelpers";
import { snoozePresets } from "../types";
import type { ComposeState, MessageDetail, MessageMeta } from "../types";
import type { ContextMenuState } from "./useContextMenu";

export type ShortcutDeps = {
  showShortcuts: () => boolean;
  setShowShortcuts: (v: boolean) => void;
  contextMenu: () => ContextMenuState | null;
  closeContextMenu: () => void;
  compose: () => ComposeState | null;
  closeCompose: () => Promise<void> | void;
  selectedIds: () => Set<string>;
  setSelectedIds: (s: Set<string>) => void;
  setAnchorId: (id: string | null) => void;
  selectedMessageId: () => string | null;
  setSelectedMessageId: (id: string | null) => void;
  setMessageDetail: (d: MessageDetail | null) => void;
  clearMultiSelect: () => void;
  currentMessage: () => MessageMeta | null;
  selectionTargets: (fallback: MessageMeta | null) => MessageMeta[];
  visibleMessages: () => MessageMeta[];
  moveSelection: (delta: number) => void;
  viewMode: () => "mail" | "calendar";
  setViewMode: (v: "mail" | "calendar") => void;
  handleRefresh: () => void;
  archiveWithUndo: (targets: MessageMeta[]) => void;
  trashWithUndo: (targets: MessageMeta[]) => void;
  snoozeMessages: (targets: MessageMeta[], fireAt: number) => Promise<void> | void;
  muteThreadAction: (m: MessageMeta) => Promise<void> | void;
  starToggleWithUndo: (targets: MessageMeta[]) => void;
  modifyLabels: (
    m: MessageMeta,
    add: string[],
    remove: string[],
  ) => Promise<void> | void;
  messageDetail: () => MessageDetail | null;
  openReply: (all: boolean) => void;
  openForward: () => void;
  openCompose: () => void;
  searchInputRef: () => HTMLInputElement | undefined;
};

/// Returns the document-level keydown handler. Caller is responsible
/// for installing/removing it (typically inside onMount/onCleanup) so
/// the hook doesn't fight with other Solid effects over listener
/// lifecycle.
export function useShortcuts(deps: ShortcutDeps): (e: KeyboardEvent) => void {
  return function handleShortcut(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (deps.showShortcuts()) {
        deps.setShowShortcuts(false);
        return;
      }
      if (deps.contextMenu()) {
        deps.closeContextMenu();
        return;
      }
      if (deps.compose()) {
        void deps.closeCompose();
        return;
      }
      if (deps.selectedIds().size > 1) {
        deps.clearMultiSelect();
        return;
      }
      if (deps.selectedMessageId()) {
        deps.setSelectedMessageId(null);
        deps.setMessageDetail(null);
        deps.clearMultiSelect();
        return;
      }
    }
    // Global re-sync: Ctrl/Cmd + Shift + R. Placed before the
    // editable-target bail so it works even when the search field
    // has focus.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      e.key.toLowerCase() === "r"
    ) {
      e.preventDefault();
      deps.handleRefresh();
      return;
    }
    // Global view switch: Ctrl+Shift+1 (Mail) / Ctrl+Shift+2 (Calendar).
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === "1" || e.key === "!")
    ) {
      e.preventDefault();
      deps.setViewMode("mail");
      return;
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === "2" || e.key === "@")
    ) {
      e.preventDefault();
      deps.setViewMode("calendar");
      return;
    }

    if (isEditableTarget(e.target)) return;

    // Ctrl/Cmd+Z fires the most recent undoable toast (archive, snooze, etc.).
    // Placed after the editable-target bail so native text undo in compose
    // still works.
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      e.key.toLowerCase() === "z"
    ) {
      if (triggerLastAction()) {
        e.preventDefault();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      if (deps.compose() || deps.showShortcuts()) return;
      e.preventDefault();
      const list = deps.visibleMessages();
      deps.setSelectedIds(new Set(list.map((m) => m.id)));
      if (list.length > 0) deps.setAnchorId(list[0].id);
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (deps.compose() || deps.showShortcuts()) return;

    // Mail-only shortcuts must not fire in calendar view — pressing 'm'
    // there would mute the previously-selected mail thread, 'e' would
    // archive it, etc. Keep compose (c) and shortcut help (?) alive
    // because they make sense from any view.
    const calendarPassthrough = e.key === "c" || e.key === "?";
    if (deps.viewMode() !== "mail" && !calendarPassthrough) return;

    const m = deps.currentMessage();
    const bulk = () => deps.selectionTargets(m);
    switch (e.key) {
      case "j":
      case "ArrowDown":
        e.preventDefault();
        deps.moveSelection(1);
        break;
      case "k":
      case "ArrowUp":
        e.preventDefault();
        deps.moveSelection(-1);
        break;
      case "e": {
        const targets = bulk().filter((t) => t.label_ids.includes("INBOX"));
        if (targets.length > 0) {
          e.preventDefault();
          deps.archiveWithUndo(targets);
        }
        break;
      }
      case "#":
      case "Delete": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          deps.trashWithUndo(targets);
        }
        break;
      }
      case "s": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          deps.starToggleWithUndo(targets);
        }
        break;
      }
      case "z": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          void deps.snoozeMessages(targets, snoozePresets()[0].fireAt);
        }
        break;
      }
      case "m": {
        if (m) {
          e.preventDefault();
          void deps.muteThreadAction(m);
        }
        break;
      }
      case "u": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          const allUnread = targets.every((t) => t.unread);
          batch(() => {
            for (const t of targets) {
              void deps.modifyLabels(
                t,
                allUnread ? [] : ["UNREAD"],
                allUnread ? ["UNREAD"] : [],
              );
            }
          });
        }
        break;
      }
      case "r":
        if (m && deps.messageDetail()) {
          e.preventDefault();
          deps.openReply(false);
        }
        break;
      case "a":
        if (m && deps.messageDetail()) {
          e.preventDefault();
          deps.openReply(true);
        }
        break;
      case "f":
        if (m && deps.messageDetail()) {
          e.preventDefault();
          deps.openForward();
        }
        break;
      case "c":
        e.preventDefault();
        deps.openCompose();
        break;
      case "/":
        e.preventDefault();
        deps.searchInputRef()?.focus();
        deps.searchInputRef()?.select();
        break;
      case "?":
        e.preventDefault();
        deps.setShowShortcuts(true);
        break;
    }
  };
}

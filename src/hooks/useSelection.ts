import { createSignal } from "solid-js";
import type { MessageDetail, MessageMeta } from "../types";

export type SelectionDeps = {
  /// All rows visible in the *current* folder/account/search view.
  /// Drives multi-select range computation + auto-advance.
  visibleMessages: () => MessageMeta[];
  /// Open `m` in the preview pane. Called from list clicks and
  /// keyboard nav.
  selectMessage: (m: MessageMeta) => Promise<void>;
  /// Clear the preview when the multi-selection collapses to zero.
  setMessageDetail: (d: MessageDetail | null) => void;
};

export type SelectionHandle = {
  selectedMessageId: () => string | null;
  setSelectedMessageId: (id: string | null) => void;
  selectedIds: () => Set<string>;
  setSelectedIds: (s: Set<string>) => void;
  anchorId: () => string | null;
  setAnchorId: (id: string | null) => void;
  isSelected: (id: string) => boolean;
  selectedMessages: () => MessageMeta[];
  selectionTargets: (fallback: MessageMeta | null) => MessageMeta[];
  contextTargets: (m: MessageMeta) => MessageMeta[];
  clearMultiSelect: () => void;
  handleListClick: (e: MouseEvent, message: MessageMeta) => void;
  moveSelection: (delta: number) => void;
  currentMessage: () => MessageMeta | null;
};

/// Owns single-message selection (selectedMessageId), multi-select
/// (selectedIds + anchorId for range clicks), and the helpers that
/// fan a single keystroke or right-click out to the active selection.
export function useSelection(deps: SelectionDeps): SelectionHandle {
  const [selectedMessageId, setSelectedMessageId] = createSignal<string | null>(
    null,
  );
  const [selectedIds, setSelectedIds] = createSignal<Set<string>>(new Set());
  const [anchorId, setAnchorId] = createSignal<string | null>(null);

  function isSelected(id: string): boolean {
    return selectedIds().has(id);
  }

  function clearMultiSelect() {
    setSelectedIds(new Set<string>());
    setAnchorId(null);
  }

  function selectedMessages(): MessageMeta[] {
    const ids = selectedIds();
    if (ids.size === 0) return [];
    return deps.visibleMessages().filter((m) => ids.has(m.id));
  }

  function selectionTargets(fallback: MessageMeta | null): MessageMeta[] {
    const multi = selectedMessages();
    if (multi.length > 1) return multi;
    if (fallback) return [fallback];
    if (multi.length === 1) return multi;
    return [];
  }

  // Right-clicking a row that is part of an active multi-select should
  // fan the action out to every selected row; right-clicking an
  // unselected row keeps the single-row behaviour.
  function contextTargets(m: MessageMeta): MessageMeta[] {
    const ids = selectedIds();
    if (ids.size > 1 && ids.has(m.id)) return selectedMessages();
    return [m];
  }

  function handleListClick(e: MouseEvent, message: MessageMeta) {
    const list = deps.visibleMessages();
    if (e.shiftKey && anchorId()) {
      e.preventDefault();
      const i = list.findIndex((m) => m.id === anchorId());
      const j = list.findIndex((m) => m.id === message.id);
      if (i >= 0 && j >= 0) {
        const [a, b] = i < j ? [i, j] : [j, i];
        const range = list.slice(a, b + 1).map((m) => m.id);
        setSelectedIds(new Set(range));
        setSelectedMessageId(message.id);
      }
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const next = new Set(selectedIds());
      if (next.has(message.id)) next.delete(message.id);
      else next.add(message.id);
      setSelectedIds(next);
      setAnchorId(message.id);
      if (next.size === 1) {
        const only = list.find((m) => next.has(m.id));
        if (only) void deps.selectMessage(only);
      } else if (next.size === 0) {
        setSelectedMessageId(null);
        deps.setMessageDetail(null);
      }
      return;
    }
    setSelectedIds(new Set([message.id]));
    setAnchorId(message.id);
    void deps.selectMessage(message);
  }

  function moveSelection(delta: number) {
    const list = deps.visibleMessages();
    if (list.length === 0) return;
    const id = selectedMessageId();
    const idx = id ? list.findIndex((m) => m.id === id) : -1;
    let next = idx + delta;
    if (idx < 0) next = delta > 0 ? 0 : list.length - 1;
    next = Math.max(0, Math.min(list.length - 1, next));
    const target = list[next];
    if (target) void deps.selectMessage(target);
  }

  function currentMessage(): MessageMeta | null {
    const id = selectedMessageId();
    if (!id) return null;
    return deps.visibleMessages().find((m) => m.id === id) ?? null;
  }

  return {
    selectedMessageId,
    setSelectedMessageId,
    selectedIds,
    setSelectedIds,
    anchorId,
    setAnchorId,
    isSelected,
    selectedMessages,
    selectionTargets,
    contextTargets,
    clearMultiSelect,
    handleListClick,
    moveSelection,
    currentMessage,
  };
}

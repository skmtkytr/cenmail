import { createSignal } from "solid-js";
import type { MessageMeta } from "../types";

export type ContextMenuState = {
  x: number;
  y: number;
  message: MessageMeta;
};

/// Owns the row-level right-click menu state. Keeps the open/close
/// surface tiny so App.tsx just hands the position + message to the
/// hook and renders <ContextMenu /> from the returned signal.
export function useContextMenu() {
  const [contextMenu, setContextMenu] = createSignal<ContextMenuState | null>(
    null,
  );

  function openContextMenu(e: MouseEvent, message: MessageMeta) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, message });
  }

  function closeContextMenu() {
    setContextMenu(null);
  }

  return { contextMenu, openContextMenu, closeContextMenu };
}

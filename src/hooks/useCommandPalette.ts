import { createSignal } from "solid-js";
import { useCmdKHotkey } from "../commandPalette";

/// Tiny wrapper around the palette open/close signal plus the
/// Cmd+K toggle binding. The actual command list lives in App.tsx
/// because it needs accountrs, triage actions, view-mode setters,
/// theme updaters etc. — passing 20 deps to a hook would be worse
/// than just keeping the list inline.
export function useCommandPalette() {
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  useCmdKHotkey(() => setPaletteOpen((v) => !v));
  return {
    paletteOpen,
    setPaletteOpen,
    closePalette: () => setPaletteOpen(false),
  };
}

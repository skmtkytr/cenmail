/// True when keystrokes should pass through to the focused element
/// rather than triggering app-wide shortcuts. Used by every keydown
/// handler before doing anything.
export function isEditableTarget(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  const tag = t.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (t.isContentEditable) return true;
  return false;
}

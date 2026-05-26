import { batch } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../toast";
import { matchesFolder } from "../utils";
import type { MessageDetail, MessageMeta } from "../types";

/// Wiring the triage hook needs into App-level state. Pulled into an
/// object so the hook signature stays readable as the dep count grows.
export type TriageDeps = {
  /// Read whatever rows are cached under the current view key.
  getCache: () => MessageMeta[] | undefined;
  /// Write the rows under the current view key.
  setCache: (rows: MessageMeta[]) => void;
  /// Current folder id (`inbox` / `pinned` / `archive` / …) — drives
  /// the "does this still belong in view?" check after a label change.
  currentFolder: () => string;
  selectedMessageId: () => string | null;
  setSelectedMessageId: (id: string | null) => void;
  setMessageDetail: (d: MessageDetail | null) => void;
  visibleMessages: () => MessageMeta[];
  selectMessage: (m: MessageMeta) => Promise<void>;
  reloadAllVisible: () => void;
  setMessagesError: (s: string | null) => void;
};

export type TriageHandle = {
  applyLocalLabelChange: (
    message: MessageMeta,
    add: string[],
    remove: string[],
  ) => void;
  modifyLabels: (
    message: MessageMeta,
    add: string[],
    remove: string[],
  ) => Promise<void>;
  pickAutoAdvance: (targets: MessageMeta[]) => MessageMeta | null;
  archiveWithUndo: (targets: MessageMeta[]) => void;
  trashWithUndo: (targets: MessageMeta[]) => void;
  snoozeMessages: (targets: MessageMeta[], fireAtMs: number) => Promise<void>;
  muteThreadAction: (message: MessageMeta) => Promise<void>;
  spamWithUndo: (targets: MessageMeta[]) => void;
  notSpam: (targets: MessageMeta[]) => void;
  starToggleWithUndo: (targets: MessageMeta[]) => void;
  /// Wall-clock of the last optimistic cache mutation. The host's
  /// debounced reload uses this to back off — a reload that fires
  /// while a backend modify is still in flight will SELECT the old
  /// state for that row and flicker it back into the list.
  lastOptimisticAt: () => number;
};

/// Bulk triage actions (archive / trash / snooze / mute / spam / star /
/// mark-read) plus the optimistic-update plumbing they all share. Each
/// public action wraps its per-target loop in `batch()` so the rows
/// disappear together instead of popping out one Gmail round-trip at
/// a time.
export function useTriage(deps: TriageDeps): TriageHandle {
  // Updated on every optimistic mutation. Read by App's reload
  // debounce so a burst of triage actions doesn't trigger a reload
  // that races the in-flight backend writes.
  let lastOptimisticAt = 0;

  function applyLocalLabelChange(
    message: MessageMeta,
    add: string[],
    remove: string[],
  ) {
    const list = deps.getCache();
    if (!list) return;
    lastOptimisticAt = Date.now();
    const newLabels = new Set(message.label_ids);
    for (const r of remove) newLabels.delete(r);
    for (const a of add) newLabels.add(a);
    const nextLabels = Array.from(newLabels);
    const updated: MessageMeta = {
      ...message,
      label_ids: nextLabels,
      unread: nextLabels.includes("UNREAD"),
    };
    const stillVisible = matchesFolder(nextLabels, deps.currentFolder());
    if (stillVisible) {
      deps.setCache(list.map((m) => (m.id === message.id ? updated : m)));
    } else {
      deps.setCache(list.filter((m) => m.id !== message.id));
      if (deps.selectedMessageId() === message.id) {
        deps.setSelectedMessageId(null);
        deps.setMessageDetail(null);
      }
    }
  }

  async function modifyLabels(
    message: MessageMeta,
    add: string[],
    remove: string[],
  ) {
    applyLocalLabelChange(message, add, remove);
    try {
      await invoke("modify_message", {
        email: message.account_email,
        messageId: message.id,
        addLabels: add,
        removeLabels: remove,
      });
    } catch (err) {
      deps.setMessagesError(String(err));
      deps.reloadAllVisible();
    }
  }

  async function trashMessageAction(message: MessageMeta) {
    applyLocalLabelChange(message, ["TRASH"], ["INBOX", "UNREAD", "STARRED"]);
    try {
      await invoke("trash_message", {
        email: message.account_email,
        messageId: message.id,
      });
    } catch (err) {
      deps.setMessagesError(String(err));
      deps.reloadAllVisible();
    }
  }

  async function untrashMessageAction(message: MessageMeta) {
    try {
      await invoke("untrash_message", {
        email: message.account_email,
        messageId: message.id,
      });
      deps.reloadAllVisible();
    } catch (err) {
      deps.setMessagesError(String(err));
    }
  }

  function pickAutoAdvance(targets: MessageMeta[]): MessageMeta | null {
    const list = deps.visibleMessages() ?? [];
    if (targets.length === 0 || list.length === 0) return null;
    const ids = new Set(targets.map((t) => t.id));
    let firstIdx = list.length;
    let lastIdx = -1;
    for (let i = 0; i < list.length; i++) {
      if (!ids.has(list[i].id)) continue;
      if (i < firstIdx) firstIdx = i;
      if (i > lastIdx) lastIdx = i;
    }
    if (lastIdx < 0) return null;
    for (let i = lastIdx + 1; i < list.length; i++) {
      if (!ids.has(list[i].id)) return list[i];
    }
    for (let i = firstIdx - 1; i >= 0; i--) {
      if (!ids.has(list[i].id)) return list[i];
    }
    return null;
  }

  function archiveWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    const next = pickAutoAdvance(targets);
    batch(() => {
      for (const t of targets) void modifyLabels(t, [], ["INBOX"]);
    });
    if (next && !deps.selectedMessageId()) void deps.selectMessage(next);
    showToast({
      message:
        targets.length === 1 ? "Archived" : `Archived ${targets.length}`,
      action: {
        label: "Undo",
        onClick: () => {
          for (const t of snapshot) void modifyLabels(t, ["INBOX"], []);
          deps.reloadAllVisible();
        },
      },
    });
  }

  function trashWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    const next = pickAutoAdvance(targets);
    batch(() => {
      for (const t of targets) void trashMessageAction(t);
    });
    if (next && !deps.selectedMessageId()) void deps.selectMessage(next);
    showToast({
      message:
        targets.length === 1
          ? "Moved to Trash"
          : `Moved ${targets.length} to Trash`,
      action: {
        label: "Undo",
        onClick: () => {
          for (const t of snapshot) void untrashMessageAction(t);
        },
      },
    });
  }

  async function snoozeMessages(targets: MessageMeta[], fireAtMs: number) {
    if (targets.length === 0) return;
    const prevSelectionId = deps.selectedMessageId();
    const prevSelectionMeta = prevSelectionId
      ? targets.find((t) => t.id === prevSelectionId) ?? null
      : null;
    const next = pickAutoAdvance(targets);
    batch(() => {
      for (const t of targets) applyLocalLabelChange(t, [], ["INBOX"]);
    });
    if (next && !deps.selectedMessageId()) void deps.selectMessage(next);
    const results = await Promise.allSettled(
      targets.map((t) =>
        invoke("snooze_message", {
          email: t.account_email,
          messageId: t.id,
          fireAtMs,
        }),
      ),
    );
    const failure = results.find((r) => r.status === "rejected");
    if (failure) {
      showToast({
        message: `Snooze failed: ${(failure as PromiseRejectedResult).reason}`,
        variant: "error",
      });
      deps.reloadAllVisible();
      if (prevSelectionMeta) void deps.selectMessage(prevSelectionMeta);
      return;
    }
    const when = new Date(fireAtMs);
    const label =
      targets.length === 1
        ? `Snoozed until ${when.toLocaleString()}`
        : `Snoozed ${targets.length} until ${when.toLocaleString()}`;
    const snapshot = targets.slice();
    showToast({
      message: label,
      action: {
        label: "Undo",
        onClick: () => {
          for (const t of snapshot) {
            void invoke("unsnooze_message", {
              email: t.account_email,
              messageId: t.id,
            }).catch((e) =>
              showToast({ message: `Undo failed: ${e}`, variant: "error" }),
            );
          }
          deps.reloadAllVisible();
        },
      },
    });
  }

  async function muteThreadAction(message: MessageMeta) {
    if (!message.thread_id) {
      showToast({ message: "No thread to mute", variant: "error" });
      return;
    }
    try {
      await invoke("mute_thread", {
        email: message.account_email,
        threadId: message.thread_id,
      });
      deps.reloadAllVisible();
      showToast({
        message: "Thread muted",
        action: {
          label: "Undo",
          onClick: () => {
            void invoke("unmute_thread", {
              email: message.account_email,
              threadId: message.thread_id,
            }).then(() => deps.reloadAllVisible());
          },
        },
      });
    } catch (err) {
      showToast({ message: `Mute failed: ${err}`, variant: "error" });
    }
  }

  function spamWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    const next = pickAutoAdvance(targets);
    batch(() => {
      for (const t of targets) {
        applyLocalLabelChange(t, ["SPAM"], ["INBOX", "UNREAD"]);
        void invoke("modify_message", {
          email: t.account_email,
          messageId: t.id,
          addLabels: ["SPAM"],
          removeLabels: ["INBOX", "UNREAD"],
        }).catch((err) => {
          showToast({ message: `Spam failed: ${err}`, variant: "error" });
          deps.reloadAllVisible();
        });
      }
    });
    if (next && !deps.selectedMessageId()) void deps.selectMessage(next);
    showToast({
      message:
        snapshot.length === 1
          ? "Marked as spam"
          : `Marked ${snapshot.length} as spam`,
      action: {
        label: "Undo",
        onClick: () => {
          for (const t of snapshot) {
            void invoke("modify_message", {
              email: t.account_email,
              messageId: t.id,
              addLabels: ["INBOX"],
              removeLabels: ["SPAM"],
            });
          }
          deps.reloadAllVisible();
        },
      },
    });
  }

  function notSpam(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    batch(() => {
      for (const t of targets) {
        applyLocalLabelChange(t, ["INBOX"], ["SPAM"]);
        void invoke("modify_message", {
          email: t.account_email,
          messageId: t.id,
          addLabels: ["INBOX"],
          removeLabels: ["SPAM"],
        }).catch((err) => {
          showToast({ message: `Restore failed: ${err}`, variant: "error" });
          deps.reloadAllVisible();
        });
      }
    });
    showToast({
      message:
        targets.length === 1
          ? "Moved out of Spam"
          : `Moved ${targets.length} out of Spam`,
    });
  }

  function starToggleWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    const allStarred = snapshot.every((t) => t.label_ids.includes("STARRED"));
    batch(() => {
      for (const t of snapshot) {
        void modifyLabels(
          t,
          allStarred ? [] : ["STARRED"],
          allStarred ? ["STARRED"] : [],
        );
      }
    });
    const noun = snapshot.length === 1 ? "" : ` ${snapshot.length}`;
    showToast({
      message: allStarred ? `Unstarred${noun}` : `Starred${noun}`,
      action: {
        label: "Undo",
        onClick: () => {
          for (const t of snapshot) {
            void modifyLabels(
              t,
              allStarred ? ["STARRED"] : [],
              allStarred ? [] : ["STARRED"],
            );
          }
        },
      },
    });
  }

  return {
    applyLocalLabelChange,
    modifyLabels,
    pickAutoAdvance,
    archiveWithUndo,
    trashWithUndo,
    snoozeMessages,
    muteThreadAction,
    spamWithUndo,
    notSpam,
    starToggleWithUndo,
    lastOptimisticAt: () => lastOptimisticAt,
  };
}

import { Accessor } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../toast";
import { extractEmailAddresses } from "../utils";
import { settings } from "../settings";
import type { ComposeState } from "../types";
import type { DraftAutosaveHandle } from "./useDraftAutosave";

export type SendUndoHandle = {
  /// Take whatever's in `compose` and either send it immediately (when
  /// the configured undo window is 0) or stash it for `undoMs` while
  /// showing a "Sending… · Undo" toast.
  handleSendCompose: () => Promise<void>;
  /// Schedule the current compose to fire at `fireAtMs`; persists on
  /// the backend so it survives restart.
  scheduleCurrentCompose: (fireAtMs: number) => Promise<void>;
};

/// Owns the send-with-undo lifecycle: undo-window timer, in-flight
/// payload, and the actual send → toast → sync sequence. Coordinates
/// with the draft autosave so the latest edits are flushed before
/// drafts.send fires.
export function useSendUndo(
  compose: Accessor<ComposeState | null>,
  setCompose: (next: ComposeState | null) => void,
  setSendError: (msg: string | null) => void,
  draftAutosave: DraftAutosaveHandle,
  startSync: (email: string) => Promise<void>,
  clearDraft: () => void,
): SendUndoHandle {
  let pendingSendTimer: number | undefined;
  let pendingSendPayload: ComposeState | null = null;

  function fireSend(payload: ComposeState) {
    const send = payload.draft_id
      ? invoke("send_draft", {
          email: payload.from_account,
          draftId: payload.draft_id,
        })
      : invoke("send_message", {
          request: {
            fromAccount: payload.from_account,
            to: extractEmailAddresses(payload.to),
            cc: extractEmailAddresses(payload.cc),
            bcc: extractEmailAddresses(payload.bcc),
            subject: payload.subject,
            body: payload.body,
            htmlBody: payload.html_body ?? null,
            attachments: payload.attachments ?? [],
            inReplyTo: payload.in_reply_to,
            references: payload.references,
          },
        });
    send
      .then(() => {
        showToast({ message: "Sent" });
        // Pull the new sent message into cache so it lands in Sent
        // within a second or two instead of waiting for the next
        // periodic sync.
        void startSync(payload.from_account);
      })
      .catch((err) =>
        showToast({ message: `Send failed: ${err}`, variant: "error" }),
      );
  }

  async function handleSendCompose() {
    const cur = compose();
    if (!cur) return;
    if (!cur.from_account) {
      setSendError("Choose an account to send from.");
      return;
    }
    const to = extractEmailAddresses(cur.to);
    if (to.length === 0) {
      setSendError("Add at least one recipient in To.");
      return;
    }
    setSendError(null);

    // If an earlier send is still in its undo window, fire it now so
    // we don't lose it when this one queues up.
    if (pendingSendTimer !== undefined && pendingSendPayload) {
      window.clearTimeout(pendingSendTimer);
      const earlier = pendingSendPayload;
      pendingSendTimer = undefined;
      pendingSendPayload = null;
      fireSend(earlier);
    }

    // Flush any pending autosave so send_draft (which sends Gmail's
    // server copy of the draft) sees the latest body. Without this a
    // user who types and clicks Send within the 1.5 s debounce loses
    // those edits.
    draftAutosave.cancelPendingDraftSave();
    await draftAutosave.saveDraftNow();

    // Re-read compose: saveDraftNow may have written back draft_id.
    const latest = compose() ?? cur;
    const payload: ComposeState = { ...latest };
    pendingSendPayload = payload;
    clearDraft();
    draftAutosave.bumpComposeSession();
    setCompose(null);

    const undoMs = Math.max(0, settings().compose.undoSendSeconds) * 1000;
    if (undoMs === 0) {
      pendingSendPayload = null;
      fireSend(payload);
      return;
    }

    pendingSendTimer = window.setTimeout(() => {
      pendingSendTimer = undefined;
      pendingSendPayload = null;
      fireSend(payload);
    }, undoMs);

    showToast({
      message: "Sending…",
      timeoutMs: undoMs + 500,
      action: {
        label: "Undo",
        onClick: () => {
          if (pendingSendTimer !== undefined) {
            window.clearTimeout(pendingSendTimer);
            pendingSendTimer = undefined;
          }
          pendingSendPayload = null;
          setCompose(payload);
        },
      },
    });
  }

  async function scheduleCurrentCompose(fireAtMs: number) {
    const cur = compose();
    if (!cur) return;
    if (!cur.from_account) {
      setSendError("Choose an account to send from.");
      return;
    }
    const to = extractEmailAddresses(cur.to);
    if (to.length === 0) {
      setSendError("Add at least one recipient in To.");
      return;
    }
    try {
      await invoke("schedule_send", {
        request: {
          fireAtMs,
          fromAccount: cur.from_account,
          to,
          cc: extractEmailAddresses(cur.cc),
          bcc: extractEmailAddresses(cur.bcc),
          subject: cur.subject,
          body: cur.body,
          htmlBody: cur.html_body ?? null,
          attachments: cur.attachments ?? [],
          inReplyTo: cur.in_reply_to,
          references: cur.references,
        },
      });
      draftAutosave.cancelPendingDraftSave();
      draftAutosave.bumpComposeSession();
      clearDraft();
      setCompose(null);
      showToast({
        message: `Scheduled for ${new Date(fireAtMs).toLocaleString()}`,
      });
    } catch (err) {
      setSendError(String(err));
    }
  }

  return { handleSendCompose, scheduleCurrentCompose };
}

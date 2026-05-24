import { Accessor, createEffect } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "../toast";
import { composeFingerprint, isComposeEmpty } from "../composeHelpers";
import { DRAFT_AUTOSAVE_DEBOUNCE_MS } from "../constants";
import { extractEmailAddresses } from "../utils";
import { settings } from "../settings";
import type { ComposeState } from "../types";

export type DraftAutosaveHandle = {
  /// Bump every time we switch composes (open new, discard, schedule,
  /// finish sending). Captured by in-flight saves so a stale Gmail draft
  /// id can't graft onto a different compose.
  bumpComposeSession: () => void;
  /// Re-arm the 1.5 s debounce.
  scheduleDraftSave: () => void;
  /// Force an immediate save — used by handleSendCompose to flush
  /// last-second edits before drafts.send fires.
  saveDraftNow: () => Promise<void>;
  /// Drop any pending timer so a discard right after typing doesn't
  /// fire an orphan create.
  cancelPendingDraftSave: () => void;
};

/// Owns the Gmail Drafts autosave lifecycle for the currently-open
/// compose. Installs a `createEffect` that watches the compose and
/// schedules a debounced save when the saveable-field fingerprint
/// changes. Reply / forward composes and signature-only composes are
/// skipped to avoid splitting threads on the server and to keep the
/// Drafts folder clean.
export function useDraftAutosave(
  compose: Accessor<ComposeState | null>,
  setCompose: (next: ComposeState | null) => void,
): DraftAutosaveHandle {
  let draftSaveTimer: number | undefined;
  let draftSaveInflight = false;
  let draftSaveErrorShown = false;
  let composeSession = 0;
  let lastSavedFingerprint = "";

  function bumpComposeSession() {
    composeSession += 1;
  }

  function scheduleDraftSave() {
    if (draftSaveTimer !== undefined) clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(saveDraftNow, DRAFT_AUTOSAVE_DEBOUNCE_MS);
  }

  async function saveDraftNow() {
    const cur = compose();
    if (!cur) return;
    if (draftSaveInflight) {
      // A save is already in flight; reschedule once it lands so we
      // never drop the latest edits.
      scheduleDraftSave();
      return;
    }
    if (isComposeEmpty(settings(), cur)) return;
    if (!cur.from_account) return;
    const session = composeSession;
    const wasCreating = !cur.draft_id;
    draftSaveInflight = true;
    try {
      const id = await invoke<string>("save_draft", {
        request: {
          draftId: cur.draft_id ?? null,
          fromAccount: cur.from_account,
          to: extractEmailAddresses(cur.to),
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
      // Compose was discarded / replaced while we were in flight: do
      // not graft the new id onto whatever the user is editing now.
      // If we just created a brand new server draft it has no local
      // owner — delete it so the user's Gmail Drafts folder doesn't
      // accumulate orphans.
      if (session !== composeSession) {
        if (wasCreating) {
          void invoke("delete_draft", {
            email: cur.from_account,
            draftId: id,
          }).catch(() => {});
        }
        return;
      }
      const latest = compose();
      if (latest && !latest.draft_id) {
        setCompose({ ...latest, draft_id: id });
      }
      // Pin the fingerprint to what we just persisted; the autosave
      // effect uses this to suppress its immediate re-fire after we
      // stamp the new draft_id back onto state.
      lastSavedFingerprint = composeFingerprint(compose() ?? cur);
      draftSaveErrorShown = false;
    } catch (err) {
      // Surface only the first failure so we don't spam the user on
      // every keystroke when offline. The flag is reset on the next
      // success.
      if (!draftSaveErrorShown) {
        showToast({
          message: `Draft autosave failed: ${err}`,
          variant: "error",
        });
        draftSaveErrorShown = true;
      }
    } finally {
      draftSaveInflight = false;
    }
  }

  function cancelPendingDraftSave() {
    if (draftSaveTimer !== undefined) {
      clearTimeout(draftSaveTimer);
      draftSaveTimer = undefined;
    }
  }

  // Auto-installed: schedule a save whenever the compose changes in a
  // way that would change what we'd upload. The fingerprint gate
  // suppresses no-op re-runs (e.g. when saveDraftNow stamps draft_id
  // back onto state).
  createEffect(() => {
    const cur = compose();
    if (!cur) {
      // Compose closed → reset the fingerprint so the next session
      // starts dirty (otherwise the very first save would be skipped
      // if the user re-types the same body).
      lastSavedFingerprint = "";
      return;
    }
    if (cur.in_reply_to) return;
    if (cur.subject.startsWith("Fwd:")) return;
    if (isComposeEmpty(settings(), cur)) return;
    if (composeFingerprint(cur) === lastSavedFingerprint) return;
    scheduleDraftSave();
  });

  return {
    bumpComposeSession,
    scheduleDraftSave,
    saveDraftNow,
    cancelPendingDraftSave,
  };
}

import { For, Show, createEffect, createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { showToast } from "./toast";
import { sanitizeMessageHtml } from "./htmlSanitize";
import { parseFromHeader } from "./utils";
import type { Attachment, MessageDetail } from "./types";

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  const units = ["B", "KB", "MB", "GB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

// Open an attachment with the OS default app. The backend fetches the bytes,
// writes them to a cache dir, and hands the path to the system opener — the
// blob/`<a download>` trick doesn't work inside the webview.
async function openAttachment(
  accountEmail: string,
  messageId: string,
  att: Attachment,
) {
  try {
    await invoke("open_attachment", {
      email: accountEmail,
      messageId,
      attachmentId: att.attachment_id,
      filename: att.filename || "attachment",
    });
  } catch (err) {
    showToast({ message: `Open failed: ${err}`, variant: "error" });
  }
}

// Save an attachment to a user-chosen location via the native save dialog.
async function saveAttachment(
  accountEmail: string,
  messageId: string,
  att: Attachment,
) {
  try {
    const dest = await save({ defaultPath: att.filename || "attachment" });
    if (!dest) return; // user cancelled
    await invoke("save_attachment", {
      email: accountEmail,
      messageId,
      attachmentId: att.attachment_id,
      destPath: dest,
    });
    showToast({ message: `Saved ${att.filename || "attachment"}` });
  } catch (err) {
    showToast({ message: `Save failed: ${err}`, variant: "error" });
  }
}

function ThreadMessage(props: {
  detail: MessageDetail;
  isLast: boolean;
  expanded: boolean;
  allowed: boolean;
  accountEmail: string;
  onToggleExpanded: () => void;
  onShowImages: () => void;
}) {
  // Per-message CID map: prefetched lazily when the message expands. Cached
  // here so collapsing/re-expanding doesn't re-download.
  const [cidMap, setCidMap] = createSignal<Record<string, string>>({});
  const fillsRemaining = () => props.expanded && props.isLast;

  // Partition attachments into "real" (chip-strip) and "inline" (CID-only)
  // so the strip stays focused on what the user can act on.
  const allAttachments = (): Attachment[] => props.detail.attachments ?? [];
  const visibleAttachments = createMemo(() =>
    allAttachments().filter((a) => !a.inline || !a.content_id),
  );

  // Prefetch CID inline images once the user opens the message.
  createEffect(() => {
    if (!props.expanded) return;
    const html = props.detail.html_body ?? "";
    if (!html) return;
    const inline = allAttachments().filter((a) => a.inline && a.content_id);
    if (inline.length === 0) return;
    const referenced = inline.filter((a) =>
      html.toLowerCase().includes(`cid:${a.content_id!.toLowerCase()}`),
    );
    if (referenced.length === 0) return;
    const already = cidMap();
    const todo = referenced.filter((a) => !already[a.content_id!]);
    if (todo.length === 0) return;
    Promise.all(
      todo.map((a) =>
        invoke<string>("get_attachment", {
          email: props.accountEmail,
          messageId: props.detail.id,
          attachmentId: a.attachment_id,
        }).then(
          (b64) =>
            [
              // Normalise to lowercase so the sanitizer's case-insensitive
              // lookup hits regardless of how the producer cased Content-Id.
              a.content_id!.toLowerCase(),
              `data:${a.mime_type};base64,${b64}`,
            ] as const,
          () => null,
        ),
      ),
    ).then((entries) => {
      const next = { ...cidMap() };
      for (const e of entries) {
        if (e) next[e[0]] = e[1];
      }
      setCidMap(next);
    });
  });

  const sanitized = createMemo(() =>
    sanitizeMessageHtml(props.detail.html_body ?? "", {
      allowRemoteImages: props.allowed,
      cidMap: cidMap(),
    }),
  );

  const previewText = () =>
    (props.detail.text_body ?? props.detail.html_body ?? "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .slice(0, 160);

  return (
    <article
      class={`flex flex-col border-b border-[color:var(--color-border)] ${
        fillsRemaining() ? "min-h-0 flex-1" : "shrink-0"
      }`}
      style={{ contain: "layout paint" }}
    >
      <header
        onClick={props.onToggleExpanded}
        class="flex shrink-0 cursor-pointer items-baseline justify-between gap-4 px-6 py-3 hover:bg-[color:var(--color-surface-hover)]"
      >
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm">
            <span class="font-medium">
              {parseFromHeader(props.detail.from).name}
            </span>{" "}
            <span class="text-[color:var(--color-muted)]">
              &lt;{parseFromHeader(props.detail.from).email}&gt;
            </span>
          </div>
          <Show when={!props.expanded}>
            <div class="truncate text-xs text-[color:var(--color-muted)]">
              {previewText()}
            </div>
          </Show>
        </div>
        <span class="shrink-0 text-xs text-[color:var(--color-muted)]">
          {props.detail.date}
        </span>
      </header>
      <Show when={props.expanded}>
        <div
          class={`flex flex-col border-t border-[color:var(--color-border)] ${
            fillsRemaining() ? "min-h-0 flex-1" : ""
          }`}
        >
          <Show
            when={
              props.detail.calendar_uid &&
              props.detail.calendar_method?.toUpperCase() === "REQUEST"
            }
          >
            <InviteBar
              uid={props.detail.calendar_uid!}
              accountEmail={props.accountEmail}
            />
          </Show>
          <Show when={visibleAttachments().length > 0}>
            <div class="flex shrink-0 flex-wrap gap-1.5 border-b border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-6 py-2 text-xs">
              <For each={visibleAttachments()}>
                {(att) => (
                  <div class="flex items-stretch overflow-hidden rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)]">
                    <button
                      type="button"
                      onClick={() =>
                        openAttachment(
                          props.accountEmail,
                          props.detail.id,
                          att,
                        )
                      }
                      title={`Open ${att.filename || "attachment"}`}
                      class="flex items-center gap-1.5 px-2 py-1 hover:bg-[color:var(--color-surface-hover)]"
                    >
                      <span aria-hidden="true">📎</span>
                      <span class="max-w-48 truncate font-medium">
                        {att.filename || "(unnamed)"}
                      </span>
                      <Show when={att.size > 0}>
                        <span class="text-[color:var(--color-muted)]">
                          {formatBytes(att.size)}
                        </span>
                      </Show>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        saveAttachment(
                          props.accountEmail,
                          props.detail.id,
                          att,
                        )
                      }
                      title={`Save ${att.filename || "attachment"}…`}
                      aria-label={`Save ${att.filename || "attachment"}`}
                      class="flex items-center border-l border-[color:var(--color-border)] px-1.5 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)] hover:text-[color:var(--color-fg)]"
                    >
                      <span aria-hidden="true">↓</span>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>
          <Show
            when={props.detail.html_body}
            fallback={
              <pre
                class={`whitespace-pre-wrap p-6 font-sans text-sm ${
                  fillsRemaining()
                    ? "min-h-0 flex-1 overflow-auto"
                    : "max-h-[60vh] overflow-auto"
                }`}
              >
                {props.detail.text_body || "(no body)"}
              </pre>
            }
          >
            <Show when={!props.allowed && sanitized().blockedImages > 0}>
              <div class="flex shrink-0 items-center justify-between bg-[color:var(--color-bg)] px-6 py-2 text-xs text-[color:var(--color-muted)]">
                <span>Remote images blocked to protect your privacy.</span>
                <button
                  type="button"
                  onClick={props.onShowImages}
                  class="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-surface-hover)]"
                >
                  Show images
                </button>
              </div>
            </Show>
            <iframe
              srcdoc={sanitized().html}
              sandbox="allow-scripts allow-popups-to-escape-sandbox"
              class={`w-full border-0 bg-white ${
                fillsRemaining() ? "min-h-0 flex-1" : "h-[60vh]"
              }`}
              style={{
                transform: "translateZ(0)",
                "will-change": "transform",
              }}
              title="message body"
            />
          </Show>
        </div>
      </Show>
    </article>
  );
}

export function InviteBar(props: { uid: string; accountEmail: string }) {
  const [busy, setBusy] = createSignal(false);
  async function rsvp(status: "accepted" | "tentative" | "declined") {
    if (!props.accountEmail) {
      showToast({ message: "No account context for invite", variant: "error" });
      return;
    }
    setBusy(true);
    try {
      await invoke("respond_to_invite", {
        email: props.accountEmail,
        icalUid: props.uid,
        status,
      });
      showToast({
        message:
          status === "accepted"
            ? "Accepted invite"
            : status === "tentative"
              ? "Marked tentative"
              : "Declined invite",
      });
    } catch (err) {
      showToast({ message: `RSVP failed: ${err}`, variant: "error" });
    } finally {
      setBusy(false);
    }
  }
  return (
    <div class="flex shrink-0 items-center gap-2 border-b border-[color:var(--color-border)] bg-[color:var(--color-accent-bg)] px-6 py-2 text-xs">
      <span class="text-[color:var(--color-fg)]">📅 Meeting invite</span>
      <div class="ml-auto flex gap-1">
        <button
          type="button"
          disabled={busy()}
          onClick={() => rsvp("accepted")}
          class="rounded bg-[color:var(--color-accent)] px-2 py-0.5 text-white hover:opacity-90 disabled:opacity-50"
        >
          Accept
        </button>
        <button
          type="button"
          disabled={busy()}
          onClick={() => rsvp("tentative")}
          class="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-0.5 hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
        >
          Maybe
        </button>
        <button
          type="button"
          disabled={busy()}
          onClick={() => rsvp("declined")}
          class="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-0.5 hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
        >
          Decline
        </button>
      </div>
    </div>
  );
}

export function MessagePreview(props: {
  selectedMessageId: string | null;
  messageDetailLoading: boolean;
  messageDetailError: string | null;
  messageDetail: MessageDetail | null;
  threadDetails: MessageDetail[];
  latestInThread: MessageDetail | null;
  currentMessageAccount: string;
  expandedInThread: Set<string>;
  allowImagesFor: Set<string>;
  alwaysAllowImages: boolean;
  toggleThreadExpanded: (id: string) => void;
  setAllowImagesFor: (next: Set<string>) => void;
  onReply: (all: boolean) => void;
  onForward: () => void;
}) {
  return (
    <section class="flex min-w-0 flex-1 flex-col bg-[color:var(--color-surface)]">
      <Show
        when={props.selectedMessageId}
        fallback={
          <div class="flex flex-1 items-center justify-center text-sm text-[color:var(--color-muted)]">
            Select a message to read.
          </div>
        }
      >
        <Show
          when={
            props.messageDetailLoading && props.threadDetails.length === 0
          }
        >
          <div class="flex flex-1 items-center justify-center text-sm text-[color:var(--color-muted)]">
            Loading…
          </div>
        </Show>
        <Show
          when={
            props.messageDetailError && props.threadDetails.length === 0
          }
        >
          <div class="flex flex-1 items-center justify-center p-6">
            <div class="rounded border border-red-400 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
              {props.messageDetailError}
            </div>
          </div>
        </Show>
        <Show when={props.messageDetail && props.threadDetails.length > 0}>
          <header class="shrink-0 border-b border-[color:var(--color-border)] px-6 py-4">
            <div class="flex items-start justify-between gap-4">
              <h1 class="text-lg font-semibold">
                {(props.latestInThread ?? props.messageDetail)?.subject ||
                  "(no subject)"}
              </h1>
              <div class="flex shrink-0 items-center gap-2">
                <Show when={props.threadDetails.length > 1}>
                  <span class="rounded-full bg-[color:var(--color-surface-active)] px-2 py-0.5 text-xs text-[color:var(--color-muted)]">
                    {props.threadDetails.length} messages
                  </span>
                </Show>
                <button
                  type="button"
                  onClick={() => props.onReply(false)}
                  class="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
                >
                  Reply
                </button>
                <button
                  type="button"
                  onClick={() => props.onReply(true)}
                  class="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
                >
                  Reply all
                </button>
                <button
                  type="button"
                  onClick={props.onForward}
                  class="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
                >
                  Forward
                </button>
              </div>
            </div>
          </header>
          <div
            class="flex min-h-0 flex-1 flex-col overflow-y-auto"
            style={{ "will-change": "scroll-position" }}
          >
            <For each={props.threadDetails}>
              {(d, i) => (
                <ThreadMessage
                  detail={d}
                  isLast={i() === props.threadDetails.length - 1}
                  expanded={props.expandedInThread.has(d.id)}
                  allowed={
                    props.alwaysAllowImages || props.allowImagesFor.has(d.id)
                  }
                  accountEmail={props.currentMessageAccount}
                  onToggleExpanded={() => props.toggleThreadExpanded(d.id)}
                  onShowImages={() => {
                    const next = new Set(props.allowImagesFor);
                    next.add(d.id);
                    props.setAllowImagesFor(next);
                  }}
                />
              )}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}

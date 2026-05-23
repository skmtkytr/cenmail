import { For, Show, createMemo, createSignal } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { showToast } from "./toast";
import { sanitizeMessageHtml } from "./htmlSanitize";
import { parseFromHeader } from "./utils";
import type { MessageDetail } from "./types";

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
  prefersDark: boolean;
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
              {(d, i) => {
                const expanded = () => props.expandedInThread.has(d.id);
                const allowed = () =>
                  props.alwaysAllowImages || props.allowImagesFor.has(d.id);
                const sanitized = createMemo(() =>
                  sanitizeMessageHtml(d.html_body ?? "", {
                    allowRemoteImages: allowed(),
                    dark: props.prefersDark,
                  }),
                );
                const isLast = () => i() === props.threadDetails.length - 1;
                const fillsRemaining = () => expanded() && isLast();
                return (
                  <article
                    class={`flex flex-col border-b border-[color:var(--color-border)] ${
                      fillsRemaining() ? "min-h-0 flex-1" : "shrink-0"
                    }`}
                    style={{ contain: "layout paint" }}
                  >
                    <header
                      onClick={() => props.toggleThreadExpanded(d.id)}
                      class="flex shrink-0 cursor-pointer items-baseline justify-between gap-4 px-6 py-3 hover:bg-[color:var(--color-surface-hover)]"
                    >
                      <div class="min-w-0 flex-1">
                        <div class="truncate text-sm">
                          <span class="font-medium">
                            {parseFromHeader(d.from).name}
                          </span>{" "}
                          <span class="text-[color:var(--color-muted)]">
                            &lt;{parseFromHeader(d.from).email}&gt;
                          </span>
                        </div>
                        <Show when={!expanded()}>
                          <div class="truncate text-xs text-[color:var(--color-muted)]">
                            {(d.text_body ?? d.html_body ?? "")
                              .replace(/<[^>]+>/g, " ")
                              .replace(/\s+/g, " ")
                              .slice(0, 160)}
                          </div>
                        </Show>
                      </div>
                      <span class="shrink-0 text-xs text-[color:var(--color-muted)]">
                        {d.date}
                      </span>
                    </header>
                    <Show when={expanded()}>
                      <div
                        class={`flex flex-col border-t border-[color:var(--color-border)] ${
                          fillsRemaining() ? "min-h-0 flex-1" : ""
                        }`}
                      >
                        <Show
                          when={
                            d.calendar_uid &&
                            d.calendar_method?.toUpperCase() === "REQUEST"
                          }
                        >
                          <InviteBar
                            uid={d.calendar_uid!}
                            accountEmail={props.currentMessageAccount}
                          />
                        </Show>
                        <Show
                          when={d.html_body}
                          fallback={
                            <pre
                              class={`whitespace-pre-wrap p-6 font-sans text-sm ${
                                fillsRemaining()
                                  ? "min-h-0 flex-1 overflow-auto"
                                  : "max-h-[60vh] overflow-auto"
                              }`}
                            >
                              {d.text_body || "(no body)"}
                            </pre>
                          }
                        >
                          <Show
                            when={!allowed() && sanitized().blockedImages > 0}
                          >
                            <div class="flex shrink-0 items-center justify-between bg-[color:var(--color-bg)] px-6 py-2 text-xs text-[color:var(--color-muted)]">
                              <span>
                                Remote images blocked to protect your privacy.
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  const next = new Set(props.allowImagesFor);
                                  next.add(d.id);
                                  props.setAllowImagesFor(next);
                                }}
                                class="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-surface-hover)]"
                              >
                                Show images
                              </button>
                            </div>
                          </Show>
                          <iframe
                            srcdoc={sanitized().html}
                            sandbox="allow-popups allow-popups-to-escape-sandbox"
                            class={`w-full border-0 ${
                              fillsRemaining() ? "min-h-0 flex-1" : "h-[60vh]"
                            } ${
                              props.prefersDark
                                ? "bg-[color:var(--color-surface)]"
                                : "bg-white"
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
              }}
            </For>
          </div>
        </Show>
      </Show>
    </section>
  );
}

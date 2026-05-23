import { For, Show, createSignal } from "solid-js";
import type { Account, ComposeAttachment, ComposeState } from "./types";
import { snoozePresets } from "./types";
import { useEscClose } from "./modal";

const ATTACHMENT_LIMIT_MB = 25;

function fileToB64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader returned non-string"));
        return;
      }
      // result is "data:<mime>;base64,<b64>" — strip the prefix.
      const idx = result.indexOf(",");
      resolve(idx >= 0 ? result.slice(idx + 1) : result);
    };
    reader.readAsDataURL(file);
  });
}

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

function stripHtmlForFallback(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return (div.textContent ?? "").replace(/ /g, " ");
}

export function ComposeModal(props: {
  compose: ComposeState | null;
  accounts: Account[];
  sendError: string | null;
  onClose: () => void;
  onSend: () => void;
  onScheduleSend: (fireAtMs: number) => void;
  onUpdate: <K extends keyof ComposeState>(key: K, value: ComposeState[K]) => void;
}) {
  const [scheduleMenuOpen, setScheduleMenuOpen] = createSignal(false);
  const [attachError, setAttachError] = createSignal<string | null>(null);
  useEscClose(() => props.compose !== null, () => props.onClose());

  async function addFiles(files: FileList | File[]) {
    setAttachError(null);
    const cur = props.compose;
    if (!cur) return;
    const existing = cur.attachments ?? [];
    const currentBytes = existing.reduce((s, a) => s + a.size, 0);
    const limitBytes = ATTACHMENT_LIMIT_MB * 1024 * 1024;
    const next: ComposeAttachment[] = [...existing];
    let totalBytes = currentBytes;
    for (const f of Array.from(files)) {
      if (totalBytes + f.size > limitBytes) {
        setAttachError(
          `Attachments would exceed Gmail's ${ATTACHMENT_LIMIT_MB} MB limit.`,
        );
        break;
      }
      try {
        const b64 = await fileToB64(f);
        next.push({
          filename: f.name,
          mime_type: f.type || "application/octet-stream",
          size: f.size,
          data_b64: b64,
        });
        totalBytes += f.size;
      } catch (err) {
        setAttachError(`Failed to read ${f.name}: ${err}`);
      }
    }
    props.onUpdate("attachments", next);
  }

  function removeAttachment(idx: number) {
    const cur = props.compose;
    if (!cur) return;
    const next = (cur.attachments ?? []).filter((_, i) => i !== idx);
    props.onUpdate("attachments", next);
  }

  function applyFormat(cmd: "bold" | "italic" | "createLink" | "formatBlock") {
    if (cmd === "createLink") {
      const url = window.prompt("Link URL?");
      if (!url) return;
      document.execCommand("createLink", false, url);
    } else if (cmd === "formatBlock") {
      document.execCommand("formatBlock", false, "blockquote");
    } else {
      document.execCommand(cmd);
    }
  }
  return (
    <Show when={props.compose}>
      {(cs) => (
        <div
          class="fixed inset-0 z-40 flex items-end justify-end p-4 sm:items-center sm:justify-center sm:p-8"
          onClick={props.onClose}
        >
          <div
            class="absolute inset-0 bg-black/40"
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            class="relative flex h-[640px] w-full max-w-3xl flex-col rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <header class="flex items-center justify-between border-b border-[color:var(--color-border)] px-4 py-3">
              <span class="text-sm font-semibold">
                {cs().in_reply_to
                  ? "Reply"
                  : cs().subject.startsWith("Fwd:")
                    ? "Forward"
                    : "New message"}
              </span>
              <button
                type="button"
                onClick={props.onClose}
                class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
                aria-label="Close"
              >
                ×
              </button>
            </header>

            <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
              <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                From
              </span>
              <select
                value={cs().from_account}
                onChange={(e) =>
                  props.onUpdate("from_account", e.currentTarget.value)
                }
                class="flex-1 bg-transparent outline-none"
              >
                <For each={props.accounts}>
                  {(a) => <option value={a.email}>{a.email}</option>}
                </For>
              </select>
            </div>

            <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
              <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                To
              </span>
              <input
                value={cs().to}
                onInput={(e) => props.onUpdate("to", e.currentTarget.value)}
                placeholder="recipient@example.com, another@example.com"
                class="flex-1 bg-transparent outline-none"
              />
              <Show when={!cs().show_cc_bcc}>
                <button
                  type="button"
                  onClick={() => props.onUpdate("show_cc_bcc", true)}
                  class="text-xs text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]"
                >
                  Cc / Bcc
                </button>
              </Show>
            </div>

            <Show when={cs().show_cc_bcc}>
              <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
                <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                  Cc
                </span>
                <input
                  value={cs().cc}
                  onInput={(e) => props.onUpdate("cc", e.currentTarget.value)}
                  class="flex-1 bg-transparent outline-none"
                />
              </div>
              <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
                <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                  Bcc
                </span>
                <input
                  value={cs().bcc}
                  onInput={(e) => props.onUpdate("bcc", e.currentTarget.value)}
                  class="flex-1 bg-transparent outline-none"
                />
              </div>
            </Show>

            <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
              <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                Subject
              </span>
              <input
                value={cs().subject}
                onInput={(e) =>
                  props.onUpdate("subject", e.currentTarget.value)
                }
                class="flex-1 bg-transparent outline-none"
              />
            </div>

            <Show when={cs().rich}>
              <div class="flex shrink-0 items-center gap-1 border-b border-[color:var(--color-border)] px-2 py-1 text-xs text-[color:var(--color-muted)]">
                <button
                  type="button"
                  title="Bold (Ctrl+B)"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyFormat("bold");
                  }}
                  class="rounded px-2 py-0.5 font-bold hover:bg-[color:var(--color-surface-hover)]"
                >
                  B
                </button>
                <button
                  type="button"
                  title="Italic (Ctrl+I)"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyFormat("italic");
                  }}
                  class="rounded px-2 py-0.5 italic hover:bg-[color:var(--color-surface-hover)]"
                >
                  I
                </button>
                <button
                  type="button"
                  title="Insert link"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyFormat("createLink");
                  }}
                  class="rounded px-2 py-0.5 hover:bg-[color:var(--color-surface-hover)]"
                >
                  🔗
                </button>
                <button
                  type="button"
                  title="Block quote"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    applyFormat("formatBlock");
                  }}
                  class="rounded px-2 py-0.5 hover:bg-[color:var(--color-surface-hover)]"
                >
                  ❝
                </button>
                <span class="ml-auto">
                  <button
                    type="button"
                    title="Switch to plain text"
                    onClick={() => {
                      // Drop HTML, keep text content.
                      const text = stripHtmlForFallback(cs().html_body ?? "");
                      props.onUpdate("body", text || cs().body);
                      props.onUpdate("html_body", undefined);
                      props.onUpdate("rich", false);
                    }}
                    class="text-[10px] uppercase tracking-wide hover:text-[color:var(--color-fg)]"
                  >
                    Plain
                  </button>
                </span>
              </div>
              <div
                contentEditable
                class="flex-1 overflow-auto bg-transparent p-4 text-sm leading-relaxed outline-none"
                ref={(el) => {
                  // Only seed the DOM when html_body is non-empty; otherwise
                  // typing into an empty div is fine without an initial value.
                  if (el && cs().html_body && el.innerHTML === "") {
                    el.innerHTML = cs().html_body ?? "";
                  }
                }}
                onInput={(e) => {
                  const html = (e.currentTarget as HTMLDivElement).innerHTML;
                  props.onUpdate("html_body", html);
                  props.onUpdate("body", stripHtmlForFallback(html));
                }}
              />
            </Show>
            <Show when={!cs().rich}>
              <div class="flex shrink-0 items-center justify-end gap-2 border-b border-[color:var(--color-border)] px-2 py-1 text-xs text-[color:var(--color-muted)]">
                <button
                  type="button"
                  title="Switch to rich text"
                  onClick={() => {
                    if (!cs().html_body) {
                      // Promote the current plain body to HTML by escaping &
                      // wrapping linebreaks.
                      const seed = (cs().body || "")
                        .replace(/&/g, "&amp;")
                        .replace(/</g, "&lt;")
                        .replace(/>/g, "&gt;")
                        .replace(/\n/g, "<br>");
                      props.onUpdate("html_body", seed);
                    }
                    props.onUpdate("rich", true);
                  }}
                  class="text-[10px] uppercase tracking-wide hover:text-[color:var(--color-fg)]"
                >
                  Rich text
                </button>
              </div>
              <textarea
                value={cs().body}
                onInput={(e) => props.onUpdate("body", e.currentTarget.value)}
                placeholder="Write your message…"
                class="flex-1 resize-none bg-transparent p-4 text-sm leading-relaxed outline-none"
              />
            </Show>

            <Show when={(cs().attachments ?? []).length > 0}>
              <div class="flex shrink-0 flex-wrap gap-1.5 border-t border-[color:var(--color-border)] px-4 py-2 text-xs">
                <For each={cs().attachments ?? []}>
                  {(att, idx) => (
                    <span class="flex items-center gap-1.5 rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] px-2 py-1">
                      <span aria-hidden="true">📎</span>
                      <span class="max-w-48 truncate font-medium">
                        {att.filename}
                      </span>
                      <span class="text-[color:var(--color-muted)]">
                        {formatBytes(att.size)}
                      </span>
                      <button
                        type="button"
                        onClick={() => removeAttachment(idx())}
                        aria-label={`Remove ${att.filename}`}
                        class="ml-1 text-[color:var(--color-muted)] hover:text-red-500"
                      >
                        ×
                      </button>
                    </span>
                  )}
                </For>
              </div>
            </Show>

            <Show when={attachError() || props.sendError}>
              <div class="mx-4 mb-2 rounded border border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
                {attachError() ?? props.sendError}
              </div>
            </Show>

            <footer class="flex items-center justify-end gap-2 border-t border-[color:var(--color-border)] px-4 py-3">
              <label class="cursor-pointer rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]">
                📎 Attach
                <input
                  type="file"
                  multiple
                  class="hidden"
                  onChange={(e) => {
                    const fl = e.currentTarget.files;
                    if (fl && fl.length > 0) void addFiles(fl);
                    e.currentTarget.value = "";
                  }}
                />
              </label>
              <div class="relative mr-auto">
                <button
                  type="button"
                  onClick={() => setScheduleMenuOpen(!scheduleMenuOpen())}
                  class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
                >
                  Send later ▾
                </button>
                <Show when={scheduleMenuOpen()}>
                  <ul class="absolute bottom-full left-0 mb-1 min-w-44 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-1 text-sm shadow-lg">
                    <For each={snoozePresets()}>
                      {(p) => (
                        <li>
                          <button
                            type="button"
                            class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                            onClick={() => {
                              setScheduleMenuOpen(false);
                              props.onScheduleSend(p.fireAt);
                            }}
                          >
                            {p.label}
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
              </div>
              <button
                type="button"
                onClick={props.onClose}
                class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={props.onSend}
                class="rounded bg-[color:var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
              >
                Send
              </button>
            </footer>
          </div>
        </div>
      )}
    </Show>
  );
}

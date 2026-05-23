import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import { createStore } from "solid-js/store";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  cacheKey,
  classifyBucket,
  extractEmailAddresses,
  formatRelativeDate,
  matchesFolder,
  parseFromHeader,
  prefixSubject,
  type AccountSelection,
  type Bucket,
} from "./utils";
import { sanitizeMessageHtml } from "./htmlSanitize";
import { ToastContainer, showToast, triggerLastAction } from "./toast";
import { ConfirmHost, confirmModal } from "./modal";
import { settings, notificationsEnabledFor } from "./settings";
import { SettingsModal } from "./settingsModal";
import "./App.css";

const DRAFT_STORAGE_KEY = "cenmail:compose-draft";

function usePrefersDark(): () => boolean {
  const [dark, setDark] = createSignal(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-color-scheme: dark)").matches,
  );
  if (typeof window !== "undefined" && window.matchMedia) {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = (e: MediaQueryListEvent) => setDark(e.matches);
    mq.addEventListener("change", handler);
  }
  return dark;
}

type Account = {
  id: number;
  email: string;
  display_name: string | null;
  picture_url: string | null;
  provider: string;
  created_at: string;
};

type MessageMeta = {
  id: string;
  thread_id: string | null;
  from: string;
  subject: string;
  snippet: string;
  date_millis: number;
  unread: boolean;
  label_ids: string[];
  account_email: string;
};

type MessageDetail = {
  id: string;
  thread_id: string | null;
  from: string;
  to: string;
  cc: string;
  subject: string;
  date: string;
  message_id_header: string;
  references: string;
  html_body: string | null;
  text_body: string | null;
};

type ComposeState = {
  from_account: string;
  to: string;
  cc: string;
  bcc: string;
  subject: string;
  body: string;
  in_reply_to: string | null;
  references: string | null;
  show_cc_bcc: boolean;
};

type SyncProgress = { email: string; fetched: number; total: number };
type SyncDone = { email: string; total: number };
type SyncError = { email: string; error: string };

type SyncState = {
  fetched: number;
  total: number;
  status: "idle" | "syncing" | "done" | "error";
  error?: string;
};

type Folder = { id: string; label: string };
const folders: Folder[] = [
  { id: "inbox", label: "Inbox" },
  { id: "pinned", label: "Pinned" },
  { id: "snoozed", label: "Snoozed" },
  { id: "sent", label: "Sent" },
  { id: "archive", label: "Archive" },
  { id: "trash", label: "Trash" },
];

function quoteForReply(detail: MessageDetail): string {
  const original = detail.text_body ?? stripHtml(detail.html_body ?? "");
  const lines = original.split(/\r?\n/).map((l) => `> ${l}`);
  return `\n\nOn ${detail.date}, ${detail.from} wrote:\n${lines.join("\n")}`;
}

function quoteForForward(detail: MessageDetail): string {
  const original = detail.text_body ?? stripHtml(detail.html_body ?? "");
  return `\n\n---------- Forwarded message ----------\nFrom: ${detail.from}\nDate: ${detail.date}\nSubject: ${detail.subject}\nTo: ${detail.to}\n\n${original}`;
}

function stripHtml(html: string): string {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? "";
}

const PANE_DEFAULTS = { sidebar: 240, list: 384 };
const PANE_MIN = { sidebar: 160, list: 240 };
const PANE_MAX = { sidebar: 480, list: 800 };

function readStoredWidth(key: keyof typeof PANE_DEFAULTS): number {
  try {
    const raw = localStorage.getItem(`pane:${key}`);
    if (raw === null) return PANE_DEFAULTS[key];
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) {
      return Math.max(PANE_MIN[key], Math.min(PANE_MAX[key], n));
    }
  } catch {}
  return PANE_DEFAULTS[key];
}

function App() {
  const osPrefersDark = usePrefersDark();
  // The user can override the OS preference in settings.
  const prefersDark = () => {
    const theme = settings().appearance.theme;
    if (theme === "dark") return true;
    if (theme === "light") return false;
    return osPrefersDark();
  };
  const [allowImagesFor, setAllowImagesFor] = createSignal<Set<string>>(
    new Set(),
  );
  const [settingsOpen, setSettingsOpen] = createSignal(false);

  // Apply explicit theme override to <html data-theme=...>.
  createEffect(() => {
    const theme = settings().appearance.theme;
    const root = document.documentElement;
    if (theme === "system") {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", theme);
    }
  });
  const [selectedFolder, setSelectedFolder] = createSignal("inbox");
  const [selectedAccount, setSelectedAccount] =
    createSignal<AccountSelection>("all");
  const [selectedMessageId, setSelectedMessageId] = createSignal<string | null>(
    null,
  );
  const [messageDetail, setMessageDetail] = createSignal<MessageDetail | null>(
    null,
  );
  const [messageDetailLoading, setMessageDetailLoading] = createSignal(false);
  const [messageDetailError, setMessageDetailError] = createSignal<
    string | null
  >(null);
  const [addingAccount, setAddingAccount] = createSignal(false);
  const [addError, setAddError] = createSignal<string | null>(null);

  const [messageCache, setMessageCache] = createStore<
    Record<string, MessageMeta[]>
  >({});
  const [loadingKeys, setLoadingKeys] = createStore<Record<string, boolean>>(
    {},
  );
  const [messagesError, setMessagesError] = createSignal<string | null>(null);

  const [syncState, setSyncState] = createStore<Record<string, SyncState>>({});

  const [accounts, { refetch: refetchAccounts }] = createResource<Account[]>(
    async () => await invoke<Account[]>("list_accounts"),
    { initialValue: [] },
  );

  const accountById = (id: AccountSelection): Account | undefined => {
    if (id === "all") return undefined;
    return (accounts() ?? []).find((a) => a.id === id);
  };

  const [searchQuery, setSearchQuery] = createSignal("");
  const [debouncedSearch, setDebouncedSearch] = createSignal("");
  let searchDebounce: number | undefined;
  let searchInputRef: HTMLInputElement | undefined;

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
    return (messages() ?? []).filter((m) => ids.has(m.id));
  }

  function selectionTargets(fallback: MessageMeta | null): MessageMeta[] {
    const multi = selectedMessages();
    if (multi.length > 1) return multi;
    if (fallback) return [fallback];
    if (multi.length === 1) return multi;
    return [];
  }

  function handleListClick(e: MouseEvent, message: MessageMeta) {
    const list = visibleMessages() ?? [];
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
        if (only) void selectMessage(only);
      } else if (next.size === 0) {
        setSelectedMessageId(null);
        setMessageDetail(null);
      }
      return;
    }
    setSelectedIds(new Set([message.id]));
    setAnchorId(message.id);
    void selectMessage(message);
  }

  async function loadMessages(
    sel: AccountSelection,
    folder: string,
    query: string,
  ) {
    const key = cacheKey(sel, folder, query);
    setLoadingKeys(key, true);
    setMessagesError(null);
    try {
      const params: {
        email?: string;
        folder: string;
        query?: string;
        limit?: number;
      } = { folder, limit: 500 };
      if (query.length > 0) params.query = query;
      if (sel !== "all") {
        const acct = accountById(sel);
        if (!acct) {
          setLoadingKeys(key, false);
          return;
        }
        params.email = acct.email;
      }
      const data = await invoke<MessageMeta[]>("list_messages", params);
      setMessageCache(key, data);
    } catch (err) {
      setMessagesError(String(err));
    } finally {
      setLoadingKeys(key, false);
    }
  }

  function reloadAllVisible() {
    setMessageCache({});
    void loadMessages(selectedAccount(), selectedFolder(), debouncedSearch());
  }

  // Reload the visible list at most once per `LIST_RELOAD_DEBOUNCE_MS` while
  // a sync is streaming progress events. Without debounce we'd thrash the DB
  // on every batch.
  const LIST_RELOAD_DEBOUNCE_MS = 1500;
  let listReloadTimer: number | undefined;
  function scheduleListReload() {
    if (listReloadTimer !== undefined) return;
    listReloadTimer = window.setTimeout(() => {
      listReloadTimer = undefined;
      void loadMessages(
        selectedAccount(),
        selectedFolder(),
        debouncedSearch(),
      );
    }, LIST_RELOAD_DEBOUNCE_MS);
  }

  async function startSync(email: string) {
    setSyncState(email, {
      fetched: 0,
      total: 0,
      status: "syncing",
      error: undefined,
    });
    try {
      await invoke("sync_account", { email });
    } catch (err) {
      setSyncState(email, "status", "error");
      setSyncState(email, "error", String(err));
    }
  }

  async function syncAll() {
    const list = accounts() ?? [];
    await Promise.all(list.map((a) => startSync(a.email)));
  }

  createEffect(() => {
    const sel = selectedAccount();
    const folder = selectedFolder();
    const q = debouncedSearch();
    void loadMessages(sel, folder, q);
  });

  function handleSearchInput(value: string) {
    setSearchQuery(value);
    if (searchDebounce !== undefined) clearTimeout(searchDebounce);
    searchDebounce = window.setTimeout(() => {
      setDebouncedSearch(value.trim());
    }, 200);
  }

  function clearSearch() {
    setSearchQuery("");
    setDebouncedSearch("");
  }

  const messages = (): MessageMeta[] =>
    messageCache[
      cacheKey(selectedAccount(), selectedFolder(), debouncedSearch())
    ] ?? [];
  const messagesLoading = (): boolean =>
    !!loadingKeys[
      cacheKey(selectedAccount(), selectedFolder(), debouncedSearch())
    ];
  const hasCache = (): boolean =>
    cacheKey(selectedAccount(), selectedFolder(), debouncedSearch()) in
    messageCache;

  // Smart Inbox bucket filter — only applies to the Inbox folder.
  const [selectedBucket, setSelectedBucket] = createSignal<Bucket | "all">(
    settings().inbox.defaultBucket,
  );
  const bucketCounts = createMemo(() => {
    const out = { personal: 0, newsletters: 0, notifications: 0 };
    if (selectedFolder() !== "inbox") return out;
    for (const m of messages()) out[classifyBucket(m)] += 1;
    return out;
  });
  const visibleMessages = createMemo(() => {
    const all = messages();
    const bucket = selectedBucket();
    if (bucket === "all" || selectedFolder() !== "inbox") return all;
    return all.filter((m) => classifyBucket(m) === bucket);
  });

  const [sidebarWidth, setSidebarWidth] = createSignal(
    readStoredWidth("sidebar"),
  );
  const [listWidth, setListWidth] = createSignal(readStoredWidth("list"));

  function startResize(
    e: MouseEvent,
    side: "sidebar" | "list",
  ): void {
    e.preventDefault();
    const startX = e.clientX;
    const startW = side === "sidebar" ? sidebarWidth() : listWidth();
    const setter = side === "sidebar" ? setSidebarWidth : setListWidth;
    const min = PANE_MIN[side];
    const max = PANE_MAX[side];

    const prevCursor = document.body.style.cursor;
    const prevSelect = document.body.style.userSelect;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    function onMove(ev: MouseEvent) {
      const next = Math.max(min, Math.min(max, startW + ev.clientX - startX));
      setter(next);
    }
    function onUp() {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = prevCursor;
      document.body.style.userSelect = prevSelect;
      try {
        localStorage.setItem(
          `pane:${side}`,
          String(side === "sidebar" ? sidebarWidth() : listWidth()),
        );
      } catch {}
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  const aggregateSync = createMemo(() => {
    const entries = Object.values(syncState);
    if (entries.length === 0) return null;
    const syncing = entries.filter((e) => e.status === "syncing");
    if (syncing.length === 0) {
      const errored = entries.filter((e) => e.status === "error");
      if (errored.length > 0) {
        return { label: `Sync failed for ${errored.length}`, syncing: false };
      }
      const total = entries.reduce((a, e) => a + (e.total || 0), 0);
      return total > 0
        ? { label: `Synced ${total.toLocaleString()} messages`, syncing: false }
        : { label: "Synced", syncing: false };
    }
    const fetched = syncing.reduce((a, e) => a + e.fetched, 0);
    const total = syncing.reduce((a, e) => a + e.total, 0);
    if (total === 0) {
      return { label: `Listing… (${syncing.length} accounts)`, syncing: true };
    }
    return {
      label: `Syncing ${fetched.toLocaleString()} / ${total.toLocaleString()}`,
      syncing: true,
    };
  });

  const unlistenFns: UnlistenFn[] = [];
  onMount(async () => {
    unlistenFns.push(
      await listen("accounts:changed", async () => {
        await refetchAccounts();
        reloadAllVisible();
      }),
    );
    unlistenFns.push(
      await listen<SyncProgress>("sync:progress", (e) => {
        const { email, fetched, total } = e.payload;
        setSyncState(email, "fetched", fetched);
        setSyncState(email, "total", total);
        setSyncState(email, "status", "syncing");
        scheduleListReload();
      }),
    );
    unlistenFns.push(
      await listen<SyncDone>("sync:done", (e) => {
        const { email, total } = e.payload;
        setSyncState(email, "fetched", total);
        setSyncState(email, "total", total);
        setSyncState(email, "status", "done");
        reloadAllVisible();
      }),
    );
    unlistenFns.push(
      await listen<SyncError>("sync:error", (e) => {
        const { email, error } = e.payload;
        setSyncState(email, "status", "error");
        setSyncState(email, "error", error);
      }),
    );
    unlistenFns.push(
      await listen<string>("snooze:fired", () => {
        reloadAllVisible();
      }),
    );
    unlistenFns.push(
      await listen<string>("schedule:sent", () => {
        showToast({ message: "Scheduled message sent" });
      }),
    );
    unlistenFns.push(
      await listen<string>("messages:changed", () => {
        // Backend mutated a message (e.g., timer fired); refresh visible list.
        reloadAllVisible();
      }),
    );

    // Backfill profile pictures for accounts saved before picture_url existed.
    void backfillAccountProfiles();
    // Ensure notification permission is requested early; ignore failure.
    void ensureNotificationPermission();
    // Start background sync of all accounts on first load.
    void syncAll();
  });

  async function ensureNotificationPermission(): Promise<boolean> {
    try {
      let granted = await isPermissionGranted();
      if (!granted) {
        const perm = await requestPermission();
        granted = perm === "granted";
      }
      return granted;
    } catch {
      return false;
    }
  }

  const NOTIFY_KEY = "cenmail:last-notified-ms";
  function getLastNotifiedMs(): number {
    try {
      const raw = localStorage.getItem(NOTIFY_KEY);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  function setLastNotifiedMs(ms: number) {
    try {
      localStorage.setItem(NOTIFY_KEY, String(ms));
    } catch {}
  }

  // Cross-reference: after a sync settles and the visible cache is reloaded,
  // notify for any new Personal-bucket unread message we haven't notified for.
  let notifyWarmedUp = false;
  createEffect(() => {
    const allKeys = Object.keys(messageCache);
    if (allKeys.length === 0) return;
    const lastSeen = getLastNotifiedMs();
    let maxSeen = lastSeen;
    const candidates: MessageMeta[] = [];
    for (const key of allKeys) {
      // Only consider the Inbox caches so we don't pick up sent/archive lists.
      if (!key.startsWith("inbox:")) continue;
      const list = messageCache[key] ?? [];
      for (const m of list) {
        if (m.date_millis > maxSeen) maxSeen = m.date_millis;
        if (!m.unread) continue;
        if (m.date_millis <= lastSeen) continue;
        if (!notificationsEnabledFor(m.account_email, classifyBucket(m))) {
          continue;
        }
        candidates.push(m);
      }
    }
    // On first observation after launch, swallow the burst — set the watermark
    // to the latest seen and don't fire any notifications.
    if (!notifyWarmedUp) {
      notifyWarmedUp = true;
      if (maxSeen > lastSeen) setLastNotifiedMs(maxSeen);
      return;
    }
    if (candidates.length === 0) return;
    if (maxSeen > lastSeen) setLastNotifiedMs(maxSeen);
    void ensureNotificationPermission().then((granted) => {
      if (!granted) return;
      if (candidates.length === 1) {
        const m = candidates[0];
        sendNotification({
          title: parseFromHeader(m.from).name,
          body: m.subject || "(no subject)",
        });
      } else {
        sendNotification({
          title: "cenmail",
          body: `${candidates.length} new messages`,
        });
      }
    });
  });

  async function backfillAccountProfiles() {
    await refetchAccounts();
    const missing = (accounts() ?? []).filter((a) => !a.picture_url);
    if (missing.length === 0) return;
    await Promise.all(
      missing.map(async (a) => {
        try {
          await invoke("refresh_account", { email: a.email });
        } catch (err) {
          // best-effort: ignore here, user will see a fallback initial avatar
        }
      }),
    );
  }
  onCleanup(() => {
    unlistenFns.forEach((u) => u());
  });

  async function handleAddAccount() {
    setAddError(null);
    setAddingAccount(true);
    try {
      const newAcct = await invoke<Account>("add_account");
      void startSync(newAcct.email);
    } catch (err) {
      setAddError(String(err));
    } finally {
      setAddingAccount(false);
    }
  }

  async function handleRemoveAccount(id: number) {
    const ok = await confirmModal({
      title: "Remove account?",
      body: "Cached messages will be deleted and the refresh token will be removed from the keyring.",
      confirmLabel: "Remove",
      destructive: true,
    });
    if (!ok) return;
    try {
      await invoke("remove_account", { id });
    } catch (err) {
      setAddError(String(err));
    }
  }

  async function modifyLabels(
    message: MessageMeta,
    add: string[],
    remove: string[],
  ) {
    // Optimistic local update
    applyLocalLabelChange(message, add, remove);
    try {
      await invoke("modify_message", {
        email: message.account_email,
        messageId: message.id,
        addLabels: add,
        removeLabels: remove,
      });
    } catch (err) {
      setMessagesError(String(err));
      reloadAllVisible();
    }
  }

  async function trashMessageAction(message: MessageMeta) {
    applyLocalLabelChange(message, ["TRASH"], [
      "INBOX",
      "UNREAD",
      "STARRED",
    ]);
    try {
      await invoke("trash_message", {
        email: message.account_email,
        messageId: message.id,
      });
    } catch (err) {
      setMessagesError(String(err));
      reloadAllVisible();
    }
  }

  async function untrashMessageAction(message: MessageMeta) {
    try {
      await invoke("untrash_message", {
        email: message.account_email,
        messageId: message.id,
      });
      reloadAllVisible();
    } catch (err) {
      setMessagesError(String(err));
    }
  }

  function archiveWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    for (const t of targets) void modifyLabels(t, [], ["INBOX"]);
    showToast({
      message: targets.length === 1 ? "Archived" : `Archived ${targets.length}`,
      action: {
        label: "Undo",
        onClick: () => {
          for (const t of snapshot) void modifyLabels(t, ["INBOX"], []);
          reloadAllVisible();
        },
      },
    });
  }

  function trashWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    for (const t of targets) void trashMessageAction(t);
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

  function snoozePresets(): Array<{ label: string; fireAt: number }> {
    const now = new Date();
    const inOneHour = now.getTime() + 60 * 60 * 1000;
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);
    tomorrow.setHours(9, 0, 0, 0);
    const nextMonday = new Date(now);
    const daysUntilMonday = ((1 + 7 - nextMonday.getDay()) % 7) || 7;
    nextMonday.setDate(nextMonday.getDate() + daysUntilMonday);
    nextMonday.setHours(9, 0, 0, 0);
    const thisEvening = new Date(now);
    thisEvening.setHours(18, 0, 0, 0);
    return [
      { label: "1 hour", fireAt: inOneHour },
      ...(thisEvening.getTime() > now.getTime() + 30 * 60 * 1000
        ? [{ label: "This evening (6pm)", fireAt: thisEvening.getTime() }]
        : []),
      { label: "Tomorrow 9am", fireAt: tomorrow.getTime() },
      { label: "Next Monday 9am", fireAt: nextMonday.getTime() },
    ];
  }

  async function snoozeMessages(targets: MessageMeta[], fireAtMs: number) {
    if (targets.length === 0) return;
    for (const t of targets) {
      // Optimistic: remove from current cache so it disappears immediately.
      applyLocalLabelChange(t, [], ["INBOX"]);
      try {
        await invoke("snooze_message", {
          email: t.account_email,
          messageId: t.id,
          fireAtMs,
        });
      } catch (err) {
        showToast({
          message: `Snooze failed: ${err}`,
          variant: "error",
        });
        reloadAllVisible();
        return;
      }
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
          reloadAllVisible();
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
      reloadAllVisible();
      showToast({
        message: "Thread muted",
        action: {
          label: "Undo",
          onClick: () => {
            void invoke("unmute_thread", {
              email: message.account_email,
              threadId: message.thread_id,
            }).then(() => reloadAllVisible());
          },
        },
      });
    } catch (err) {
      showToast({ message: `Mute failed: ${err}`, variant: "error" });
    }
  }

  function starToggleWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    const allStarred = snapshot.every((t) => t.label_ids.includes("STARRED"));
    for (const t of snapshot) {
      void modifyLabels(
        t,
        allStarred ? [] : ["STARRED"],
        allStarred ? ["STARRED"] : [],
      );
    }
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

  function applyLocalLabelChange(
    message: MessageMeta,
    add: string[],
    remove: string[],
  ) {
    const key = cacheKey(
      selectedAccount(),
      selectedFolder(),
      debouncedSearch(),
    );
    const list = messageCache[key];
    if (!list) return;
    const newLabels = new Set(message.label_ids);
    for (const r of remove) newLabels.delete(r);
    for (const a of add) newLabels.add(a);
    const nextLabels = Array.from(newLabels);
    const updated: MessageMeta = {
      ...message,
      label_ids: nextLabels,
      unread: nextLabels.includes("UNREAD"),
    };
    // Decide whether the message still belongs in the current folder; if not,
    // drop it locally so the UI feels snappy.
    const stillVisible = matchesCurrentFolder(nextLabels);
    if (stillVisible) {
      setMessageCache(
        key,
        list.map((m) => (m.id === message.id ? updated : m)),
      );
    } else {
      setMessageCache(
        key,
        list.filter((m) => m.id !== message.id),
      );
      if (selectedMessageId() === message.id) {
        setSelectedMessageId(null);
        setMessageDetail(null);
      }
    }
  }

  function matchesCurrentFolder(labels: string[]): boolean {
    return matchesFolder(labels, selectedFolder());
  }

  async function selectMessage(message: MessageMeta) {
    setSelectedMessageId(message.id);
    setSelectedIds(new Set([message.id]));
    setAnchorId(message.id);
    setMessageDetail(null);
    setMessageDetailError(null);
    setMessageDetailLoading(true);
    if (message.unread && settings().inbox.markAsReadOnOpen) {
      void modifyLabels(message, [], ["UNREAD"]);
    }
    try {
      const detail = await invoke<MessageDetail>("get_message", {
        email: message.account_email,
        messageId: message.id,
      });
      setMessageDetail(detail);
      void loadThread(detail, message.account_email);
    } catch (err) {
      setMessageDetailError(String(err));
    } finally {
      setMessageDetailLoading(false);
    }
  }

  const [threadDetails, setThreadDetails] = createSignal<MessageDetail[]>([]);
  const [expandedInThread, setExpandedInThread] = createSignal<Set<string>>(
    new Set<string>(),
  );

  async function loadThread(detail: MessageDetail, accountEmail: string) {
    if (!detail.thread_id) {
      setThreadDetails([detail]);
      setExpandedInThread(new Set([detail.id]));
      return;
    }
    try {
      const result = await invoke<MessageDetail[]>("get_thread", {
        email: accountEmail,
        threadId: detail.thread_id,
      });
      if (result.length <= 1) {
        setThreadDetails([detail]);
        setExpandedInThread(new Set([detail.id]));
        return;
      }
      setThreadDetails(result);
      // Expand the latest, plus the message the user clicked on.
      const last = result[result.length - 1];
      const expanded = new Set<string>([last.id, detail.id]);
      setExpandedInThread(expanded);
    } catch {
      setThreadDetails([detail]);
      setExpandedInThread(new Set([detail.id]));
    }
  }

  function toggleThreadExpanded(id: string) {
    const next = new Set(expandedInThread());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpandedInThread(next);
  }

  function latestInThread(): MessageDetail | null {
    const arr = threadDetails();
    return arr.length > 0 ? arr[arr.length - 1] : null;
  }

  const [compose, setCompose] = createSignal<ComposeState | null>(null);
  const [sendError, setSendError] = createSignal<string | null>(null);
  const [scheduleMenuOpen, setScheduleMenuOpen] = createSignal(false);

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
          inReplyTo: cur.in_reply_to,
          references: cur.references,
        },
      });
      clearDraft();
      setCompose(null);
      showToast({
        message: `Scheduled for ${new Date(fireAtMs).toLocaleString()}`,
      });
    } catch (err) {
      setSendError(String(err));
    }
  }

  // Autosave: only persist blank composes (reply / forward composes are
  // initiated from a specific message and shouldn't survive across sessions).
  createEffect(() => {
    const cur = compose();
    if (!cur) return;
    if (cur.in_reply_to || cur.subject.startsWith("Fwd:")) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(cur));
    } catch {}
  });

  function defaultFromAccount(): string {
    // 1. Explicit user default in settings wins (if still valid).
    const explicit = settings().compose.defaultAccount;
    if (explicit && (accounts() ?? []).some((a) => a.email === explicit)) {
      return explicit;
    }
    // 2. Current sidebar selection if narrowed to one account.
    const sel = selectedAccount();
    if (sel !== "all") {
      const acct = accountById(sel);
      if (acct) return acct.email;
    }
    // 3. First added.
    return (accounts() ?? [])[0]?.email ?? "";
  }

  function loadDraft(): ComposeState | null {
    try {
      const raw = localStorage.getItem(DRAFT_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as ComposeState;
      // Sanity check: drafts saved before account removal can reference an
      // account that no longer exists. Fall back to the default account.
      const known = (accounts() ?? []).some(
        (a) => a.email === parsed.from_account,
      );
      if (!known) parsed.from_account = defaultFromAccount();
      return parsed;
    } catch {
      return null;
    }
  }

  function clearDraft() {
    try {
      localStorage.removeItem(DRAFT_STORAGE_KEY);
    } catch {}
  }

  function isComposeEmpty(c: ComposeState): boolean {
    return (
      c.to.trim() === "" &&
      c.cc.trim() === "" &&
      c.bcc.trim() === "" &&
      c.subject.trim() === "" &&
      c.body.trim() === ""
    );
  }

  function openCompose() {
    setSendError(null);
    const restored = loadDraft();
    if (restored && !isComposeEmpty(restored)) {
      setCompose(restored);
      showToast({ message: "Draft restored" });
      return;
    }
    setCompose({
      from_account: defaultFromAccount(),
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      body: "",
      in_reply_to: null,
      references: null,
      show_cc_bcc: false,
    });
  }

  function openReply(all: boolean) {
    const detail = latestInThread() ?? messageDetail();
    if (!detail) return;
    const senderMeta = (messages() ?? []).find(
      (m) => m.id === selectedMessageId(),
    );
    const fromAccount = senderMeta?.account_email ?? defaultFromAccount();
    const original = parseFromHeader(detail.from).email;
    const toList = [original];
    const ccList: string[] = [];
    if (all) {
      const tos = extractEmailAddresses(detail.to).filter(
        (e) => e !== fromAccount && e !== original,
      );
      const ccs = extractEmailAddresses(detail.cc).filter(
        (e) => e !== fromAccount && e !== original,
      );
      toList.push(...tos);
      ccList.push(...ccs);
    }
    const refs = detail.references
      ? `${detail.references} ${detail.message_id_header}`.trim()
      : detail.message_id_header;
    setSendError(null);
    setCompose({
      from_account: fromAccount,
      to: toList.join(", "),
      cc: ccList.join(", "),
      bcc: "",
      subject: prefixSubject("Re:", detail.subject),
      body: quoteForReply(detail),
      in_reply_to: detail.message_id_header || null,
      references: refs || null,
      show_cc_bcc: ccList.length > 0,
    });
  }

  function openForward() {
    const detail = latestInThread() ?? messageDetail();
    if (!detail) return;
    const senderMeta = (messages() ?? []).find(
      (m) => m.id === selectedMessageId(),
    );
    const fromAccount = senderMeta?.account_email ?? defaultFromAccount();
    setSendError(null);
    setCompose({
      from_account: fromAccount,
      to: "",
      cc: "",
      bcc: "",
      subject: prefixSubject("Fwd:", detail.subject),
      body: quoteForForward(detail),
      in_reply_to: null,
      references: null,
      show_cc_bcc: false,
    });
  }

  async function closeCompose() {
    const cur = compose();
    if (cur && !isComposeEmpty(cur)) {
      const ok = await confirmModal({
        title: "Discard this draft?",
        body: "Your message will be lost.",
        confirmLabel: "Discard",
        destructive: true,
      });
      if (!ok) return;
    }
    clearDraft();
    setCompose(null);
  }

  function updateCompose<K extends keyof ComposeState>(
    key: K,
    value: ComposeState[K],
  ) {
    const cur = compose();
    if (!cur) return;
    setCompose({ ...cur, [key]: value });
  }

  let pendingSendTimer: number | undefined;
  let pendingSendPayload: ComposeState | null = null;

  function fireSend(payload: ComposeState) {
    invoke("send_message", {
      request: {
        fromAccount: payload.from_account,
        to: extractEmailAddresses(payload.to),
        cc: extractEmailAddresses(payload.cc),
        bcc: extractEmailAddresses(payload.bcc),
        subject: payload.subject,
        body: payload.body,
        inReplyTo: payload.in_reply_to,
        references: payload.references,
      },
    })
      .then(() => showToast({ message: "Sent" }))
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

    // If an earlier send is still in its undo window, fire it now so we don't
    // lose it when this one queues up.
    if (pendingSendTimer !== undefined && pendingSendPayload) {
      window.clearTimeout(pendingSendTimer);
      const earlier = pendingSendPayload;
      pendingSendTimer = undefined;
      pendingSendPayload = null;
      fireSend(earlier);
    }

    const payload: ComposeState = { ...cur };
    pendingSendPayload = payload;
    clearDraft();
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

  const [contextMenu, setContextMenu] = createSignal<{
    x: number;
    y: number;
    message: MessageMeta;
  } | null>(null);

  function closeContextMenu() {
    setContextMenu(null);
  }

  function openContextMenu(e: MouseEvent, message: MessageMeta) {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, message });
  }

  const [showShortcuts, setShowShortcuts] = createSignal(false);

  function currentMessage(): MessageMeta | null {
    const id = selectedMessageId();
    if (!id) return null;
    return (messages() ?? []).find((m) => m.id === id) ?? null;
  }

  function moveSelection(delta: number) {
    const list = visibleMessages() ?? [];
    if (list.length === 0) return;
    const id = selectedMessageId();
    const idx = id ? list.findIndex((m) => m.id === id) : -1;
    let next = idx + delta;
    if (idx < 0) next = delta > 0 ? 0 : list.length - 1;
    next = Math.max(0, Math.min(list.length - 1, next));
    const target = list[next];
    if (target) void selectMessage(target);
  }

  function isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }

  function handleShortcut(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (showShortcuts()) {
        setShowShortcuts(false);
        return;
      }
      if (contextMenu()) {
        closeContextMenu();
        return;
      }
      if (compose()) {
        closeCompose();
        return;
      }
      if (selectedIds().size > 1) {
        clearMultiSelect();
        return;
      }
      if (selectedMessageId()) {
        setSelectedMessageId(null);
        setMessageDetail(null);
        clearMultiSelect();
        return;
      }
    }
    // Global re-sync: Ctrl/Cmd + Shift + R. Placed before the editable-target
    // bail so it works even when the search field has focus.
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      e.key.toLowerCase() === "r"
    ) {
      e.preventDefault();
      handleRefresh();
      return;
    }

    if (isEditableTarget(e.target)) return;

    // Ctrl/Cmd+Z fires the most recent undoable toast (archive, snooze, etc.).
    // Placed after the editable-target bail so native text undo in compose
    // still works.
    if (
      (e.ctrlKey || e.metaKey) &&
      !e.shiftKey &&
      e.key.toLowerCase() === "z"
    ) {
      if (triggerLastAction()) {
        e.preventDefault();
      }
      return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      if (compose() || showShortcuts()) return;
      e.preventDefault();
      const list = visibleMessages() ?? [];
      setSelectedIds(new Set(list.map((m) => m.id)));
      if (list.length > 0) setAnchorId(list[0].id);
      return;
    }

    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (compose() || showShortcuts()) return;

    const m = currentMessage();
    const bulk = () => selectionTargets(m);
    switch (e.key) {
      case "j":
        e.preventDefault();
        moveSelection(1);
        break;
      case "k":
        e.preventDefault();
        moveSelection(-1);
        break;
      case "e": {
        const targets = bulk().filter((t) =>
          t.label_ids.includes("INBOX"),
        );
        if (targets.length > 0) {
          e.preventDefault();
          archiveWithUndo(targets);
        }
        break;
      }
      case "#":
      case "Delete": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          trashWithUndo(targets);
        }
        break;
      }
      case "s": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          starToggleWithUndo(targets);
        }
        break;
      }
      case "z": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          void snoozeMessages(targets, snoozePresets()[0].fireAt);
        }
        break;
      }
      case "m": {
        if (m) {
          e.preventDefault();
          void muteThreadAction(m);
        }
        break;
      }
      case "u": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          const allUnread = targets.every((t) => t.unread);
          for (const t of targets) {
            void modifyLabels(
              t,
              allUnread ? [] : ["UNREAD"],
              allUnread ? ["UNREAD"] : [],
            );
          }
        }
        break;
      }
      case "r":
        if (m && messageDetail()) {
          e.preventDefault();
          openReply(false);
        }
        break;
      case "a":
        if (m && messageDetail()) {
          e.preventDefault();
          openReply(true);
        }
        break;
      case "f":
        if (m && messageDetail()) {
          e.preventDefault();
          openForward();
        }
        break;
      case "c":
        e.preventDefault();
        openCompose();
        break;
      case "/":
        e.preventDefault();
        searchInputRef?.focus();
        searchInputRef?.select();
        break;
      case "?":
        e.preventDefault();
        setShowShortcuts(true);
        break;
    }
  }

  onMount(() => {
    const onDocClick = () => closeContextMenu();
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", handleShortcut);
    onCleanup(() => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", handleShortcut);
    });
  });

  function handleRefresh() {
    const sel = selectedAccount();
    if (sel === "all") {
      void syncAll();
    } else {
      const acct = accountById(sel);
      if (acct) void startSync(acct.email);
    }
  }

  const headerTitle = () => {
    const sel = selectedAccount();
    if (sel === "all") return "All Inboxes";
    const acct = accountById(sel);
    return acct?.email ?? "Inbox";
  };

  return (
    <div class="flex h-full w-full text-[color:var(--color-fg)]">
      <aside
        class="flex shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-surface)]"
        style={{ width: `${sidebarWidth()}px` }}
      >
        <div class="flex items-center justify-between px-4 py-3">
          <span class="text-sm font-semibold tracking-wide">cenmail</span>
          <div class="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              title="Settings"
              class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
              aria-label="Settings"
            >
              ⚙
            </button>
            <button
              type="button"
              onClick={handleRefresh}
              title="Sync now"
              class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
              aria-label="Sync now"
            >
              ↻
            </button>
          </div>
        </div>
        <div class="px-2 pb-2">
          <button
            type="button"
            onClick={openCompose}
            disabled={(accounts() ?? []).length === 0}
            class="flex w-full items-center justify-center gap-2 rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            ✎ Compose
          </button>
        </div>

        <div class="px-2">
          <button
            type="button"
            onClick={() => setSelectedAccount("all")}
            class={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-hover)] ${
              selectedAccount() === "all"
                ? "bg-[color:var(--color-surface-active)] font-medium"
                : ""
            }`}
          >
            <div class="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-400 text-xs text-white">
              ∞
            </div>
            <span class="truncate">All Inboxes</span>
          </button>
          <For each={accounts() ?? []}>
            {(a) => {
              const isActive = () => selectedAccount() === a.id;
              const state = (): SyncState | undefined => syncState[a.email];
              return (
                <div
                  class={`group flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)] ${
                    isActive()
                      ? "bg-[color:var(--color-surface-active)] font-medium"
                      : ""
                  }`}
                >
                  <button
                    type="button"
                    onClick={() => setSelectedAccount(a.id)}
                    class="flex flex-1 items-center gap-2 overflow-hidden text-left"
                  >
                    <Show
                      when={a.picture_url}
                      fallback={
                        <div class="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300">
                          {a.email.charAt(0).toUpperCase()}
                        </div>
                      }
                    >
                      <img
                        src={a.picture_url ?? ""}
                        class="size-6 shrink-0 rounded-full object-cover"
                        alt=""
                        referrerpolicy="no-referrer"
                      />
                    </Show>
                    <span class="truncate">{a.email}</span>
                    <Show when={state()?.status === "syncing"}>
                      <span class="ml-auto text-xs text-[color:var(--color-muted)]">
                        ↻
                      </span>
                    </Show>
                    <Show when={state()?.status === "error"}>
                      <span
                        class="ml-auto text-xs text-red-500"
                        title={state()?.error}
                      >
                        !
                      </span>
                    </Show>
                  </button>
                  <button
                    type="button"
                    title="Remove account"
                    onClick={() => handleRemoveAccount(a.id)}
                    class="hidden text-[color:var(--color-muted)] hover:text-red-500 group-hover:block"
                    aria-label={`Remove ${a.email}`}
                  >
                    ×
                  </button>
                </div>
              );
            }}
          </For>
          <button
            type="button"
            onClick={handleAddAccount}
            disabled={addingAccount()}
            class="mt-1 flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
          >
            <span class="size-2 rounded-full border border-current" />
            <span>{addingAccount() ? "Authorizing…" : "+ Add account"}</span>
          </button>
          <Show when={addError()}>
            <div class="mt-2 rounded border border-red-400 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
              {addError()}
            </div>
          </Show>
        </div>

        <nav class="mt-4 flex-1 overflow-y-auto px-2">
          <For each={folders}>
            {(f) => {
              const active = () => selectedFolder() === f.id;
              return (
                <button
                  type="button"
                  onClick={() => setSelectedFolder(f.id)}
                  class={`flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-[color:var(--color-surface-hover)] ${
                    active()
                      ? "bg-[color:var(--color-surface-active)] font-medium"
                      : ""
                  }`}
                >
                  <span>{f.label}</span>
                </button>
              );
            }}
          </For>
        </nav>
        <div class="border-t border-[color:var(--color-border)] px-4 py-2 text-xs text-[color:var(--color-muted)]">
          <Show when={aggregateSync()} fallback={<span>Idle</span>}>
            {(s) => (
              <span class={s().syncing ? "text-[color:var(--color-accent)]" : ""}>
                {s().label}
              </span>
            )}
          </Show>
        </div>
      </aside>

      <div
        onMouseDown={(e) => startResize(e, "sidebar")}
        class="group relative flex w-1 shrink-0 cursor-col-resize items-stretch hover:bg-[color:var(--color-accent)]"
        title="Drag to resize sidebar"
      >
        <span class="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
      </div>

      <section
        class="flex shrink-0 flex-col border-r border-[color:var(--color-border)] bg-[color:var(--color-bg)]"
        style={{ width: `${listWidth()}px` }}
      >
        <header class="flex items-center justify-between gap-2 px-4 py-3">
          <h2 class="truncate text-sm font-semibold">{headerTitle()}</h2>
          <div class="flex shrink-0 items-center gap-2 text-xs text-[color:var(--color-muted)]">
            <span>
              {messagesLoading()
                ? `${visibleMessages().length} ↻`
                : `${visibleMessages().length.toLocaleString()} messages`}
            </span>
            <button
              type="button"
              onClick={() => setShowShortcuts(true)}
              title="Keyboard shortcuts (?)"
              aria-label="Keyboard shortcuts"
              class="rounded border border-[color:var(--color-border)] px-1.5 py-0.5 font-mono text-[10px] hover:bg-[color:var(--color-surface-hover)]"
            >
              ?
            </button>
          </div>
        </header>
        <div class="px-4 pb-2">
          <div class="flex items-center gap-2 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-sm focus-within:border-[color:var(--color-accent)]">
            <span class="text-[color:var(--color-muted)]">⌕</span>
            <input
              ref={(el) => (searchInputRef = el)}
              value={searchQuery()}
              onInput={(e) => handleSearchInput(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  if (searchQuery().length > 0) {
                    clearSearch();
                  } else {
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }
              }}
              placeholder="Search subject / from / snippet"
              class="flex-1 bg-transparent outline-none placeholder:text-[color:var(--color-muted)]"
            />
            <Show when={searchQuery().length > 0}>
              <button
                type="button"
                onClick={clearSearch}
                class="text-xs text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)]"
                aria-label="Clear search"
              >
                ×
              </button>
            </Show>
          </div>
        </div>
        <Show when={messagesError()}>
          <div class="mx-4 mb-2 rounded border border-red-400 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
            {messagesError()}
          </div>
        </Show>
        <Show when={selectedFolder() === "inbox"}>
          <div class="flex shrink-0 gap-1 border-b border-[color:var(--color-border)] px-3 py-1.5 text-xs">
            <For
              each={
                [
                  { id: "all" as const, label: "All", count: null },
                  {
                    id: "personal" as const,
                    label: "Personal",
                    count: bucketCounts().personal,
                  },
                  {
                    id: "newsletters" as const,
                    label: "Newsletters",
                    count: bucketCounts().newsletters,
                  },
                  {
                    id: "notifications" as const,
                    label: "Notifications",
                    count: bucketCounts().notifications,
                  },
                ]
              }
            >
              {(b) => {
                const active = () => selectedBucket() === b.id;
                return (
                  <button
                    type="button"
                    onClick={() => setSelectedBucket(b.id)}
                    class={`flex items-center gap-1.5 rounded-full px-2.5 py-1 ${
                      active()
                        ? "bg-[color:var(--color-accent-bg)] text-[color:var(--color-fg)] font-medium"
                        : "text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
                    }`}
                  >
                    <span>{b.label}</span>
                    <Show when={b.count !== null && b.count > 0}>
                      <span class="text-[color:var(--color-muted)]">
                        {b.count}
                      </span>
                    </Show>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>
        <ul class="flex-1 overflow-y-auto">
          <Show
            when={
              !messagesLoading() && hasCache() && visibleMessages().length === 0
            }
          >
            <li class="px-4 py-8 text-center text-sm text-[color:var(--color-muted)]">
              {(accounts() ?? []).length === 0
                ? "Add an account to get started."
                : aggregateSync()?.syncing
                  ? "Syncing…"
                  : "No messages."}
            </li>
          </Show>
          <Show when={messagesLoading() && !hasCache()}>
            <li class="px-4 py-8 text-center text-sm text-[color:var(--color-muted)]">
              Loading…
            </li>
          </Show>
          <For each={visibleMessages()}>
            {(m) => {
              const active = () => selectedMessageId() === m.id;
              const fromParsed = () => parseFromHeader(m.from);
              return (
                <li
                  onClick={(e) => handleListClick(e, m)}
                  onContextMenu={(e) => {
                    if (!isSelected(m.id)) {
                      setSelectedIds(new Set([m.id]));
                      setAnchorId(m.id);
                    }
                    openContextMenu(e, m);
                  }}
                  class={`group flex cursor-pointer select-none items-start gap-3 border-b border-[color:var(--color-border)] px-4 py-3 hover:bg-[color:var(--color-surface-hover)] ${
                    isSelected(m.id)
                      ? "bg-[color:var(--color-accent-bg)]"
                      : ""
                  } ${
                    active() && !isSelected(m.id)
                      ? "ring-1 ring-inset ring-[color:var(--color-accent)]"
                      : ""
                  }`}
                >
                  {(() => {
                    const acct = (accounts() ?? []).find(
                      (a) => a.email === m.account_email,
                    );
                    return acct?.picture_url ? (
                      <img
                        src={acct.picture_url}
                        class="size-6 shrink-0 rounded-full object-cover"
                        alt=""
                        title={m.account_email}
                        referrerpolicy="no-referrer"
                      />
                    ) : (
                      <div
                        class="flex size-6 shrink-0 items-center justify-center rounded-full bg-zinc-300 text-xs text-zinc-600 dark:bg-zinc-700 dark:text-zinc-300"
                        title={m.account_email}
                      >
                        {m.account_email.charAt(0).toUpperCase()}
                      </div>
                    );
                  })()}
                  <div
                    class={`flex w-1.5 shrink-0 self-stretch items-center justify-center ${
                      m.unread ? "" : "invisible"
                    }`}
                  >
                    <span class="size-1.5 rounded-full bg-[color:var(--color-accent)]" />
                  </div>
                  <div
                    class={`min-w-0 flex-1 ${
                      m.unread ? "" : "text-[color:var(--color-muted)]"
                    }`}
                  >
                    <div class="flex justify-between gap-2">
                      <span
                        class={`truncate text-sm ${
                          m.unread
                            ? "font-semibold text-[color:var(--color-fg)]"
                            : ""
                        }`}
                      >
                        {fromParsed().name}
                      </span>
                      <div class="flex shrink-0 items-center gap-1.5 text-xs">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            starToggleWithUndo([m]);
                          }}
                          title={
                            m.label_ids.includes("STARRED")
                              ? "Remove star"
                              : "Star"
                          }
                          aria-label={
                            m.label_ids.includes("STARRED")
                              ? "Remove star"
                              : "Star"
                          }
                          class={`text-sm leading-none ${
                            m.label_ids.includes("STARRED")
                              ? "text-yellow-500"
                              : "text-transparent group-hover:text-[color:var(--color-muted)] hover:!text-yellow-500"
                          }`}
                        >
                          ★
                        </button>
                        <span title={new Date(m.date_millis).toLocaleString()}>
                          {formatRelativeDate(m.date_millis)}
                        </span>
                      </div>
                    </div>
                    <div
                      class={`truncate text-sm ${
                        m.unread
                          ? "font-medium text-[color:var(--color-fg)]"
                          : ""
                      }`}
                    >
                      {m.subject || "(no subject)"}
                    </div>
                    <div class="truncate text-xs text-[color:var(--color-muted)]">
                      {m.snippet}
                    </div>
                  </div>
                </li>
              );
            }}
          </For>
        </ul>
      </section>

      <div
        onMouseDown={(e) => startResize(e, "list")}
        class="group relative flex w-1 shrink-0 cursor-col-resize items-stretch hover:bg-[color:var(--color-accent)]"
        title="Drag to resize list"
      >
        <span class="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
      </div>

      <section class="flex min-w-0 flex-1 flex-col bg-[color:var(--color-surface)]">
        <Show
          when={selectedMessageId()}
          fallback={
            <div class="flex flex-1 items-center justify-center text-sm text-[color:var(--color-muted)]">
              Select a message to read.
            </div>
          }
        >
          <Show when={messageDetailLoading() && threadDetails().length === 0}>
            <div class="flex flex-1 items-center justify-center text-sm text-[color:var(--color-muted)]">
              Loading…
            </div>
          </Show>
          <Show when={messageDetailError() && threadDetails().length === 0}>
            <div class="flex flex-1 items-center justify-center p-6">
              <div class="rounded border border-red-400 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
                {messageDetailError()}
              </div>
            </div>
          </Show>
          <Show when={messageDetail() && threadDetails().length > 0}>
            <header class="shrink-0 border-b border-[color:var(--color-border)] px-6 py-4">
              <div class="flex items-start justify-between gap-4">
                <h1 class="text-lg font-semibold">
                  {(latestInThread() ?? messageDetail())?.subject ||
                    "(no subject)"}
                </h1>
                <div class="flex shrink-0 items-center gap-2">
                  <Show when={threadDetails().length > 1}>
                    <span class="rounded-full bg-[color:var(--color-surface-active)] px-2 py-0.5 text-xs text-[color:var(--color-muted)]">
                      {threadDetails().length} messages
                    </span>
                  </Show>
                  <button
                    type="button"
                    onClick={() => openReply(false)}
                    class="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
                  >
                    Reply
                  </button>
                  <button
                    type="button"
                    onClick={() => openReply(true)}
                    class="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
                  >
                    Reply all
                  </button>
                  <button
                    type="button"
                    onClick={openForward}
                    class="rounded border border-[color:var(--color-border)] px-3 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
                  >
                    Forward
                  </button>
                </div>
              </div>
            </header>
            <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
              <For each={threadDetails()}>
                {(d, i) => {
                  const expanded = () => expandedInThread().has(d.id);
                  const allowed = () =>
                    settings().privacy.alwaysAllowImages ||
                    allowImagesFor().has(d.id);
                  const sanitized = createMemo(() =>
                    sanitizeMessageHtml(d.html_body ?? "", {
                      allowRemoteImages: allowed(),
                      dark: prefersDark(),
                    }),
                  );
                  const isLast = () => i() === threadDetails().length - 1;
                  const fillsRemaining = () => expanded() && isLast();
                  return (
                    <article
                      class={`flex flex-col border-b border-[color:var(--color-border)] ${
                        fillsRemaining() ? "min-h-0 flex-1" : "shrink-0"
                      }`}
                    >
                      <header
                        onClick={() => toggleThreadExpanded(d.id)}
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
                              when={
                                !allowed() && sanitized().blockedImages > 0
                              }
                            >
                              <div class="flex shrink-0 items-center justify-between bg-[color:var(--color-bg)] px-6 py-2 text-xs text-[color:var(--color-muted)]">
                                <span>
                                  Remote images blocked to protect your
                                  privacy.
                                </span>
                                <button
                                  type="button"
                                  onClick={() => {
                                    const next = new Set(allowImagesFor());
                                    next.add(d.id);
                                    setAllowImagesFor(next);
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
                                fillsRemaining()
                                  ? "min-h-0 flex-1"
                                  : "h-[60vh]"
                              } ${
                                prefersDark()
                                  ? "bg-[color:var(--color-surface)]"
                                  : "bg-white"
                              }`}
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

      <Show when={contextMenu()}>
        {(cm) => {
          const m = cm().message;
          const isStarred = () => m.label_ids.includes("STARRED");
          const inTrash = () => m.label_ids.includes("TRASH");
          const inInbox = () => m.label_ids.includes("INBOX");
          return (
            <ul
              role="menu"
              class="fixed z-50 min-w-44 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-1 text-sm shadow-lg"
              style={{ left: `${cm().x}px`, top: `${cm().y}px` }}
              onClick={(e) => e.stopPropagation()}
            >
              <li>
                <button
                  type="button"
                  class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                  onClick={() => {
                    closeContextMenu();
                    void modifyLabels(
                      m,
                      m.unread ? [] : ["UNREAD"],
                      m.unread ? ["UNREAD"] : [],
                    );
                  }}
                >
                  {m.unread ? "Mark as read" : "Mark as unread"}
                </button>
              </li>
              <li>
                <button
                  type="button"
                  class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                  onClick={() => {
                    closeContextMenu();
                    starToggleWithUndo([m]);
                  }}
                >
                  {isStarred() ? "Remove star" : "Star"}
                </button>
              </li>
              <Show when={inInbox()}>
                <li>
                  <button
                    type="button"
                    class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                    onClick={() => {
                      closeContextMenu();
                      archiveWithUndo([m]);
                    }}
                  >
                    Archive
                  </button>
                </li>
                <li class="border-t border-[color:var(--color-border)] mt-1 pt-1">
                  <div class="px-3 pb-1 text-xs text-[color:var(--color-muted)]">
                    Snooze until
                  </div>
                  <For each={snoozePresets()}>
                    {(p) => (
                      <button
                        type="button"
                        class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                        onClick={() => {
                          closeContextMenu();
                          void snoozeMessages([m], p.fireAt);
                        }}
                      >
                        {p.label}
                      </button>
                    )}
                  </For>
                </li>
                <li class="border-t border-[color:var(--color-border)] mt-1">
                  <button
                    type="button"
                    class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                    onClick={() => {
                      closeContextMenu();
                      void muteThreadAction(m);
                    }}
                  >
                    Mute thread
                  </button>
                </li>
              </Show>
              <Show when={!inInbox() && !inTrash()}>
                <li>
                  <button
                    type="button"
                    class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                    onClick={() => {
                      closeContextMenu();
                      void modifyLabels(m, ["INBOX"], []);
                    }}
                  >
                    Move to Inbox
                  </button>
                </li>
              </Show>
              <li>
                <button
                  type="button"
                  class="block w-full px-3 py-1.5 text-left text-red-500 hover:bg-[color:var(--color-surface-hover)]"
                  onClick={() => {
                    closeContextMenu();
                    if (inTrash()) {
                      void modifyLabels(m, [], ["TRASH"]);
                    } else {
                      trashWithUndo([m]);
                    }
                  }}
                >
                  {inTrash() ? "Restore from Trash" : "Move to Trash"}
                </button>
              </li>
            </ul>
          );
        }}
      </Show>

      <Show when={showShortcuts()}>
        <div
          class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
          onClick={() => setShowShortcuts(false)}
        >
          <div
            role="dialog"
            class="w-full max-w-md rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 class="mb-4 text-lg font-semibold">Keyboard shortcuts</h2>
            <table class="w-full text-sm">
              <tbody>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      j
                    </kbd>{" "}
                    /{" "}
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      k
                    </kbd>
                  </td>
                  <td>Next / previous message</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      e
                    </kbd>
                  </td>
                  <td>Archive</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      #
                    </kbd>{" "}
                    /{" "}
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      Del
                    </kbd>
                  </td>
                  <td>Move to Trash</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      s
                    </kbd>
                  </td>
                  <td>Toggle star</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      z
                    </kbd>
                  </td>
                  <td>Snooze 1h</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4 whitespace-nowrap">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      Ctrl
                    </kbd>{" "}
                    +{" "}
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      Z
                    </kbd>
                  </td>
                  <td>Undo last action</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      m
                    </kbd>
                  </td>
                  <td>Mute thread</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      u
                    </kbd>
                  </td>
                  <td>Toggle read / unread</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      r
                    </kbd>{" "}
                    /{" "}
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      a
                    </kbd>{" "}
                    /{" "}
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      f
                    </kbd>
                  </td>
                  <td>Reply / Reply all / Forward</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      c
                    </kbd>
                  </td>
                  <td>Compose new</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      /
                    </kbd>
                  </td>
                  <td>Search</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4 whitespace-nowrap">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      Ctrl
                    </kbd>{" "}
                    +{" "}
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      Shift
                    </kbd>{" "}
                    +{" "}
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      R
                    </kbd>
                  </td>
                  <td>Sync now</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      ?
                    </kbd>
                  </td>
                  <td>Show this help</td>
                </tr>
                <tr>
                  <td class="py-1 pr-4">
                    <kbd class="rounded bg-[color:var(--color-surface-active)] px-1.5 py-0.5 font-mono">
                      Esc
                    </kbd>
                  </td>
                  <td>Close modal / deselect</td>
                </tr>
              </tbody>
            </table>
            <div class="mt-4 text-right">
              <button
                type="button"
                onClick={() => setShowShortcuts(false)}
                class="rounded border border-[color:var(--color-border)] px-3 py-1 text-sm hover:bg-[color:var(--color-surface-hover)]"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      </Show>

      <Show when={compose()}>
        {(cs) => (
          <div
            class="fixed inset-0 z-40 flex items-end justify-end p-4 sm:items-center sm:justify-center sm:p-8"
            onClick={closeCompose}
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
                  onClick={closeCompose}
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
                    updateCompose("from_account", e.currentTarget.value)
                  }
                  class="flex-1 bg-transparent outline-none"
                >
                  <For each={accounts() ?? []}>
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
                  onInput={(e) => updateCompose("to", e.currentTarget.value)}
                  placeholder="recipient@example.com, another@example.com"
                  class="flex-1 bg-transparent outline-none"
                />
                <Show when={!cs().show_cc_bcc}>
                  <button
                    type="button"
                    onClick={() => updateCompose("show_cc_bcc", true)}
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
                    onInput={(e) => updateCompose("cc", e.currentTarget.value)}
                    class="flex-1 bg-transparent outline-none"
                  />
                </div>
                <div class="flex items-center gap-2 border-b border-[color:var(--color-border)] px-4 py-2 text-sm">
                  <span class="w-12 shrink-0 text-[color:var(--color-muted)]">
                    Bcc
                  </span>
                  <input
                    value={cs().bcc}
                    onInput={(e) => updateCompose("bcc", e.currentTarget.value)}
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
                    updateCompose("subject", e.currentTarget.value)
                  }
                  class="flex-1 bg-transparent outline-none"
                />
              </div>

              <textarea
                value={cs().body}
                onInput={(e) => updateCompose("body", e.currentTarget.value)}
                placeholder="Write your message…"
                class="flex-1 resize-none bg-transparent p-4 text-sm leading-relaxed outline-none"
              />

              <Show when={sendError()}>
                <div class="mx-4 mb-2 rounded border border-red-400 bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
                  {sendError()}
                </div>
              </Show>

              <footer class="flex items-center justify-end gap-2 border-t border-[color:var(--color-border)] px-4 py-3">
                <div class="relative mr-auto">
                  <button
                    type="button"
                    onClick={() => setScheduleMenuOpen(!scheduleMenuOpen())}
                    class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
                  >
                    Send later ▾
                  </button>
                  <Show when={scheduleMenuOpen()}>
                    <ul
                      class="absolute bottom-full left-0 mb-1 min-w-44 rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-1 text-sm shadow-lg"
                    >
                      <For each={snoozePresets()}>
                        {(p) => (
                          <li>
                            <button
                              type="button"
                              class="block w-full px-3 py-1.5 text-left hover:bg-[color:var(--color-surface-hover)]"
                              onClick={() => {
                                setScheduleMenuOpen(false);
                                void scheduleCurrentCompose(p.fireAt);
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
                  onClick={closeCompose}
                  class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSendCompose}
                  class="rounded bg-[color:var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90"
                >
                  Send
                </button>
              </footer>
            </div>
          </div>
        )}
      </Show>

      <ToastContainer />
      <ConfirmHost />
      <SettingsModal
        open={settingsOpen()}
        onClose={() => setSettingsOpen(false)}
        accounts={accounts() ?? []}
      />
    </div>
  );
}

export default App;

import {
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
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  cacheKey,
  classifyBucket,
  extractEmailAddresses,
  matchesFolder,
  parseFromHeader,
  prefixSubject,
  type AccountSelection,
  type Bucket,
} from "./utils";
import {
  FOLDERS as folders,
  snoozePresets,
  type Account,
  type ComposeState,
  type MessageDetail,
  type MessageMeta,
  type SyncDone,
  type SyncError,
  type SyncProgress,
  type SyncState,
} from "./types";
import { ToastContainer, showToast, triggerLastAction } from "./toast";
import { ConfirmHost, confirmModal } from "./modal";
import { settings, notificationsEnabledFor, updateSettings } from "./settings";
import { SettingsModal } from "./settingsModal";
import { CalendarPane } from "./calendarPane";
import { ShortcutsHelpModal } from "./shortcutsHelp";
import { ContextMenu, type TriageActions } from "./contextMenu";
import {
  CommandPalette,
  useCmdKHotkey,
  type Command,
} from "./commandPalette";
import { ComposeModal } from "./composeModal";
import { MessagePreview } from "./messagePreview";
import { MessageList } from "./messageList";
import { Sidebar } from "./sidebar";
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
  const [viewMode, setViewMode] = createSignal<"mail" | "calendar">("mail");

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

  // Unread badge map: `${email}|${folder}` → count. Refreshed after every
  // sync:done / messages:changed / snooze:fired (cheap query, indexed).
  const [unreadCounts, setUnreadCounts] = createSignal<Record<string, number>>(
    {},
  );
  async function refreshUnreadCounts() {
    try {
      const rows = await invoke<
        Array<{ account_email: string; folder: string; count: number }>
      >("unread_counts");
      const next: Record<string, number> = {};
      for (const r of rows) {
        next[`${r.account_email}|${r.folder}`] = r.count;
      }
      setUnreadCounts(next);
    } catch {
      // best-effort; leave previous badges
    }
  }

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

  // Invalidate every cached folder/account view. Reserved for events that
  // could affect every view at once: account added/removed, manual full
  // refresh, or destructive backend mutations whose blast radius isn't known.
  function invalidateAllCaches() {
    setMessageCache({});
  }

  // Refetch only the folder/account/query the user is looking at now. Other
  // cached folders stay warm until the user navigates to them, where the
  // foreground sync that brought us here will already have updated the DB.
  function reloadCurrentList() {
    void loadMessages(selectedAccount(), selectedFolder(), debouncedSearch());
  }

  // Backwards-compatible helper: wipe everything *and* refetch current. Use
  // only when we genuinely can't pinpoint the dirty key set (e.g. mute thread
  // which spans multiple cached folders for the same account).
  function reloadAllVisible() {
    invalidateAllCaches();
    reloadCurrentList();
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
        // Account list shifted (add/remove) → every cached account-scoped
        // view is stale.
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
        // Sync brought new rows for this account → refresh whatever the user
        // is looking at, then run the notification pass against the freshly
        // populated cache.
        reloadCurrentList();
        void refreshUnreadCounts();
        void notifyForRecent();
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
        // Snoozed message landed back in Inbox; only the current view needs
        // a refetch.
        reloadCurrentList();
        void refreshUnreadCounts();
      }),
    );
    unlistenFns.push(
      await listen<string>("schedule:sent", () => {
        showToast({ message: "Scheduled message sent" });
      }),
    );
    unlistenFns.push(
      await listen<string>("messages:changed", () => {
        // User-initiated mutations apply locally via applyLocalLabelChange
        // before this event fires, so we only refetch the current view to
        // pick up changes from the CLI / other windows / timer-fired actions.
        reloadCurrentList();
        void refreshUnreadCounts();
      }),
    );

    // Backfill profile pictures for accounts saved before picture_url existed.
    void backfillAccountProfiles();
    // Ensure notification permission is requested early; ignore failure.
    void ensureNotificationPermission();
    // Seed the sidebar badges before the first sync completes.
    void refreshUnreadCounts();
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

  // Notification pass: fired explicitly after every sync:done. Pulls a fresh
  // unread/personal list straight from the backend so we don't depend on
  // which cache key the user happens to be viewing.
  let notifyWarmedUp = false;
  async function notifyForRecent() {
    const lastSeen = getLastNotifiedMs();
    let maxSeen = lastSeen;
    const candidates: MessageMeta[] = [];
    try {
      const inbox = await invoke<MessageMeta[]>("list_messages", {
        folder: "inbox",
        limit: 200,
      });
      for (const m of inbox) {
        if (m.date_millis > maxSeen) maxSeen = m.date_millis;
        if (!m.unread) continue;
        if (m.date_millis <= lastSeen) continue;
        if (!notificationsEnabledFor(m.account_email, classifyBucket(m))) {
          continue;
        }
        candidates.push(m);
      }
    } catch {
      return;
    }
    // First post-launch pass: swallow the inbox snapshot rather than
    // notifying for every existing unread; record the high-water mark and
    // bail.
    if (!notifyWarmedUp) {
      notifyWarmedUp = true;
      if (maxSeen > lastSeen) setLastNotifiedMs(maxSeen);
      return;
    }
    if (candidates.length === 0) return;
    if (maxSeen > lastSeen) setLastNotifiedMs(maxSeen);
    const granted = await ensureNotificationPermission();
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
  }

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
    const next = pickAutoAdvance(targets);
    for (const t of targets) void modifyLabels(t, [], ["INBOX"]);
    if (next && !selectedMessageId()) void selectMessage(next);
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
    const next = pickAutoAdvance(targets);
    for (const t of targets) void trashMessageAction(t);
    if (next && !selectedMessageId()) void selectMessage(next);
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
    const next = pickAutoAdvance(targets);
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
    if (next && !selectedMessageId()) void selectMessage(next);
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

  function spamWithUndo(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    const snapshot = targets.slice();
    const next = pickAutoAdvance(targets);
    for (const t of targets) {
      applyLocalLabelChange(t, ["SPAM"], ["INBOX", "UNREAD"]);
      void invoke("modify_message", {
        email: t.account_email,
        messageId: t.id,
        addLabels: ["SPAM"],
        removeLabels: ["INBOX", "UNREAD"],
      }).catch((err) => {
        showToast({ message: `Spam failed: ${err}`, variant: "error" });
        reloadAllVisible();
      });
    }
    if (next && !selectedMessageId()) void selectMessage(next);
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
          reloadAllVisible();
        },
      },
    });
  }

  function notSpam(targets: MessageMeta[]) {
    if (targets.length === 0) return;
    for (const t of targets) {
      applyLocalLabelChange(t, ["INBOX"], ["SPAM"]);
      void invoke("modify_message", {
        email: t.account_email,
        messageId: t.id,
        addLabels: ["INBOX"],
        removeLabels: ["SPAM"],
      }).catch((err) => {
        showToast({ message: `Restore failed: ${err}`, variant: "error" });
        reloadAllVisible();
      });
    }
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

  // After bulk archive / trash / snooze / mute / spam, pick the message we
  // should jump to so the preview never goes empty. Prefers the row right
  // after the last target; falls back to the row right before the first.
  function pickAutoAdvance(targets: MessageMeta[]): MessageMeta | null {
    const list = visibleMessages() ?? [];
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
    // If the previous message's iframe was the activeElement, the host's
    // document keydown handler stops receiving keys — so j / k / e go
    // nowhere after triage. Hand focus back to the host explicitly.
    const active = document.activeElement;
    if (active instanceof HTMLIFrameElement) active.blur();
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
      cancelPendingDraftSave();
      bumpComposeSession();
      clearDraft();
      setCompose(null);
      showToast({
        message: `Scheduled for ${new Date(fireAtMs).toLocaleString()}`,
      });
    } catch (err) {
      setSendError(String(err));
    }
  }

  // Local autosave: keep the current compose around in localStorage so a
  // crash / window close restores it. Server-side autosave below handles
  // cross-device persistence via Gmail Drafts.
  //
  // Attachments are deliberately excluded: their base64 bytes can be tens
  // of MB and localStorage caps at ~5–10 MB in WebKit. Serializing them on
  // every keystroke would silently exceed quota; the user re-picks files
  // after a crash, but the text/HTML body is preserved.
  createEffect(() => {
    const cur = compose();
    if (!cur) return;
    if (cur.in_reply_to || cur.subject.startsWith("Fwd:")) return;
    const persistable: ComposeState = { ...cur, attachments: [] };
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(persistable));
    } catch {}
  });

  // Debounced Gmail Drafts autosave: 1.5s after the compose state stops
  // changing, push the current draft to Gmail. The first save creates a
  // draft and stashes its id back into compose state; subsequent saves
  // update in place.
  let draftSaveTimer: number | undefined;
  let draftSaveInflight = false;
  let draftSaveErrorShown = false;
  // Bumped every time the user switches to a different compose (open new,
  // discard, schedule, finish sending). Captured by saveDraftNow before the
  // network round-trip so we can detect "the compose changed while my save
  // was in flight" — without this the returned draft_id can leak into a
  // sibling compose and silently overwrite an unrelated server draft.
  let composeSession = 0;
  function bumpComposeSession() {
    composeSession += 1;
  }

  function scheduleDraftSave() {
    if (draftSaveTimer !== undefined) clearTimeout(draftSaveTimer);
    draftSaveTimer = window.setTimeout(saveDraftNow, 1500);
  }
  async function saveDraftNow() {
    const cur = compose();
    if (!cur) return;
    if (draftSaveInflight) {
      // A save is already in flight; reschedule once it lands so we never
      // drop the latest edits.
      scheduleDraftSave();
      return;
    }
    if (isComposeEmpty(cur)) return;
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
      // Compose was discarded / replaced while we were in flight: do not
      // graft the new id onto whatever the user is editing now. If we just
      // created a brand new server draft it has no local owner — delete it
      // so the user's Gmail Drafts folder doesn't accumulate orphans.
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
      // Pin the fingerprint to what we just persisted; the autosave effect
      // uses this to suppress its immediate re-fire after we stamp the new
      // draft_id back onto state.
      lastSavedFingerprint = composeFingerprint(compose() ?? cur);
      draftSaveErrorShown = false;
    } catch (err) {
      // Surface only the first failure so we don't spam the user on every
      // keystroke when offline. The flag is reset on the next success.
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

  // Fingerprint of the saveable fields. Used by the autosave effect to skip
  // round-trips that wouldn't change the server-side draft — most notably
  // the immediate re-fire we get when saveDraftNow stamps draft_id back on
  // state via setCompose.
  let lastSavedFingerprint = "";
  function composeFingerprint(c: ComposeState): string {
    return JSON.stringify({
      a: c.from_account,
      t: c.to,
      c: c.cc,
      b: c.bcc,
      s: c.subject,
      bd: c.body,
      h: c.html_body ?? "",
      // We don't include the base64 bytes — same {filename,size,mime}
      // sequence implies same upload payload.
      at: (c.attachments ?? []).map((a) => `${a.filename}|${a.size}|${a.mime_type}`),
      r: c.in_reply_to ?? "",
      x: c.references ?? "",
    });
  }

  createEffect(() => {
    const cur = compose();
    if (!cur) {
      // Compose closed → reset the fingerprint so the next session starts
      // dirty (otherwise the very first save would be skipped if the user
      // re-types the same body).
      lastSavedFingerprint = "";
      return;
    }
    // Skip server autosave for replies/forwards (the user usually wants the
    // draft local until they actually send) and for empty composes.
    if (cur.in_reply_to) return;
    if (cur.subject.startsWith("Fwd:")) return;
    if (isComposeEmpty(cur)) return;
    if (composeFingerprint(cur) === lastSavedFingerprint) return;
    scheduleDraftSave();
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
      c.body.trim() === "" &&
      (c.attachments ?? []).length === 0 &&
      (c.html_body ?? "").trim() === ""
    );
  }

  function signatureFor(email: string): string {
    return settings().compose.signatures[email] ?? "";
  }
  // Append the per-account signature to a fresh body. We never auto-append
  // to replies/forwards — those already carry the quoted history and the
  // signature would land in an awkward spot.
  function bodyWithSignature(account: string): string {
    const sig = signatureFor(account);
    return sig ? `\n\n--\n${sig}` : "";
  }

  function openCompose() {
    setSendError(null);
    bumpComposeSession();
    const restored = loadDraft();
    if (restored && !isComposeEmpty(restored)) {
      setCompose(restored);
      showToast({ message: "Draft restored" });
      return;
    }
    const acct = defaultFromAccount();
    setCompose({
      from_account: acct,
      to: "",
      cc: "",
      bcc: "",
      subject: "",
      body: bodyWithSignature(acct),
      in_reply_to: null,
      references: null,
      show_cc_bcc: false,
      rich: settings().compose.richTextDefault,
      attachments: [],
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
    bumpComposeSession();
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
      rich: false,
      attachments: [],
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
    bumpComposeSession();
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
      rich: false,
      attachments: [],
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
      // Discard also removes the server-side Gmail draft so it doesn't
      // linger in the Drafts folder. Best-effort: silently ignore failures.
      if (cur.draft_id) {
        void invoke("delete_draft", {
          email: cur.from_account,
          draftId: cur.draft_id,
        }).catch(() => {});
      }
    }
    // Cancel a queued autosave and invalidate any in-flight one. Without
    // this a pending save can land after discard and create an orphan
    // draft on Gmail that we never reference again.
    cancelPendingDraftSave();
    bumpComposeSession();
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

    // Flush any pending autosave so send_draft (which sends Gmail's server
    // copy of the draft) sees the latest body. Without this a user who
    // types and clicks Send within the 1.5s debounce loses those edits.
    cancelPendingDraftSave();
    await saveDraftNow();

    // Re-read compose: saveDraftNow may have written back the draft_id.
    const latest = compose() ?? cur;
    const payload: ComposeState = { ...latest };
    pendingSendPayload = payload;
    clearDraft();
    bumpComposeSession();
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

  // Right-clicking a row that is part of an active multi-select should
  // fan the action out to every selected row; right-clicking an
  // unselected row keeps the single-row behaviour.
  function contextTargets(m: MessageMeta): MessageMeta[] {
    const ids = selectedIds();
    if (ids.size > 1 && ids.has(m.id)) return selectedMessages();
    return [m];
  }

  const triageActions: TriageActions = {
    toggleRead: (m) => {
      const targets = contextTargets(m);
      // Toggle direction matches the right-clicked row's state, so the
      // menu label ("Mark as read" / "Mark as unread") matches what the
      // bulk action does.
      const wasUnread = m.unread;
      for (const t of targets) {
        void modifyLabels(
          t,
          wasUnread ? [] : ["UNREAD"],
          wasUnread ? ["UNREAD"] : [],
        );
      }
    },
    toggleStar: (m) => starToggleWithUndo(contextTargets(m)),
    archive: (m) => archiveWithUndo(contextTargets(m)),
    trash: (m) => trashWithUndo(contextTargets(m)),
    restoreFromTrash: (m) => {
      for (const t of contextTargets(m)) void modifyLabels(t, [], ["TRASH"]);
    },
    moveToInbox: (m) => {
      for (const t of contextTargets(m)) void modifyLabels(t, ["INBOX"], []);
    },
    markSpam: (m) => spamWithUndo(contextTargets(m)),
    notSpam: (m) => notSpam(contextTargets(m)),
    snooze: (m, fireAt) => void snoozeMessages(contextTargets(m), fireAt),
    // mute is thread-scoped; firing per selected row hits each row's
    // thread (typical: one per selection).
    mute: (m) => {
      for (const t of contextTargets(m)) void muteThreadAction(t);
    },
  };

  const [showShortcuts, setShowShortcuts] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  useCmdKHotkey(() => setPaletteOpen((v) => !v));

  // Build the palette command list from current state on each open. Cheap
  // because Solid only recomputes when the dependencies actually change.
  const paletteCommands = createMemo<Command[]>(() => {
    const m = currentMessage();
    const cmds: Command[] = [
      {
        id: "compose",
        label: "Compose new message",
        group: "Mail",
        hint: "c",
        keywords: ["new", "write", "mail"],
        run: openCompose,
      },
      {
        id: "sync-now",
        label: "Sync now",
        group: "Mail",
        hint: "Ctrl+Shift+R",
        keywords: ["refresh", "fetch", "reload"],
        run: handleRefresh,
      },
      {
        id: "view-mail",
        label: "Switch to Mail view",
        group: "View",
        hint: "Ctrl+Shift+1",
        run: () => setViewMode("mail"),
      },
      {
        id: "view-cal",
        label: "Switch to Calendar view",
        group: "View",
        hint: "Ctrl+Shift+2",
        run: () => setViewMode("calendar"),
      },
      {
        id: "open-settings",
        label: "Open settings",
        group: "App",
        keywords: ["preferences", "options"],
        run: () => setSettingsOpen(true),
      },
      {
        id: "open-shortcuts",
        label: "Show keyboard shortcuts",
        group: "App",
        hint: "?",
        run: () => setShowShortcuts(true),
      },
    ];
    // Folder switches
    for (const f of folders) {
      cmds.push({
        id: `folder-${f.id}`,
        label: `Go to ${f.label}`,
        group: "Folder",
        keywords: [f.id, "folder", "switch"],
        run: () => {
          setViewMode("mail");
          setSelectedFolder(f.id);
        },
      });
    }
    // Account switches
    cmds.push({
      id: "acct-all",
      label: "Show All Inboxes",
      group: "Account",
      keywords: ["all", "everyone", "merged"],
      run: () => setSelectedAccount("all"),
    });
    for (const a of accounts() ?? []) {
      cmds.push({
        id: `acct-${a.id}`,
        label: `Switch to ${a.email}`,
        group: "Account",
        keywords: ["account", a.email],
        run: () => setSelectedAccount(a.id),
      });
    }
    // Theme toggles
    for (const t of ["system", "light", "dark"] as const) {
      cmds.push({
        id: `theme-${t}`,
        label: `Theme: ${t.charAt(0).toUpperCase() + t.slice(1)}`,
        group: "Theme",
        run: () =>
          updateSettings((s) => ({
            ...s,
            appearance: { ...s.appearance, theme: t },
          })),
      });
    }
    // Message-scoped actions (only when something is selected)
    if (m) {
      const sel = m;
      cmds.push({
        id: "msg-archive",
        label: "Archive selected",
        group: "Triage",
        hint: "e",
        run: () => archiveWithUndo([sel]),
      });
      cmds.push({
        id: "msg-trash",
        label: "Move selected to Trash",
        group: "Triage",
        hint: "#",
        run: () => trashWithUndo([sel]),
      });
      cmds.push({
        id: "msg-star",
        label: sel.label_ids.includes("STARRED")
          ? "Unstar selected"
          : "Star selected",
        group: "Triage",
        hint: "s",
        run: () => starToggleWithUndo([sel]),
      });
      cmds.push({
        id: "msg-read",
        label: sel.unread ? "Mark as read" : "Mark as unread",
        group: "Triage",
        hint: "u",
        run: () => {
          if (sel.unread) void modifyLabels(sel, [], ["UNREAD"]);
          else void modifyLabels(sel, ["UNREAD"], []);
        },
      });
      cmds.push({
        id: "msg-snooze-1h",
        label: "Snooze selected for 1 hour",
        group: "Triage",
        hint: "z",
        run: () => void snoozeMessages([sel], snoozePresets()[0].fireAt),
      });
      cmds.push({
        id: "msg-mute",
        label: "Mute thread",
        group: "Triage",
        hint: "m",
        run: () => void muteThreadAction(sel),
      });
      cmds.push({
        id: "msg-spam",
        label: "Mark as spam",
        group: "Triage",
        run: () => spamWithUndo([sel]),
      });
      if (messageDetail()) {
        cmds.push({
          id: "msg-reply",
          label: "Reply",
          group: "Reply",
          hint: "r",
          run: () => openReply(false),
        });
        cmds.push({
          id: "msg-reply-all",
          label: "Reply all",
          group: "Reply",
          hint: "a",
          run: () => openReply(true),
        });
        cmds.push({
          id: "msg-forward",
          label: "Forward",
          group: "Reply",
          hint: "f",
          run: openForward,
        });
      }
    }
    return cmds;
  });

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
    // Global view switch: Ctrl+Shift+1 (Mail) / Ctrl+Shift+2 (Calendar).
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === "1" || e.key === "!")
    ) {
      e.preventDefault();
      setViewMode("mail");
      return;
    }
    if (
      (e.ctrlKey || e.metaKey) &&
      e.shiftKey &&
      (e.key === "2" || e.key === "@")
    ) {
      e.preventDefault();
      setViewMode("calendar");
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
      case "ArrowDown":
        e.preventDefault();
        moveSelection(1);
        break;
      case "k":
      case "ArrowUp":
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
    // Sanitized message iframes can't reach the host (opaque origin) so
    // they postMessage link clicks here. We validate the scheme before
    // handing the URL to the OS opener — only http(s) and mailto: pass.
    // The same channel carries the vimium-mode `cenmail:blur` request
    // which returns keyboard focus to the host so j/k navigation
    // resumes.
    const onIframeMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; href?: string } | null;
      if (!data || typeof data.type !== "string") return;
      if (data.type === "cenmail:blur") {
        const active = document.activeElement;
        if (active instanceof HTMLIFrameElement) active.blur();
        return;
      }
      if (data.type !== "cenmail:open") return;
      const href = data.href;
      if (typeof href !== "string" || href.length === 0) return;
      try {
        const u = new URL(href);
        if (!["http:", "https:", "mailto:"].includes(u.protocol)) return;
      } catch {
        return;
      }
      void openUrl(href).catch((err) =>
        showToast({ message: `Open failed: ${err}`, variant: "error" }),
      );
    };
    window.addEventListener("message", onIframeMessage);
    onCleanup(() => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", handleShortcut);
      window.removeEventListener("message", onIframeMessage);
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
      <Sidebar
        width={sidebarWidth()}
        accounts={accounts() ?? []}
        folders={folders}
        viewMode={viewMode()}
        setViewMode={setViewMode}
        selectedAccount={selectedAccount()}
        setSelectedAccount={setSelectedAccount}
        selectedFolder={selectedFolder()}
        setSelectedFolder={setSelectedFolder}
        syncState={syncState}
        aggregateSync={aggregateSync() ?? null}
        addingAccount={addingAccount()}
        addError={addError()}
        unreadCounts={unreadCounts()}
        onAddAccount={handleAddAccount}
        onRemoveAccount={handleRemoveAccount}
        onCompose={openCompose}
        onRefresh={handleRefresh}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <div
        onMouseDown={(e) => startResize(e, "sidebar")}
        class="group relative flex w-1 shrink-0 cursor-col-resize items-stretch hover:bg-[color:var(--color-accent)]"
        title="Drag to resize sidebar"
      >
        <span class="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
      </div>

      <Show when={viewMode() === "calendar"}>
        <CalendarPane accounts={accounts() ?? []} />
      </Show>

      <Show when={viewMode() === "mail"}>
      <MessageList
        width={listWidth()}
        accounts={accounts() ?? []}
        headerTitle={headerTitle()}
        messages={visibleMessages()}
        messagesLoading={messagesLoading()}
        hasCache={hasCache()}
        messagesError={messagesError()}
        selectedMessageId={selectedMessageId()}
        selectedFolder={selectedFolder()}
        selectedBucket={selectedBucket()}
        setSelectedBucket={setSelectedBucket}
        bucketCounts={bucketCounts()}
        searchQuery={searchQuery()}
        onSearchInput={handleSearchInput}
        onClearSearch={clearSearch}
        setSearchInputRef={(el) => (searchInputRef = el)}
        syncingHint={!!aggregateSync()?.syncing}
        onShowShortcuts={() => setShowShortcuts(true)}
        isSelected={isSelected}
        onRowClick={(e, m) => handleListClick(e, m)}
        onContextMenu={(e, m) => openContextMenu(e, m)}
        onSelectOnlyForContext={(m) => {
          setSelectedIds(new Set([m.id]));
          setAnchorId(m.id);
        }}
        onToggleStar={(m) => starToggleWithUndo([m])}
      />

      <div
        onMouseDown={(e) => startResize(e, "list")}
        class="group relative flex w-1 shrink-0 cursor-col-resize items-stretch hover:bg-[color:var(--color-accent)]"
        title="Drag to resize list"
      >
        <span class="pointer-events-none absolute inset-y-0 -left-1 -right-1" />
      </div>

      <MessagePreview
        selectedMessageId={selectedMessageId()}
        messageDetailLoading={messageDetailLoading()}
        messageDetailError={messageDetailError()}
        messageDetail={messageDetail()}
        threadDetails={threadDetails()}
        latestInThread={latestInThread()}
        currentMessageAccount={currentMessage()?.account_email ?? ""}
        expandedInThread={expandedInThread()}
        allowImagesFor={allowImagesFor()}
        alwaysAllowImages={settings().privacy.alwaysAllowImages}
        prefersDark={prefersDark()}
        toggleThreadExpanded={toggleThreadExpanded}
        setAllowImagesFor={setAllowImagesFor}
        onReply={openReply}
        onForward={openForward}
      />
      </Show>

      <ContextMenu
        menu={contextMenu()}
        onClose={closeContextMenu}
        actions={triageActions}
      />

      <ShortcutsHelpModal open={showShortcuts()} onClose={() => setShowShortcuts(false)} />

      <CommandPalette
        open={paletteOpen()}
        commands={paletteCommands()}
        onClose={() => setPaletteOpen(false)}
      />


      <ComposeModal
        compose={compose()}
        accounts={accounts() ?? []}
        sendError={sendError()}
        onClose={closeCompose}
        onSend={handleSendCompose}
        onScheduleSend={(ms) => void scheduleCurrentCompose(ms)}
        onUpdate={updateCompose}
      />

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

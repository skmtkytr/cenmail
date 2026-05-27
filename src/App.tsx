import {
  Show,
  batch,
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
import { ToastContainer, showToast } from "./toast";
import { ConfirmHost, confirmModal } from "./modal";
import { settings, notificationsEnabledFor, updateSettings } from "./settings";
import {
  bodyWithSignature,
  isComposeEmpty as isComposeEmptyHelper,
} from "./composeHelpers";
import { useDraftAutosave } from "./hooks/useDraftAutosave";
import { useSendUndo } from "./hooks/useSendUndo";
import { useTriage } from "./hooks/useTriage";
import { useContextMenu } from "./hooks/useContextMenu";
import { useSelection } from "./hooks/useSelection";
import { useCommandPalette } from "./hooks/useCommandPalette";
import { useShortcuts } from "./hooks/useShortcuts";
import { SettingsModal } from "./settingsModal";
import { ScheduledSendsModal } from "./scheduledSendsModal";
import { CalendarPane } from "./calendarPane";
import { ShortcutsHelpModal } from "./shortcutsHelp";
import { ContextMenu, type TriageActions } from "./contextMenu";
import { CommandPalette, type Command } from "./commandPalette";
import { ComposeModal } from "./composeModal";
import { MessagePreview } from "./messagePreview";
import { MessageList } from "./messageList";
import { Sidebar } from "./sidebar";
import "./App.css";

import {
  DRAFT_STORAGE_KEY,
  LIST_RELOAD_DEBOUNCE_MS,
  MESSAGES_CHANGED_DEBOUNCE_MS,
  NOTIFY_LAST_SEEN_KEY,
  PANE_DEFAULTS,
  PANE_MAX,
  PANE_MIN,
  SEARCH_DEBOUNCE_MS,
} from "./constants";

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

  // Selection state + helpers (single + multi + range + context-fan-out)
  // live in useSelection.
  const selection = useSelection({
    visibleMessages: () => visibleMessages() ?? [],
    selectMessage: (m) => selectMessage(m),
    setMessageDetail,
  });
  const {
    selectedMessageId,
    setSelectedMessageId,
    selectedIds,
    setSelectedIds,
    setAnchorId,
    isSelected,
    selectionTargets,
    contextTargets,
    clearMultiSelect,
    handleListClick,
    moveSelection,
    currentMessage,
  } = selection;

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

  // Debounced refresh for backend `messages:changed` bursts (typically one
  // event per row in a bulk action). The optimistic update already shows
  // the post-action state; the reload is only here to pick up changes
  // from the CLI / other windows / timer-fired actions.
  //
  // OPTIMISTIC_QUIET_MS guards a flicker: rapid E-presses produce a stream
  // of optimistic removals followed by in-flight backend modify_message
  // calls. If the debounced reload fires while one of those backend writes
  // hasn't hit the DB yet, list_messages SELECTs the row as still inbox=1
  // and setMessageCache puts it back into the list — until the next
  // round-trip kicks it back out. Defer the reload until the user has
  // stopped triaging for a moment so the backend writes can settle.
  const OPTIMISTIC_QUIET_MS = 1500;
  let changedReloadTimer: number | undefined;
  function scheduleChangedReload() {
    if (changedReloadTimer !== undefined) clearTimeout(changedReloadTimer);
    changedReloadTimer = window.setTimeout(() => {
      changedReloadTimer = undefined;
      const sinceOp = Date.now() - triage.lastOptimisticAt();
      if (sinceOp < OPTIMISTIC_QUIET_MS) {
        // User is still triaging; re-arm and try again later.
        scheduleChangedReload();
        return;
      }
      reloadCurrentList();
      void refreshUnreadCounts();
    }, MESSAGES_CHANGED_DEBOUNCE_MS);
  }

  // Reload the visible list at most once per LIST_RELOAD_DEBOUNCE_MS while
  // a sync is streaming progress events. Without debounce we'd thrash the
  // DB on every batch.
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
    }, SEARCH_DEBOUNCE_MS);
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
        // pick up changes from the CLI / other windows / timer-fired
        // actions. Debounce so a bulk action (N rows → N backend calls
        // → N events) collapses into a single reload after the burst
        // settles, instead of paint-flickering for each backend ack.
        scheduleChangedReload();
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

  function getLastNotifiedMs(): number {
    try {
      const raw = localStorage.getItem(NOTIFY_LAST_SEEN_KEY);
      const n = raw ? parseInt(raw, 10) : 0;
      return Number.isFinite(n) ? n : 0;
    } catch {
      return 0;
    }
  }
  function setLastNotifiedMs(ms: number) {
    try {
      localStorage.setItem(NOTIFY_LAST_SEEN_KEY, String(ms));
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

  // All bulk triage actions (archive/trash/star/snooze/mute/spam/etc.)
  // and the optimistic-update plumbing they share live in their own
  // hook. See src/hooks/useTriage.ts.
  const triage = useTriage({
    getCache: () =>
      messageCache[cacheKey(selectedAccount(), selectedFolder(), debouncedSearch())],
    setCache: (rows) =>
      setMessageCache(
        cacheKey(selectedAccount(), selectedFolder(), debouncedSearch()),
        rows,
      ),
    currentFolder: selectedFolder,
    selectedMessageId,
    setSelectedMessageId,
    setMessageDetail,
    visibleMessages: () => visibleMessages() ?? [],
    selectMessage: (m) => selectMessage(m),
    reloadAllVisible,
    setMessagesError,
  });
  const {
    modifyLabels,
    archiveWithUndo,
    trashWithUndo,
    snoozeMessages,
    muteThreadAction,
    spamWithUndo,
    notSpam,
    starToggleWithUndo,
  } = triage;

  async function selectMessage(
    message: MessageMeta,
    options?: { silent?: boolean },
  ) {
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
    // Auto-advance from triage (silent=true) skips the mark-read invoke
    // — the user isn't reading this message, they're cycling through to
    // archive the next one. Firing mark-read here queues a modify on
    // the same message_id, which then races / blocks the user's next
    // archive on Gmail. A real "open this message" (user click) still
    // marks-read as before.
    if (
      !options?.silent &&
      message.unread &&
      settings().inbox.markAsReadOnOpen
    ) {
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

  // Local autosave: every compose (new, reply, forward) gets mirrored to
  // localStorage so a crash / window close doesn't lose typed text. The
  // server-side Gmail Drafts autosave further down covers cross-device
  // persistence — but only for *new* composes, since saving a reply as a
  // standalone draft would split the conversation thread on the server.
  //
  // Attachments are deliberately excluded: their base64 bytes can be tens
  // of MB and localStorage caps at ~5–10 MB in WebKit. Serializing them on
  // every keystroke would silently exceed quota; the user re-picks files
  // after a crash, but the text/HTML body is preserved.
  createEffect(() => {
    const cur = compose();
    if (!cur) return;
    const persistable: ComposeState = { ...cur, attachments: [] };
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(persistable));
    } catch {}
  });

  // Gmail Drafts autosave: debounced 1.5 s, with session-token rollback
  // for racing compose lifecycle events. See src/hooks/useDraftAutosave.ts.
  const draftAutosave = useDraftAutosave(compose, setCompose);
  const { bumpComposeSession, cancelPendingDraftSave } = draftAutosave;

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

  // Thin curried wrapper so existing call sites keep their no-arg shape.
  // The actual logic lives in src/composeHelpers.ts.
  const isComposeEmpty = (c: ComposeState) => isComposeEmptyHelper(settings(), c);

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
      body: bodyWithSignature(settings(), acct),
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

  // Send-with-undo + scheduled-send live in their own hook so the
  // pending-payload state and the 5s undo timer aren't mixed in with
  // the rest of App.tsx. See src/hooks/useSendUndo.ts.
  const { handleSendCompose, scheduleCurrentCompose } = useSendUndo(
    compose,
    setCompose,
    setSendError,
    draftAutosave,
    startSync,
    clearDraft,
  );

  const { contextMenu, openContextMenu, closeContextMenu } = useContextMenu();

  const triageActions: TriageActions = {
    toggleRead: (m) => {
      const targets = contextTargets(m);
      // Toggle direction matches the right-clicked row's state, so the
      // menu label ("Mark as read" / "Mark as unread") matches what the
      // bulk action does.
      const wasUnread = m.unread;
      batch(() => {
        for (const t of targets) {
          void modifyLabels(
            t,
            wasUnread ? [] : ["UNREAD"],
            wasUnread ? ["UNREAD"] : [],
          );
        }
      });
    },
    toggleStar: (m) => starToggleWithUndo(contextTargets(m)),
    archive: (m) => archiveWithUndo(contextTargets(m)),
    trash: (m) => trashWithUndo(contextTargets(m)),
    restoreFromTrash: (m) => {
      batch(() => {
        for (const t of contextTargets(m)) void modifyLabels(t, [], ["TRASH"]);
      });
    },
    moveToInbox: (m) => {
      batch(() => {
        for (const t of contextTargets(m)) void modifyLabels(t, ["INBOX"], []);
      });
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
  const [scheduledOpen, setScheduledOpen] = createSignal(false);
  const { paletteOpen, setPaletteOpen } = useCommandPalette();

  // Build the palette command list on demand. Returning [] when the
  // palette is closed means Solid only tracks (and rebuilds on) the
  // underlying signals while the user is actually looking at the list —
  // typing in the search field or switching messages with the palette
  // closed no longer rebuilds 30+ Command objects per keystroke.
  const paletteCommands = createMemo<Command[]>(() => {
    if (!paletteOpen()) return [];
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
        id: "show-scheduled-sends",
        label: "Show scheduled sends",
        group: "Mail",
        keywords: ["queued", "schedule", "pending", "later"],
        run: () => setScheduledOpen(true),
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

  const handleShortcut = useShortcuts({
    showShortcuts,
    setShowShortcuts,
    contextMenu,
    closeContextMenu,
    compose,
    closeCompose: () => closeCompose(),
    selectedIds,
    setSelectedIds,
    setAnchorId,
    selectedMessageId,
    setSelectedMessageId,
    setMessageDetail,
    clearMultiSelect,
    currentMessage,
    selectionTargets,
    visibleMessages: () => visibleMessages() ?? [],
    moveSelection,
    viewMode,
    setViewMode,
    handleRefresh,
    archiveWithUndo,
    trashWithUndo,
    snoozeMessages,
    muteThreadAction,
    starToggleWithUndo,
    modifyLabels,
    messageDetail,
    openReply,
    openForward,
    openCompose,
    searchInputRef: () => searchInputRef,
  });

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
      <ScheduledSendsModal
        open={scheduledOpen()}
        onClose={() => setScheduledOpen(false)}
      />
    </div>
  );
}

export default App;

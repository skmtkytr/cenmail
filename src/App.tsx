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
  cacheKey,
  extractEmailAddresses,
  formatRelativeDate,
  matchesFolder,
  parseFromHeader,
  prefixSubject,
  type AccountSelection,
} from "./utils";
import "./App.css";

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
    setSelectedIds(new Set());
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
    const list = messages() ?? [];
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

    // Backfill profile pictures for accounts saved before picture_url existed.
    void backfillAccountProfiles();
    // Start background sync of all accounts on first load.
    void syncAll();
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
    if (!confirm("Remove this account from cenmail?")) return;
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
    if (message.unread) {
      void modifyLabels(message, [], ["UNREAD"]);
    }
    try {
      const detail = await invoke<MessageDetail>("get_message", {
        email: message.account_email,
        messageId: message.id,
      });
      setMessageDetail(detail);
    } catch (err) {
      setMessageDetailError(String(err));
    } finally {
      setMessageDetailLoading(false);
    }
  }

  const [compose, setCompose] = createSignal<ComposeState | null>(null);
  const [sending, setSending] = createSignal(false);
  const [sendError, setSendError] = createSignal<string | null>(null);

  function defaultFromAccount(): string {
    const sel = selectedAccount();
    if (sel !== "all") {
      const acct = accountById(sel);
      if (acct) return acct.email;
    }
    return (accounts() ?? [])[0]?.email ?? "";
  }

  function openCompose() {
    setSendError(null);
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
    const detail = messageDetail();
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
    const detail = messageDetail();
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

  function closeCompose() {
    if (sending()) return;
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
    setSending(true);
    try {
      await invoke("send_message", {
        request: {
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
      setCompose(null);
    } catch (err) {
      setSendError(String(err));
    } finally {
      setSending(false);
    }
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
    const list = messages() ?? [];
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
    if (isEditableTarget(e.target)) return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
      if (compose() || showShortcuts()) return;
      e.preventDefault();
      const list = messages() ?? [];
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
          for (const t of targets) {
            void modifyLabels(t, [], ["INBOX"]);
          }
        }
        break;
      }
      case "#":
      case "Delete": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          for (const t of targets) {
            void trashMessageAction(t);
          }
        }
        break;
      }
      case "s": {
        const targets = bulk();
        if (targets.length > 0) {
          e.preventDefault();
          const allStarred = targets.every((t) =>
            t.label_ids.includes("STARRED"),
          );
          for (const t of targets) {
            void modifyLabels(
              t,
              allStarred ? [] : ["STARRED"],
              allStarred ? ["STARRED"] : [],
            );
          }
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
          <Show when={aggregateSync()} fallback={<>Phase 3 · cache & sync</>}>
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
        <header class="flex items-center justify-between px-4 py-3">
          <h2 class="truncate text-sm font-semibold">{headerTitle()}</h2>
          <span class="text-xs text-[color:var(--color-muted)]">
            {messagesLoading()
              ? `${messages().length} ↻`
              : `${messages().length.toLocaleString()} messages`}
          </span>
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
        <ul class="flex-1 overflow-y-auto">
          <Show
            when={!messagesLoading() && hasCache() && messages().length === 0}
          >
            <li class="px-4 py-8 text-center text-sm text-[color:var(--color-muted)]">
              {(accounts() ?? []).length === 0
                ? "アカウントを追加してください。"
                : aggregateSync()?.syncing
                  ? "同期中…"
                  : "メッセージがありません。"}
            </li>
          </Show>
          <Show when={messagesLoading() && !hasCache()}>
            <li class="px-4 py-8 text-center text-sm text-[color:var(--color-muted)]">
              読み込み中…
            </li>
          </Show>
          <For each={messages()}>
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
                  class={`flex cursor-pointer select-none items-start gap-3 border-b border-[color:var(--color-border)] px-4 py-3 hover:bg-[color:var(--color-surface-hover)] ${
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
                      <span class="shrink-0 text-xs">
                        {formatRelativeDate(m.date_millis)}
                      </span>
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
              メッセージを選択してください。
            </div>
          }
        >
          <Show when={messageDetailLoading()}>
            <div class="p-8 text-sm text-[color:var(--color-muted)]">
              読み込み中…
            </div>
          </Show>
          <Show when={messageDetailError()}>
            <div class="m-6 rounded border border-red-400 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950 dark:text-red-200">
              {messageDetailError()}
            </div>
          </Show>
          <Show when={messageDetail()}>
            {(detail) => (
              <>
                <header class="border-b border-[color:var(--color-border)] px-6 py-4">
                  <div class="flex items-start justify-between gap-4">
                    <h1 class="text-lg font-semibold">
                      {detail().subject || "(no subject)"}
                    </h1>
                    <div class="flex shrink-0 gap-2">
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
                  <div class="mt-1 text-sm text-[color:var(--color-muted)]">
                    <span class="font-medium text-[color:var(--color-fg)]">
                      {parseFromHeader(detail().from).name}
                    </span>{" "}
                    &lt;{parseFromHeader(detail().from).email}&gt;
                  </div>
                  <div class="text-xs text-[color:var(--color-muted)]">
                    {detail().date}
                  </div>
                </header>
                <div class="flex-1 overflow-hidden">
                  <Show
                    when={detail().html_body}
                    fallback={
                      <pre class="h-full overflow-auto whitespace-pre-wrap p-6 font-sans text-sm">
                        {detail().text_body || "(no body)"}
                      </pre>
                    }
                  >
                    <iframe
                      srcdoc={detail().html_body ?? ""}
                      sandbox=""
                      class="h-full w-full border-0 bg-white"
                      title="message body"
                    />
                  </Show>
                </div>
              </>
            )}
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
                    void modifyLabels(
                      m,
                      isStarred() ? [] : ["STARRED"],
                      isStarred() ? ["STARRED"] : [],
                    );
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
                      void modifyLabels(m, [], ["INBOX"]);
                    }}
                  >
                    Archive
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
                      void trashMessageAction(m);
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
                <button
                  type="button"
                  onClick={closeCompose}
                  disabled={sending()}
                  class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleSendCompose}
                  disabled={sending()}
                  class="rounded bg-[color:var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
                >
                  {sending() ? "Sending…" : "Send"}
                </button>
              </footer>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
}

export default App;

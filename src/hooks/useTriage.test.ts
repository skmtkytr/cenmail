import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import type { MessageMeta } from "../types";

// Mock invoke / showToast before importing the hook so the module-level
// imports inside the hook resolve to our spies.
const invokeMock = vi.fn<(...args: unknown[]) => unknown>(() =>
  Promise.resolve(),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));
vi.mock("../toast", () => ({
  showToast: vi.fn(),
}));

import { useTriage, type TriageDeps } from "./useTriage";

function mockMessage(id: string, overrides: Partial<MessageMeta> = {}): MessageMeta {
  return {
    id,
    account_email: "user@example.com",
    thread_id: id,
    from: "x@example.com",
    subject: "",
    snippet: "",
    date_millis: 0,
    unread: false,
    label_ids: ["INBOX"],
    ...overrides,
  };
}

type Fixture = {
  triage: ReturnType<typeof useTriage>;
  selectMessage: ReturnType<typeof vi.fn>;
  cache: () => MessageMeta[];
  dispose: () => void;
};

function mountTriage(initial: MessageMeta[], selectedId: string | null): Fixture {
  let cache = [...initial];
  let selId = selectedId;
  const selectMessage = vi.fn(() => Promise.resolve());
  let triage: ReturnType<typeof useTriage>;
  const dispose = createRoot((cleanup) => {
    const deps: TriageDeps = {
      getCache: () => cache,
      setCache: (rows) => {
        cache = rows;
      },
      currentFolder: () => "inbox",
      selectedMessageId: () => selId,
      setSelectedMessageId: (id) => {
        selId = id;
      },
      setMessageDetail: vi.fn(),
      visibleMessages: () => cache,
      selectMessage,
      reloadAllVisible: vi.fn(),
      setMessagesError: vi.fn(),
    };
    triage = useTriage(deps);
    return cleanup;
  });
  // `triage` is always assigned synchronously inside createRoot before it
  // returns. The non-null assertion is purely for TS narrowing.
  return { triage: triage!, selectMessage, cache: () => cache, dispose };
}

beforeEach(() => {
  invokeMock.mockClear();
  invokeMock.mockImplementation(() => Promise.resolve());
});
afterEach(() => {
  vi.useRealTimers();
});

describe("useTriage auto-advance never fires mark-read on the next message", () => {
  it("archiveWithUndo selects the next message with silent: true", () => {
    const A = mockMessage("a");
    const B = mockMessage("b");
    const f = mountTriage([A, B], "a");
    f.triage.archiveWithUndo([A]);
    f.dispose();
    expect(f.selectMessage).toHaveBeenCalledTimes(1);
    expect(f.selectMessage).toHaveBeenCalledWith(B, { silent: true });
  });

  it("trashWithUndo selects the next message with silent: true", () => {
    const A = mockMessage("a");
    const B = mockMessage("b");
    const f = mountTriage([A, B], "a");
    f.triage.trashWithUndo([A]);
    f.dispose();
    expect(f.selectMessage).toHaveBeenCalledWith(B, { silent: true });
  });

  it("spamWithUndo selects the next message with silent: true", () => {
    const A = mockMessage("a");
    const B = mockMessage("b");
    const f = mountTriage([A, B], "a");
    f.triage.spamWithUndo([A]);
    f.dispose();
    expect(f.selectMessage).toHaveBeenCalledWith(B, { silent: true });
  });

  it("snoozeMessages selects the next message with silent: true", async () => {
    const A = mockMessage("a");
    const B = mockMessage("b");
    const f = mountTriage([A, B], "a");
    await f.triage.snoozeMessages([A], Date.now() + 3600_000);
    f.dispose();
    expect(f.selectMessage).toHaveBeenCalledWith(B, { silent: true });
  });

  it("snoozeMessages on failure rolls the selection back silently", async () => {
    const A = mockMessage("a", { label_ids: ["INBOX"] });
    const B = mockMessage("b");
    const f = mountTriage([A, B], "a");
    invokeMock.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    await f.triage.snoozeMessages([A], Date.now() + 3600_000);
    f.dispose();
    // First call: auto-advance to B (silent). Second call: rollback to A
    // because the snooze failed (also silent — we didn't open it for
    // reading, we restored the selection).
    expect(f.selectMessage).toHaveBeenCalledTimes(2);
    expect(f.selectMessage.mock.calls[0]).toEqual([B, { silent: true }]);
    expect(f.selectMessage.mock.calls[1]).toEqual([A, { silent: true }]);
  });

  it("lastOptimisticAt updates when a triage action fires", () => {
    const A = mockMessage("a");
    const before = Date.now() - 1;
    const f = mountTriage([A], "a");
    expect(f.triage.lastOptimisticAt()).toBe(0);
    f.triage.archiveWithUndo([A]);
    expect(f.triage.lastOptimisticAt()).toBeGreaterThan(before);
    f.dispose();
  });
});

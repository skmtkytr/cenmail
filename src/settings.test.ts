import { afterEach, describe, expect, it, vi } from "vitest";

// Mock invoke before importing settings so pushRuntimePrefs hits our spy.
const invokeMock = vi.fn<(...args: unknown[]) => unknown>(() =>
  Promise.resolve(),
);
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { pushRuntimePrefs, updateSettings, DEFAULT_SETTINGS } from "./settings";

afterEach(() => {
  // Reset to defaults so cross-test settings mutations don't leak.
  updateSettings(() => structuredClone(DEFAULT_SETTINGS));
  invokeMock.mockClear();
});

describe("pushRuntimePrefs", () => {
  it("maps the notification + close-to-tray subset to set_runtime_prefs", async () => {
    const s = structuredClone(DEFAULT_SETTINGS);
    s.notifications.enabled = true;
    s.notifications.buckets = ["personal", "newsletters"];
    s.notifications.perAccount = { "a@b.com": false };
    s.general.closeToTray = false;

    await pushRuntimePrefs(s);

    expect(invokeMock).toHaveBeenCalledWith("set_runtime_prefs", {
      prefs: {
        notifications: {
          enabled: true,
          buckets: ["personal", "newsletters"],
          perAccount: { "a@b.com": false },
        },
        closeToTray: false,
      },
    });
  });

  it("swallows backend errors (best-effort)", async () => {
    invokeMock.mockRejectedValueOnce(new Error("not in tauri"));
    await expect(pushRuntimePrefs(DEFAULT_SETTINGS)).resolves.toBeUndefined();
  });
});

describe("updateSettings", () => {
  it("pushes runtime prefs to the backend on every change", () => {
    updateSettings((s) => ({
      ...s,
      general: { ...s.general, closeToTray: false },
    }));
    const call = invokeMock.mock.calls.find((c) => c[0] === "set_runtime_prefs");
    expect(call).toBeTruthy();
    expect(
      (call![1] as { prefs: { closeToTray: boolean } }).prefs.closeToTray,
    ).toBe(false);
  });
});

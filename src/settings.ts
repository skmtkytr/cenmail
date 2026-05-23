import { createSignal } from "solid-js";
import type { Bucket } from "./utils";

export type ThemeMode = "system" | "light" | "dark";

export type Settings = {
  notifications: {
    enabled: boolean;
    buckets: Bucket[];
    perAccount: Record<string, boolean>;
  };
  appearance: {
    theme: ThemeMode;
  };
  compose: {
    undoSendSeconds: number;
    defaultAccount: string | null;
    // Per-account signature appended to the body of new composes (not
    // replies/forwards). Keyed by account email. Empty string = no signature.
    signatures: Record<string, string>;
    // When true, new composes start in rich-text (contenteditable) mode.
    richTextDefault: boolean;
  };
  inbox: {
    markAsReadOnOpen: boolean;
    defaultBucket: Bucket | "all";
  };
  privacy: {
    alwaysAllowImages: boolean;
  };
  calendar: {
    // Key: `${account_email}|${calendar_id}`. Missing key falls back to the
    // calendar's `selected` flag from Google.
    visibility: Record<string, boolean>;
  };
};

export const DEFAULT_SETTINGS: Settings = {
  notifications: {
    enabled: true,
    buckets: ["personal"],
    perAccount: {},
  },
  appearance: {
    theme: "system",
  },
  compose: {
    undoSendSeconds: 5,
    defaultAccount: null,
    signatures: {},
    richTextDefault: false,
  },
  inbox: {
    markAsReadOnOpen: true,
    defaultBucket: "all",
  },
  privacy: {
    alwaysAllowImages: false,
  },
  calendar: {
    visibility: {},
  },
};

const STORAGE_KEY = "cenmail:settings";

function mergeDefaults(partial: unknown): Settings {
  // Shallow-merge each section so new fields added later still get defaults.
  const p = (partial ?? {}) as Partial<Settings>;
  return {
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      ...(p.notifications ?? {}),
      perAccount: {
        ...DEFAULT_SETTINGS.notifications.perAccount,
        ...(p.notifications?.perAccount ?? {}),
      },
      buckets:
        Array.isArray(p.notifications?.buckets) &&
        p.notifications!.buckets.length >= 0
          ? p.notifications!.buckets
          : DEFAULT_SETTINGS.notifications.buckets,
    },
    appearance: { ...DEFAULT_SETTINGS.appearance, ...(p.appearance ?? {}) },
    compose: {
      ...DEFAULT_SETTINGS.compose,
      ...(p.compose ?? {}),
      signatures: {
        ...DEFAULT_SETTINGS.compose.signatures,
        ...(p.compose?.signatures ?? {}),
      },
    },
    inbox: { ...DEFAULT_SETTINGS.inbox, ...(p.inbox ?? {}) },
    privacy: { ...DEFAULT_SETTINGS.privacy, ...(p.privacy ?? {}) },
    calendar: {
      ...DEFAULT_SETTINGS.calendar,
      ...(p.calendar ?? {}),
      visibility: {
        ...DEFAULT_SETTINGS.calendar.visibility,
        ...(p.calendar?.visibility ?? {}),
      },
    },
  };
}

function loadInitial(): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return mergeDefaults(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

const [settings, setSettings] = createSignal<Settings>(loadInitial());

export { settings };

export function updateSettings(updater: (prev: Settings) => Settings) {
  const next = updater(settings());
  setSettings(next);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {}
}

// Notification bucket filter helper.
export function notificationsEnabledFor(
  email: string,
  bucket: Bucket,
): boolean {
  const s = settings();
  if (!s.notifications.enabled) return false;
  if (!s.notifications.buckets.includes(bucket)) return false;
  const perAccount = s.notifications.perAccount[email];
  // Undefined means "not configured" → default on.
  return perAccount !== false;
}

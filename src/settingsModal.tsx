import { For, Show } from "solid-js";
import type { Bucket } from "./utils";
import { settings, updateSettings, type ThemeMode } from "./settings";
import { useEscClose } from "./modal";

type AccountLike = { id: number; email: string };

const BUCKETS: Array<{ id: Bucket; label: string }> = [
  { id: "personal", label: "Personal" },
  { id: "newsletters", label: "Newsletters" },
  { id: "notifications", label: "Notifications" },
];

const THEMES: Array<{ id: ThemeMode; label: string }> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const UNDO_PRESETS = [0, 5, 10, 30];

export function SettingsModal(props: {
  open: boolean;
  onClose: () => void;
  accounts: AccountLike[];
}) {
  useEscClose(() => props.open, () => props.onClose());
  function toggleBucket(b: Bucket) {
    updateSettings((s) => {
      const present = s.notifications.buckets.includes(b);
      return {
        ...s,
        notifications: {
          ...s.notifications,
          buckets: present
            ? s.notifications.buckets.filter((x) => x !== b)
            : [...s.notifications.buckets, b],
        },
      };
    });
  }

  function setPerAccount(email: string, enabled: boolean) {
    updateSettings((s) => ({
      ...s,
      notifications: {
        ...s.notifications,
        perAccount: { ...s.notifications.perAccount, [email]: enabled },
      },
    }));
  }

  return (
    <Show when={props.open}>
      <div
        class="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4"
        onClick={props.onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          class="flex h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <header class="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
            <h2 class="text-base font-semibold">Settings</h2>
            <button
              type="button"
              onClick={props.onClose}
              class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
              aria-label="Close settings"
            >
              ×
            </button>
          </header>

          <div class="flex-1 space-y-8 overflow-y-auto px-5 py-4 text-sm">
            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                Notifications
              </h3>
              <Field label="Enable desktop notifications">
                <Toggle
                  checked={settings().notifications.enabled}
                  onChange={(v) =>
                    updateSettings((s) => ({
                      ...s,
                      notifications: { ...s.notifications, enabled: v },
                    }))
                  }
                />
              </Field>
              <Field label="Notify for buckets">
                <div class="flex flex-wrap gap-1.5">
                  <For each={BUCKETS}>
                    {(b) => {
                      const active = () =>
                        settings().notifications.buckets.includes(b.id);
                      return (
                        <button
                          type="button"
                          onClick={() => toggleBucket(b.id)}
                          class={`rounded-full border px-3 py-1 text-xs ${
                            active()
                              ? "border-[color:var(--color-accent)] bg-[color:var(--color-accent-bg)] text-[color:var(--color-fg)]"
                              : "border-[color:var(--color-border)] text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
                          }`}
                        >
                          {b.label}
                        </button>
                      );
                    }}
                  </For>
                </div>
              </Field>
              <Show when={props.accounts.length > 0}>
                <Field label="Per account">
                  <div class="flex flex-col gap-1.5">
                    <For each={props.accounts}>
                      {(a) => {
                        const enabled = () =>
                          settings().notifications.perAccount[a.email] !==
                          false;
                        return (
                          <label class="flex cursor-pointer items-center justify-between gap-3">
                            <span class="truncate text-[color:var(--color-muted)]">
                              {a.email}
                            </span>
                            <Toggle
                              checked={enabled()}
                              onChange={(v) => setPerAccount(a.email, v)}
                            />
                          </label>
                        );
                      }}
                    </For>
                  </div>
                </Field>
              </Show>
            </section>

            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                Appearance
              </h3>
              <Field label="Theme">
                <SegmentedControl
                  options={THEMES}
                  value={settings().appearance.theme}
                  onChange={(v) =>
                    updateSettings((s) => ({
                      ...s,
                      appearance: { ...s.appearance, theme: v as ThemeMode },
                    }))
                  }
                />
              </Field>
            </section>

            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                Compose
              </h3>
              <Field label="Undo Send window">
                <SegmentedControl
                  options={UNDO_PRESETS.map((n) => ({
                    id: String(n),
                    label: n === 0 ? "Off" : `${n}s`,
                  }))}
                  value={String(settings().compose.undoSendSeconds)}
                  onChange={(v) =>
                    updateSettings((s) => ({
                      ...s,
                      compose: { ...s.compose, undoSendSeconds: parseInt(v) },
                    }))
                  }
                />
              </Field>
              <Field label="Default sending account">
                <select
                  value={settings().compose.defaultAccount ?? ""}
                  onChange={(e) =>
                    updateSettings((s) => ({
                      ...s,
                      compose: {
                        ...s.compose,
                        defaultAccount: e.currentTarget.value || null,
                      },
                    }))
                  }
                  class="rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 text-sm"
                >
                  <option value="">(First added)</option>
                  <For each={props.accounts}>
                    {(a) => <option value={a.email}>{a.email}</option>}
                  </For>
                </select>
              </Field>
            </section>

            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                Inbox
              </h3>
              <Field label="Mark as read when opening a message">
                <Toggle
                  checked={settings().inbox.markAsReadOnOpen}
                  onChange={(v) =>
                    updateSettings((s) => ({
                      ...s,
                      inbox: { ...s.inbox, markAsReadOnOpen: v },
                    }))
                  }
                />
              </Field>
              <Field label="Default inbox tab">
                <SegmentedControl
                  options={[
                    { id: "all", label: "All" },
                    { id: "personal", label: "Personal" },
                  ]}
                  value={settings().inbox.defaultBucket}
                  onChange={(v) =>
                    updateSettings((s) => ({
                      ...s,
                      inbox: {
                        ...s.inbox,
                        defaultBucket: v as Bucket | "all",
                      },
                    }))
                  }
                />
              </Field>
            </section>

            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                Privacy
              </h3>
              <Field label="Always load remote images">
                <Toggle
                  checked={settings().privacy.alwaysAllowImages}
                  onChange={(v) =>
                    updateSettings((s) => ({
                      ...s,
                      privacy: { ...s.privacy, alwaysAllowImages: v },
                    }))
                  }
                />
              </Field>
              <p class="mt-1 text-xs text-[color:var(--color-muted)]">
                When off, images are blocked until you click "Show images" per
                message.
              </p>
            </section>

            <section>
              <h3 class="mb-2 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                About
              </h3>
              <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-xs text-[color:var(--color-muted)]">
                <dt>SQLite cache</dt>
                <dd class="font-mono">
                  $XDG_DATA_HOME/cenmail/cenmail.db
                </dd>
                <dt>OAuth credentials</dt>
                <dd class="font-mono">
                  $XDG_CONFIG_HOME/cenmail/credentials.env
                </dd>
                <dt>Refresh tokens</dt>
                <dd>System keyring (service "cenmail")</dd>
              </dl>
            </section>
          </div>
        </div>
      </div>
    </Show>
  );
}

function Field(props: { label: string; children: any }) {
  return (
    <div class="mb-3 flex items-start justify-between gap-4">
      <label class="flex-1 text-sm">{props.label}</label>
      <div class="shrink-0">{props.children}</div>
    </div>
  );
}

function Toggle(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      onClick={() => props.onChange(!props.checked)}
      class={`relative inline-flex h-5 w-9 items-center rounded-full transition ${
        props.checked
          ? "bg-[color:var(--color-accent)]"
          : "bg-[color:var(--color-surface-active)]"
      }`}
    >
      <span
        class={`inline-block size-4 transform rounded-full bg-white transition ${
          props.checked ? "translate-x-4" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}

function SegmentedControl<T extends string>(props: {
  options: Array<{ id: T; label: string }>;
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div class="inline-flex rounded border border-[color:var(--color-border)] p-0.5">
      <For each={props.options}>
        {(opt) => {
          const active = () => opt.id === props.value;
          return (
            <button
              type="button"
              onClick={() => props.onChange(opt.id)}
              class={`rounded px-2.5 py-0.5 text-xs ${
                active()
                  ? "bg-[color:var(--color-surface-active)] font-medium"
                  : "text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
              }`}
            >
              {opt.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

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
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { colorForEmail } from "./utils";
import { showToast } from "./toast";
import { settings, updateSettings } from "./settings";
import { useEscClose } from "./modal";

type CalendarRow = {
  account_email: string;
  id: string;
  summary: string;
  background_color: string | null;
  is_primary: boolean;
  selected: boolean;
};

type EventRow = {
  account_email: string;
  calendar_id: string;
  id: string;
  ical_uid: string | null;
  summary: string;
  description: string | null;
  location: string | null;
  organizer_email: string | null;
  organizer_name: string | null;
  start_ms: number;
  end_ms: number;
  all_day: boolean;
  attendees_json: string;
  response_status: string | null;
  html_link: string | null;
  conference_uri: string | null;
  status: string | null;
};

type Account = { id: number; email: string; display_name: string | null };

type ViewMode = "day" | "week" | "month";

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ONE_DAY_MS = 86_400_000;

const HOUR_PX_DEFAULT = 44;
const HOUR_PX_MIN = 24;
const HOUR_PX_MAX = 120;
const HOUR_PX_STEP = 8;
import {
  CALENDAR_HOUR_PX_KEY as HOUR_PX_STORAGE,
  CALENDAR_VIEW_KEY as VIEW_STORAGE,
} from "./constants";

function loadHourPx(): number {
  try {
    const n = parseInt(localStorage.getItem(HOUR_PX_STORAGE) ?? "", 10);
    if (Number.isFinite(n)) {
      return Math.max(HOUR_PX_MIN, Math.min(HOUR_PX_MAX, n));
    }
  } catch {}
  return HOUR_PX_DEFAULT;
}

function loadView(): ViewMode {
  try {
    const raw = localStorage.getItem(VIEW_STORAGE);
    if (raw === "day" || raw === "week" || raw === "month") return raw;
  } catch {}
  return "week";
}

function startOfDay(d: Date): Date {
  const r = new Date(d);
  r.setHours(0, 0, 0, 0);
  return r;
}

function startOfWeek(d: Date): Date {
  const r = startOfDay(d);
  r.setDate(r.getDate() - r.getDay());
  return r;
}

function startOfMonthGrid(d: Date): Date {
  const firstOfMonth = new Date(d.getFullYear(), d.getMonth(), 1);
  return startOfWeek(firstOfMonth);
}

function addDays(d: Date, n: number): Date {
  const r = new Date(d);
  r.setDate(r.getDate() + n);
  return r;
}

function addMonths(d: Date, n: number): Date {
  const r = new Date(d);
  r.setMonth(r.getMonth() + n);
  return r;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function fmtRange(start: Date, view: ViewMode): string {
  if (view === "day") {
    return start.toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  if (view === "month") {
    return start.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }
  const end = addDays(start, 6);
  const sameMonth =
    start.getMonth() === end.getMonth() &&
    start.getFullYear() === end.getFullYear();
  if (sameMonth) {
    return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.getDate()}, ${end.getFullYear()}`;
  }
  return `${start.toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${end.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
}

// Layout primitives moved to src/calendar/layout.ts so they can be
// unit-tested without rendering.
import {
  evKey,
  layoutOverlappingDay,
  layoutSpanning,
  readableFg,
  type EventStyle,
  type TimedLayout,
} from "./calendar/layout";

export function CalendarPane(props: { accounts: Account[] }) {
  const [viewMode, setViewModeRaw] = createSignal<ViewMode>(loadView());
  function setViewMode(v: ViewMode) {
    setViewModeRaw(v);
    try {
      localStorage.setItem(VIEW_STORAGE, v);
    } catch {}
  }

  const [anchorDate, setAnchorDate] = createSignal(new Date());
  const [selectedEvent, setSelectedEvent] = createSignal<EventRow | null>(null);
  const [hourPx, setHourPxRaw] = createSignal(loadHourPx());

  function setHourPx(next: number) {
    const clamped = Math.max(HOUR_PX_MIN, Math.min(HOUR_PX_MAX, next));
    setHourPxRaw(clamped);
    try {
      localStorage.setItem(HOUR_PX_STORAGE, String(clamped));
    } catch {}
  }

  const viewStart = () => {
    const v = viewMode();
    if (v === "day") return startOfDay(anchorDate());
    if (v === "week") return startOfWeek(anchorDate());
    return startOfMonthGrid(anchorDate());
  };
  const viewDayCount = () =>
    viewMode() === "day" ? 1 : viewMode() === "week" ? 7 : 42;
  const viewFromMs = () => viewStart().getTime();
  const viewToMs = () =>
    addDays(viewStart(), viewDayCount()).getTime();
  // Sync window pads the visible window so adjacent navigation feels instant.
  const syncFromMs = () => addDays(viewStart(), -7).getTime();
  const syncToMs = () => addDays(viewStart(), viewDayCount() + 7).getTime();

  const [calendars, { refetch: refetchCalendars }] = createResource<
    CalendarRow[]
  >(
    async () => {
      const out: CalendarRow[] = [];
      for (const a of props.accounts) {
        try {
          const cals = await invoke<CalendarRow[]>("list_calendars", {
            email: a.email,
            refresh: false,
          });
          out.push(...cals);
        } catch {
          // first run may need refresh:true
        }
      }
      return out;
    },
    { initialValue: [] },
  );

  const [events, setEvents] = createSignal<EventRow[]>([]);
  const [syncing, setSyncing] = createSignal(false);

  const calendarColors = createMemo(() => {
    const map = new Map<string, string>();
    for (const c of calendars() ?? []) {
      if (c.background_color) {
        map.set(`${c.account_email}|${c.id}`, c.background_color);
      }
    }
    return map;
  });

  function eventStyle(ev: EventRow): EventStyle {
    const key = `${ev.account_email}|${ev.calendar_id}`;
    const fromGoogle = calendarColors().get(key);
    const bg = fromGoogle ?? colorForEmail(key);
    return { bg, fg: readableFg(bg) };
  }

  function calendarSummary(ev: EventRow): string | undefined {
    const key = `${ev.account_email}|${ev.calendar_id}`;
    return (calendars() ?? []).find(
      (c) => `${c.account_email}|${c.id}` === key,
    )?.summary;
  }

  function isCalendarVisible(c: CalendarRow): boolean {
    const key = `${c.account_email}|${c.id}`;
    const override = settings().calendar.visibility[key];
    if (override === undefined) return c.is_primary || c.selected;
    return override;
  }

  function setCalendarVisible(c: CalendarRow, visible: boolean) {
    const key = `${c.account_email}|${c.id}`;
    updateSettings((s) => ({
      ...s,
      calendar: {
        ...s.calendar,
        visibility: { ...s.calendar.visibility, [key]: visible },
      },
    }));
  }

  const visibleCalendarKeys = createMemo(() => {
    const set = new Set<string>();
    for (const c of calendars() ?? []) {
      if (isCalendarVisible(c)) set.add(`${c.account_email}|${c.id}`);
    }
    return set;
  });

  const visibleEvents = createMemo(() => {
    const filtered = events().filter((e) =>
      visibleCalendarKeys().has(`${e.account_email}|${e.calendar_id}`),
    );
    // Dedupe the same logical event that appears in multiple calendars (same
    // iCalUID within an account). Prefer the primary calendar's copy.
    const cals = calendars() ?? [];
    const primaryByEmail = new Map<string, string>();
    for (const c of cals) {
      if (c.is_primary) primaryByEmail.set(c.account_email, c.id);
    }
    const seen = new Map<string, EventRow>();
    for (const ev of filtered) {
      if (!ev.ical_uid) {
        // No iCalUID — never dedupe; use a per-row unique key.
        seen.set(
          `_norow|${ev.account_email}|${ev.calendar_id}|${ev.id}`,
          ev,
        );
        continue;
      }
      const key = `${ev.account_email}|${ev.ical_uid}`;
      const existing = seen.get(key);
      if (!existing) {
        seen.set(key, ev);
        continue;
      }
      // Prefer primary calendar copy.
      const primaryCal = primaryByEmail.get(ev.account_email);
      if (ev.calendar_id === primaryCal && existing.calendar_id !== primaryCal) {
        seen.set(key, ev);
      }
    }
    return Array.from(seen.values());
  });

  const [pickerOpen, setPickerOpen] = createSignal(false);
  const [editorDraft, setEditorDraft] = createSignal<EventDraft | null>(null);

  function openNewEventEditor() {
    // Default to 1-hour event starting on the next half-hour mark, on the
    // current anchor date.
    const base = new Date(anchorDate());
    base.setMinutes(base.getMinutes() < 30 ? 30 : 0, 0, 0);
    if (base.getMinutes() === 0) base.setHours(base.getHours() + 1);
    const startMs = base.getTime();
    setEditorDraft({
      summary: "",
      description: "",
      location: "",
      start_ms: startMs,
      end_ms: startMs + 60 * 60 * 1000,
      all_day: false,
      attendees: "",
    });
  }

  function openEditEventEditor(ev: EventRow) {
    let attendees: string[] = [];
    try {
      const parsed = JSON.parse(ev.attendees_json) as Array<{ email: string; self?: boolean }>;
      attendees = parsed.filter((a) => !a.self).map((a) => a.email);
    } catch {}
    setEditorDraft({
      account_email: ev.account_email,
      calendar_id: ev.calendar_id,
      event_id: ev.id,
      summary: ev.summary || "",
      description: ev.description || "",
      location: ev.location || "",
      start_ms: ev.start_ms,
      end_ms: ev.end_ms,
      all_day: ev.all_day,
      attendees: attendees.join(", "),
    });
  }

  async function deleteEvent(ev: EventRow) {
    if (
      !window.confirm(`Delete "${ev.summary || "(no title)"}"? This cannot be undone.`)
    ) {
      return;
    }
    try {
      await invoke("delete_event", {
        email: ev.account_email,
        calendarId: ev.calendar_id,
        eventId: ev.id,
      });
      showToast({ message: "Event deleted" });
      setSelectedEvent(null);
      void refetchEvents();
      void syncWindow();
    } catch (err) {
      showToast({ message: `Delete failed: ${err}`, variant: "error" });
    }
  }

  async function refetchEvents() {
    try {
      const rows = await invoke<EventRow[]>("list_events_cached", {
        fromMs: viewFromMs(),
        toMs: viewToMs(),
      });
      setEvents(rows);
    } catch (err) {
      showToast({
        message: `Calendar load failed: ${err}`,
        variant: "error",
      });
    }
  }

  async function syncWindow() {
    if (syncing()) return;
    setSyncing(true);
    try {
      let cals = calendars() ?? [];
      if (cals.length === 0) {
        for (const a of props.accounts) {
          try {
            await invoke("list_calendars", { email: a.email, refresh: true });
          } catch {}
        }
        await refetchCalendars();
        cals = calendars() ?? [];
      }
      const targets = cals.filter((c) => isCalendarVisible(c));
      for (const c of targets) {
        try {
          await invoke<number>("sync_calendar_events", {
            email: c.account_email,
            calendarId: c.id,
            fromMs: syncFromMs(),
            toMs: syncToMs(),
          });
        } catch (err) {
          showToast({
            message: `Sync failed (${c.summary}): ${err}`,
            variant: "error",
          });
        }
      }
      await refetchEvents();
    } finally {
      setSyncing(false);
    }
  }

  onMount(() => {
    void refetchEvents();
    void syncWindow();
    const unlistens: UnlistenFn[] = [];
    (async () => {
      unlistens.push(
        await listen<string>("accounts:changed", () => {
          void refetchCalendars();
          void syncWindow();
        }),
      );
    })();
    return () => unlistens.forEach((u) => u());
  });

  createEffect(() => {
    viewFromMs();
    viewToMs();
    void refetchEvents();
  });

  function gotoPrev() {
    const v = viewMode();
    if (v === "day") setAnchorDate(addDays(anchorDate(), -1));
    else if (v === "week") setAnchorDate(addDays(anchorDate(), -7));
    else setAnchorDate(addMonths(anchorDate(), -1));
  }
  function gotoNext() {
    const v = viewMode();
    if (v === "day") setAnchorDate(addDays(anchorDate(), 1));
    else if (v === "week") setAnchorDate(addDays(anchorDate(), 7));
    else setAnchorDate(addMonths(anchorDate(), 1));
  }
  function gotoToday() {
    setAnchorDate(new Date());
  }

  function onZoomWheel(e: WheelEvent) {
    if (!e.ctrlKey) return;
    e.preventDefault();
    setHourPx(hourPx() + (e.deltaY < 0 ? HOUR_PX_STEP : -HOUR_PX_STEP));
  }

  // Calendar-only keyboard shortcuts. Registered on document because the
  // pane itself has no focusable container; CalendarPane is unmounted
  // when leaving calendar view so the listener auto-cleans.
  function isEditableTarget(t: EventTarget | null): boolean {
    if (!(t instanceof HTMLElement)) return false;
    const tag = t.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
    if (t.isContentEditable) return true;
    return false;
  }
  onMount(() => {
    function onCalKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (isEditableTarget(e.target)) return;
      // Skip while any calendar modal is open — they own their own
      // Esc handling and shouldn't steal navigation keys.
      if (editorDraft() || selectedEvent() || pickerOpen()) return;
      switch (e.key) {
        case "ArrowLeft":
        case "h":
          e.preventDefault();
          gotoPrev();
          break;
        case "ArrowRight":
        case "l":
          e.preventDefault();
          gotoNext();
          break;
        case "t":
          e.preventDefault();
          gotoToday();
          break;
        case "d":
          e.preventDefault();
          setViewMode("day");
          break;
        case "w":
          e.preventDefault();
          setViewMode("week");
          break;
        case "M":
          e.preventDefault();
          setViewMode("month");
          break;
      }
    }
    document.addEventListener("keydown", onCalKey);
    onCleanup(() => document.removeEventListener("keydown", onCalKey));
  });

  return (
    <section class="flex min-w-0 flex-1 flex-col bg-[color:var(--color-surface)]">
      <header class="flex shrink-0 items-center justify-between gap-3 border-b border-[color:var(--color-border)] px-5 py-3">
        <div class="flex items-center gap-1">
          <button
            type="button"
            title="Previous"
            onClick={gotoPrev}
            class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={gotoToday}
            class="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-surface-hover)]"
          >
            Today
          </button>
          <button
            type="button"
            title="Next"
            onClick={gotoNext}
            class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
          >
            ›
          </button>
          <h2 class="ml-3 text-sm font-semibold">
            {fmtRange(viewStart(), viewMode())}
          </h2>
        </div>
        <div class="flex items-center gap-2">
          <div class="inline-flex rounded border border-[color:var(--color-border)] p-0.5 text-xs">
            <For each={["day", "week", "month"] as const}>
              {(v) => (
                <button
                  type="button"
                  onClick={() => setViewMode(v)}
                  class={`rounded px-2 py-0.5 capitalize ${
                    viewMode() === v
                      ? "bg-[color:var(--color-surface-active)] font-medium"
                      : "text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
                  }`}
                >
                  {v}
                </button>
              )}
            </For>
          </div>
          <Show when={viewMode() !== "month"}>
            <div class="flex items-center gap-0.5 rounded border border-[color:var(--color-border)] p-0.5 text-xs">
              <button
                type="button"
                title="Zoom out (Ctrl+Scroll)"
                disabled={hourPx() <= HOUR_PX_MIN}
                onClick={() => setHourPx(hourPx() - HOUR_PX_STEP)}
                class="px-1.5 hover:bg-[color:var(--color-surface-hover)] disabled:opacity-30"
              >
                −
              </button>
              <span class="px-1 text-[10px] text-[color:var(--color-muted)] tabular-nums">
                {hourPx()}px
              </span>
              <button
                type="button"
                title="Zoom in (Ctrl+Scroll)"
                disabled={hourPx() >= HOUR_PX_MAX}
                onClick={() => setHourPx(hourPx() + HOUR_PX_STEP)}
                class="px-1.5 hover:bg-[color:var(--color-surface-hover)] disabled:opacity-30"
              >
                +
              </button>
            </div>
          </Show>
          <button
            type="button"
            onClick={openNewEventEditor}
            title="Create event"
            class="rounded bg-[color:var(--color-accent)] px-2 py-0.5 text-xs font-medium text-white hover:opacity-90"
          >
            + New
          </button>
          <div class="relative">
            <button
              type="button"
              onClick={() => setPickerOpen(!pickerOpen())}
              title="Choose calendars"
              class="rounded border border-[color:var(--color-border)] px-2 py-0.5 text-xs hover:bg-[color:var(--color-surface-hover)]"
            >
              Calendars ({visibleCalendarKeys().size})
            </button>
            <Show when={pickerOpen()}>
              <CalendarPicker
                accounts={props.accounts}
                calendars={calendars() ?? []}
                isVisible={isCalendarVisible}
                onToggle={(c, v) => {
                  setCalendarVisible(c, v);
                  void syncWindow();
                }}
                onClose={() => setPickerOpen(false)}
                eventStyle={eventStyle}
              />
            </Show>
          </div>
          <button
            type="button"
            onClick={syncWindow}
            disabled={syncing()}
            title="Refetch from Google"
            class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
          >
            ↻
          </button>
        </div>
      </header>

      <Show when={viewMode() === "day" || viewMode() === "week"}>
        <TimeGridView
          dayCount={viewMode() === "day" ? 1 : 7}
          startMs={viewFromMs()}
          events={visibleEvents()}
          hourPx={hourPx()}
          onZoomWheel={onZoomWheel}
          onSelectEvent={(ev) => setSelectedEvent(ev)}
          onCreateRange={(startMs, endMs) => {
            setEditorDraft({
              summary: "",
              description: "",
              location: "",
              start_ms: startMs,
              end_ms: endMs,
              all_day: false,
              attendees: "",
            });
          }}
          eventStyle={eventStyle}
        />
      </Show>
      <Show when={viewMode() === "month"}>
        <MonthGridView
          startMs={viewFromMs()}
          monthAnchor={anchorDate()}
          events={visibleEvents()}
          onSelectEvent={(ev) => setSelectedEvent(ev)}
          onJumpToDay={(d) => {
            setAnchorDate(d);
            setViewMode("day");
          }}
          eventStyle={eventStyle}
        />
      </Show>

      <Show when={selectedEvent()}>
        {(ev) => (
          <EventDetailModal
            event={ev()}
            calendarName={calendarSummary(ev())}
            eventStyle={eventStyle(ev())}
            onClose={() => setSelectedEvent(null)}
            onChanged={() => {
              void refetchEvents();
              void syncWindow();
            }}
            onEdit={() => openEditEventEditor(ev())}
            onDelete={() => deleteEvent(ev())}
          />
        )}
      </Show>
      <Show when={editorDraft()}>
        {(d) => (
          <EventEditorModal
            draft={d()}
            accounts={props.accounts}
            calendars={calendars() ?? []}
            onClose={() => setEditorDraft(null)}
            onSaved={() => {
              void refetchEvents();
              void syncWindow();
            }}
          />
        )}
      </Show>
    </section>
  );
}

function TimeGridView(props: {
  dayCount: number;
  startMs: number;
  events: EventRow[];
  hourPx: number;
  onZoomWheel: (e: WheelEvent) => void;
  onSelectEvent: (ev: EventRow) => void;
  onCreateRange: (startMs: number, endMs: number) => void;
  eventStyle: (ev: EventRow) => EventStyle;
}) {
  type DragState = {
    dayIndex: number;
    dayMs: number;
    startY: number;
    currentY: number;
  };
  const [drag, setDrag] = createSignal<DragState | null>(null);
  const SNAP_MIN = 15;

  const pxToMinutes = (y: number): number => {
    const raw = (y / props.hourPx) * 60;
    return Math.max(0, Math.min(24 * 60, Math.round(raw / SNAP_MIN) * SNAP_MIN));
  };

  function startDrag(e: MouseEvent, di: number, dayMs: number) {
    // Only start a drag on the column background, not on an event button.
    if (e.target !== e.currentTarget) return;
    if (e.button !== 0) return;
    e.preventDefault();
    const colEl = e.currentTarget as HTMLElement;
    const rect = colEl.getBoundingClientRect();
    const y0 = e.clientY - rect.top;
    setDrag({ dayIndex: di, dayMs, startY: y0, currentY: y0 });
    const onMove = (mv: MouseEvent) => {
      const r = colEl.getBoundingClientRect();
      const y = Math.max(0, Math.min(r.height, mv.clientY - r.top));
      setDrag((s) => (s ? { ...s, currentY: y } : null));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      const s = drag();
      setDrag(null);
      if (!s) return;
      let startMin = pxToMinutes(Math.min(s.startY, s.currentY));
      let endMin = pxToMinutes(Math.max(s.startY, s.currentY));
      if (endMin - startMin < SNAP_MIN) endMin = startMin + 60; // click → 1h
      props.onCreateRange(
        s.dayMs + startMin * 60_000,
        s.dayMs + endMin * 60_000,
      );
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  function dragRect(di: number): { top: number; height: number; label: string } | null {
    const s = drag();
    if (!s || s.dayIndex !== di) return null;
    const yMin = Math.min(s.startY, s.currentY);
    const yMax = Math.max(s.startY, s.currentY);
    const startMin = pxToMinutes(yMin);
    const endMin = Math.max(startMin + SNAP_MIN, pxToMinutes(yMax));
    const top = (startMin / 60) * props.hourPx;
    const height = ((endMin - startMin) / 60) * props.hourPx;
    const fmt = (m: number) =>
      `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    return { top, height, label: `${fmt(startMin)} – ${fmt(endMin)}` };
  }
  const days = createMemo(() =>
    Array.from({ length: props.dayCount }, (_, i) =>
      new Date(props.startMs + i * ONE_DAY_MS),
    ),
  );

  const allDay = createMemo(() => props.events.filter((e) => e.all_day));
  const timed = createMemo(() => props.events.filter((e) => !e.all_day));

  const timedByDay = createMemo<EventRow[][]>(() => {
    const buckets: EventRow[][] = days().map(() => []);
    const dayStarts = days().map((d) => d.getTime());
    for (const ev of timed()) {
      for (let i = 0; i < buckets.length; i++) {
        const ds = dayStarts[i];
        const de = ds + ONE_DAY_MS;
        if (ev.start_ms < de && ev.end_ms > ds) {
          buckets[i].push(ev);
        }
      }
    }
    return buckets;
  });

  // Per-day sub-column layout for overlapping events (computed once per
  // events/days change to keep scroll painting cheap).
  const overlapByDay = createMemo<Array<Map<string, TimedLayout>>>(() =>
    timedByDay().map((evs) => layoutOverlappingDay(evs)),
  );

  const allDayLayout = createMemo(() =>
    layoutSpanning(allDay(), props.startMs, props.dayCount),
  );

  const cols = () => props.dayCount;
  const timeColPx = 56;

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Day headers (week only) */}
      <Show when={cols() > 1}>
        <div
          class="grid shrink-0 border-b border-[color:var(--color-border)] text-xs"
          style={{
            "grid-template-columns": `${timeColPx}px repeat(${cols()}, minmax(0, 1fr))`,
          }}
        >
          <div />
          <For each={days()}>
            {(d) => {
              const today = sameDay(d, new Date());
              return (
                <div
                  class={`border-l border-[color:var(--color-border)] px-2 py-1 text-center ${
                    today
                      ? "text-[color:var(--color-accent)] font-semibold"
                      : "text-[color:var(--color-muted)]"
                  }`}
                >
                  <div>{DAY_NAMES[d.getDay()]}</div>
                  <div
                    class={
                      today
                        ? "text-base"
                        : "text-sm font-medium text-[color:var(--color-fg)]"
                    }
                  >
                    {d.getDate()}
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </Show>

      {/* All-day events with multi-day spanning */}
      <Show when={allDayLayout().laneCount > 0}>
        <div
          class="grid shrink-0 border-b border-[color:var(--color-border)] text-xs"
          style={{
            "grid-template-columns": `${timeColPx}px repeat(${cols()}, minmax(0, 1fr))`,
            "grid-template-rows": `repeat(${allDayLayout().laneCount}, 22px)`,
          }}
        >
          <div
            class="px-1 py-1 text-right text-[color:var(--color-muted)]"
            style={{ "grid-column": "1", "grid-row": "1 / -1" }}
          >
            all-day
          </div>
          <For each={days()}>
            {(_, di) => (
              <div
                class="border-l border-[color:var(--color-border)]"
                style={{
                  "grid-column": `${di() + 2}`,
                  "grid-row": "1 / -1",
                }}
              />
            )}
          </For>
          <For each={allDayLayout().placements}>
            {(p) => {
              const s = props.eventStyle(p.ev);
              return (
                <button
                  type="button"
                  onClick={() => props.onSelectEvent(p.ev)}
                  title={p.ev.summary}
                  class="mx-0.5 my-px overflow-hidden truncate rounded px-1.5 text-left text-xs"
                  style={{
                    "grid-column": `${p.startCol + 2} / span ${p.endCol - p.startCol + 1}`,
                    "grid-row": `${p.lane + 1}`,
                    "background-color": s.bg,
                    color: s.fg,
                  }}
                >
                  {p.ev.summary || "(no title)"}
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Hour grid */}
      <div
        class="min-h-0 flex-1 overflow-y-auto"
        style={{ "will-change": "scroll-position" }}
        onWheel={props.onZoomWheel}
      >
        <div
          class="flex"
          style={{
            transform: "translateZ(0)",
          }}
        >
          {/* Time labels */}
          <div class="shrink-0" style={{ width: `${timeColPx}px` }}>
            <For each={Array.from({ length: 24 }, (_, h) => h)}>
              {(h) => (
                <div
                  class="-translate-y-1.5 pr-2 text-right text-[10px] text-[color:var(--color-muted)]"
                  style={{ height: `${props.hourPx}px` }}
                >
                  {h === 0 ? "" : `${String(h).padStart(2, "0")}:00`}
                </div>
              )}
            </For>
          </div>
          {/* Day columns */}
          <For each={days()}>
            {(d, di) => (
              <div
                class="relative flex-1 cursor-cell border-l border-[color:var(--color-border)]"
                style={{
                  height: `${props.hourPx * 24}px`,
                  "background-image": `repeating-linear-gradient(to bottom, transparent 0, transparent ${props.hourPx - 1}px, var(--color-border) ${props.hourPx - 1}px, var(--color-border) ${props.hourPx}px)`,
                  contain: "layout style paint",
                }}
                onMouseDown={(e) => startDrag(e, di(), d.getTime())}
              >
                <Show when={dragRect(di())}>
                  {(r) => (
                    <div
                      class="pointer-events-none absolute inset-x-0.5 rounded border border-[color:var(--color-accent)] bg-[color:var(--color-accent)]/30"
                      style={{
                        top: `${r().top}px`,
                        height: `${r().height}px`,
                      }}
                    >
                      <span class="m-1 inline-block rounded bg-[color:var(--color-accent)] px-1 text-[10px] font-medium text-white">
                        {r().label}
                      </span>
                    </div>
                  )}
                </Show>
                <For each={timedByDay()[di()]}>
                  {(ev) => {
                    const dayStartMs = d.getTime();
                    const layout = overlapByDay()[di()].get(evKey(ev)) ?? {
                      col: 0,
                      totalCols: 1,
                      span: 1,
                    };
                    const startMin = () =>
                      Math.max(0, (ev.start_ms - dayStartMs) / 60000);
                    const endMin = () =>
                      Math.min(24 * 60, (ev.end_ms - dayStartMs) / 60000);
                    const top = () => (startMin() / 60) * props.hourPx;
                    const height = () =>
                      Math.max(
                        18,
                        ((endMin() - startMin()) / 60) * props.hourPx - 2,
                      );
                    // Sub-column widths share the day column; the event
                    // expands to span as many empty neighbour columns as it
                    // can (Google Calendar-style smart packing). Inset a hair
                    // on the right so adjacent events show a visible gap.
                    const widthPct =
                      (100 * layout.span) / layout.totalCols;
                    const leftPct = (100 * layout.col) / layout.totalCols;
                    const startLabel = new Date(ev.start_ms).toLocaleTimeString(
                      undefined,
                      { hour: "2-digit", minute: "2-digit" },
                    );
                    const declined = ev.response_status === "declined";
                    const s = props.eventStyle(ev);
                    return (
                      <button
                        type="button"
                        onClick={() => props.onSelectEvent(ev)}
                        class={`absolute flex flex-col items-start justify-start overflow-hidden rounded px-1.5 py-0.5 text-left text-xs leading-tight ${
                          declined ? "opacity-50 line-through" : ""
                        }`}
                        style={{
                          top: `${top()}px`,
                          height: `${height()}px`,
                          left: `calc(${leftPct}% + 2px)`,
                          width: `calc(${widthPct}% - 4px)`,
                          "background-color": s.bg,
                          color: s.fg,
                        }}
                        title={`${startLabel} ${ev.summary}`}
                      >
                        <div class="w-full truncate font-medium">
                          {ev.summary || "(no title)"}
                        </div>
                        <Show when={height() > 32}>
                          <div class="text-[10px] opacity-80">{startLabel}</div>
                        </Show>
                      </button>
                    );
                  }}
                </For>
              </div>
            )}
          </For>
        </div>
      </div>
    </div>
  );
}

function MonthGridView(props: {
  startMs: number;
  monthAnchor: Date;
  events: EventRow[];
  onSelectEvent: (ev: EventRow) => void;
  onJumpToDay: (d: Date) => void;
  eventStyle: (ev: EventRow) => EventStyle;
}) {
  const days = createMemo(() =>
    Array.from({ length: 42 }, (_, i) => new Date(props.startMs + i * ONE_DAY_MS)),
  );

  // For month view, lay out events as spans across week-rows.
  // We treat each week (7 days) independently for lane assignment so each row's
  // event blocks line up visually.
  const weeks = createMemo<EventRow[][]>(() => {
    const w: EventRow[][] = [[], [], [], [], [], []];
    for (const ev of props.events) {
      for (let wi = 0; wi < 6; wi++) {
        const weekStart = props.startMs + wi * 7 * ONE_DAY_MS;
        const weekEnd = weekStart + 7 * ONE_DAY_MS;
        if (ev.start_ms < weekEnd && ev.end_ms > weekStart) {
          w[wi].push(ev);
        }
      }
    }
    return w;
  });

  const currentMonth = () => props.monthAnchor.getMonth();

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Day name header */}
      <div class="grid shrink-0 border-b border-[color:var(--color-border)] text-xs"
           style={{ "grid-template-columns": "repeat(7, minmax(0, 1fr))" }}>
        <For each={DAY_NAMES}>
          {(name) => (
            <div class="border-l border-[color:var(--color-border)] px-2 py-1 text-center text-[color:var(--color-muted)] first:border-l-0">
              {name}
            </div>
          )}
        </For>
      </div>
      {/* 6 stacked week rows. Each row is itself a 7-column grid. */}
      <div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <For each={Array.from({ length: 6 }, (_, i) => i)}>
          {(wi) => (
            <div class="min-h-0 flex-1">
              <MonthWeekRow
                days={days().slice(wi * 7, wi * 7 + 7)}
                events={weeks()[wi]}
                weekStartMs={props.startMs + wi * 7 * ONE_DAY_MS}
                currentMonth={currentMonth()}
                onSelectEvent={props.onSelectEvent}
                onJumpToDay={props.onJumpToDay}
                eventStyle={props.eventStyle}
              />
            </div>
          )}
        </For>
      </div>
    </div>
  );
}

function MonthWeekRow(props: {
  days: Date[];
  events: EventRow[];
  weekStartMs: number;
  currentMonth: number;
  onSelectEvent: (ev: EventRow) => void;
  onJumpToDay: (d: Date) => void;
  eventStyle: (ev: EventRow) => EventStyle;
}) {
  const layout = createMemo(() =>
    layoutSpanning(props.events, props.weekStartMs, 7),
  );
  const MAX_VISIBLE_LANES = 3;
  // Row layout: header (date numbers) + N event lanes + filler row that
  // stretches the cells to fill the available week height. Hidden lanes
  // (events that didn't fit) get a "+N more" line at the bottom of each cell.
  const ROW_HEADER = "22px";
  const ROW_LANE = "20px";

  // Per-day count of events that couldn't fit in the visible lanes.
  const dayOverflow = createMemo(() => {
    const out = [0, 0, 0, 0, 0, 0, 0];
    for (const p of layout().placements) {
      if (p.lane < MAX_VISIBLE_LANES) continue;
      for (let di = p.startCol; di <= p.endCol; di++) {
        if (di >= 0 && di < 7) out[di] += 1;
      }
    }
    return out;
  });

  return (
    <div
      class="grid h-full border-b border-[color:var(--color-border)]"
      style={{
        "grid-template-columns": "repeat(7, minmax(0, 1fr))",
        "grid-template-rows": `${ROW_HEADER} repeat(${MAX_VISIBLE_LANES}, ${ROW_LANE}) auto 1fr`,
        contain: "layout style paint",
      }}
    >
      {/* Cell backgrounds (1 per day, span all rows) — provide borders +
          click-to-jump + dim style for out-of-month days. */}
      <For each={props.days}>
        {(d, di) => {
          const today = sameDay(d, new Date());
          const inMonth = d.getMonth() === props.currentMonth;
          return (
            <button
              type="button"
              onClick={() => props.onJumpToDay(d)}
              class={`flex flex-col items-start border-l border-[color:var(--color-border)] px-1.5 py-1 text-left text-xs first:border-l-0 hover:bg-[color:var(--color-surface-hover)] ${
                inMonth ? "" : "bg-[color:var(--color-bg)] opacity-60"
              }`}
              style={{
                "grid-column": di() + 1,
                "grid-row": "1 / -1",
              }}
            >
              <span
                class={
                  today
                    ? "rounded-full bg-[color:var(--color-accent)] px-1.5 font-semibold text-white"
                    : "px-0.5 font-medium text-[color:var(--color-fg)]"
                }
              >
                {d.getDate()}
              </span>
            </button>
          );
        }}
      </For>
      {/* Event bars placed in grid lanes (rows 2..MAX_VISIBLE_LANES+1). */}
      <For each={layout().placements}>
        {(p) => {
          if (p.lane >= MAX_VISIBLE_LANES) return null;
          const s = props.eventStyle(p.ev);
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onSelectEvent(p.ev);
              }}
              title={p.ev.summary}
              class="z-10 mx-0.5 self-center overflow-hidden truncate rounded px-1.5 text-left text-xs leading-tight"
              style={{
                "grid-column": `${p.startCol + 1} / span ${p.endCol - p.startCol + 1}`,
                "grid-row": `${p.lane + 2}`,
                height: "18px",
                "background-color": s.bg,
                color: s.fg,
              }}
            >
              {p.ev.summary || "(no title)"}
            </button>
          );
        }}
      </For>
      {/* "+N more" per day in the row right below the last event lane. */}
      <For each={Array.from({ length: 7 }, (_, di) => di)}>
        {(di) => {
          const n = dayOverflow()[di];
          if (n === 0) return null;
          return (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                props.onJumpToDay(props.days[di]);
              }}
              class="z-10 mx-0.5 self-start px-1 text-left text-[10px] text-[color:var(--color-muted)] hover:text-[color:var(--color-fg)] hover:underline"
              style={{
                "grid-column": di + 1,
                "grid-row": `${MAX_VISIBLE_LANES + 2}`,
              }}
            >
              +{n} more
            </button>
          );
        }}
      </For>
    </div>
  );
}

export type EventDraft = {
  // If both account_email + calendar_id + event_id are set, this is an edit.
  // Otherwise it's a new event (calendar_id+account picked from form).
  account_email?: string;
  calendar_id?: string;
  event_id?: string;
  summary: string;
  description: string;
  location: string;
  start_ms: number;
  end_ms: number;
  all_day: boolean;
  attendees: string; // comma separated
};

const pad2 = (n: number) => String(n).padStart(2, "0");

function localDateValue(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localTimeValue(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function parseLocalDate(s: string): number {
  const t = new Date(`${s}T00:00:00`).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function combineDateTime(dateStr: string, timeStr: string): number {
  const t = new Date(`${dateStr}T${timeStr}`).getTime();
  return Number.isFinite(t) ? t : Date.now();
}

function bumpMinutes(ms: number, minutes: number): number {
  return ms + minutes * 60_000;
}

function EventEditorModal(props: {
  draft: EventDraft;
  accounts: Account[];
  calendars: CalendarRow[];
  onClose: () => void;
  onSaved: () => void;
}) {
  useEscClose(() => true, () => props.onClose());
  const [summary, setSummary] = createSignal(props.draft.summary);
  const [description, setDescription] = createSignal(props.draft.description);
  const [location, setLocation] = createSignal(props.draft.location);
  const [allDay, setAllDay] = createSignal(props.draft.all_day);
  const [startMs, setStartMs] = createSignal(props.draft.start_ms);
  const [endMs, setEndMs] = createSignal(props.draft.end_ms);
  const [attendees, setAttendees] = createSignal(props.draft.attendees);
  const isEdit = !!props.draft.event_id;

  // Initial account/calendar selection — derive from draft or default to the
  // first account's primary calendar.
  const defaultAccount = () =>
    props.draft.account_email ?? props.accounts[0]?.email ?? "";
  const defaultCalendar = () => {
    const cals = props.calendars.filter(
      (c) => c.account_email === accountEmail(),
    );
    if (props.draft.calendar_id) return props.draft.calendar_id;
    const primary = cals.find((c) => c.is_primary);
    return primary?.id ?? cals[0]?.id ?? "primary";
  };
  const [accountEmail, setAccountEmail] = createSignal(defaultAccount());
  const [calendarId, setCalendarId] = createSignal(props.draft.calendar_id ?? "");
  // Reset calendar selection when account changes.
  createEffect(() => {
    const cals = props.calendars.filter(
      (c) => c.account_email === accountEmail(),
    );
    if (!cals.some((c) => c.id === calendarId())) {
      const primary = cals.find((c) => c.is_primary);
      setCalendarId(primary?.id ?? cals[0]?.id ?? "");
    }
  });
  // Initialize on mount
  if (!calendarId()) setCalendarId(defaultCalendar());

  const [saving, setSaving] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  async function save() {
    if (!summary().trim()) {
      setErr("Title is required");
      return;
    }
    if (!accountEmail() || !calendarId()) {
      setErr("Pick an account and calendar");
      return;
    }
    if (endMs() <= startMs()) {
      setErr("End must be after start");
      return;
    }
    setSaving(true);
    setErr(null);
    const attendeeList = attendees()
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const payload = {
      email: accountEmail(),
      calendarId: calendarId(),
      summary: summary(),
      description: description() || null,
      location: location() || null,
      startMs: startMs(),
      endMs: endMs(),
      allDay: allDay(),
      attendees: attendeeList,
    };
    try {
      if (isEdit) {
        await invoke("update_event", {
          request: { ...payload, eventId: props.draft.event_id },
        });
        showToast({ message: "Event updated" });
      } else {
        await invoke("create_event", { request: payload });
        showToast({ message: "Event created" });
      }
      props.onSaved();
      props.onClose();
    } catch (e) {
      setErr(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      class="fixed inset-0 z-[65] flex items-center justify-center bg-black/50 p-4"
      onClick={props.onClose}
    >
      <div
        class="flex max-h-[85vh] w-full max-w-xl flex-col rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-center justify-between border-b border-[color:var(--color-border)] px-5 py-3">
          <h2 class="text-base font-semibold">
            {isEdit ? "Edit event" : "New event"}
          </h2>
          <button
            type="button"
            onClick={props.onClose}
            class="rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
            aria-label="Close"
          >
            ×
          </button>
        </header>
        <div class="flex-1 space-y-3 overflow-y-auto px-5 py-4 text-sm">
          <Field label="Title">
            <input
              value={summary()}
              onInput={(e) => setSummary(e.currentTarget.value)}
              placeholder="Event title"
              class="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 outline-none focus:border-[color:var(--color-accent)]"
              autofocus
            />
          </Field>
          <label class="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={allDay()}
              onChange={(e) => setAllDay(e.currentTarget.checked)}
              class="accent-[color:var(--color-accent)]"
            />
            All day
          </label>
          <DateTimeRow
            label="Start"
            ms={startMs()}
            allDay={allDay()}
            onChange={(ms) => {
              const oldDuration = endMs() - startMs();
              setStartMs(ms);
              // Keep the duration constant when moving the start so the user
              // doesn't have to re-set end every time.
              setEndMs(ms + Math.max(15 * 60_000, oldDuration));
            }}
          />
          <DateTimeRow
            label="End"
            ms={endMs()}
            allDay={allDay()}
            onChange={setEndMs}
          />
          <Field label="Location">
            <input
              value={location()}
              onInput={(e) => setLocation(e.currentTarget.value)}
              class="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 outline-none focus:border-[color:var(--color-accent)]"
            />
          </Field>
          <Field label="Description">
            <textarea
              value={description()}
              onInput={(e) => setDescription(e.currentTarget.value)}
              rows={3}
              class="w-full resize-none rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 outline-none focus:border-[color:var(--color-accent)]"
            />
          </Field>
          <Field label="Attendees">
            <input
              value={attendees()}
              onInput={(e) => setAttendees(e.currentTarget.value)}
              placeholder="alice@example.com, bob@example.com"
              class="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 outline-none focus:border-[color:var(--color-accent)]"
            />
          </Field>
          <div class="grid grid-cols-2 gap-3">
            <Field label="Account">
              <select
                disabled={isEdit}
                value={accountEmail()}
                onChange={(e) => setAccountEmail(e.currentTarget.value)}
                class="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 outline-none disabled:opacity-50"
              >
                <For each={props.accounts}>
                  {(a) => <option value={a.email}>{a.email}</option>}
                </For>
              </select>
            </Field>
            <Field label="Calendar">
              <select
                disabled={isEdit}
                value={calendarId()}
                onChange={(e) => setCalendarId(e.currentTarget.value)}
                class="w-full rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 outline-none disabled:opacity-50"
              >
                <For
                  each={props.calendars.filter(
                    (c) => c.account_email === accountEmail(),
                  )}
                >
                  {(c) => <option value={c.id}>{c.summary}</option>}
                </For>
              </select>
            </Field>
          </div>
          <Show when={err()}>
            <div class="rounded border border-red-400 bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-200">
              {err()}
            </div>
          </Show>
        </div>
        <footer class="flex justify-end gap-2 border-t border-[color:var(--color-border)] px-5 py-3">
          <button
            type="button"
            onClick={props.onClose}
            class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={saving()}
            onClick={save}
            class="rounded bg-[color:var(--color-accent)] px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {saving() ? "Saving…" : isEdit ? "Save" : "Create"}
          </button>
        </footer>
      </div>
    </div>
  );
}

function Field(props: { label: string; children: any }) {
  return (
    <label class="block">
      <span class="mb-0.5 block text-xs font-medium text-[color:var(--color-muted)]">
        {props.label}
      </span>
      {props.children}
    </label>
  );
}

function DateTimeRow(props: {
  label: string;
  ms: number;
  allDay: boolean;
  onChange: (ms: number) => void;
}) {
  const inputCls =
    "rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] px-2 py-1 outline-none focus:border-[color:var(--color-accent)]";
  return (
    <div>
      <div class="mb-0.5 text-xs font-medium text-[color:var(--color-muted)]">
        {props.label}
      </div>
      <div class="flex items-center gap-1.5">
        <input
          type="date"
          value={localDateValue(props.ms)}
          onChange={(e) => {
            const t = props.allDay
              ? parseLocalDate(e.currentTarget.value)
              : combineDateTime(
                  e.currentTarget.value,
                  localTimeValue(props.ms),
                );
            props.onChange(t);
          }}
          class={`${inputCls} flex-1`}
        />
        <Show when={!props.allDay}>
          <input
            type="time"
            step="900"
            value={localTimeValue(props.ms)}
            onChange={(e) =>
              props.onChange(
                combineDateTime(
                  localDateValue(props.ms),
                  e.currentTarget.value,
                ),
              )
            }
            class={`${inputCls} w-24 tabular-nums`}
          />
          <button
            type="button"
            title="−15 min"
            onClick={() => props.onChange(bumpMinutes(props.ms, -15))}
            class="rounded border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
          >
            −15
          </button>
          <button
            type="button"
            title="+15 min"
            onClick={() => props.onChange(bumpMinutes(props.ms, 15))}
            class="rounded border border-[color:var(--color-border)] px-2 py-1 text-xs hover:bg-[color:var(--color-surface-hover)]"
          >
            +15
          </button>
        </Show>
      </div>
    </div>
  );
}

function CalendarPicker(props: {
  accounts: Account[];
  calendars: CalendarRow[];
  isVisible: (c: CalendarRow) => boolean;
  onToggle: (c: CalendarRow, visible: boolean) => void;
  onClose: () => void;
  eventStyle: (ev: EventRow) => EventStyle;
}) {
  useEscClose(() => true, () => props.onClose());
  const grouped = createMemo(() => {
    const byEmail = new Map<string, CalendarRow[]>();
    for (const c of props.calendars) {
      if (!byEmail.has(c.account_email)) byEmail.set(c.account_email, []);
      byEmail.get(c.account_email)!.push(c);
    }
    // Preserve account order from props.accounts.
    return props.accounts
      .map((a) => ({ email: a.email, cals: byEmail.get(a.email) ?? [] }))
      .filter((g) => g.cals.length > 0);
  });
  return (
    <>
      {/* invisible backdrop to close on outside click */}
      <div
        class="fixed inset-0 z-[55]"
        onClick={props.onClose}
      />
      <div
        class="absolute right-0 top-full z-[56] mt-1 max-h-[60vh] w-80 overflow-y-auto rounded border border-[color:var(--color-border)] bg-[color:var(--color-surface)] py-2 text-xs shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <For each={grouped()}>
          {(g) => (
            <section class="border-b border-[color:var(--color-border)] last:border-b-0">
              <header class="px-3 py-1 text-[10px] font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                {g.email}
              </header>
              <For each={g.cals}>
                {(c) => {
                  const visible = () => props.isVisible(c);
                  // Fake an EventRow to reuse eventStyle helper for the chip.
                  const fakeEv = {
                    account_email: c.account_email,
                    calendar_id: c.id,
                  } as EventRow;
                  return (
                    <label class="flex cursor-pointer items-center gap-2 px-3 py-1 hover:bg-[color:var(--color-surface-hover)]">
                      <input
                        type="checkbox"
                        checked={visible()}
                        onChange={(e) =>
                          props.onToggle(c, e.currentTarget.checked)
                        }
                        class="accent-[color:var(--color-accent)]"
                      />
                      <span
                        class="inline-block size-3 shrink-0 rounded"
                        style={{
                          "background-color": props.eventStyle(fakeEv).bg,
                        }}
                      />
                      <span class="flex-1 truncate" title={c.summary}>
                        {c.summary}
                      </span>
                      <Show when={c.is_primary}>
                        <span class="text-[10px] text-[color:var(--color-muted)]">
                          primary
                        </span>
                      </Show>
                    </label>
                  );
                }}
              </For>
            </section>
          )}
        </For>
        <Show when={grouped().length === 0}>
          <div class="px-3 py-4 text-center text-[color:var(--color-muted)]">
            No calendars synced yet — click ↻ to fetch.
          </div>
        </Show>
      </div>
    </>
  );
}

function EventDetailModal(props: {
  event: EventRow;
  calendarName: string | undefined;
  eventStyle: EventStyle;
  onClose: () => void;
  onChanged: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  useEscClose(() => true, () => props.onClose());
  const e = props.event;
  const dt = (ms: number, all_day: boolean) => {
    const d = new Date(ms);
    return all_day
      ? d.toLocaleDateString(undefined, {
          weekday: "long",
          month: "long",
          day: "numeric",
          year: "numeric",
        })
      : d.toLocaleString(undefined, {
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        });
  };
  const attendees = (() => {
    try {
      return JSON.parse(e.attendees_json) as Array<{
        email: string;
        displayName?: string;
        responseStatus?: string;
        self?: boolean;
      }>;
    } catch {
      return [];
    }
  })();
  const isOrganizer =
    !!e.organizer_email &&
    e.organizer_email.toLowerCase() === e.account_email.toLowerCase();
  const isAttendee = attendees.some(
    (a) =>
      a.self === true ||
      a.email.toLowerCase() === e.account_email.toLowerCase(),
  );
  // No point in RSVP-ing to your own meeting or to an event with no attendees
  // (a personal event you created on your own calendar).
  const showRsvp = !isOrganizer && isAttendee;
  const [responding, setResponding] = createSignal(false);
  async function rsvp(status: string) {
    setResponding(true);
    try {
      await invoke("respond_to_event", {
        email: e.account_email,
        calendarId: e.calendar_id,
        eventId: e.id,
        status,
      });
      showToast({ message: `Responded: ${status}` });
      props.onChanged();
      props.onClose();
    } catch (err) {
      showToast({ message: `RSVP failed: ${err}`, variant: "error" });
    } finally {
      setResponding(false);
    }
  }
  return (
    <div
      class="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
      onClick={props.onClose}
    >
      <div
        class="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-lg border border-[color:var(--color-border)] bg-[color:var(--color-surface)] shadow-2xl"
        onClick={(ev) => ev.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <header class="flex items-start justify-between gap-4 border-b border-[color:var(--color-border)] px-6 py-4">
          <div class="min-w-0">
            <h2 class="text-xl font-semibold leading-snug">
              {e.summary || "(no title)"}
            </h2>
            <div class="mt-1 text-sm text-[color:var(--color-muted)]">
              {dt(e.start_ms, e.all_day)} – {dt(e.end_ms, e.all_day)}
            </div>
            <div class="mt-0.5 flex items-center gap-1.5 text-xs text-[color:var(--color-muted)]">
              <span
                class="inline-block size-2.5 rounded-full"
                style={{ "background-color": props.eventStyle.bg }}
              />
              <Show when={props.calendarName}>
                <span>{props.calendarName}</span>
                <span>·</span>
              </Show>
              <span>{e.account_email}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={props.onClose}
            class="shrink-0 rounded p-1 text-[color:var(--color-muted)] hover:bg-[color:var(--color-surface-hover)]"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div class="flex-1 space-y-4 overflow-y-auto px-6 py-4 text-sm">
          <Show when={e.location}>
            <div class="flex gap-2">
              <span class="shrink-0 text-[color:var(--color-muted)]">📍</span>
              <span>{e.location}</span>
            </div>
          </Show>
          <Show when={e.conference_uri}>
            {(uri) => (
              <div class="flex gap-2">
                <span class="shrink-0 text-[color:var(--color-muted)]">🎥</span>
                <button
                  type="button"
                  onClick={() => {
                    void openUrl(uri()).catch((err) =>
                      showToast({
                        message: `Open failed: ${err}`,
                        variant: "error",
                      }),
                    );
                  }}
                  class="text-left text-[color:var(--color-accent)] hover:underline"
                >
                  Join video call
                </button>
              </div>
            )}
          </Show>
          <Show when={e.organizer_email}>
            <div class="flex gap-2">
              <span class="shrink-0 text-[color:var(--color-muted)]">👤</span>
              <span>
                <span class="font-medium">
                  {e.organizer_name || e.organizer_email}
                </span>
                <Show when={e.organizer_name}>
                  <span class="ml-1 text-[color:var(--color-muted)]">
                    &lt;{e.organizer_email}&gt;
                  </span>
                </Show>
              </span>
            </div>
          </Show>
          <Show when={e.description}>
            <div class="whitespace-pre-wrap rounded border border-[color:var(--color-border)] bg-[color:var(--color-bg)] p-3 text-[color:var(--color-fg)]">
              {e.description}
            </div>
          </Show>
          <Show when={attendees.length > 0}>
            <div>
              <div class="mb-1 text-xs font-semibold uppercase tracking-wide text-[color:var(--color-muted)]">
                Attendees ({attendees.length})
              </div>
              <ul class="max-h-48 space-y-0.5 overflow-auto">
                <For each={attendees}>
                  {(a) => (
                    <li class="flex justify-between gap-3">
                      <span class="truncate">{a.displayName || a.email}</span>
                      <span class="shrink-0 text-[color:var(--color-muted)]">
                        {a.responseStatus ?? ""}
                      </span>
                    </li>
                  )}
                </For>
              </ul>
            </div>
          </Show>
        </div>

        <footer class="flex flex-wrap items-center gap-2 border-t border-[color:var(--color-border)] px-6 py-3">
          <Show when={showRsvp}>
            <button
              type="button"
              disabled={responding()}
              onClick={() => rsvp("accepted")}
              class="rounded bg-[color:var(--color-accent)] px-3 py-1.5 text-sm text-white hover:opacity-90 disabled:opacity-50"
            >
              Accept
            </button>
            <button
              type="button"
              disabled={responding()}
              onClick={() => rsvp("tentative")}
              class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
            >
              Maybe
            </button>
            <button
              type="button"
              disabled={responding()}
              onClick={() => rsvp("declined")}
              class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)] disabled:opacity-50"
            >
              Decline
            </button>
          </Show>
          <button
            type="button"
            onClick={props.onEdit}
            class="rounded border border-[color:var(--color-border)] px-3 py-1.5 text-sm hover:bg-[color:var(--color-surface-hover)]"
          >
            Edit
          </button>
          <button
            type="button"
            onClick={props.onDelete}
            class="rounded border border-red-400 px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-950"
          >
            Delete
          </button>
          <Show when={e.html_link}>
            {(href) => (
              <button
                type="button"
                onClick={() => {
                  void openUrl(href()).catch((err) =>
                    showToast({
                      message: `Open failed: ${err}`,
                      variant: "error",
                    }),
                  );
                }}
                class="ml-auto text-xs text-[color:var(--color-muted)] hover:underline"
              >
                Open in Google Calendar
              </button>
            )}
          </Show>
        </footer>
      </div>
    </div>
  );
}

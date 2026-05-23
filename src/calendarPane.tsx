import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onMount,
} from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { colorForEmail } from "./utils";
import { showToast } from "./toast";
import { settings, updateSettings } from "./settings";

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
const HOUR_PX_STORAGE = "cenmail:calendar-hour-px";
const VIEW_STORAGE = "cenmail:calendar-view";

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

type EventStyle = { bg: string; fg: string };

// Pick black or white text depending on background luminance — Google Calendar
// returns pastel hex colours for some calendars and white text becomes
// unreadable on them.
function readableFg(bg: string): string {
  if (!bg.startsWith("#") || (bg.length !== 7 && bg.length !== 4)) {
    return "#ffffff";
  }
  let r: number, g: number, b: number;
  if (bg.length === 7) {
    r = parseInt(bg.slice(1, 3), 16);
    g = parseInt(bg.slice(3, 5), 16);
    b = parseInt(bg.slice(5, 7), 16);
  } else {
    r = parseInt(bg[1] + bg[1], 16);
    g = parseInt(bg[2] + bg[2], 16);
    b = parseInt(bg[3] + bg[3], 16);
  }
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return lum > 0.6 ? "#111111" : "#ffffff";
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

type Placement = {
  ev: EventRow;
  startCol: number;
  endCol: number;
  lane: number;
};

// Cluster events that transitively overlap in time, then assign each event to
// a sub-column within its cluster so they render side-by-side instead of on
// top of each other. Also computes `span` — how many columns the event can
// stretch into to the right without colliding with a neighbour, so that
// non-overlapping events expand to fill empty space (Google Calendar
// behaviour).
type TimedLayout = { col: number; totalCols: number; span: number };

// Globally unique per-row key (the events table's PK). The Map can't collide
// on raw ev.id because the same logical event can live in two calendars at
// once (e.g. primary + shared) and end up with the same `id` but different
// `calendar_id`.
function evKey(e: { account_email: string; calendar_id: string; id: string }): string {
  return `${e.account_email}|${e.calendar_id}|${e.id}`;
}

function layoutOverlappingDay(events: EventRow[]): Map<string, TimedLayout> {
  const sorted = [...events].sort(
    (a, b) =>
      a.start_ms - b.start_ms || b.end_ms - b.start_ms - (a.end_ms - a.start_ms),
  );
  const groups: EventRow[][] = [];
  for (const ev of sorted) {
    const matchIdx: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      if (
        groups[i].some(
          (e) => e.end_ms > ev.start_ms && e.start_ms < ev.end_ms,
        )
      ) {
        matchIdx.push(i);
      }
    }
    if (matchIdx.length === 0) {
      groups.push([ev]);
    } else {
      const merged: EventRow[] = [ev];
      for (const i of matchIdx) merged.push(...groups[i]);
      for (let i = matchIdx.length - 1; i >= 0; i--) groups.splice(matchIdx[i], 1);
      groups.push(merged);
    }
  }
  const out = new Map<string, TimedLayout>();
  for (const g of groups) {
    const colEnds: number[] = [];
    type Placement = { ev: EventRow; col: number };
    const placements: Placement[] = [];
    const gsorted = [...g].sort((a, b) => a.start_ms - b.start_ms);
    for (const ev of gsorted) {
      let col = 0;
      while (col < colEnds.length && colEnds[col] > ev.start_ms) col++;
      colEnds[col] = ev.end_ms;
      placements.push({ ev, col });
    }
    const totalCols = colEnds.length;
    for (const p of placements) {
      let span = 1;
      for (let testCol = p.col + 1; testCol < totalCols; testCol++) {
        const conflict = placements.some((q) => {
          // Exclude the placement itself (not just same-id, which would also
          // skip a sibling copy on another calendar).
          if (q === p) return false;
          if (q.col !== testCol) return false;
          return (
            q.ev.start_ms < p.ev.end_ms && q.ev.end_ms > p.ev.start_ms
          );
        });
        if (conflict) break;
        span++;
      }
      out.set(evKey(p.ev), { col: p.col, totalCols, span });
    }
  }
  return out;
}

// Greedy lane assignment for events that span 1+ day columns.
function layoutSpanning(
  events: EventRow[],
  firstDayMs: number,
  dayCount: number,
): { placements: Placement[]; laneCount: number } {
  const sorted = [...events].sort((a, b) => {
    if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
    return b.end_ms - b.start_ms - (a.end_ms - a.start_ms);
  });
  const lanes: number[] = []; // last endCol per lane
  const placements: Placement[] = [];
  for (const ev of sorted) {
    const rawStart = Math.floor((ev.start_ms - firstDayMs) / ONE_DAY_MS);
    const rawEnd = Math.floor((ev.end_ms - firstDayMs) / ONE_DAY_MS);
    const startCol = Math.max(0, rawStart);
    const endCol = Math.min(dayCount - 1, rawEnd);
    if (endCol < 0 || startCol >= dayCount) continue;
    let lane = 0;
    while (lane < lanes.length && lanes[lane] >= startCol) lane++;
    if (lane === lanes.length) lanes.push(endCol);
    else lanes[lane] = endCol;
    placements.push({ ev, startCol, endCol, lane });
  }
  return { placements, laneCount: lanes.length };
}

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
  eventStyle: (ev: EventRow) => EventStyle;
}) {
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
                class="relative flex-1 border-l border-[color:var(--color-border)]"
                style={{
                  height: `${props.hourPx * 24}px`,
                  "background-image": `repeating-linear-gradient(to bottom, transparent 0, transparent ${props.hourPx - 1}px, var(--color-border) ${props.hourPx - 1}px, var(--color-border) ${props.hourPx}px)`,
                  contain: "layout style paint",
                }}
              >
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
                        class={`absolute flex flex-col items-start justify-start overflow-hidden rounded px-1.5 py-0.5 text-left text-xs leading-tight shadow-sm ${
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

function CalendarPicker(props: {
  accounts: Account[];
  calendars: CalendarRow[];
  isVisible: (c: CalendarRow) => boolean;
  onToggle: (c: CalendarRow, visible: boolean) => void;
  onClose: () => void;
  eventStyle: (ev: EventRow) => EventStyle;
}) {
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
}) {
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

/// Pure layout primitives for the calendar grid views. Kept separate
/// from CalendarPane so they can be unit-tested without a DOM.

export type EventLike = {
  account_email: string;
  calendar_id: string;
  id: string;
  start_ms: number;
  end_ms: number;
};

export type TimedLayout = {
  /// Sub-column index inside the day column.
  col: number;
  /// Total sub-columns used by this event's overlap cluster.
  totalCols: number;
  /// How many adjacent empty sub-columns this event expands into to
  /// the right (Google-Calendar-style smart packing).
  span: number;
};

export type Placement<T extends EventLike> = {
  ev: T;
  startCol: number;
  endCol: number;
  lane: number;
};

export type EventStyle = { bg: string; fg: string };

const ONE_DAY_MS = 86_400_000;

/// Globally unique per-row key. The Map can't collide on raw ev.id
/// because the same logical event can live in two calendars at once
/// (e.g. primary + shared) and end up with the same id but different
/// calendar_id.
export function evKey(e: EventLike): string {
  return `${e.account_email}|${e.calendar_id}|${e.id}`;
}

/// Pick black or white text depending on background luminance —
/// Google Calendar returns pastel hex colours for some calendars and
/// white text becomes unreadable on them.
export function readableFg(bg: string): string {
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

/// Cluster events that transitively overlap in time, then assign each
/// event a sub-column within its cluster so they render side-by-side.
/// Also computes `span` — how many empty neighbour columns the event
/// can expand into to the right without colliding.
export function layoutOverlappingDay<T extends EventLike>(
  events: T[],
): Map<string, TimedLayout> {
  const sorted = [...events].sort(
    (a, b) =>
      a.start_ms - b.start_ms ||
      b.end_ms - b.start_ms - (a.end_ms - a.start_ms),
  );
  const groups: T[][] = [];
  for (const ev of sorted) {
    const matchIdx: number[] = [];
    for (let i = 0; i < groups.length; i++) {
      if (groups[i].some((e) => e.end_ms > ev.start_ms && e.start_ms < ev.end_ms)) {
        matchIdx.push(i);
      }
    }
    if (matchIdx.length === 0) {
      groups.push([ev]);
    } else {
      const merged: T[] = [ev];
      for (const i of matchIdx) merged.push(...groups[i]);
      for (let i = matchIdx.length - 1; i >= 0; i--) groups.splice(matchIdx[i], 1);
      groups.push(merged);
    }
  }
  const out = new Map<string, TimedLayout>();
  for (const g of groups) {
    const colEnds: number[] = [];
    type LocalPlacement = { ev: T; col: number };
    const placements: LocalPlacement[] = [];
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
          if (q === p) return false;
          if (q.col !== testCol) return false;
          return q.ev.start_ms < p.ev.end_ms && q.ev.end_ms > p.ev.start_ms;
        });
        if (conflict) break;
        span++;
      }
      out.set(evKey(p.ev), { col: p.col, totalCols, span });
    }
  }
  return out;
}

/// Greedy lane assignment for events that span 1+ day columns. Used
/// by the all-day strip and the month view.
export function layoutSpanning<T extends EventLike>(
  events: T[],
  firstDayMs: number,
  dayCount: number,
): { placements: Placement<T>[]; laneCount: number } {
  const sorted = [...events].sort((a, b) => {
    if (a.start_ms !== b.start_ms) return a.start_ms - b.start_ms;
    return b.end_ms - b.start_ms - (a.end_ms - a.start_ms);
  });
  const lanes: number[] = []; // last endCol per lane
  const placements: Placement<T>[] = [];
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

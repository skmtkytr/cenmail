import { describe, expect, it } from "vitest";
import {
  evKey,
  layoutOverlappingDay,
  layoutSpanning,
  readableFg,
  type EventLike,
} from "./layout";

const day = 86_400_000;
const hour = 3_600_000;
const t0 = 1_700_000_000_000;

function ev(
  id: string,
  startOffsetHours: number,
  durationHours: number,
  account = "a@x",
  cal = "c1",
): EventLike {
  return {
    account_email: account,
    calendar_id: cal,
    id,
    start_ms: t0 + startOffsetHours * hour,
    end_ms: t0 + (startOffsetHours + durationHours) * hour,
  };
}

describe("evKey", () => {
  it("disambiguates by account + calendar + id", () => {
    const a = ev("x", 0, 1, "a@x", "c1");
    const b = ev("x", 0, 1, "a@x", "c2");
    const c = ev("x", 0, 1, "b@x", "c1");
    expect(evKey(a)).not.toBe(evKey(b));
    expect(evKey(a)).not.toBe(evKey(c));
  });
});

describe("readableFg", () => {
  it("picks black on light backgrounds", () => {
    expect(readableFg("#ffffff")).toBe("#111111");
    expect(readableFg("#fef08a")).toBe("#111111");
  });
  it("picks white on dark backgrounds", () => {
    expect(readableFg("#000000")).toBe("#ffffff");
    expect(readableFg("#1a73e8")).toBe("#ffffff");
  });
  it("defaults to white on invalid input", () => {
    expect(readableFg("rgb(0,0,0)")).toBe("#ffffff");
    expect(readableFg("")).toBe("#ffffff");
    expect(readableFg("#fff")).toBe("#111111");
  });
});

describe("layoutOverlappingDay", () => {
  it("returns empty for no events", () => {
    expect(layoutOverlappingDay([])).toEqual(new Map());
  });

  it("places non-overlapping events in column 0", () => {
    const a = ev("a", 9, 1);
    const b = ev("b", 11, 1);
    const m = layoutOverlappingDay([a, b]);
    expect(m.get(evKey(a))?.col).toBe(0);
    expect(m.get(evKey(b))?.col).toBe(0);
    // Single column = totalCols 1, full span.
    expect(m.get(evKey(a))?.totalCols).toBe(1);
    expect(m.get(evKey(a))?.span).toBe(1);
  });

  it("splits two overlapping events into adjacent sub-columns", () => {
    const a = ev("a", 9, 2);
    const b = ev("b", 10, 2);
    const m = layoutOverlappingDay([a, b]);
    const cols = new Set([m.get(evKey(a))!.col, m.get(evKey(b))!.col]);
    expect(cols).toEqual(new Set([0, 1]));
    expect(m.get(evKey(a))?.totalCols).toBe(2);
    expect(m.get(evKey(b))?.totalCols).toBe(2);
  });

  it("expands span when neighbour column is empty (Google-style packing)", () => {
    // a: 9-12, b: 10-11 (overlaps a), c: 11.5-12.5 (overlaps a only)
    // a wants col 0, b col 1, c col 1 (b ends at 11). After b ends a
    // could expand to col 1 — but our impl is per-event constant span.
    const a = ev("a", 9, 3);
    const b = ev("b", 10, 1);
    const c = ev("c", 11.5, 1);
    const m = layoutOverlappingDay([a, b, c]);
    expect(m.get(evKey(a))?.totalCols).toBe(2);
    // a sits in col 0; b and c chain together in col 1.
    expect(m.get(evKey(a))?.col).toBe(0);
  });
});

describe("layoutSpanning", () => {
  it("returns empty for no events", () => {
    const out = layoutSpanning([], t0, 7);
    expect(out.placements).toEqual([]);
    expect(out.laneCount).toBe(0);
  });

  it("places a single-day event on lane 0 in the right column", () => {
    const a = { ...ev("a", 0, 24), start_ms: t0, end_ms: t0 + day };
    const out = layoutSpanning([a], t0, 7);
    expect(out.placements[0]?.lane).toBe(0);
    expect(out.placements[0]?.startCol).toBe(0);
    expect(out.placements[0]?.endCol).toBe(1);
    expect(out.laneCount).toBe(1);
  });

  it("stacks overlapping multi-day events into separate lanes", () => {
    const a = { ...ev("a", 0, 0), start_ms: t0, end_ms: t0 + 3 * day };
    const b = { ...ev("b", 0, 0), start_ms: t0 + day, end_ms: t0 + 4 * day };
    const out = layoutSpanning([a, b], t0, 7);
    const lanes = out.placements.map((p) => p.lane).sort();
    expect(lanes).toEqual([0, 1]);
    expect(out.laneCount).toBe(2);
  });

  it("reuses a lane for non-overlapping events", () => {
    const a = { ...ev("a", 0, 0), start_ms: t0, end_ms: t0 + day };
    const b = { ...ev("b", 0, 0), start_ms: t0 + 2 * day, end_ms: t0 + 3 * day };
    const out = layoutSpanning([a, b], t0, 7);
    expect(out.laneCount).toBe(1);
  });

  it("clips events that extend past the visible window", () => {
    const a = { ...ev("a", 0, 0), start_ms: t0 - day, end_ms: t0 + 10 * day };
    const out = layoutSpanning([a], t0, 5);
    expect(out.placements[0]?.startCol).toBe(0);
    expect(out.placements[0]?.endCol).toBe(4);
  });

  it("drops events entirely outside the window", () => {
    const a = { ...ev("a", 0, 0), start_ms: t0 - 5 * day, end_ms: t0 - 3 * day };
    const out = layoutSpanning([a], t0, 7);
    expect(out.placements).toEqual([]);
    expect(out.laneCount).toBe(0);
  });
});

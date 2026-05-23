import { describe, expect, it } from "vitest";
import {
  cacheKey,
  classifyBucket,
  colorForEmail,
  extractEmailAddresses,
  formatRelativeDate,
  matchesFolder,
  parseFromHeader,
  prefixSubject,
} from "./utils";

describe("parseFromHeader", () => {
  it("parses name + angle-bracketed email", () => {
    expect(parseFromHeader('"Alice" <a@example.com>')).toEqual({
      name: "Alice",
      email: "a@example.com",
    });
  });

  it("uses email as name when no display name", () => {
    expect(parseFromHeader("<a@example.com>")).toEqual({
      name: "a@example.com",
      email: "a@example.com",
    });
  });

  it("returns bare email when no angle brackets", () => {
    expect(parseFromHeader("plain@example.com")).toEqual({
      name: "plain@example.com",
      email: "plain@example.com",
    });
  });
});

describe("extractEmailAddresses", () => {
  it("returns empty for empty input", () => {
    expect(extractEmailAddresses("")).toEqual([]);
  });

  it("extracts addresses from comma-separated list", () => {
    expect(
      extractEmailAddresses("a@example.com, Bob <b@example.com>, c@example.com"),
    ).toEqual(["a@example.com", "b@example.com", "c@example.com"]);
  });

  it("does not split on commas inside display name", () => {
    expect(
      extractEmailAddresses('"Last, First" <one@example.com>, two@example.com'),
    ).toEqual(["one@example.com", "two@example.com"]);
  });
});

describe("prefixSubject", () => {
  it("adds Re: when missing", () => {
    expect(prefixSubject("Re:", "Hello")).toBe("Re: Hello");
  });

  it("does not duplicate Re:", () => {
    expect(prefixSubject("Re:", "Re: Hello")).toBe("Re: Hello");
  });

  it("is case insensitive for the prefix check", () => {
    expect(prefixSubject("Re:", "re: hello")).toBe("re: hello");
  });

  it("adds Fwd: when missing", () => {
    expect(prefixSubject("Fwd:", "Hello")).toBe("Fwd: Hello");
  });
});

describe("cacheKey", () => {
  it("encodes the all-inboxes selection", () => {
    expect(cacheKey("all", "inbox", "")).toBe("inbox:all:");
  });

  it("encodes a specific account selection", () => {
    expect(cacheKey(3, "archive", "foo")).toBe("archive:acct:3:foo");
  });

  it("differs by folder", () => {
    expect(cacheKey("all", "inbox", "")).not.toBe(cacheKey("all", "sent", ""));
  });

  it("differs by query", () => {
    expect(cacheKey("all", "inbox", "a")).not.toBe(cacheKey("all", "inbox", "b"));
  });
});

describe("matchesFolder", () => {
  it("matches INBOX label for inbox folder", () => {
    expect(matchesFolder(["INBOX", "CATEGORY_PERSONAL"], "inbox")).toBe(true);
    expect(matchesFolder(["SENT"], "inbox")).toBe(false);
  });

  it("matches STARRED for pinned", () => {
    expect(matchesFolder(["STARRED", "INBOX"], "pinned")).toBe(true);
    expect(matchesFolder(["INBOX"], "pinned")).toBe(false);
  });

  it("returns true for archive only when no system label is present", () => {
    expect(matchesFolder(["CATEGORY_PERSONAL"], "archive")).toBe(true);
    expect(matchesFolder(["INBOX"], "archive")).toBe(false);
    expect(matchesFolder(["SENT"], "archive")).toBe(false);
    expect(matchesFolder(["TRASH"], "archive")).toBe(false);
    expect(matchesFolder(["DRAFT"], "archive")).toBe(false);
    expect(matchesFolder(["SPAM"], "archive")).toBe(false);
    expect(matchesFolder(["CHAT"], "archive")).toBe(false);
  });

  it("matches TRASH for trash folder only", () => {
    expect(matchesFolder(["TRASH"], "trash")).toBe(true);
    expect(matchesFolder(["INBOX"], "trash")).toBe(false);
  });

  it("matches DRAFT for drafts folder only", () => {
    expect(matchesFolder(["DRAFT"], "drafts")).toBe(true);
    expect(matchesFolder(["INBOX"], "drafts")).toBe(false);
  });

  it("returns true for unknown folder name", () => {
    expect(matchesFolder(["INBOX"], "anything-else")).toBe(true);
  });
});

describe("formatRelativeDate", () => {
  it("returns empty for zero", () => {
    expect(formatRelativeDate(0)).toBe("");
  });

  it("renders a time string when same day as now", () => {
    const now = new Date(2026, 4, 23, 18, 30);
    const out = formatRelativeDate(
      new Date(2026, 4, 23, 9, 5).getTime(),
      now,
    );
    // Locale-dependent, but should contain a colon for HH:MM.
    expect(out).toMatch(/:/);
    expect(out.length).toBeGreaterThan(0);
  });

  it("renders without year for same-year past date", () => {
    const now = new Date(2026, 4, 23, 18, 30);
    const out = formatRelativeDate(
      new Date(2026, 0, 15, 8, 0).getTime(),
      now,
    );
    expect(out).not.toMatch(/2026/);
  });

  it("includes year for past-year date", () => {
    const now = new Date(2026, 4, 23, 18, 30);
    const out = formatRelativeDate(
      new Date(2024, 0, 15, 8, 0).getTime(),
      now,
    );
    expect(out).toMatch(/2024/);
  });
});

describe("classifyBucket", () => {
  it("classifies CATEGORY_PROMOTIONS as newsletters", () => {
    expect(
      classifyBucket({
        from: "Brand <hello@brand.com>",
        label_ids: ["INBOX", "CATEGORY_PROMOTIONS"],
      }),
    ).toBe("newsletters");
  });

  it("classifies CATEGORY_SOCIAL as notifications", () => {
    expect(
      classifyBucket({
        from: "LinkedIn <noreply@linkedin.com>",
        label_ids: ["INBOX", "CATEGORY_SOCIAL"],
      }),
    ).toBe("notifications");
  });

  it("classifies no-reply senders as notifications", () => {
    expect(
      classifyBucket({
        from: "Stripe <no-reply@stripe.com>",
        label_ids: ["INBOX"],
      }),
    ).toBe("notifications");
  });

  it("classifies donotreply variants as notifications", () => {
    expect(
      classifyBucket({
        from: "<donotreply@bank.example>",
        label_ids: [],
      }),
    ).toBe("notifications");
  });

  it("classifies alerts@ as notifications", () => {
    expect(
      classifyBucket({
        from: "GitHub <alerts@github.com>",
        label_ids: ["INBOX"],
      }),
    ).toBe("notifications");
  });

  it("classifies newsletter@ as newsletter", () => {
    expect(
      classifyBucket({
        from: "Acme <newsletter@acme.com>",
        label_ids: ["INBOX"],
      }),
    ).toBe("newsletters");
  });

  it("classifies team@ as newsletter", () => {
    expect(
      classifyBucket({
        from: "Some Team <team@example.com>",
        label_ids: ["INBOX"],
      }),
    ).toBe("newsletters");
  });

  it("classifies a plain personal sender as personal", () => {
    expect(
      classifyBucket({
        from: "Alice Smith <alice.smith@example.com>",
        label_ids: ["INBOX", "CATEGORY_PERSONAL"],
      }),
    ).toBe("personal");
  });

  it("prefers CATEGORY_PROMOTIONS over noreply heuristic", () => {
    // Even though sender looks like a notification, Gmail says it's a promo.
    expect(
      classifyBucket({
        from: "<no-reply@store.com>",
        label_ids: ["CATEGORY_PROMOTIONS"],
      }),
    ).toBe("newsletters");
  });

  it("does not match 'info' inside a longer word", () => {
    // 'informationservices@' shouldn't match because we anchor on - / _.
    expect(
      classifyBucket({
        from: "<informationservices@example.com>",
        label_ids: [],
      }),
    ).toBe("personal");
  });

  it("matches xxx-news@ as newsletter", () => {
    expect(
      classifyBucket({
        from: "<infoworld-news@example.com>",
        label_ids: [],
      }),
    ).toBe("newsletters");
  });
});

describe("colorForEmail", () => {
  it("returns the same hue for the same email", () => {
    expect(colorForEmail("a@example.com")).toBe(colorForEmail("a@example.com"));
  });

  it("returns different hues for different emails (sanity)", () => {
    expect(colorForEmail("a@example.com")).not.toBe(
      colorForEmail("b@example.com"),
    );
  });

  it("returns an HSL string with hue in 0-359", () => {
    const out = colorForEmail("anything@example.com");
    const m = out.match(/^hsl\((\d+) /);
    expect(m).not.toBeNull();
    const hue = parseInt(m![1], 10);
    expect(hue).toBeGreaterThanOrEqual(0);
    expect(hue).toBeLessThanOrEqual(359);
  });
});

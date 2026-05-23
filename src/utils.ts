export type AccountSelection = "all" | number;

export function colorForEmail(email: string): string {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) >>> 0;
  }
  const hue = h % 360;
  return `hsl(${hue} 65% 55%)`;
}

export function formatRelativeDate(millis: number, now: Date = new Date()): string {
  if (!millis) return "";
  const d = new Date(millis);
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  const sameYear = d.getFullYear() === now.getFullYear();
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

export function parseFromHeader(from: string): { name: string; email: string } {
  const m = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || m[2], email: m[2] };
  return { name: from.trim(), email: from.trim() };
}

export function extractEmailAddresses(header: string): string[] {
  if (!header) return [];
  const parts: string[] = [];
  let cur = "";
  let inQuote = false;
  let inAngle = false;
  for (const c of header) {
    if (c === '"' && !inAngle) {
      inQuote = !inQuote;
      cur += c;
    } else if (c === "<" && !inQuote) {
      inAngle = true;
      cur += c;
    } else if (c === ">" && !inQuote) {
      inAngle = false;
      cur += c;
    } else if (c === "," && !inQuote && !inAngle) {
      parts.push(cur);
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.length > 0) parts.push(cur);
  return parts
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => {
      const m = s.match(/<([^>]+)>/);
      return m ? m[1].trim() : s;
    });
}

export function prefixSubject(prefix: "Re:" | "Fwd:", subject: string): string {
  const s = subject.trim();
  if (s.toLowerCase().startsWith(prefix.toLowerCase())) return s;
  return `${prefix} ${s}`;
}

export function cacheKey(
  sel: AccountSelection,
  folder: string,
  query: string,
): string {
  const acct = sel === "all" ? "all" : `acct:${sel}`;
  return `${folder}:${acct}:${query}`;
}

export function matchesFolder(labels: string[], folder: string): boolean {
  const has = (l: string) => labels.includes(l);
  switch (folder) {
    case "inbox":
      return has("INBOX");
    case "pinned":
      return has("STARRED");
    case "sent":
      return has("SENT");
    case "trash":
      return has("TRASH");
    case "spam":
      return has("SPAM");
    case "snoozed":
      // Snoozed-ness lives in a separate SQLite table, not in Gmail labels.
      // Treat label-only mutations as in-place so the cache stays consistent;
      // explicit (un)snooze actions trigger a reload separately.
      return true;
    case "archive":
      return (
        !has("INBOX") &&
        !has("SENT") &&
        !has("TRASH") &&
        !has("DRAFT") &&
        !has("SPAM") &&
        !has("CHAT")
      );
    default:
      return true;
  }
}

export type Bucket = "personal" | "newsletters" | "notifications";

const NOTIFICATION_LOCAL_PARTS = [
  "no-reply",
  "noreply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "do_not_reply",
  "notification",
  "notifications",
  "alert",
  "alerts",
  "mailer-daemon",
  "mailerdaemon",
  "postmaster",
  "bounce",
  "bounces",
  "automated",
];

const NEWSLETTER_LOCAL_PARTS = [
  "newsletter",
  "newsletters",
  "news",
  "digest",
  "updates",
  "marketing",
  "promo",
  "promotions",
  "info",
  "hello",
  "hi",
  "team",
  "community",
];

function localPart(email: string): string {
  const i = email.indexOf("@");
  return (i >= 0 ? email.slice(0, i) : email).toLowerCase();
}

function matchesLocalPart(local: string, candidates: string[]): boolean {
  for (const c of candidates) {
    if (local === c) return true;
    if (local.startsWith(`${c}-`) || local.startsWith(`${c}_`)) return true;
    if (local.endsWith(`-${c}`) || local.endsWith(`_${c}`)) return true;
  }
  return false;
}

export function classifyBucket(m: {
  from: string;
  label_ids: string[];
}): Bucket {
  const labels = new Set(m.label_ids);
  if (
    labels.has("CATEGORY_PROMOTIONS") ||
    labels.has("CATEGORY_UPDATES") ||
    labels.has("CATEGORY_FORUMS")
  ) {
    return "newsletters";
  }
  if (labels.has("CATEGORY_SOCIAL")) {
    return "notifications";
  }
  const email = parseFromHeader(m.from).email.toLowerCase();
  const local = localPart(email);
  if (matchesLocalPart(local, NOTIFICATION_LOCAL_PARTS)) return "notifications";
  if (matchesLocalPart(local, NEWSLETTER_LOCAL_PARTS)) return "newsletters";
  return "personal";
}

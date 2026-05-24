import type { ComposeState } from "./types";
import type { Settings } from "./settings";

/// Per-account signature configured in Settings → Compose. Returns "" when
/// the account has no signature set, which the rest of the compose path
/// treats as "no signature appended".
export function signatureFor(settings: Settings, email: string): string {
  return settings.compose.signatures[email] ?? "";
}

/// Suffix attached to a fresh compose body so the signature renders right
/// after the user's text. Replies/forwards skip this — the quoted history
/// would otherwise push the signature into an awkward spot.
export function bodyWithSignature(settings: Settings, account: string): string {
  const sig = signatureFor(settings, account);
  return sig ? `\n\n--\n${sig}` : "";
}

/// Strip the auto-appended signature suffix (if present) from a body so
/// callers can reason about "did the user actually type anything?". Only
/// strips when the body literally ends with the configured suffix —
/// partial overlap is left alone.
export function stripSignature(
  settings: Settings,
  account: string,
  body: string,
): string {
  const sig = signatureFor(settings, account);
  if (!sig) return body;
  const suffix = `\n\n--\n${sig}`;
  return body.endsWith(suffix) ? body.slice(0, -suffix.length) : body;
}

/// True when the compose is in the "fresh, user hasn't done anything"
/// state. Used to (a) skip the discard-confirm prompt and (b) suppress
/// autosave so a signature-only body doesn't land in Gmail Drafts.
export function isComposeEmpty(
  settings: Settings,
  c: ComposeState,
): boolean {
  const bodyWithoutSig = stripSignature(settings, c.from_account, c.body).trim();
  return (
    c.to.trim() === "" &&
    c.cc.trim() === "" &&
    c.bcc.trim() === "" &&
    c.subject.trim() === "" &&
    bodyWithoutSig === "" &&
    (c.attachments ?? []).length === 0 &&
    (c.html_body ?? "").trim() === ""
  );
}

/// Fingerprint of the fields that affect what gets uploaded to Gmail as
/// a draft. Used by the autosave effect to skip no-op saves (most
/// notably the immediate re-fire after we stamp draft_id back onto
/// state). draft_id and rich/show_cc_bcc UI flags are intentionally
/// omitted.
export function composeFingerprint(c: ComposeState): string {
  return JSON.stringify({
    a: c.from_account,
    t: c.to,
    c: c.cc,
    b: c.bcc,
    s: c.subject,
    bd: c.body,
    h: c.html_body ?? "",
    // No base64 bytes — same {filename,size,mime} sequence implies the
    // same upload payload.
    at: (c.attachments ?? []).map(
      (a) => `${a.filename}|${a.size}|${a.mime_type}`,
    ),
    r: c.in_reply_to ?? "",
    x: c.references ?? "",
  });
}

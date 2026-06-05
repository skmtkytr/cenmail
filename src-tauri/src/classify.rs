//! Heuristic Smart-Inbox bucket classifier.
//!
//! Shared by the CLI (`cli.rs`) and the backend notification pass so the two
//! never drift. Mirrors the frontend classifier in `src/utils.ts`; keep the
//! two in sync when the heuristics change.

use crate::gmail::messages::MessageMeta;

/// Local-parts that mark a sender as automated → `notifications`.
const NOTIFICATION_LOCAL_PARTS: [&str; 16] = [
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

/// Local-parts that mark a sender as bulk/marketing → `newsletters`.
const NEWSLETTER_LOCAL_PARTS: [&str; 13] = [
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

/// Classify a message into one of `personal` / `newsletters` / `notifications`.
///
/// Gmail CATEGORY_* labels win first (server-side intent), then the sender's
/// local-part is matched against the automated / bulk keyword tables.
pub fn classify_bucket(m: &MessageMeta) -> &'static str {
    let has = |l: &str| m.label_ids.iter().any(|x| x == l);
    if has("CATEGORY_PROMOTIONS") || has("CATEGORY_UPDATES") || has("CATEGORY_FORUMS") {
        return "newsletters";
    }
    if has("CATEGORY_SOCIAL") {
        return "notifications";
    }
    let local = sender_local_part(&m.from);
    if matches_local_part(&local, &NOTIFICATION_LOCAL_PARTS) {
        return "notifications";
    }
    if matches_local_part(&local, &NEWSLETTER_LOCAL_PARTS) {
        return "newsletters";
    }
    "personal"
}

/// Extract the lowercased local-part (before `@`) from a `From` header, peeling
/// a `Display Name <addr>` wrapper when present.
fn sender_local_part(from: &str) -> String {
    let from_lower = from.to_lowercase();
    from_lower
        .split('<')
        .last()
        .unwrap_or(&from_lower)
        .split('@')
        .next()
        .unwrap_or("")
        .trim_matches(|c: char| c == '"' || c.is_whitespace())
        .to_string()
}

/// True when `local` equals a keyword or carries it as a `-`/`_` delimited
/// prefix or suffix (e.g. `noreply-123`, `team_news`). Substring-only matches
/// are intentionally excluded to avoid false positives like `infosec`.
fn matches_local_part(local: &str, keywords: &[&str]) -> bool {
    keywords.iter().any(|k| {
        local == *k
            || local.starts_with(&format!("{k}-"))
            || local.starts_with(&format!("{k}_"))
            || local.ends_with(&format!("-{k}"))
            || local.ends_with(&format!("_{k}"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(from: &str, labels: &[&str]) -> MessageMeta {
        MessageMeta {
            id: "m1".into(),
            thread_id: None,
            from: from.into(),
            subject: "s".into(),
            snippet: "".into(),
            date_millis: 0,
            unread: true,
            label_ids: labels.iter().map(|s| s.to_string()).collect(),
            account_email: "me@example.com".into(),
        }
    }

    #[test]
    fn category_promotions_is_newsletters() {
        assert_eq!(
            classify_bucket(&meta("Shop <deals@shop.com>", &["CATEGORY_PROMOTIONS"])),
            "newsletters"
        );
    }

    #[test]
    fn category_social_is_notifications() {
        assert_eq!(
            classify_bucket(&meta("X <notify@x.com>", &["CATEGORY_SOCIAL"])),
            "notifications"
        );
    }

    #[test]
    fn noreply_sender_is_notifications() {
        assert_eq!(
            classify_bucket(&meta("Acme <no-reply@acme.com>", &[])),
            "notifications"
        );
        assert_eq!(
            classify_bucket(&meta("donotreply@acme.com", &[])),
            "notifications"
        );
    }

    #[test]
    fn newsletter_sender_is_newsletters() {
        assert_eq!(
            classify_bucket(&meta("Weekly <newsletter@blog.com>", &[])),
            "newsletters"
        );
        assert_eq!(
            classify_bucket(&meta("team-news@blog.com", &[])),
            "newsletters"
        );
    }

    #[test]
    fn plain_human_sender_is_personal() {
        assert_eq!(
            classify_bucket(&meta("Alice <alice@example.com>", &[])),
            "personal"
        );
    }

    #[test]
    fn substring_does_not_false_match() {
        // "infosec" contains "info" but must not be classified as newsletters.
        assert_eq!(
            classify_bucket(&meta("infosec@example.com", &[])),
            "personal"
        );
    }
}

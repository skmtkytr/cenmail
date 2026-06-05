//! Pure notification-selection logic, kept free of Tauri so it can be unit
//! tested. The orchestration (DB reads, high-water persistence, actually
//! showing the OS notification) lives in `lib.rs`.

use crate::classify::classify_bucket;
use crate::commands::RuntimePrefs;
use crate::gmail::messages::MessageMeta;

/// Result of evaluating a batch of candidate messages for one account.
pub struct NotifyOutcome {
    /// Messages that pass the user's notification gate, in input order.
    pub to_notify: Vec<MessageMeta>,
    /// The high-water mark to persist: the max `date_millis` seen across *all*
    /// candidates (gated-out ones included), so we never re-evaluate them.
    pub new_high_water: i64,
}

/// Decide which of `messages` (the unread inbox messages newer than
/// `last_notified_ms` for a single account) should raise a notification.
///
/// `new_high_water` advances past every candidate regardless of whether it was
/// notified, mirroring the old frontend behaviour where the seen-watermark
/// moved over the whole inbox snapshot.
pub fn select_notifications(
    prefs: &RuntimePrefs,
    messages: &[MessageMeta],
    last_notified_ms: i64,
) -> NotifyOutcome {
    let mut new_high_water = last_notified_ms;
    let mut to_notify = Vec::new();
    for m in messages {
        if m.date_millis > new_high_water {
            new_high_water = m.date_millis;
        }
        if m.date_millis <= last_notified_ms || !m.unread {
            continue;
        }
        let bucket = classify_bucket(m);
        if prefs.notifications.allows(&m.account_email, bucket) {
            to_notify.push(m.clone());
        }
    }
    NotifyOutcome {
        to_notify,
        new_high_water,
    }
}

/// A ready-to-show OS notification.
pub struct NotificationContent {
    pub title: String,
    pub body: String,
}

/// Coalesce a batch into a single notification: one message shows the sender +
/// subject, multiple collapse to a count. Returns `None` for an empty batch.
pub fn format_notification(messages: &[MessageMeta]) -> Option<NotificationContent> {
    match messages {
        [] => None,
        [m] => Some(NotificationContent {
            title: sender_display_name(&m.from),
            body: if m.subject.trim().is_empty() {
                "(no subject)".to_string()
            } else {
                m.subject.clone()
            },
        }),
        many => Some(NotificationContent {
            title: "cenmail".to_string(),
            body: format!("{} new messages", many.len()),
        }),
    }
}

/// Pull a human-friendly display name out of a `From` header, falling back to
/// the bare address. Mirrors `parseFromHeader` in `src/utils.ts` loosely.
fn sender_display_name(from: &str) -> String {
    let from = from.trim();
    if let Some(open) = from.find('<') {
        let name = from[..open].trim().trim_matches('"').trim();
        if !name.is_empty() {
            return name.to_string();
        }
        // "<addr>" form with no display name → use the address inside.
        let addr = from[open + 1..].trim_end_matches('>').trim();
        if !addr.is_empty() {
            return addr.to_string();
        }
    }
    from.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::commands::{NotificationPrefs, RuntimePrefs};
    use std::collections::HashMap;

    fn msg(id: &str, date: i64, from: &str, account: &str, labels: &[&str]) -> MessageMeta {
        MessageMeta {
            id: id.into(),
            thread_id: None,
            from: from.into(),
            subject: "Hi".into(),
            snippet: "".into(),
            date_millis: date,
            unread: true,
            label_ids: labels.iter().map(|s| s.to_string()).collect(),
            account_email: account.into(),
        }
    }

    fn prefs(enabled: bool, buckets: &[&str], per_account: &[(&str, bool)]) -> RuntimePrefs {
        RuntimePrefs {
            notifications: NotificationPrefs {
                enabled,
                buckets: buckets.iter().map(|s| s.to_string()).collect(),
                per_account: per_account
                    .iter()
                    .map(|(k, v)| (k.to_string(), *v))
                    .collect::<HashMap<_, _>>(),
            },
            close_to_tray: true,
        }
    }

    #[test]
    fn notifies_personal_and_advances_high_water() {
        let p = prefs(true, &["personal"], &[]);
        let msgs = [msg("a", 100, "Alice <alice@x.com>", "me@x.com", &[])];
        let out = select_notifications(&p, &msgs, 0);
        assert_eq!(out.to_notify.len(), 1);
        assert_eq!(out.new_high_water, 100);
    }

    #[test]
    fn skips_messages_at_or_below_last_notified() {
        let p = prefs(true, &["personal"], &[]);
        let msgs = [msg("a", 50, "Alice <alice@x.com>", "me@x.com", &[])];
        let out = select_notifications(&p, &msgs, 50);
        assert!(out.to_notify.is_empty());
        assert_eq!(out.new_high_water, 50);
    }

    #[test]
    fn bucket_not_enabled_is_filtered_but_advances_water() {
        // Default buckets only personal; a newsletter must not notify, but the
        // high-water still moves past it.
        let p = prefs(true, &["personal"], &[]);
        let msgs = [msg("a", 200, "News <newsletter@x.com>", "me@x.com", &[])];
        let out = select_notifications(&p, &msgs, 0);
        assert!(out.to_notify.is_empty());
        assert_eq!(out.new_high_water, 200);
    }

    #[test]
    fn per_account_false_suppresses() {
        let p = prefs(true, &["personal"], &[("muted@x.com", false)]);
        let msgs = [msg("a", 200, "Alice <alice@x.com>", "muted@x.com", &[])];
        let out = select_notifications(&p, &msgs, 0);
        assert!(out.to_notify.is_empty());
        assert_eq!(out.new_high_water, 200);
    }

    #[test]
    fn globally_disabled_suppresses_all() {
        let p = prefs(false, &["personal"], &[]);
        let msgs = [msg("a", 200, "Alice <alice@x.com>", "me@x.com", &[])];
        let out = select_notifications(&p, &msgs, 0);
        assert!(out.to_notify.is_empty());
        assert_eq!(out.new_high_water, 200);
    }

    #[test]
    fn format_single_uses_sender_and_subject() {
        let m = msg("a", 1, "Alice <alice@x.com>", "me@x.com", &[]);
        let c = format_notification(std::slice::from_ref(&m)).unwrap();
        assert_eq!(c.title, "Alice");
        assert_eq!(c.body, "Hi");
    }

    #[test]
    fn format_many_coalesces_to_count() {
        let msgs = [
            msg("a", 1, "Alice <a@x.com>", "me@x.com", &[]),
            msg("b", 2, "Bob <b@x.com>", "me@x.com", &[]),
        ];
        let c = format_notification(&msgs).unwrap();
        assert_eq!(c.title, "cenmail");
        assert_eq!(c.body, "2 new messages");
    }

    #[test]
    fn format_empty_is_none() {
        assert!(format_notification(&[]).is_none());
    }

    #[test]
    fn sender_display_name_fallbacks() {
        assert_eq!(sender_display_name("Alice <a@x.com>"), "Alice");
        assert_eq!(sender_display_name("<a@x.com>"), "a@x.com");
        assert_eq!(sender_display_name("plain@x.com"), "plain@x.com");
    }
}

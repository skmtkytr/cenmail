use anyhow::{Context, Result};
use base64::Engine;
use reqwest::Client;
use serde::{Deserialize, Serialize};

pub const BASE: &str = "https://gmail.googleapis.com/gmail/v1";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct MessagesListPage {
    messages: Option<Vec<MessageRef>>,
    next_page_token: Option<String>,
}

#[derive(Deserialize)]
struct MessageRef {
    id: String,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RawMessage {
    pub id: String,
    pub thread_id: Option<String>,
    pub snippet: Option<String>,
    pub label_ids: Option<Vec<String>>,
    pub internal_date: Option<String>,
    pub payload: Option<MessagePart>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessagePart {
    #[serde(default)]
    pub part_id: Option<String>,
    pub mime_type: Option<String>,
    #[serde(default)]
    pub filename: Option<String>,
    pub headers: Option<Vec<Header>>,
    pub body: Option<MessageBody>,
    pub parts: Option<Vec<MessagePart>>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct MessageBody {
    pub data: Option<String>,
    #[serde(default)]
    pub attachment_id: Option<String>,
    #[serde(default)]
    pub size: Option<i64>,
}

#[derive(Deserialize, Clone)]
pub struct Header {
    pub name: String,
    pub value: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct MessageMeta {
    pub id: String,
    pub thread_id: Option<String>,
    pub from: String,
    pub subject: String,
    pub snippet: String,
    pub date_millis: i64,
    pub unread: bool,
    pub label_ids: Vec<String>,
    pub account_email: String,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Attachment {
    /// Stable across a single message — used for debugging.
    pub part_id: String,
    /// Opaque handle Gmail wants in `users.messages.attachments.get`.
    pub attachment_id: String,
    pub filename: String,
    pub mime_type: String,
    pub size: i64,
    /// `Content-Id` header value (with surrounding `<>` stripped). Set when
    /// the part is referenced by a `cid:` URL in the HTML body.
    #[serde(default)]
    pub content_id: Option<String>,
    /// `true` when the part is referenced inline (CID) rather than dangling
    /// as a regular attachment. The UI uses this to skip CID-only parts from
    /// the attachment chip strip.
    #[serde(default)]
    pub inline: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct MessageDetail {
    pub id: String,
    pub thread_id: Option<String>,
    pub from: String,
    pub to: String,
    pub cc: String,
    pub subject: String,
    pub date: String,
    pub message_id_header: String,
    pub references: String,
    pub html_body: Option<String>,
    pub text_body: Option<String>,
    #[serde(default)]
    pub calendar_body: Option<String>,
    /// METHOD: line value from the ICS, if any (REQUEST / REPLY / CANCEL).
    #[serde(default)]
    pub calendar_method: Option<String>,
    /// UID: line value — useful to match against Google Calendar event ids.
    #[serde(default)]
    pub calendar_uid: Option<String>,
    #[serde(default)]
    pub attachments: Vec<Attachment>,
}

#[derive(Deserialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GmailProfile {
    #[serde(default)]
    pub email_address: Option<String>,
    /// Stringified u64; we parse on the caller side to keep this struct
    /// schema-faithful.
    #[serde(default)]
    pub history_id: Option<String>,
}

/// `users.getProfile` — primarily used to learn the current historyId so the
/// next sync can switch to history.list.
pub async fn fetch_profile(http: &Client, access_token: &str) -> Result<GmailProfile> {
    let url = format!("{BASE}/users/me/profile");
    Ok(http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("profile request")?
        .error_for_status()
        .context("profile status")?
        .json::<GmailProfile>()
        .await
        .context("parse profile")?)
}

#[derive(Deserialize, Debug, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessage {
    pub id: String,
    #[serde(default)]
    pub thread_id: Option<String>,
    #[serde(default)]
    pub label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessageAdded {
    pub message: HistoryMessage,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryMessageDeleted {
    pub message: HistoryMessage,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryLabelChange {
    pub message: HistoryMessage,
    #[serde(default)]
    pub label_ids: Option<Vec<String>>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct HistoryRecord {
    pub id: String,
    #[serde(default)]
    pub messages_added: Vec<HistoryMessageAdded>,
    #[serde(default)]
    pub messages_deleted: Vec<HistoryMessageDeleted>,
    #[serde(default)]
    pub labels_added: Vec<HistoryLabelChange>,
    #[serde(default)]
    pub labels_removed: Vec<HistoryLabelChange>,
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct HistoryPage {
    #[serde(default)]
    history: Vec<HistoryRecord>,
    #[serde(default)]
    next_page_token: Option<String>,
    #[serde(default)]
    history_id: Option<String>,
}

/// Outcome of `fetch_history`. `Synced` carries the new historyId watermark
/// plus all records to apply. `Expired` means the start id was too old
/// (Gmail typically keeps ~7 days) — caller must bootstrap from scratch.
#[derive(Debug)]
pub enum HistoryOutcome {
    Synced {
        latest_history_id: Option<u64>,
        records: Vec<HistoryRecord>,
    },
    Expired,
}

/// Fetch all history records since `start_history_id`. Pages through every
/// `pageToken` until the response stops returning one. Returns
/// `HistoryOutcome::Expired` if Gmail responds 404 / 410 (start id GC'd).
pub async fn fetch_history(
    http: &Client,
    access_token: &str,
    start_history_id: u64,
) -> Result<HistoryOutcome> {
    let mut records: Vec<HistoryRecord> = Vec::new();
    let mut page_token: Option<String> = None;
    let mut latest_id: Option<u64> = None;
    loop {
        let mut url = format!(
            "{BASE}/users/me/history?startHistoryId={start_history_id}&maxResults=500"
        );
        if let Some(t) = &page_token {
            url.push_str("&pageToken=");
            url.push_str(t);
        }
        let resp = http
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .context("history.list request")?;
        let status = resp.status();
        if status == reqwest::StatusCode::NOT_FOUND
            || status == reqwest::StatusCode::GONE
        {
            return Ok(HistoryOutcome::Expired);
        }
        let page: HistoryPage = resp
            .error_for_status()
            .context("history.list status")?
            .json()
            .await
            .context("parse history.list")?;
        if let Some(id) = page.history_id.as_deref().and_then(|s| s.parse().ok()) {
            latest_id = Some(id);
        }
        records.extend(page.history);
        match page.next_page_token {
            Some(t) if !t.is_empty() => page_token = Some(t),
            _ => break,
        }
    }
    Ok(HistoryOutcome::Synced {
        latest_history_id: latest_id,
        records,
    })
}

pub async fn list_message_ids(
    http: &Client,
    access_token: &str,
    query: Option<&str>,
) -> Result<Vec<String>> {
    let mut ids = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        // includeSpamTrash=true so the Spam folder stays in sync (without it
        // Gmail excludes SPAM and TRASH labels by default).
        let mut url =
            format!("{BASE}/users/me/messages?maxResults=500&includeSpamTrash=true");
        if let Some(q) = query {
            url.push_str("&q=");
            url.push_str(&urlencoding::encode(q));
        }
        if let Some(t) = &page_token {
            url.push_str("&pageToken=");
            url.push_str(t);
        }
        let page = http
            .get(&url)
            .bearer_auth(access_token)
            .send()
            .await
            .context("messages.list request")?
            .error_for_status()
            .context("messages.list status")?
            .json::<MessagesListPage>()
            .await
            .context("parse messages.list")?;
        if let Some(messages) = page.messages {
            ids.reserve(messages.len());
            for m in messages {
                ids.push(m.id);
            }
        }
        match page.next_page_token {
            Some(t) if !t.is_empty() => page_token = Some(t),
            _ => break,
        }
    }
    Ok(ids)
}

pub async fn modify_labels(
    http: &Client,
    access_token: &str,
    message_id: &str,
    add: &[&str],
    remove: &[&str],
) -> Result<Vec<String>> {
    let url = format!("{BASE}/users/me/messages/{message_id}/modify");
    let body = serde_json::json!({
        "addLabelIds": add,
        "removeLabelIds": remove,
    });
    let raw = http
        .post(&url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .context("modify request")?
        .error_for_status()
        .context("modify status")?
        .json::<RawMessage>()
        .await
        .context("parse modify response")?;
    Ok(raw.label_ids.unwrap_or_default())
}

pub async fn trash(
    http: &Client,
    access_token: &str,
    message_id: &str,
) -> Result<Vec<String>> {
    let url = format!("{BASE}/users/me/messages/{message_id}/trash");
    let raw = http
        .post(&url)
        .bearer_auth(access_token)
        .header("Content-Length", "0")
        .send()
        .await
        .context("trash request")?
        .error_for_status()
        .context("trash status")?
        .json::<RawMessage>()
        .await
        .context("parse trash response")?;
    Ok(raw.label_ids.unwrap_or_default())
}

pub async fn untrash(
    http: &Client,
    access_token: &str,
    message_id: &str,
) -> Result<Vec<String>> {
    let url = format!("{BASE}/users/me/messages/{message_id}/untrash");
    let raw = http
        .post(&url)
        .bearer_auth(access_token)
        .header("Content-Length", "0")
        .send()
        .await
        .context("untrash request")?
        .error_for_status()
        .context("untrash status")?
        .json::<RawMessage>()
        .await
        .context("parse untrash response")?;
    Ok(raw.label_ids.unwrap_or_default())
}

pub async fn fetch_metadata(
    http: &Client,
    access_token: &str,
    account_email: &str,
    message_id: &str,
) -> Result<MessageMeta> {
    let url = format!(
        "{BASE}/users/me/messages/{message_id}?format=metadata\
         &metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"
    );
    let raw = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await?
        .error_for_status()?
        .json::<RawMessage>()
        .await?;
    Ok(raw_to_meta(raw, account_email))
}

pub async fn fetch_full(
    http: &Client,
    access_token: &str,
    message_id: &str,
) -> Result<MessageDetail> {
    let url = format!("{BASE}/users/me/messages/{message_id}?format=full");
    let raw = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("messages.get request")?
        .error_for_status()
        .context("messages.get status")?
        .json::<RawMessage>()
        .await
        .context("parse messages.get")?;

    Ok(raw_to_detail(raw))
}

#[derive(Deserialize)]
struct ThreadResponse {
    messages: Option<Vec<RawMessage>>,
}

/// Fetch the entire thread in one request. Returns each message in delivery
/// order (Gmail returns them oldest-first, which is what the UI wants).
pub async fn fetch_thread_full(
    http: &Client,
    access_token: &str,
    thread_id: &str,
) -> Result<Vec<MessageDetail>> {
    let url = format!("{BASE}/users/me/threads/{thread_id}?format=full");
    let resp = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("threads.get request")?
        .error_for_status()
        .context("threads.get status")?
        .json::<ThreadResponse>()
        .await
        .context("parse threads.get")?;
    Ok(resp
        .messages
        .unwrap_or_default()
        .into_iter()
        .map(raw_to_detail)
        .collect())
}

fn raw_to_detail(raw: RawMessage) -> MessageDetail {
    let payload = raw.payload.clone();
    let header = |name: &str| -> String {
        payload
            .as_ref()
            .and_then(|p| p.headers.as_ref())
            .map(|hs| hs.as_slice())
            .unwrap_or(&[])
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.clone())
            .unwrap_or_default()
    };

    let html_body = payload.as_ref().and_then(|p| find_part(p, "text/html"));
    let text_body = payload.as_ref().and_then(|p| find_part(p, "text/plain"));
    let calendar_body = payload.as_ref().and_then(|p| find_part(p, "text/calendar"));
    let (calendar_method, calendar_uid) = match &calendar_body {
        Some(ics) => (extract_ics_line(ics, "METHOD"), extract_ics_line(ics, "UID")),
        None => (None, None),
    };
    let attachments = match payload.as_ref() {
        Some(p) => {
            let mut out = Vec::new();
            collect_attachments(p, &mut out);
            out
        }
        None => Vec::new(),
    };

    MessageDetail {
        id: raw.id,
        thread_id: raw.thread_id,
        from: header("From"),
        to: header("To"),
        cc: header("Cc"),
        subject: header("Subject"),
        date: header("Date"),
        message_id_header: header("Message-Id"),
        references: header("References"),
        html_body,
        text_body,
        calendar_body,
        calendar_method,
        calendar_uid,
        attachments,
    }
}

/// Recursively collect every part with an `attachmentId` (i.e. parts whose
/// bytes live behind the dedicated `users.messages.attachments.get` endpoint
/// rather than inline in the payload).
fn collect_attachments(part: &MessagePart, out: &mut Vec<Attachment>) {
    let body = part.body.as_ref();
    let attachment_id = body.and_then(|b| b.attachment_id.clone());
    if let Some(aid) = attachment_id {
        let headers = part.headers.as_deref().unwrap_or(&[]);
        let content_id = headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("Content-Id"))
            .map(|h| h.value.trim().trim_matches('<').trim_matches('>').to_string());
        let disposition = headers
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case("Content-Disposition"))
            .map(|h| h.value.to_ascii_lowercase());
        let inline = disposition
            .as_deref()
            .map(|d| d.starts_with("inline"))
            .unwrap_or(false)
            || content_id.is_some();
        out.push(Attachment {
            part_id: part.part_id.clone().unwrap_or_default(),
            attachment_id: aid,
            filename: part.filename.clone().unwrap_or_default(),
            mime_type: part.mime_type.clone().unwrap_or_default(),
            size: body.and_then(|b| b.size).unwrap_or(0),
            content_id,
            inline,
        });
    }
    if let Some(parts) = &part.parts {
        for sub in parts {
            collect_attachments(sub, out);
        }
    }
}

#[derive(Deserialize)]
struct AttachmentResponse {
    data: String,
    #[serde(default)]
    #[allow(dead_code)]
    size: Option<i64>,
}

/// Fetch raw bytes for an attachment. Returned as the standard base64 form
/// (no URL-safe alphabet, no padding stripped) so the frontend can hand it
/// straight to `atob`.
pub async fn fetch_attachment(
    http: &Client,
    access_token: &str,
    message_id: &str,
    attachment_id: &str,
) -> Result<String> {
    let url = format!(
        "{BASE}/users/me/messages/{message_id}/attachments/{attachment_id}"
    );
    let resp: AttachmentResponse = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("attachment request")?
        .error_for_status()
        .context("attachment status")?
        .json()
        .await
        .context("parse attachment")?;
    // Gmail returns URL-safe base64 without padding; normalise to standard
    // base64 with padding so the frontend can decode with `atob`.
    let mut padded = resp.data.replace('-', "+").replace('_', "/");
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    Ok(padded)
}

fn extract_ics_line(ics: &str, name: &str) -> Option<String> {
    let prefix_colon = format!("{name}:");
    let prefix_semi = format!("{name};");
    for raw_line in ics.lines() {
        let line = raw_line.trim_end_matches('\r');
        if line.starts_with(&prefix_colon) {
            return Some(line[prefix_colon.len()..].trim().to_string());
        }
        if line.starts_with(&prefix_semi) {
            // Skip params, just grab whatever's after the value separator.
            if let Some(idx) = line.find(':') {
                return Some(line[idx + 1..].trim().to_string());
            }
        }
    }
    None
}

pub fn raw_to_meta(raw: RawMessage, account_email: &str) -> MessageMeta {
    let header = |name: &str| -> String {
        raw.payload
            .as_ref()
            .and_then(|p| p.headers.as_ref())
            .map(|hs| hs.as_slice())
            .unwrap_or(&[])
            .iter()
            .find(|h| h.name.eq_ignore_ascii_case(name))
            .map(|h| h.value.clone())
            .unwrap_or_default()
    };
    let date_millis: i64 = raw
        .internal_date
        .as_deref()
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let label_ids = raw.label_ids.clone().unwrap_or_default();
    let unread = label_ids.iter().any(|l| l == "UNREAD");
    MessageMeta {
        id: raw.id,
        thread_id: raw.thread_id,
        from: header("From"),
        subject: header("Subject"),
        snippet: raw.snippet.unwrap_or_default(),
        date_millis,
        unread,
        label_ids,
        account_email: account_email.to_string(),
    }
}

fn find_part(part: &MessagePart, mime_type: &str) -> Option<String> {
    if part.mime_type.as_deref() == Some(mime_type) {
        if let Some(body) = &part.body {
            if let Some(data) = &body.data {
                return decode_body(data).ok();
            }
        }
    }
    if let Some(parts) = &part.parts {
        for sub in parts {
            if let Some(found) = find_part(sub, mime_type) {
                return Some(found);
            }
        }
    }
    None
}

fn decode_body(data: &str) -> Result<String> {
    let mut padded = data.replace('-', "+").replace('_', "/");
    while padded.len() % 4 != 0 {
        padded.push('=');
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&padded)
        .context("base64 decode")?;
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn b64url(input: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(input.as_bytes())
    }

    #[test]
    fn decode_body_handles_url_safe_no_padding() {
        let encoded = b64url("Hello, world");
        let decoded = decode_body(&encoded).unwrap();
        assert_eq!(decoded, "Hello, world");
    }

    #[test]
    fn decode_body_handles_padded_input() {
        // Standard base64 with padding still works through our normalisation.
        let encoded = base64::engine::general_purpose::URL_SAFE.encode("abc".as_bytes());
        let decoded = decode_body(&encoded).unwrap();
        assert_eq!(decoded, "abc");
    }

    #[test]
    fn decode_body_handles_utf8() {
        let encoded = b64url("日本語テスト");
        let decoded = decode_body(&encoded).unwrap();
        assert_eq!(decoded, "日本語テスト");
    }

    fn part(mime: &str, data: Option<&str>, children: Vec<MessagePart>) -> MessagePart {
        MessagePart {
            part_id: None,
            mime_type: Some(mime.into()),
            filename: None,
            headers: None,
            body: data.map(|d| MessageBody {
                data: Some(d.to_string()),
                attachment_id: None,
                size: None,
            }),
            parts: if children.is_empty() {
                None
            } else {
                Some(children)
            },
        }
    }

    #[test]
    fn find_part_picks_preferred_mime_recursively() {
        let html_body = b64url("<p>hi</p>");
        let plain_body = b64url("hi");
        let root = part(
            "multipart/alternative",
            None,
            vec![
                part("text/plain", Some(&plain_body), vec![]),
                part("text/html", Some(&html_body), vec![]),
            ],
        );
        assert_eq!(find_part(&root, "text/html").as_deref(), Some("<p>hi</p>"));
        assert_eq!(find_part(&root, "text/plain").as_deref(), Some("hi"));
        assert!(find_part(&root, "image/png").is_none());
    }

    #[test]
    fn raw_to_meta_extracts_headers_and_labels() {
        let raw = RawMessage {
            id: "m1".into(),
            thread_id: Some("t1".into()),
            snippet: Some("preview".into()),
            label_ids: Some(vec!["INBOX".into(), "UNREAD".into()]),
            internal_date: Some("1700000000000".into()),
            payload: Some(MessagePart {
                part_id: None,
                mime_type: None,
                filename: None,
                headers: Some(vec![
                    Header {
                        name: "From".into(),
                        value: "Alice <a@example.com>".into(),
                    },
                    Header {
                        name: "Subject".into(),
                        value: "hi".into(),
                    },
                ]),
                body: None,
                parts: None,
            }),
        };
        let meta = raw_to_meta(raw, "me@example.com");
        assert_eq!(meta.id, "m1");
        assert_eq!(meta.from, "Alice <a@example.com>");
        assert_eq!(meta.subject, "hi");
        assert_eq!(meta.snippet, "preview");
        assert_eq!(meta.date_millis, 1_700_000_000_000);
        assert!(meta.unread);
        assert_eq!(meta.account_email, "me@example.com");
        assert!(meta.label_ids.iter().any(|l| l == "INBOX"));
    }

    #[test]
    fn raw_to_meta_marks_read_when_no_unread_label() {
        let raw = RawMessage {
            id: "m1".into(),
            thread_id: None,
            snippet: None,
            label_ids: Some(vec!["INBOX".into()]),
            internal_date: None,
            payload: None,
        };
        let meta = raw_to_meta(raw, "me@example.com");
        assert!(!meta.unread);
        assert_eq!(meta.date_millis, 0);
    }
}

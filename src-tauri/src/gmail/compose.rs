use anyhow::{Context, Result};
use base64::Engine;
use reqwest::Client;
use serde::Deserialize;

use super::messages::BASE;

#[derive(Debug, Clone, Default)]
pub struct ComposeAttachment {
    pub filename: String,
    pub mime_type: String,
    /// Standard base64 (with padding). The frontend reads File objects and
    /// hands us the encoded bytes — we never see raw binary.
    pub data_b64: String,
}

#[derive(Debug, Clone, Default)]
pub struct Compose {
    pub from: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    /// Plain-text body. Always sent. Doubles as the text/plain fallback when
    /// html_body is present.
    pub body: String,
    /// Optional HTML body. When present we emit a multipart/alternative
    /// payload so mail clients pick whichever they support.
    pub html_body: Option<String>,
    pub attachments: Vec<ComposeAttachment>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

#[derive(Deserialize)]
struct SendResponse {
    id: String,
}

pub async fn send(http: &Client, access_token: &str, compose: &Compose) -> Result<String> {
    let raw_mime = build_raw_mime(compose);
    let encoded = base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(raw_mime.as_bytes());
    let url = format!("{BASE}/users/me/messages/send");
    let body = serde_json::json!({ "raw": encoded });
    let resp = http
        .post(&url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .context("send request")?
        .error_for_status()
        .context("send status")?
        .json::<SendResponse>()
        .await
        .context("parse send response")?;
    Ok(resp.id)
}

#[derive(Deserialize)]
struct DraftIdResponse {
    id: String,
}

fn encoded_raw(compose: &Compose) -> String {
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(build_raw_mime(compose).as_bytes())
}

/// Create a new Gmail draft from `compose`. Returns the draft id, which the
/// caller stores so subsequent autosaves go through `update_draft` rather
/// than spawning fresh drafts on every keystroke.
pub async fn create_draft(http: &Client, access_token: &str, compose: &Compose) -> Result<String> {
    let url = format!("{BASE}/users/me/drafts");
    let body = serde_json::json!({ "message": { "raw": encoded_raw(compose) } });
    let resp = http
        .post(&url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .context("drafts.create request")?
        .error_for_status()
        .context("drafts.create status")?
        .json::<DraftIdResponse>()
        .await
        .context("parse drafts.create")?;
    Ok(resp.id)
}

/// Overwrite the body of an existing Gmail draft. Returns its id (same value
/// passed in — kept symmetric with create_draft for ergonomics).
pub async fn update_draft(
    http: &Client,
    access_token: &str,
    draft_id: &str,
    compose: &Compose,
) -> Result<String> {
    let url = format!("{BASE}/users/me/drafts/{draft_id}");
    let body = serde_json::json!({
        "id": draft_id,
        "message": { "raw": encoded_raw(compose) }
    });
    let resp = http
        .put(&url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .context("drafts.update request")?
        .error_for_status()
        .context("drafts.update status")?
        .json::<DraftIdResponse>()
        .await
        .context("parse drafts.update")?;
    Ok(resp.id)
}

pub async fn delete_draft(
    http: &Client,
    access_token: &str,
    draft_id: &str,
) -> Result<()> {
    let url = format!("{BASE}/users/me/drafts/{draft_id}");
    http.delete(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("drafts.delete request")?
        .error_for_status()
        .context("drafts.delete status")?;
    Ok(())
}

/// Promote a draft to a sent message. Gmail removes the draft on success and
/// hands us back the resulting message id.
pub async fn send_draft(
    http: &Client,
    access_token: &str,
    draft_id: &str,
) -> Result<String> {
    let url = format!("{BASE}/users/me/drafts/send");
    let body = serde_json::json!({ "id": draft_id });
    let resp = http
        .post(&url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .context("drafts.send request")?
        .error_for_status()
        .context("drafts.send status")?
        .json::<SendResponse>()
        .await
        .context("parse drafts.send")?;
    Ok(resp.id)
}

pub fn build_raw_mime(c: &Compose) -> String {
    let mut out = String::new();
    let from_value = match &c.from_name {
        Some(name) if !name.is_empty() => format!(
            "{} <{}>",
            encode_phrase_if_needed(name),
            c.from
        ),
        _ => c.from.clone(),
    };
    out.push_str(&format!("From: {from_value}\r\n"));
    if !c.to.is_empty() {
        out.push_str(&format!("To: {}\r\n", c.to.join(", ")));
    }
    if !c.cc.is_empty() {
        out.push_str(&format!("Cc: {}\r\n", c.cc.join(", ")));
    }
    if !c.bcc.is_empty() {
        out.push_str(&format!("Bcc: {}\r\n", c.bcc.join(", ")));
    }
    out.push_str(&format!("Subject: {}\r\n", encode_header_value(&c.subject)));
    if let Some(reply_to) = &c.in_reply_to {
        out.push_str(&format!("In-Reply-To: {reply_to}\r\n"));
        let refs = c.references.as_deref().unwrap_or(reply_to.as_str());
        out.push_str(&format!("References: {refs}\r\n"));
    }
    out.push_str("MIME-Version: 1.0\r\n");

    let has_attachments = !c.attachments.is_empty();
    let has_html = c.html_body.as_ref().map(|s| !s.is_empty()).unwrap_or(false);

    if !has_attachments && !has_html {
        out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
        out.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
        out.push_str(&normalize_body(&c.body));
        return out;
    }

    let mixed_boundary = make_boundary("mix");
    let alt_boundary = make_boundary("alt");

    if has_attachments {
        out.push_str(&format!(
            "Content-Type: multipart/mixed; boundary=\"{mixed_boundary}\"\r\n\r\n"
        ));
        out.push_str(&format!("--{mixed_boundary}\r\n"));
    }

    if has_html {
        out.push_str(&format!(
            "Content-Type: multipart/alternative; boundary=\"{alt_boundary}\"\r\n\r\n"
        ));
        out.push_str(&format!("--{alt_boundary}\r\n"));
        out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
        out.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
        out.push_str(&normalize_body(&c.body));
        out.push_str(&format!("\r\n--{alt_boundary}\r\n"));
        out.push_str("Content-Type: text/html; charset=utf-8\r\n");
        out.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
        out.push_str(&normalize_body(c.html_body.as_deref().unwrap_or("")));
        out.push_str(&format!("\r\n--{alt_boundary}--\r\n"));
    } else {
        out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
        out.push_str("Content-Transfer-Encoding: 8bit\r\n\r\n");
        out.push_str(&normalize_body(&c.body));
        out.push_str("\r\n");
    }

    for a in &c.attachments {
        out.push_str(&format!("--{mixed_boundary}\r\n"));
        let mime = if a.mime_type.is_empty() {
            "application/octet-stream"
        } else {
            &a.mime_type
        };
        let filename = encode_header_value(&a.filename);
        out.push_str(&format!("Content-Type: {mime}; name=\"{filename}\"\r\n"));
        out.push_str("Content-Transfer-Encoding: base64\r\n");
        out.push_str(&format!(
            "Content-Disposition: attachment; filename=\"{filename}\"\r\n\r\n"
        ));
        out.push_str(&wrap_base64(&a.data_b64));
        out.push_str("\r\n");
    }
    if has_attachments {
        out.push_str(&format!("--{mixed_boundary}--\r\n"));
    }
    out
}

fn make_boundary(prefix: &str) -> String {
    use rand::Rng;
    let suffix: String = (0..16)
        .map(|_| {
            const CHARSET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
            let idx = rand::thread_rng().gen_range(0..CHARSET.len());
            CHARSET[idx] as char
        })
        .collect();
    format!("cenmail-{prefix}-{suffix}")
}

fn wrap_base64(b64: &str) -> String {
    // RFC 2045 requires base64 lines ≤ 76 chars. The input is already stripped
    // of newlines by the frontend's encoder.
    let mut out = String::with_capacity(b64.len() + b64.len() / 76 * 2);
    let bytes = b64.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let end = (i + 76).min(bytes.len());
        out.push_str(std::str::from_utf8(&bytes[i..end]).unwrap_or(""));
        out.push_str("\r\n");
        i = end;
    }
    out
}

fn normalize_body(s: &str) -> String {
    // RFC 5322: lines terminated with CRLF.
    let s = s.replace("\r\n", "\n");
    s.replace('\n', "\r\n")
}

fn encode_header_value(s: &str) -> String {
    if s.is_ascii() {
        s.to_string()
    } else {
        let b64 = base64::engine::general_purpose::STANDARD.encode(s.as_bytes());
        format!("=?utf-8?B?{b64}?=")
    }
}

fn encode_phrase_if_needed(s: &str) -> String {
    if s.is_ascii() && !s.contains('"') {
        format!("\"{s}\"")
    } else {
        encode_header_value(s)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ascii_subject_round_trip() {
        let c = Compose {
            from: "me@example.com".into(),
            to: vec!["you@example.com".into()],
            subject: "Hello".into(),
            body: "Test\nBody".into(),
            ..Compose::default()
        };
        let mime = build_raw_mime(&c);
        assert!(mime.contains("Subject: Hello\r\n"));
        assert!(mime.contains("From: me@example.com\r\n"));
        assert!(mime.contains("To: you@example.com\r\n"));
        assert!(mime.contains("\r\nTest\r\nBody"));
    }

    #[test]
    fn non_ascii_subject_is_encoded() {
        let c = Compose {
            from: "me@example.com".into(),
            to: vec!["you@example.com".into()],
            subject: "件名テスト".into(),
            body: "".into(),
            ..Compose::default()
        };
        let mime = build_raw_mime(&c);
        assert!(mime.contains("Subject: =?utf-8?B?"));
    }

    #[test]
    fn reply_headers_present() {
        let c = Compose {
            from: "me@example.com".into(),
            to: vec!["you@example.com".into()],
            subject: "Re: x".into(),
            in_reply_to: Some("<msg@id>".into()),
            ..Compose::default()
        };
        let mime = build_raw_mime(&c);
        assert!(mime.contains("In-Reply-To: <msg@id>\r\n"));
        assert!(mime.contains("References: <msg@id>\r\n"));
    }

    #[test]
    fn html_alternative_emits_multipart() {
        let c = Compose {
            from: "me@example.com".into(),
            to: vec!["you@example.com".into()],
            subject: "Hi".into(),
            body: "plain".into(),
            html_body: Some("<p>html</p>".into()),
            ..Compose::default()
        };
        let mime = build_raw_mime(&c);
        assert!(mime.contains("Content-Type: multipart/alternative"));
        assert!(mime.contains("Content-Type: text/plain; charset=utf-8"));
        assert!(mime.contains("Content-Type: text/html; charset=utf-8"));
        assert!(mime.contains("plain"));
        assert!(mime.contains("<p>html</p>"));
    }

    #[test]
    fn attachment_emits_multipart_mixed() {
        let c = Compose {
            from: "me@example.com".into(),
            to: vec!["you@example.com".into()],
            subject: "with attachment".into(),
            body: "see attached".into(),
            attachments: vec![ComposeAttachment {
                filename: "hello.txt".into(),
                mime_type: "text/plain".into(),
                data_b64: "aGVsbG8=".into(),
            }],
            ..Compose::default()
        };
        let mime = build_raw_mime(&c);
        assert!(mime.contains("Content-Type: multipart/mixed"));
        assert!(mime.contains("Content-Disposition: attachment; filename=\"hello.txt\""));
        assert!(mime.contains("Content-Transfer-Encoding: base64"));
        assert!(mime.contains("aGVsbG8="));
    }

    #[test]
    fn attachment_with_html_nests_alternative_inside_mixed() {
        let c = Compose {
            from: "me@example.com".into(),
            to: vec!["you@example.com".into()],
            subject: "rich".into(),
            body: "plain".into(),
            html_body: Some("<b>rich</b>".into()),
            attachments: vec![ComposeAttachment {
                filename: "a.bin".into(),
                mime_type: "application/octet-stream".into(),
                data_b64: "AAAA".into(),
            }],
            ..Compose::default()
        };
        let mime = build_raw_mime(&c);
        let mixed_idx = mime
            .find("Content-Type: multipart/mixed")
            .expect("missing mixed");
        let alt_idx = mime
            .find("Content-Type: multipart/alternative")
            .expect("missing alternative");
        assert!(mixed_idx < alt_idx, "alternative must nest inside mixed");
        assert!(mime.contains("<b>rich</b>"));
        assert!(mime.contains("Content-Disposition: attachment; filename=\"a.bin\""));
    }
}

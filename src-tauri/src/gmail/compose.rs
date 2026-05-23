use anyhow::{Context, Result};
use base64::Engine;
use reqwest::Client;
use serde::Deserialize;

use super::messages::BASE;

#[derive(Debug, Clone, Default)]
pub struct Compose {
    pub from: String,
    pub from_name: Option<String>,
    pub to: Vec<String>,
    pub cc: Vec<String>,
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
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
    out.push_str("Content-Type: text/plain; charset=utf-8\r\n");
    out.push_str("Content-Transfer-Encoding: 8bit\r\n");
    out.push_str("\r\n");
    out.push_str(&normalize_body(&c.body));
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
}

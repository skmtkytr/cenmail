//! `mailto:` URL parsing for the OS mail-handler integration.
//!
//! When cenmail is registered as the `x-scheme-handler/mailto` handler, the
//! desktop launches it (or the single-instance forwards the args) with a
//! `mailto:` URL. We turn that into compose fields the frontend pre-fills.

use serde::Serialize;

#[derive(Serialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ComposeFields {
    pub to: String,
    pub cc: String,
    pub bcc: String,
    pub subject: String,
    pub body: String,
}

/// Parse a `mailto:` URL into compose fields. Returns `None` when `raw` isn't a
/// mailto URL. Recipients can come from the path (`mailto:a@b,c@d`) and/or
/// repeated `to=` query params; cc/bcc/subject/body come from query params.
pub fn parse_mailto(raw: &str) -> Option<ComposeFields> {
    let url = url::Url::parse(raw.trim()).ok()?;
    if url.scheme() != "mailto" {
        return None;
    }

    let mut to: Vec<String> = Vec::new();
    let path = urlencoding::decode(url.path())
        .map(|c| c.into_owned())
        .unwrap_or_else(|_| url.path().to_string());
    if !path.trim().is_empty() {
        to.push(path);
    }

    let mut f = ComposeFields::default();
    for (k, v) in url.query_pairs() {
        let v = v.into_owned();
        match k.as_ref().to_ascii_lowercase().as_str() {
            "to" => {
                if !v.trim().is_empty() {
                    to.push(v);
                }
            }
            "cc" => f.cc = join(f.cc, v),
            "bcc" => f.bcc = join(f.bcc, v),
            "subject" => f.subject = v,
            "body" => f.body = v,
            _ => {}
        }
    }
    f.to = to.join(", ");
    Some(f)
}

/// Find the first parseable `mailto:` URL among process args.
pub fn mailto_from_args<I: IntoIterator<Item = String>>(args: I) -> Option<ComposeFields> {
    args.into_iter().find_map(|a| parse_mailto(&a))
}

fn join(existing: String, add: String) -> String {
    match (existing.is_empty(), add.trim().is_empty()) {
        (_, true) => existing,
        (true, false) => add,
        (false, false) => format!("{existing}, {add}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bare_recipient() {
        let f = parse_mailto("mailto:alice@example.com").unwrap();
        assert_eq!(f.to, "alice@example.com");
        assert!(f.subject.is_empty() && f.body.is_empty());
    }

    #[test]
    fn subject_and_body_are_decoded() {
        let f = parse_mailto("mailto:a@b.com?subject=Hi%20there&body=Line%201%0ALine%202").unwrap();
        assert_eq!(f.subject, "Hi there");
        assert_eq!(f.body, "Line 1\nLine 2");
    }

    #[test]
    fn multiple_recipients_and_cc_bcc() {
        let f = parse_mailto("mailto:a@b.com,c@d.com?cc=e@f.com&bcc=g@h.com").unwrap();
        assert_eq!(f.to, "a@b.com,c@d.com");
        assert_eq!(f.cc, "e@f.com");
        assert_eq!(f.bcc, "g@h.com");
    }

    #[test]
    fn recipient_only_in_query() {
        let f = parse_mailto("mailto:?to=x@y.com&subject=Yo").unwrap();
        assert_eq!(f.to, "x@y.com");
        assert_eq!(f.subject, "Yo");
    }

    #[test]
    fn path_and_query_to_combine() {
        let f = parse_mailto("mailto:a@b.com?to=c@d.com").unwrap();
        assert_eq!(f.to, "a@b.com, c@d.com");
    }

    #[test]
    fn non_mailto_is_none() {
        assert!(parse_mailto("https://example.com").is_none());
        assert!(parse_mailto("not a url").is_none());
        assert!(parse_mailto("").is_none());
    }

    #[test]
    fn picks_mailto_out_of_args() {
        let args = vec![
            "/usr/bin/cenmail".to_string(),
            "mailto:a@b.com?subject=Hey".to_string(),
        ];
        let f = mailto_from_args(args).unwrap();
        assert_eq!(f.to, "a@b.com");
        assert_eq!(f.subject, "Hey");
        assert!(mailto_from_args(vec!["/usr/bin/cenmail".to_string()]).is_none());
    }
}

use anyhow::{anyhow, Context, Result};
use oauth2::basic::BasicClient;
use oauth2::{
    AuthUrl, AuthorizationCode, ClientId, ClientSecret, CsrfToken, PkceCodeChallenge, RedirectUrl,
    Scope, TokenResponse, TokenUrl,
};
use serde::Deserialize;
use tauri::AppHandle;
use tauri_plugin_opener::OpenerExt;

use crate::config::OAuthConfig;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const USERINFO_URL: &str = "https://www.googleapis.com/oauth2/v3/userinfo";

const SCOPES: &[&str] = &[
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/gmail.send",
    "https://www.googleapis.com/auth/userinfo.email",
    "https://www.googleapis.com/auth/userinfo.profile",
];

pub struct OAuthResult {
    pub email: String,
    pub display_name: Option<String>,
    pub picture_url: Option<String>,
    pub refresh_token: String,
}

#[derive(Debug, Deserialize)]
pub struct UserInfo {
    pub email: String,
    pub name: Option<String>,
    pub picture: Option<String>,
}

pub async fn fetch_userinfo(
    http: &reqwest::Client,
    access_token: &str,
) -> anyhow::Result<UserInfo> {
    Ok(http
        .get(USERINFO_URL)
        .bearer_auth(access_token)
        .send()
        .await
        .context("fetch userinfo")?
        .error_for_status()
        .context("userinfo status")?
        .json()
        .await
        .context("parse userinfo")?)
}

pub async fn run_flow(config: &OAuthConfig, app: &AppHandle) -> Result<OAuthResult> {
    let server = tiny_http::Server::http("127.0.0.1:0")
        .map_err(|e| anyhow!("bind loopback server: {e}"))?;
    let port = server
        .server_addr()
        .to_ip()
        .context("server addr is not ip")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");

    let http_client = reqwest::ClientBuilder::new()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .context("build http client")?;

    let client = BasicClient::new(ClientId::new(config.client_id.clone()))
        .set_client_secret(ClientSecret::new(config.client_secret.clone()))
        .set_auth_uri(AuthUrl::new(AUTH_URL.into()).context("auth url")?)
        .set_token_uri(TokenUrl::new(TOKEN_URL.into()).context("token url")?)
        .set_redirect_uri(RedirectUrl::new(redirect_uri).context("redirect uri")?);

    let (pkce_challenge, pkce_verifier) = PkceCodeChallenge::new_random_sha256();

    let mut auth_req = client.authorize_url(CsrfToken::new_random);
    for scope in SCOPES {
        auth_req = auth_req.add_scope(Scope::new((*scope).into()));
    }
    let (auth_url, csrf_token) = auth_req
        .add_extra_param("access_type", "offline")
        .add_extra_param("prompt", "consent")
        .set_pkce_challenge(pkce_challenge)
        .url();

    tracing::info!(%auth_url, "opening browser for OAuth consent");
    app.opener()
        .open_url(auth_url.as_str(), None::<&str>)
        .map_err(|e| anyhow!("open browser: {e}"))?;

    let (code, returned_state) = wait_for_callback(server).await?;
    if returned_state != *csrf_token.secret() {
        return Err(anyhow!("CSRF state mismatch — possible interception"));
    }

    let token = client
        .exchange_code(AuthorizationCode::new(code))
        .set_pkce_verifier(pkce_verifier)
        .request_async(&http_client)
        .await
        .map_err(|e| anyhow!("token exchange: {e}"))?;

    let access_token = token.access_token().secret().clone();
    let refresh_token = token
        .refresh_token()
        .map(|r| r.secret().clone())
        .ok_or_else(|| {
            anyhow!(
                "no refresh_token received — revoke the app in your Google Account \
                 permissions and retry (Google only issues refresh tokens on first consent)"
            )
        })?;

    let userinfo = fetch_userinfo(&http_client, &access_token).await?;

    Ok(OAuthResult {
        email: userinfo.email,
        display_name: userinfo.name,
        picture_url: userinfo.picture,
        refresh_token,
    })
}

async fn wait_for_callback(server: tiny_http::Server) -> Result<(String, String)> {
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<(String, String)>>();

    tokio::task::spawn_blocking(move || {
        let deadline = std::time::Instant::now() + TIMEOUT;
        let result = loop {
            let remaining = match deadline.checked_duration_since(std::time::Instant::now()) {
                Some(d) => d,
                None => break Err(anyhow!("authentication timed out after 5 minutes")),
            };
            match server.recv_timeout(remaining) {
                Ok(Some(request)) => {
                    let url_path = request.url().to_string();
                    let body = "<!doctype html><html><head><meta charset=\"utf-8\"><title>cenmail</title></head>\
                        <body style=\"font-family:system-ui,sans-serif;text-align:center;padding-top:4em;color:#111\">\
                        <h2>cenmail</h2><p>Authentication successful. You can close this window.</p>\
                        </body></html>";
                    let header: tiny_http::Header =
                        "Content-Type: text/html; charset=utf-8".parse().unwrap();
                    let response = tiny_http::Response::from_string(body).with_header(header);
                    let _ = request.respond(response);
                    break parse_callback(&url_path);
                }
                Ok(None) => continue,
                Err(e) => break Err(anyhow!("loopback recv: {e}")),
            }
        };
        let _ = tx.send(result);
    });

    rx.await?
}

fn parse_callback(url_path: &str) -> Result<(String, String)> {
    let url = url::Url::parse(&format!("http://localhost{url_path}"))?;
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for (k, v) in url.query_pairs() {
        match k.as_ref() {
            "code" => code = Some(v.into_owned()),
            "state" => state = Some(v.into_owned()),
            "error" => error = Some(v.into_owned()),
            _ => {}
        }
    }
    if let Some(e) = error {
        return Err(anyhow!("oauth error from provider: {e}"));
    }
    Ok((
        code.context("no code in callback")?,
        state.context("no state in callback")?,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_callback_extracts_code_and_state() {
        let (code, state) =
            parse_callback("/callback?code=abc123&state=xyz").expect("parse ok");
        assert_eq!(code, "abc123");
        assert_eq!(state, "xyz");
    }

    #[test]
    fn parse_callback_url_decodes_values() {
        let (code, _) =
            parse_callback("/callback?code=ab%2Fcd&state=s").expect("parse ok");
        assert_eq!(code, "ab/cd");
    }

    #[test]
    fn parse_callback_propagates_provider_error() {
        let err = parse_callback("/callback?error=access_denied&state=x")
            .expect_err("should fail");
        assert!(err.to_string().contains("access_denied"));
    }

    #[test]
    fn parse_callback_requires_code_and_state() {
        assert!(parse_callback("/callback?code=a").is_err());
        assert!(parse_callback("/callback?state=s").is_err());
    }
}

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use reqwest::Client;
use serde::Deserialize;
use tokio::sync::Mutex as AsyncMutex;

use crate::config::OAuthConfig;
use crate::secret;

const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const SAFETY_MARGIN: Duration = Duration::from_secs(60);

#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    expires_in: u64,
}

struct CachedToken {
    access_token: String,
    expires_at: Instant,
}

pub struct TokenCache {
    map: Mutex<HashMap<String, CachedToken>>,
    // Per-email lock to single-flight refresh requests. Multiple callers asking
    // for the same email will queue here; once the first finishes the others
    // see the freshly cached token and skip refreshing.
    locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
}

impl TokenCache {
    pub fn new() -> Self {
        Self {
            map: Mutex::new(HashMap::new()),
            locks: Mutex::new(HashMap::new()),
        }
    }

    fn cached(&self, email: &str) -> Option<String> {
        let map = self.map.lock().ok()?;
        let entry = map.get(email)?;
        if entry.expires_at > Instant::now() + SAFETY_MARGIN {
            Some(entry.access_token.clone())
        } else {
            None
        }
    }

    fn store(&self, email: &str, token: String, expires_in: u64) {
        if let Ok(mut map) = self.map.lock() {
            map.insert(
                email.to_string(),
                CachedToken {
                    access_token: token,
                    expires_at: Instant::now() + Duration::from_secs(expires_in),
                },
            );
        }
    }

    pub fn invalidate(&self, email: &str) {
        if let Ok(mut map) = self.map.lock() {
            map.remove(email);
        }
    }

    fn refresh_lock(&self, email: &str) -> Arc<AsyncMutex<()>> {
        let mut locks = self.locks.lock().expect("token cache locks poisoned");
        locks
            .entry(email.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(())))
            .clone()
    }
}

impl Default for TokenCache {
    fn default() -> Self {
        Self::new()
    }
}

pub async fn access_token(
    cache: &TokenCache,
    config: &OAuthConfig,
    http: &Client,
    email: &str,
) -> Result<String> {
    if let Some(token) = cache.cached(email) {
        return Ok(token);
    }

    let lock = cache.refresh_lock(email);
    let _guard = lock.lock().await;

    // Re-check under the lock: another caller may have refreshed already.
    if let Some(token) = cache.cached(email) {
        return Ok(token);
    }

    let refresh_token = secret::load_refresh_token(email)
        .with_context(|| format!("load refresh_token from keyring for {email}"))?;

    let resp = http
        .post(TOKEN_URL)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token.as_str()),
            ("client_id", config.client_id.as_str()),
            ("client_secret", config.client_secret.as_str()),
        ])
        .send()
        .await
        .context("token endpoint request")?
        .error_for_status()
        .context("token endpoint status")?
        .json::<TokenResponse>()
        .await
        .context("parse token response")?;

    let token = resp.access_token.clone();
    cache.store(email, resp.access_token, resp.expires_in);
    Ok(token)
}

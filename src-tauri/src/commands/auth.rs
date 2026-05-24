//! Authenticated Gmail / Calendar request plumbing: 401-refresh and
//! 429/403-backoff retries that wrap every API call cenmail makes.

use crate::constants::{AUTH_RETRY_DELAY, RATE_LIMIT_BASE_DELAY};
use crate::gmail;

use super::AppState;

pub(crate) type BoxFut<'a, T> =
    std::pin::Pin<Box<dyn std::future::Future<Output = anyhow::Result<T>> + Send + 'a>>;

/// Wrap `op` with token refresh + rate-limit backoff. The closure
/// receives the current access token; on 401 we invalidate the cache
/// and try again, on 429/403 we exponentially back off, on any other
/// error we surface it immediately.
pub(crate) async fn with_token<T, F>(
    state: &AppState,
    email: &str,
    op: F,
) -> anyhow::Result<T>
where
    F: for<'a> Fn(&'a reqwest::Client, &'a str) -> BoxFut<'a, T>,
{
    const MAX_ATTEMPTS: u32 = 4;
    let mut attempt: u32 = 0;
    let mut last_err: Option<anyhow::Error> = None;
    while attempt < MAX_ATTEMPTS {
        attempt += 1;
        let token = gmail::auth::access_token(
            &state.token_cache,
            &state.oauth_config,
            &state.http,
            email,
        )
        .await?;
        match op(&state.http, &token).await {
            Ok(v) => return Ok(v),
            Err(e) if is_unauthorized(&e) => {
                tracing::debug!(%email, attempt, "401 from Gmail, refreshing token");
                state.token_cache.invalidate(email);
                tokio::time::sleep(AUTH_RETRY_DELAY).await;
                last_err = Some(e);
            }
            Err(e) if is_rate_limited(&e) => {
                let backoff = RATE_LIMIT_BASE_DELAY * 2u32.pow(attempt - 1);
                tracing::debug!(%email, attempt, ?backoff, "rate limited by Gmail");
                tokio::time::sleep(backoff).await;
                last_err = Some(e);
            }
            Err(e) => return Err(e),
        }
    }
    Err(last_err.unwrap_or_else(|| anyhow::anyhow!("with_token: max retries exceeded")))
}

pub(crate) fn is_unauthorized(e: &anyhow::Error) -> bool {
    for src in e.chain() {
        if let Some(req_err) = src.downcast_ref::<reqwest::Error>() {
            if req_err.status() == Some(reqwest::StatusCode::UNAUTHORIZED) {
                return true;
            }
        }
    }
    false
}

pub(crate) fn is_rate_limited(e: &anyhow::Error) -> bool {
    for src in e.chain() {
        if let Some(req_err) = src.downcast_ref::<reqwest::Error>() {
            if let Some(s) = req_err.status() {
                if s == reqwest::StatusCode::TOO_MANY_REQUESTS
                    || s == reqwest::StatusCode::FORBIDDEN
                {
                    return true;
                }
            }
        }
    }
    false
}

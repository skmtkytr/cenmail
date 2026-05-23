use anyhow::{Context, Result};

#[derive(Clone)]
pub struct OAuthConfig {
    pub client_id: String,
    pub client_secret: String,
}

impl OAuthConfig {
    pub fn from_env() -> Result<Self> {
        Ok(Self {
            client_id: std::env::var("CENMAIL_GOOGLE_CLIENT_ID").context(
                "CENMAIL_GOOGLE_CLIENT_ID not set — run via `op run --env-file=.env.op -- pnpm app`",
            )?,
            client_secret: std::env::var("CENMAIL_GOOGLE_CLIENT_SECRET")
                .context("CENMAIL_GOOGLE_CLIENT_SECRET not set")?,
        })
    }
}

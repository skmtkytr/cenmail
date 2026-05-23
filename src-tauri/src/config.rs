use anyhow::{Context, Result};
use std::path::PathBuf;

#[derive(Clone)]
pub struct OAuthConfig {
    pub client_id: String,
    pub client_secret: String,
}

const ENV_ID: &str = "CENMAIL_GOOGLE_CLIENT_ID";
const ENV_SECRET: &str = "CENMAIL_GOOGLE_CLIENT_SECRET";

impl OAuthConfig {
    pub fn load() -> Result<Self> {
        if let (Ok(id), Ok(secret)) = (std::env::var(ENV_ID), std::env::var(ENV_SECRET)) {
            return Ok(Self {
                client_id: id,
                client_secret: secret,
            });
        }
        let path = credentials_path()?;
        let contents = std::fs::read_to_string(&path).with_context(|| {
            format!(
                "OAuth credentials not configured. Set ${ENV_ID}/${ENV_SECRET}, \
                 or create {} with lines:\n  {ENV_ID}=...\n  {ENV_SECRET}=...",
                path.display()
            )
        })?;
        let mut id = None;
        let mut secret = None;
        for raw in contents.lines() {
            let line = raw.trim();
            if line.is_empty() || line.starts_with('#') {
                continue;
            }
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            let key = k.trim();
            let value = v.trim().trim_matches('"').trim_matches('\'').to_string();
            match key {
                ENV_ID => id = Some(value),
                ENV_SECRET => secret = Some(value),
                _ => {}
            }
        }
        Ok(Self {
            client_id: id.with_context(|| format!("{ENV_ID} missing in {}", path.display()))?,
            client_secret: secret
                .with_context(|| format!("{ENV_SECRET} missing in {}", path.display()))?,
        })
    }
}

pub fn credentials_path() -> Result<PathBuf> {
    let base = dirs::config_dir().context("could not resolve XDG_CONFIG_HOME")?;
    Ok(base.join("cenmail").join("credentials.env"))
}

use anyhow::Result;
use keyring::Entry;

const SERVICE: &str = "cenmail";

pub fn save_refresh_token(email: &str, token: &str) -> Result<()> {
    Entry::new(SERVICE, email)?.set_password(token)?;
    Ok(())
}

#[allow(dead_code)]
pub fn load_refresh_token(email: &str) -> Result<String> {
    Ok(Entry::new(SERVICE, email)?.get_password()?)
}

pub fn delete_refresh_token(email: &str) -> Result<()> {
    Entry::new(SERVICE, email)?.delete_credential()?;
    Ok(())
}

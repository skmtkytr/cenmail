use anyhow::{Context, Result};
use reqwest::Client;
use serde::{Deserialize, Serialize};

const BASE: &str = "https://www.googleapis.com/calendar/v3";

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct GCalCalendar {
    pub id: String,
    #[serde(default)]
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default, rename = "timeZone")]
    pub time_zone: Option<String>,
    #[serde(default, rename = "backgroundColor")]
    pub background_color: Option<String>,
    #[serde(default, rename = "foregroundColor")]
    pub foreground_color: Option<String>,
    #[serde(default)]
    pub primary: Option<bool>,
    #[serde(default)]
    pub selected: Option<bool>,
}

#[derive(Deserialize)]
struct ListResp {
    items: Option<Vec<GCalCalendar>>,
}

pub async fn list_calendars(http: &Client, access_token: &str) -> Result<Vec<GCalCalendar>> {
    let url = format!("{BASE}/users/me/calendarList");
    let resp: ListResp = http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("calendarList request")?
        .error_for_status()
        .context("calendarList status")?
        .json()
        .await
        .context("parse calendarList")?;
    Ok(resp.items.unwrap_or_default())
}

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, NaiveDate, TimeZone, Utc};
use reqwest::Client;
use serde::{Deserialize, Serialize};

const BASE: &str = "https://www.googleapis.com/calendar/v3";

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct EventDateTime {
    #[serde(default, rename = "dateTime")]
    pub date_time: Option<String>,
    #[serde(default)]
    pub date: Option<String>,
    #[serde(default, rename = "timeZone")]
    pub time_zone: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct Attendee {
    #[serde(default)]
    pub email: String,
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(default, rename = "responseStatus")]
    pub response_status: Option<String>,
    #[serde(default, rename = "self")]
    pub self_field: Option<bool>,
    #[serde(default)]
    pub organizer: Option<bool>,
    #[serde(default)]
    pub optional: Option<bool>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct Organizer {
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default, rename = "displayName")]
    pub display_name: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct ConferenceData {
    #[serde(default, rename = "entryPoints")]
    pub entry_points: Vec<ConferenceEntryPoint>,
}

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
pub struct ConferenceEntryPoint {
    #[serde(default, rename = "entryPointType")]
    pub entry_point_type: Option<String>,
    #[serde(default)]
    pub uri: Option<String>,
}

#[derive(Deserialize, Serialize, Clone, Debug)]
pub struct GCalEvent {
    pub id: String,
    #[serde(default, rename = "iCalUID")]
    pub ical_uid: Option<String>,
    #[serde(default)]
    pub summary: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default, rename = "htmlLink")]
    pub html_link: Option<String>,
    #[serde(default)]
    pub organizer: Option<Organizer>,
    #[serde(default)]
    pub start: Option<EventDateTime>,
    #[serde(default)]
    pub end: Option<EventDateTime>,
    #[serde(default)]
    pub attendees: Vec<Attendee>,
    #[serde(default, rename = "conferenceData")]
    pub conference_data: Option<ConferenceData>,
}

#[derive(Deserialize)]
struct ListResp {
    items: Option<Vec<GCalEvent>>,
    #[serde(default, rename = "nextPageToken")]
    next_page_token: Option<String>,
}

/// Fetch events in `[time_min, time_max]` for a single calendar. Returns the
/// fully-paginated list with cancelled/recurring expanded by Google.
pub async fn list_events(
    http: &Client,
    access_token: &str,
    calendar_id: &str,
    time_min: DateTime<Utc>,
    time_max: DateTime<Utc>,
) -> Result<Vec<GCalEvent>> {
    let url = format!(
        "{BASE}/calendars/{}/events",
        urlencoding::encode(calendar_id)
    );
    let mut out = Vec::new();
    let mut page_token: Option<String> = None;
    loop {
        let mut req = http
            .get(&url)
            .bearer_auth(access_token)
            .query(&[
                ("timeMin", time_min.to_rfc3339()),
                ("timeMax", time_max.to_rfc3339()),
                ("singleEvents", "true".to_string()),
                ("orderBy", "startTime".to_string()),
                ("maxResults", "250".to_string()),
            ]);
        if let Some(t) = &page_token {
            req = req.query(&[("pageToken", t.clone())]);
        }
        let resp: ListResp = req
            .send()
            .await
            .context("list events request")?
            .error_for_status()
            .context("list events status")?
            .json()
            .await
            .context("parse list events")?;
        if let Some(items) = resp.items {
            out.extend(items);
        }
        match resp.next_page_token {
            Some(t) => page_token = Some(t),
            None => break,
        }
    }
    Ok(out)
}

pub async fn find_by_ical_uid(
    http: &Client,
    access_token: &str,
    calendar_id: &str,
    ical_uid: &str,
) -> Result<Option<GCalEvent>> {
    let url = format!(
        "{BASE}/calendars/{}/events",
        urlencoding::encode(calendar_id)
    );
    let resp: ListResp = http
        .get(&url)
        .bearer_auth(access_token)
        .query(&[
            ("iCalUID", ical_uid),
            ("maxResults", "1"),
        ])
        .send()
        .await
        .context("find by iCalUID request")?
        .error_for_status()
        .context("find by iCalUID status")?
        .json()
        .await
        .context("parse find by iCalUID")?;
    Ok(resp.items.and_then(|mut v| v.pop()))
}

pub async fn get_event(
    http: &Client,
    access_token: &str,
    calendar_id: &str,
    event_id: &str,
) -> Result<GCalEvent> {
    let url = format!(
        "{BASE}/calendars/{}/events/{}",
        urlencoding::encode(calendar_id),
        urlencoding::encode(event_id),
    );
    Ok(http
        .get(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("get event request")?
        .error_for_status()
        .context("get event status")?
        .json::<GCalEvent>()
        .await
        .context("parse event")?)
}

/// Update the self attendee's `responseStatus` ("accepted", "declined",
/// "tentative", "needsAction"). Sends a PATCH.
pub async fn respond_to_event(
    http: &Client,
    access_token: &str,
    calendar_id: &str,
    event_id: &str,
    self_email: &str,
    status: &str,
) -> Result<GCalEvent> {
    // Have to fetch first to update the attendees array, then PATCH it back.
    let event = get_event(http, access_token, calendar_id, event_id).await?;
    let mut attendees = event.attendees.clone();
    let mut found = false;
    for a in &mut attendees {
        if a.email.eq_ignore_ascii_case(self_email)
            || a.self_field == Some(true)
        {
            a.response_status = Some(status.to_string());
            found = true;
        }
    }
    if !found {
        // Add self if not in attendees list.
        attendees.push(Attendee {
            email: self_email.to_string(),
            response_status: Some(status.to_string()),
            self_field: Some(true),
            ..Default::default()
        });
    }

    let url = format!(
        "{BASE}/calendars/{}/events/{}?sendUpdates=externalOnly",
        urlencoding::encode(calendar_id),
        urlencoding::encode(event_id),
    );
    Ok(http
        .patch(&url)
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "attendees": attendees }))
        .send()
        .await
        .context("patch attendees request")?
        .error_for_status()
        .context("patch attendees status")?
        .json::<GCalEvent>()
        .await
        .context("parse patched event")?)
}

#[derive(Serialize, Default)]
pub struct CreateEventInput {
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub attendees: Vec<String>,
    pub time_zone: Option<String>,
}

pub async fn create_event(
    http: &Client,
    access_token: &str,
    calendar_id: &str,
    input: &CreateEventInput,
) -> Result<GCalEvent> {
    let url = format!(
        "{BASE}/calendars/{}/events?sendUpdates=externalOnly",
        urlencoding::encode(calendar_id)
    );
    let body = build_event_body(input)?;
    Ok(http
        .post(&url)
        .bearer_auth(access_token)
        .json(&body)
        .send()
        .await
        .context("create event request")?
        .error_for_status()
        .context("create event status")?
        .json::<GCalEvent>()
        .await
        .context("parse create event")?)
}

pub async fn delete_event(
    http: &Client,
    access_token: &str,
    calendar_id: &str,
    event_id: &str,
) -> Result<()> {
    let url = format!(
        "{BASE}/calendars/{}/events/{}?sendUpdates=externalOnly",
        urlencoding::encode(calendar_id),
        urlencoding::encode(event_id),
    );
    http.delete(&url)
        .bearer_auth(access_token)
        .send()
        .await
        .context("delete event request")?
        .error_for_status()
        .context("delete event status")?;
    Ok(())
}

fn build_event_body(input: &CreateEventInput) -> Result<serde_json::Value> {
    let start = format_dt(input.start_ms, input.all_day, input.time_zone.as_deref())?;
    let end = format_dt(input.end_ms, input.all_day, input.time_zone.as_deref())?;
    let mut body = serde_json::json!({
        "summary": input.summary,
        "start": start,
        "end": end,
    });
    if let Some(d) = &input.description {
        body["description"] = serde_json::Value::String(d.clone());
    }
    if let Some(l) = &input.location {
        body["location"] = serde_json::Value::String(l.clone());
    }
    if !input.attendees.is_empty() {
        body["attendees"] = serde_json::Value::Array(
            input
                .attendees
                .iter()
                .map(|e| serde_json::json!({ "email": e }))
                .collect(),
        );
    }
    Ok(body)
}

fn format_dt(ms: i64, all_day: bool, tz: Option<&str>) -> Result<serde_json::Value> {
    let dt = Utc
        .timestamp_millis_opt(ms)
        .single()
        .ok_or_else(|| anyhow!("invalid timestamp_ms {ms}"))?;
    if all_day {
        Ok(serde_json::json!({
            "date": dt.format("%Y-%m-%d").to_string(),
        }))
    } else {
        let mut v = serde_json::json!({ "dateTime": dt.to_rfc3339() });
        if let Some(z) = tz {
            v["timeZone"] = serde_json::Value::String(z.to_string());
        }
        Ok(v)
    }
}

/// Resolve a GCal event start/end into a UTC millis pair.
pub fn event_time_range(ev: &GCalEvent) -> Result<(i64, i64, bool)> {
    let resolve = |dt: &Option<EventDateTime>, end_of_day: bool| -> Result<(i64, bool)> {
        let dt = dt
            .as_ref()
            .ok_or_else(|| anyhow!("event has no start/end"))?;
        if let Some(date_time) = &dt.date_time {
            let parsed = DateTime::parse_from_rfc3339(date_time)
                .with_context(|| format!("parse dateTime {date_time}"))?;
            Ok((parsed.timestamp_millis(), false))
        } else if let Some(date) = &dt.date {
            // All-day. Interpret as user's local midnight; treat as UTC midnight
            // for cache key purposes (frontend renders by date already).
            let nd = NaiveDate::parse_from_str(date, "%Y-%m-%d")
                .with_context(|| format!("parse date {date}"))?;
            let dt = if end_of_day {
                nd.and_hms_opt(23, 59, 59).unwrap()
            } else {
                nd.and_hms_opt(0, 0, 0).unwrap()
            };
            let utc = Utc.from_utc_datetime(&dt);
            Ok((utc.timestamp_millis(), true))
        } else {
            Err(anyhow!("event date/dateTime missing"))
        }
    };
    let (start, all_day_start) = resolve(&ev.start, false)?;
    let (end, _) = resolve(&ev.end, true)?;
    Ok((start, end, all_day_start))
}

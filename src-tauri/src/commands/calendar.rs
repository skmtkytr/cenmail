//! Google Calendar commands: calendar / event CRUD + RSVP. Reads go
//! through the local cache (events table), writes round-trip via
//! gcal::events and invalidate the affected cached rows.

use chrono::{TimeZone, Utc};
use rusqlite::params;
use serde::Serialize;
use tauri::State;

use crate::gcal;

use super::auth::with_token;
use super::AppState;

#[derive(Debug, Serialize, Clone)]
pub struct CalendarRow {
    pub account_email: String,
    pub id: String,
    pub summary: String,
    pub description: Option<String>,
    pub time_zone: Option<String>,
    pub background_color: Option<String>,
    pub foreground_color: Option<String>,
    pub is_primary: bool,
    pub selected: bool,
}

#[tauri::command]
pub async fn list_calendars(
    state: State<'_, AppState>,
    email: String,
    refresh: Option<bool>,
) -> Result<Vec<CalendarRow>, String> {
    if refresh.unwrap_or(false) {
        let cals = with_token(&state, &email, |http, token| {
            Box::pin(async move { gcal::calendars::list_calendars(http, token).await })
        })
        .await
        .map_err(|e| {
            tracing::error!(%email, error = %format!("{e:#}"), "list_calendars failed");
            format!("{e:#}")
        })?;
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        for c in &cals {
            tx.execute(
                "INSERT OR REPLACE INTO calendars
                 (account_email, id, summary, description, time_zone,
                  background_color, foreground_color, is_primary, selected)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    email,
                    c.id,
                    c.summary,
                    c.description,
                    c.time_zone,
                    c.background_color,
                    c.foreground_color,
                    c.primary.unwrap_or(false) as i64,
                    c.selected.unwrap_or(true) as i64,
                ],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
    }

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT account_email, id, summary, description, time_zone,
                    background_color, foreground_color, is_primary, selected
             FROM calendars WHERE account_email = ?1 ORDER BY is_primary DESC, summary ASC",
        )
        .map_err(|e| e.to_string())?;
    let rows: Vec<CalendarRow> = stmt
        .query_map(params![email], |r| {
            Ok(CalendarRow {
                account_email: r.get(0)?,
                id: r.get(1)?,
                summary: r.get(2)?,
                description: r.get(3)?,
                time_zone: r.get(4)?,
                background_color: r.get(5)?,
                foreground_color: r.get(6)?,
                is_primary: r.get::<_, i64>(7)? != 0,
                selected: r.get::<_, i64>(8)? != 0,
            })
        })
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn sync_calendar_events(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    from_ms: i64,
    to_ms: i64,
) -> Result<usize, String> {
    let from_dt = chrono::Utc
        .timestamp_millis_opt(from_ms)
        .single()
        .ok_or_else(|| "invalid from_ms".to_string())?;
    let to_dt = chrono::Utc
        .timestamp_millis_opt(to_ms)
        .single()
        .ok_or_else(|| "invalid to_ms".to_string())?;
    let cid_owned = calendar_id.clone();
    let evs = with_token(&state, &email, move |http, token| {
        let cid = cid_owned.clone();
        Box::pin(async move {
            gcal::events::list_events(http, token, &cid, from_dt, to_dt).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, %calendar_id, error = %format!("{e:#}"), "sync_calendar_events failed");
        format!("{e:#}")
    })?;

    let count = evs.len();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    // Purge stale rows in this window so cancelled / moved events disappear.
    tx.execute(
        "DELETE FROM events
         WHERE account_email = ?1 AND calendar_id = ?2
           AND start_ms >= ?3 AND start_ms < ?4",
        params![email, calendar_id, from_ms, to_ms],
    )
    .map_err(|e| e.to_string())?;
    for ev in &evs {
        let (start_ms, end_ms, all_day) = match gcal::events::event_time_range(ev) {
            Ok(t) => t,
            Err(e) => {
                tracing::debug!(error = %format!("{e:#}"), id = %ev.id, "skip event without times");
                continue;
            }
        };
        let attendees_json = serde_json::to_string(&ev.attendees).unwrap_or_else(|_| "[]".into());
        let (org_email, org_name) = match &ev.organizer {
            Some(o) => (o.email.clone(), o.display_name.clone()),
            None => (None, None),
        };
        let self_status = ev
            .attendees
            .iter()
            .find(|a| a.self_field == Some(true))
            .and_then(|a| a.response_status.clone());
        let conf_uri = ev.conference_data.as_ref().and_then(|c| {
            c.entry_points
                .iter()
                .find(|p| p.entry_point_type.as_deref() == Some("video"))
                .and_then(|p| p.uri.clone())
        });
        tx.execute(
            "INSERT OR REPLACE INTO events
             (account_email, calendar_id, id, ical_uid, summary, description, location,
              organizer_email, organizer_name, start_ms, end_ms, all_day,
              attendees_json, response_status, html_link, conference_uri,
              status, fetched_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18)",
            params![
                email,
                calendar_id,
                ev.id,
                ev.ical_uid,
                ev.summary.clone().unwrap_or_default(),
                ev.description,
                ev.location,
                org_email,
                org_name,
                start_ms,
                end_ms,
                all_day as i64,
                attendees_json,
                self_status,
                ev.html_link,
                conf_uri,
                ev.status,
                Utc::now().to_rfc3339(),
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[derive(Debug, Serialize, Clone)]
pub struct EventRow {
    pub account_email: String,
    pub calendar_id: String,
    pub id: String,
    pub ical_uid: Option<String>,
    pub summary: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub organizer_email: Option<String>,
    pub organizer_name: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    pub all_day: bool,
    pub attendees_json: String,
    pub response_status: Option<String>,
    pub html_link: Option<String>,
    pub conference_uri: Option<String>,
    pub status: Option<String>,
}

#[tauri::command]
pub fn list_events_cached(
    state: State<'_, AppState>,
    email: Option<String>,
    from_ms: i64,
    to_ms: i64,
) -> Result<Vec<EventRow>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let (sql, bind): (String, Vec<Box<dyn rusqlite::ToSql>>) = match email {
        Some(e) => (
            "SELECT account_email, calendar_id, id, ical_uid, summary, description, location,
                    organizer_email, organizer_name, start_ms, end_ms, all_day,
                    attendees_json, response_status, html_link, conference_uri, status
             FROM events
             WHERE account_email = ?1 AND start_ms < ?2 AND end_ms > ?3
             ORDER BY start_ms ASC"
                .to_string(),
            vec![Box::new(e), Box::new(to_ms), Box::new(from_ms)],
        ),
        None => (
            "SELECT account_email, calendar_id, id, ical_uid, summary, description, location,
                    organizer_email, organizer_name, start_ms, end_ms, all_day,
                    attendees_json, response_status, html_link, conference_uri, status
             FROM events
             WHERE start_ms < ?1 AND end_ms > ?2
             ORDER BY start_ms ASC"
                .to_string(),
            vec![Box::new(to_ms), Box::new(from_ms)],
        ),
    };
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<EventRow> = stmt
        .query_map(
            rusqlite::params_from_iter(bind.iter().map(|b| b.as_ref())),
            |r| {
                Ok(EventRow {
                    account_email: r.get(0)?,
                    calendar_id: r.get(1)?,
                    id: r.get(2)?,
                    ical_uid: r.get(3)?,
                    summary: r.get(4)?,
                    description: r.get(5)?,
                    location: r.get(6)?,
                    organizer_email: r.get(7)?,
                    organizer_name: r.get(8)?,
                    start_ms: r.get(9)?,
                    end_ms: r.get(10)?,
                    all_day: r.get::<_, i64>(11)? != 0,
                    attendees_json: r.get(12)?,
                    response_status: r.get(13)?,
                    html_link: r.get(14)?,
                    conference_uri: r.get(15)?,
                    status: r.get(16)?,
                })
            },
        )
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();
    Ok(rows)
}

#[tauri::command]
pub async fn respond_to_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event_id: String,
    status: String,
) -> Result<(), String> {
    let cid_owned = calendar_id.clone();
    let eid_owned = event_id.clone();
    let self_email = email.clone();
    let status_owned = status.clone();
    let ev = with_token(&state, &email, move |http, token| {
        let cid = cid_owned.clone();
        let eid = eid_owned.clone();
        let me = self_email.clone();
        let st = status_owned.clone();
        Box::pin(async move {
            gcal::events::respond_to_event(http, token, &cid, &eid, &me, &st).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(%email, %calendar_id, %event_id, error = %format!("{e:#}"), "respond failed");
        format!("{e:#}")
    })?;

    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let self_status = ev
        .attendees
        .iter()
        .find(|a| a.self_field == Some(true) || a.email.eq_ignore_ascii_case(&email))
        .and_then(|a| a.response_status.clone());
    conn.execute(
        "UPDATE events SET response_status = ?1
         WHERE account_email = ?2 AND calendar_id = ?3 AND id = ?4",
        params![self_status, email, calendar_id, event_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateEventRequest {
    pub email: String,
    pub calendar_id: String,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
}

#[tauri::command]
pub async fn respond_to_invite(
    state: State<'_, AppState>,
    email: String,
    ical_uid: String,
    status: String,
) -> Result<(), String> {
    let uid_owned = ical_uid.clone();
    let ev = with_token(&state, &email, move |http, token| {
        let uid = uid_owned.clone();
        Box::pin(async move {
            gcal::events::find_by_ical_uid(http, token, "primary", &uid)
                .await
                .map_err(|e| e.context("find invite"))
                .and_then(|o| {
                    o.ok_or_else(|| anyhow::anyhow!("invite not found in primary calendar"))
                })
        })
    })
    .await
    .map_err(|e| format!("{e:#}"))?;
    let event_id = ev.id.clone();
    let self_email = email.clone();
    let status_owned = status.clone();
    let _ = with_token(&state, &email, move |http, token| {
        let eid = event_id.clone();
        let me = self_email.clone();
        let st = status_owned.clone();
        Box::pin(async move {
            gcal::events::respond_to_event(http, token, "primary", &eid, &me, &st).await
        })
    })
    .await
    .map_err(|e| format!("{e:#}"))?;
    Ok(())
}

#[tauri::command]
pub async fn create_event(
    state: State<'_, AppState>,
    request: CreateEventRequest,
) -> Result<String, String> {
    let cid_owned = request.calendar_id.clone();
    let input = gcal::events::CreateEventInput {
        summary: request.summary.clone(),
        description: request.description.clone(),
        location: request.location.clone(),
        start_ms: request.start_ms,
        end_ms: request.end_ms,
        all_day: request.all_day,
        attendees: request.attendees.clone(),
        time_zone: request.time_zone.clone(),
    };
    let ev = with_token(&state, &request.email, move |http, token| {
        let cid = cid_owned.clone();
        let inp = gcal::events::CreateEventInput {
            summary: input.summary.clone(),
            description: input.description.clone(),
            location: input.location.clone(),
            start_ms: input.start_ms,
            end_ms: input.end_ms,
            all_day: input.all_day,
            attendees: input.attendees.clone(),
            time_zone: input.time_zone.clone(),
        };
        Box::pin(async move { gcal::events::create_event(http, token, &cid, &inp).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "create_event failed");
        format!("{e:#}")
    })?;
    Ok(ev.id)
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateEventRequest {
    pub email: String,
    pub calendar_id: String,
    pub event_id: String,
    pub summary: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    pub start_ms: i64,
    pub end_ms: i64,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub attendees: Vec<String>,
    #[serde(default)]
    pub time_zone: Option<String>,
}

#[tauri::command]
pub async fn update_event(
    state: State<'_, AppState>,
    request: UpdateEventRequest,
) -> Result<(), String> {
    let cid_owned = request.calendar_id.clone();
    let eid_owned = request.event_id.clone();
    let input = gcal::events::CreateEventInput {
        summary: request.summary.clone(),
        description: request.description.clone(),
        location: request.location.clone(),
        start_ms: request.start_ms,
        end_ms: request.end_ms,
        all_day: request.all_day,
        attendees: request.attendees.clone(),
        time_zone: request.time_zone.clone(),
    };
    let _ = with_token(&state, &request.email, move |http, token| {
        let cid = cid_owned.clone();
        let eid = eid_owned.clone();
        let inp = gcal::events::CreateEventInput {
            summary: input.summary.clone(),
            description: input.description.clone(),
            location: input.location.clone(),
            start_ms: input.start_ms,
            end_ms: input.end_ms,
            all_day: input.all_day,
            attendees: input.attendees.clone(),
            time_zone: input.time_zone.clone(),
        };
        Box::pin(async move {
            gcal::events::update_event(http, token, &cid, &eid, &inp).await
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "update_event failed");
        format!("{e:#}")
    })?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM events WHERE account_email = ?1 AND calendar_id = ?2 AND id = ?3",
        params![request.email, request.calendar_id, request.event_id],
    );
    Ok(())
}

#[tauri::command]
pub async fn delete_event(
    state: State<'_, AppState>,
    email: String,
    calendar_id: String,
    event_id: String,
) -> Result<(), String> {
    let cid_owned = calendar_id.clone();
    let eid_owned = event_id.clone();
    let _ = with_token(&state, &email, move |http, token| {
        let cid = cid_owned.clone();
        let eid = eid_owned.clone();
        Box::pin(async move { gcal::events::delete_event(http, token, &cid, &eid).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "delete_event failed");
        format!("{e:#}")
    })?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let _ = conn.execute(
        "DELETE FROM events WHERE account_email = ?1 AND calendar_id = ?2 AND id = ?3",
        params![email, calendar_id, event_id],
    );
    Ok(())
}

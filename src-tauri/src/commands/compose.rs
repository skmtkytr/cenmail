//! Compose / send / draft commands. Maps the wire `SendRequest` into a
//! `gmail::compose::Compose` and routes through send / drafts.create /
//! drafts.update / drafts.send / drafts.delete.

use rusqlite::params;
use tauri::State;

use crate::gmail::{self, compose::Compose};

use super::auth::with_token;
use super::AppState;

#[derive(Debug, serde::Deserialize, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct OutgoingAttachment {
    pub filename: String,
    pub mime_type: String,
    /// Standard base64 (with padding) of the attachment bytes.
    pub data_b64: String,
}

#[derive(Debug, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    pub from_account: String,
    #[serde(default)]
    pub to: Vec<String>,
    #[serde(default)]
    pub cc: Vec<String>,
    #[serde(default)]
    pub bcc: Vec<String>,
    pub subject: String,
    pub body: String,
    #[serde(default)]
    pub html_body: Option<String>,
    #[serde(default)]
    pub attachments: Vec<OutgoingAttachment>,
    pub in_reply_to: Option<String>,
    pub references: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveDraftRequest {
    /// When set, update an existing draft in place rather than creating
    /// a new one. The frontend stashes the value returned by save_draft
    /// and hands it back on subsequent autosaves.
    pub draft_id: Option<String>,
    #[serde(flatten)]
    pub send: SendRequest,
}

fn to_compose_attachments(
    items: Vec<OutgoingAttachment>,
) -> Vec<gmail::compose::ComposeAttachment> {
    items
        .into_iter()
        .map(|a| gmail::compose::ComposeAttachment {
            filename: a.filename,
            mime_type: a.mime_type,
            data_b64: a.data_b64,
        })
        .collect()
}

fn compose_from_request(state: &AppState, request: &SendRequest) -> Compose {
    let display_name = state.db.lock().ok().and_then(|conn| {
        conn.query_row(
            "SELECT display_name FROM accounts WHERE email = ?1",
            params![request.from_account],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    });
    Compose {
        from: request.from_account.clone(),
        from_name: display_name,
        to: request.to.clone(),
        cc: request.cc.clone(),
        bcc: request.bcc.clone(),
        subject: request.subject.clone(),
        body: request.body.clone(),
        html_body: request.html_body.clone(),
        attachments: to_compose_attachments(request.attachments.clone()),
        in_reply_to: request.in_reply_to.clone(),
        references: request.references.clone(),
    }
}

#[tauri::command]
pub async fn send_message(
    state: State<'_, AppState>,
    request: SendRequest,
) -> Result<String, String> {
    let compose = compose_from_request(&state, &request);
    let from_account = request.from_account.clone();

    with_token(&state, &from_account, |http, token| {
        let c = compose.clone();
        Box::pin(async move { gmail::compose::send(http, token, &c).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "send_message failed");
        format!("{e:#}")
    })
}

#[tauri::command]
pub async fn save_draft(
    state: State<'_, AppState>,
    request: SaveDraftRequest,
) -> Result<String, String> {
    let compose = compose_from_request(&state, &request.send);
    let from_account = request.send.from_account.clone();
    let existing = request.draft_id.clone();
    with_token(&state, &from_account, move |http, token| {
        let c = compose.clone();
        let existing = existing.clone();
        Box::pin(async move {
            match existing {
                Some(id) => gmail::compose::update_draft(http, token, &id, &c).await,
                None => gmail::compose::create_draft(http, token, &c).await,
            }
        })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "save_draft failed");
        format!("{e:#}")
    })
}

#[tauri::command]
pub async fn delete_draft(
    state: State<'_, AppState>,
    email: String,
    draft_id: String,
) -> Result<(), String> {
    let did = draft_id.clone();
    with_token(&state, &email, move |http, token| {
        let id = did.clone();
        Box::pin(async move { gmail::compose::delete_draft(http, token, &id).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "delete_draft failed");
        format!("{e:#}")
    })
}

#[tauri::command]
pub async fn send_draft(
    state: State<'_, AppState>,
    email: String,
    draft_id: String,
) -> Result<String, String> {
    let did = draft_id.clone();
    with_token(&state, &email, move |http, token| {
        let id = did.clone();
        Box::pin(async move { gmail::compose::send_draft(http, token, &id).await })
    })
    .await
    .map_err(|e| {
        tracing::error!(error = %format!("{e:#}"), "send_draft failed");
        format!("{e:#}")
    })
}

/// Called from the scheduled-sends timer. Deserialises the persisted
/// `SendRequest` payload and fires the actual messages.send.
pub async fn fire_scheduled_send(
    state: &AppState,
    email: &str,
    payload_json: &str,
) -> anyhow::Result<()> {
    let req: SendRequest = serde_json::from_str(payload_json)
        .map_err(|e| anyhow::anyhow!("parse scheduled payload: {e}"))?;
    let display_name = {
        let conn = state
            .db
            .lock()
            .map_err(|e| anyhow::anyhow!("db lock: {e}"))?;
        conn.query_row(
            "SELECT display_name FROM accounts WHERE email = ?1",
            params![email],
            |r| r.get::<_, Option<String>>(0),
        )
        .ok()
        .flatten()
    };
    let compose = Compose {
        from: req.from_account.clone(),
        from_name: display_name,
        to: req.to,
        cc: req.cc,
        bcc: req.bcc,
        subject: req.subject,
        body: req.body,
        html_body: req.html_body,
        attachments: to_compose_attachments(req.attachments),
        in_reply_to: req.in_reply_to,
        references: req.references,
    };
    let from = req.from_account.clone();
    with_token(state, &from, |http, token| {
        let c = compose.clone();
        Box::pin(async move { gmail::compose::send(http, token, &c).await })
    })
    .await?;
    Ok(())
}

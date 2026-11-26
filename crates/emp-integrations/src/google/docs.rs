//! Google Docs import by URL and export (SPEC §17.1).
//!
//! **Import** extracts the document id from the URL and calls `documents.get`, mapping the
//! structure to plain HTML ([`super::docs_html`]); if that fails it falls back to the Drive
//! HTML export (10 MiB cap). [`import_document_export`] exports directly as HTML or Markdown.
//! The HTML/Markdown goes to the app's sanitising import path; this crate does not build
//! TipTap JSON.
//!
//! **Export** uploads sanitised HTML as a new Google Doc (Drive multipart, scope `drive.file`)
//! or replaces an existing one ("Export again", `files.update`).

use serde::{Deserialize, Serialize};

use super::docs_html::convert_document;
use super::drive::{self, DriveFile, DriveFileRef, MIME_GOOGLE_DOC};
use super::{GoogleSession, extract_file_id};
use crate::error::{IntegrationError, Result};
use crate::netguard::{BodyCap, ConnectorId, Credential, Expect, NetRequest};
use crate::secret::SecretString;

/// Drive export cap for Docs (SPEC §17.1: 10 MB).
pub const DOC_EXPORT_CAP: u64 = 10 * 1024 * 1024;

/// Export format for import.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DocFormat {
    /// `text/html`
    Html,
    /// `text/markdown`
    Markdown,
}

impl DocFormat {
    /// Drive export MIME type.
    pub fn mime(self) -> &'static str {
        match self {
            DocFormat::Html => "text/html",
            DocFormat::Markdown => "text/markdown",
        }
    }

    fn expect(self) -> Expect {
        match self {
            DocFormat::Html => Expect::Html,
            DocFormat::Markdown => Expect::Markdown,
        }
    }
}

/// An imported document, ready for the HTML/Markdown import path.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportedDoc {
    /// Drive metadata (title in `name`).
    pub file: DriveFile,
    /// Format of `content`.
    pub format: DocFormat,
    /// The exported document. Untrusted: sanitise before rendering.
    pub content: String,
    /// Import warnings.
    pub warnings: Vec<String>,
}

/// Extract the document id from a `https://docs.google.com/document/d/<id>/…` URL.
pub fn extract_document_id(url: &str) -> Result<String> {
    extract_file_id(url, "document", "docs.google.com")
}

/// Import a Google Doc by URL.
/// `GET https://docs.googleapis.com/v1/documents/{id}` (scope `documents.readonly`).
pub fn document_request(token: &SecretString, id: &str) -> Result<NetRequest> {
    let url = url::Url::parse(&format!(
        "https://docs.googleapis.com/v1/documents/{}",
        super::path_segment(id)
    ))
    .map_err(|e| IntegrationError::Internal(e.to_string()))?;
    Ok(
        NetRequest::get(ConnectorId::Google, url, "/v1/documents/{id}")
            .credential(Credential::bearer(token))
            .cap(BodyCap::Bytes(2 * DOC_EXPORT_CAP)),
    )
}

/// Import a Google Doc by URL (SPEC §17.1): `documents.get` mapped to HTML; if the mapping
/// fails, fall back to the Drive HTML export. Needs `documents.readonly` (plus
/// `drive.readonly` for the fallback).
pub async fn import_document(session: &GoogleSession, url: &str) -> Result<ImportedDoc> {
    let id = extract_document_id(url)?;
    let resp = session.send(|tok| document_request(tok, &id)).await?;
    let resp = resp.error_for_status()?;
    match convert_document(&resp.body) {
        Ok(converted) => Ok(ImportedDoc {
            file: DriveFile {
                id: id.clone(),
                name: converted.title,
                mime_type: MIME_GOOGLE_DOC.to_string(),
                modified_time: None,
                web_view_link: Some(format!("https://docs.google.com/document/d/{id}/edit")),
            },
            format: DocFormat::Html,
            content: converted.html,
            warnings: converted.warnings,
        }),
        Err(_) => {
            let mut doc = import_document_export(session, &id, DocFormat::Html).await?;
            doc.warnings.insert(
                0,
                "The document was imported from Google's HTML export.".to_string(),
            );
            Ok(doc)
        }
    }
}

/// Import a Google Doc through Drive `files.export` as HTML or Markdown (10 MiB cap).
/// Needs `drive.readonly`.
pub async fn import_document_export(
    session: &GoogleSession,
    url: &str,
    format: DocFormat,
) -> Result<ImportedDoc> {
    let id = extract_document_id(url)?;
    let meta_resp = session
        .send(|tok| drive::metadata_request(tok, &id))
        .await?;
    let file = drive::parse_metadata(&meta_resp.error_for_status()?)?;
    if file.mime_type != MIME_GOOGLE_DOC {
        return Err(IntegrationError::Unsupported(format!(
            "this link is not a Google Doc ({})",
            file.mime_type
        )));
    }
    let resp = session
        .send(|tok| {
            drive::export_request(
                tok,
                &id,
                format.mime(),
                format.expect(),
                BodyCap::Bytes(DOC_EXPORT_CAP),
            )
        })
        .await?;
    let resp = map_export_status(resp)?;
    let (content, warnings) = decode_export(&resp.body);
    Ok(ImportedDoc {
        file,
        format,
        content,
        warnings,
    })
}

fn map_export_status(resp: crate::netguard::NetResponse) -> Result<crate::netguard::NetResponse> {
    if resp.status == 403 && resp.text().contains("exportSizeLimitExceeded") {
        return Err(IntegrationError::TooLarge {
            cap: DOC_EXPORT_CAP,
        });
    }
    resp.error_for_status()
}

/// Decode an export body as UTF-8, replacing invalid sequences with a warning.
pub fn decode_export(body: &[u8]) -> (String, Vec<String>) {
    let body = body.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(body);
    match std::str::from_utf8(body) {
        Ok(s) => (s.to_string(), Vec::new()),
        Err(_) => (
            String::from_utf8_lossy(body).into_owned(),
            vec!["Some characters could not be decoded and were replaced.".to_string()],
        ),
    }
}

/// Export sanitised HTML as a Google Doc. With `existing_file_id` ("Export again") the file is
/// updated in place; if it no longer exists a new one is created.
/// Returns the file reference and whether a new file was created.
pub async fn export_document(
    session: &GoogleSession,
    title: &str,
    sanitized_html: &str,
    existing_file_id: Option<&str>,
) -> Result<(DriveFileRef, bool)> {
    let title = clean_title(title);
    if let Some(id) = existing_file_id {
        let resp = session
            .send(|tok| {
                drive::update_request(
                    tok,
                    id,
                    &title,
                    "text/html; charset=UTF-8",
                    sanitized_html.as_bytes(),
                )
            })
            .await?;
        if resp.status != 404 {
            return Ok((
                drive::parse_upload_response(&resp.error_for_status()?, "document")?,
                false,
            ));
        }
    }
    let resp = session
        .send(|tok| {
            drive::create_request(
                tok,
                &title,
                MIME_GOOGLE_DOC,
                "text/html; charset=UTF-8",
                sanitized_html.as_bytes(),
            )
        })
        .await?;
    Ok((
        drive::parse_upload_response(&resp.error_for_status()?, "document")?,
        true,
    ))
}

/// Trim, drop control characters, cap at 1,024 characters, default "Untitled".
pub(crate) fn clean_title(title: &str) -> String {
    let t: String = title
        .chars()
        .filter(|c| !c.is_control())
        .take(1024)
        .collect();
    let t = t.trim();
    if t.is_empty() {
        "Untitled".to_string()
    } else {
        t.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::netguard::testing::guard_for;
    use crate::oauth::{ClientCredentials, GoogleOAuth, TokenSet};
    use crate::secret::SecretString;
    use crate::testutil::{Reply, TestServer};

    fn session(guard: crate::NetGuard) -> GoogleSession {
        let oauth = GoogleOAuth::new(
            guard.clone(),
            ClientCredentials {
                client_id: "c".into(),
                client_secret: None,
            },
        );
        let tokens = TokenSet {
            access_token: SecretString::new("at"),
            expires_at: chrono::Utc::now() + chrono::Duration::hours(1),
            refresh_token: Some(SecretString::new("rt")),
            scopes: vec![],
            identity: None,
        };
        GoogleSession::from_tokens(guard, oauth, &tokens).unwrap()
    }

    const ID: &str = "1AbCdEfGhIjKlMnOpQrStUvWxYz";

    #[tokio::test]
    async fn imports_doc_as_html() {
        let server = TestServer::start(vec![
            Reply::json(200, &format!(r#"{{"id":"{ID}","name":"Trip plan","mimeType":"application/vnd.google-apps.document"}}"#)),
            Reply::new(200, "text/html; charset=utf-8", "\u{feff}<html><body><h1>Trip</h1></body></html>"),
        ])
        .await;
        let s = session(guard_for(&["www.googleapis.com"], server.addr()));
        let doc = import_document_export(
            &s,
            &format!("https://docs.google.com/document/d/{ID}/edit"),
            DocFormat::Html,
        )
        .await
        .unwrap();
        assert_eq!(doc.file.name, "Trip plan");
        assert!(doc.content.starts_with("<html>"));
        assert!(doc.warnings.is_empty());
        let reqs = server.requests();
        assert!(
            reqs[1]
                .path
                .contains(&format!("/drive/v3/files/{ID}/export?mimeType=text%2Fhtml"))
        );
        assert_eq!(reqs[1].header("authorization"), Some("Bearer at"));
    }

    #[tokio::test]
    async fn imports_via_docs_api_then_falls_back_to_export() {
        let server = TestServer::start(vec![
            Reply::json(
                200,
                r#"{"documentId":"d","title":"Plan","body":{"content":[{"paragraph":{"paragraphStyle":{"namedStyleType":"HEADING_2"},"elements":[{"textRun":{"content":"Hi\n"}}]}}]}}"#,
            ),
            // Second import: unparseable Docs payload → Drive export fallback.
            Reply::json(200, r#"{"body":{"content":"not-a-list"}}"#),
            Reply::json(
                200,
                &format!(r#"{{"id":"{ID}","name":"Plan","mimeType":"application/vnd.google-apps.document"}}"#),
            ),
            Reply::new(200, "text/html", "<p>exported</p>"),
        ])
        .await;
        let s = session(guard_for(
            &["docs.googleapis.com", "www.googleapis.com"],
            server.addr(),
        ));
        let url = format!("https://docs.google.com/document/d/{ID}/edit");
        let doc = import_document(&s, &url).await.unwrap();
        assert_eq!(doc.file.name, "Plan");
        assert_eq!(doc.content, "<h2>Hi</h2>");
        let doc = import_document(&s, &url).await.unwrap();
        assert_eq!(doc.content, "<p>exported</p>");
        assert!(doc.warnings[0].contains("HTML export"));
        let reqs = server.requests();
        assert_eq!(reqs[0].path, format!("/v1/documents/{ID}"));
    }

    #[tokio::test]
    async fn rejects_non_docs_and_markdown_works() {
        let server = TestServer::start(vec![
            Reply::json(200, &format!(r#"{{"id":"{ID}","name":"x","mimeType":"application/pdf"}}"#)),
            Reply::json(200, &format!(r#"{{"id":"{ID}","name":"x","mimeType":"application/vnd.google-apps.document"}}"#)),
            Reply::new(200, "text/markdown", "# Title\n"),
        ])
        .await;
        let s = session(guard_for(&["www.googleapis.com"], server.addr()));
        let err = import_document_export(&s, ID, DocFormat::Markdown)
            .await
            .unwrap_err();
        assert!(matches!(err, IntegrationError::Unsupported(_)));
        let doc = import_document_export(&s, ID, DocFormat::Markdown)
            .await
            .unwrap();
        assert_eq!(doc.content, "# Title\n");
    }

    #[tokio::test]
    async fn export_again_falls_back_to_create_on_404() {
        let server = TestServer::start(vec![
            Reply::json(404, r#"{"error":{"message":"File not found"}}"#),
            Reply::json(
                200,
                r#"{"id":"new","webViewLink":"https://docs.google.com/document/d/new/edit"}"#,
            ),
            Reply::json(
                200,
                r#"{"id":"new","webViewLink":"https://docs.google.com/document/d/new/edit"}"#,
            ),
        ])
        .await;
        let s = session(guard_for(&["www.googleapis.com"], server.addr()));
        let (r, created) = export_document(&s, " Notes\u{0007} ", "<p>Hi</p>", Some("gone"))
            .await
            .unwrap();
        assert!(created);
        assert_eq!(r.file_id, "new");
        let (_, created) = export_document(&s, "Notes", "<p>Hi</p>", Some("new"))
            .await
            .unwrap();
        assert!(!created);
        let reqs = server.requests();
        assert_eq!(reqs[0].method, "PATCH");
        assert_eq!(reqs[1].method, "POST");
        assert!(reqs[1].body_str().contains("\"name\":\"Notes\""));
        assert!(
            reqs[1]
                .header("content-type")
                .unwrap()
                .starts_with("multipart/related; boundary=")
        );
    }

    #[test]
    fn decode_reports_bad_utf8() {
        let (s, w) = decode_export(b"ok \xff");
        assert!(s.starts_with("ok"));
        assert_eq!(w.len(), 1);
        assert_eq!(clean_title("   "), "Untitled");
    }
}

//! Google Drive v3: file metadata, export, and multipart create/update (SPEC §17.1).

use rand_core::{OsRng, RngCore};
use serde::{Deserialize, Serialize};
use url::Url;

use super::path_segment;
use crate::error::{IntegrationError, Result};
use crate::netguard::{
    Body, BodyCap, ConnectorId, Credential, Expect, Method, NetRequest, NetResponse,
};
use crate::secret::SecretString;

/// Google Docs MIME type.
pub const MIME_GOOGLE_DOC: &str = "application/vnd.google-apps.document";
/// Google Sheets MIME type.
pub const MIME_GOOGLE_SHEET: &str = "application/vnd.google-apps.spreadsheet";

/// Drive file metadata.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFile {
    /// File id.
    pub id: String,
    /// File name (the document title).
    #[serde(default)]
    pub name: String,
    /// MIME type.
    #[serde(default)]
    pub mime_type: String,
    /// RFC 3339 modification time.
    #[serde(default)]
    pub modified_time: Option<String>,
    /// Browser link.
    #[serde(default)]
    pub web_view_link: Option<String>,
}

/// Result of a create/update upload: `{fileId, webViewLink}` in IPC terms.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DriveFileRef {
    /// Remote file id (store in `sync_links`).
    pub file_id: String,
    /// Browser link.
    pub web_view_link: String,
}

fn api_url(path: &str) -> Result<Url> {
    Url::parse(&format!("https://www.googleapis.com{path}"))
        .map_err(|e| IntegrationError::Internal(e.to_string()))
}

/// `GET /drive/v3/files/{id}?fields=…`.
pub fn metadata_request(token: &SecretString, file_id: &str) -> Result<NetRequest> {
    let mut url = api_url(&format!("/drive/v3/files/{}", path_segment(file_id)))?;
    url.query_pairs_mut()
        .append_pair("fields", "id,name,mimeType,modifiedTime,webViewLink")
        .append_pair("supportsAllDrives", "true");
    Ok(
        NetRequest::get(ConnectorId::Google, url, "/drive/v3/files/{id}")
            .credential(Credential::bearer(token)),
    )
}

/// `GET /drive/v3/files/{id}/export?mimeType=…` with the given cap.
pub fn export_request(
    token: &SecretString,
    file_id: &str,
    mime: &str,
    expect: Expect,
    cap: BodyCap,
) -> Result<NetRequest> {
    let mut url = api_url(&format!("/drive/v3/files/{}/export", path_segment(file_id)))?;
    url.query_pairs_mut().append_pair("mimeType", mime);
    Ok(
        NetRequest::get(ConnectorId::Google, url, "/drive/v3/files/{id}/export")
            .credential(Credential::bearer(token))
            .expect(expect)
            .cap(cap),
    )
}

/// Build a `multipart/related` body (metadata JSON + media). The boundary is random and
/// guaranteed not to occur in either part.
pub fn multipart_related(metadata: &serde_json::Value, media_type: &str, media: &[u8]) -> Body {
    let meta = metadata.to_string();
    let boundary = loop {
        let mut b = [0u8; 16];
        OsRng.fill_bytes(&mut b);
        let candidate = format!(
            "emp-{}",
            b.iter().map(|x| format!("{x:02x}")).collect::<String>()
        );
        let needle = candidate.as_bytes();
        let clash = meta.contains(&candidate) || media.windows(needle.len()).any(|w| w == needle);
        if !clash {
            break candidate;
        }
    };
    let mut bytes = Vec::with_capacity(meta.len() + media.len() + 256);
    bytes.extend_from_slice(
        format!("--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n").as_bytes(),
    );
    bytes.extend_from_slice(meta.as_bytes());
    bytes.extend_from_slice(
        format!("\r\n--{boundary}\r\nContent-Type: {media_type}\r\n\r\n").as_bytes(),
    );
    bytes.extend_from_slice(media);
    bytes.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    Body {
        content_type: format!("multipart/related; boundary={boundary}"),
        bytes,
    }
}

/// `POST /upload/drive/v3/files?uploadType=multipart` creating a file converted to
/// `target_mime` (e.g. [`MIME_GOOGLE_DOC`]). Scope: `drive.file`.
pub fn create_request(
    token: &SecretString,
    name: &str,
    target_mime: &str,
    media_type: &str,
    media: &[u8],
) -> Result<NetRequest> {
    let mut url = api_url("/upload/drive/v3/files")?;
    url.query_pairs_mut()
        .append_pair("uploadType", "multipart")
        .append_pair("fields", "id,webViewLink");
    let meta = serde_json::json!({ "name": name, "mimeType": target_mime });
    Ok(NetRequest::with_body(
        ConnectorId::Google,
        Method::Post,
        url,
        "/upload/drive/v3/files",
        multipart_related(&meta, media_type, media),
    )
    .credential(Credential::bearer(token)))
}

/// `PATCH /upload/drive/v3/files/{id}?uploadType=multipart` replacing content ("Export again").
pub fn update_request(
    token: &SecretString,
    file_id: &str,
    name: &str,
    media_type: &str,
    media: &[u8],
) -> Result<NetRequest> {
    let mut url = api_url(&format!("/upload/drive/v3/files/{}", path_segment(file_id)))?;
    url.query_pairs_mut()
        .append_pair("uploadType", "multipart")
        .append_pair("fields", "id,webViewLink");
    let meta = serde_json::json!({ "name": name });
    Ok(NetRequest::with_body(
        ConnectorId::Google,
        Method::Patch,
        url,
        "/upload/drive/v3/files/{id}",
        multipart_related(&meta, media_type, media),
    )
    .credential(Credential::bearer(token)))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct UploadResponse {
    id: String,
    web_view_link: Option<String>,
}

/// Parse a create/update response.
pub fn parse_upload_response(resp: &NetResponse, fallback_link_kind: &str) -> Result<DriveFileRef> {
    let r: UploadResponse = resp.json()?;
    let link = r.web_view_link.unwrap_or_else(|| {
        format!(
            "https://docs.google.com/{fallback_link_kind}/d/{}/edit",
            r.id
        )
    });
    Ok(DriveFileRef {
        file_id: r.id,
        web_view_link: link,
    })
}

/// Parse file metadata.
pub fn parse_metadata(resp: &NetResponse) -> Result<DriveFile> {
    resp.json()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn multipart_body_is_well_formed() {
        let body = multipart_related(
            &serde_json::json!({"name":"T"}),
            "text/html; charset=UTF-8",
            b"<p>x</p>",
        );
        let boundary = body
            .content_type
            .strip_prefix("multipart/related; boundary=")
            .unwrap();
        let text = String::from_utf8(body.bytes).unwrap();
        assert!(text.starts_with(&format!("--{boundary}\r\nContent-Type: application/json")));
        assert!(text.contains("{\"name\":\"T\"}"));
        assert!(text.contains("<p>x</p>"));
        assert!(text.ends_with(&format!("\r\n--{boundary}--\r\n")));
        assert_eq!(text.matches(&format!("--{boundary}")).count(), 3);
    }

    #[test]
    fn request_shapes() {
        let tok = SecretString::new("t");
        let r = create_request(&tok, "My doc", MIME_GOOGLE_DOC, "text/html", b"<p/>").unwrap();
        assert_eq!(r.method, Method::Post);
        assert_eq!(r.url.path(), "/upload/drive/v3/files");
        assert!(r.url.query().unwrap().contains("uploadType=multipart"));
        let body = String::from_utf8(r.body.unwrap().bytes).unwrap();
        assert!(body.contains(MIME_GOOGLE_DOC));

        let r = update_request(&tok, "abc/def", "n", "text/html", b"").unwrap();
        assert_eq!(r.method, Method::Patch);
        assert_eq!(r.url.path(), "/upload/drive/v3/files/abc%2Fdef");
        assert_eq!(r.path_template, "/upload/drive/v3/files/{id}");

        let r = export_request(&tok, "id1", "text/html", Expect::Html, BodyCap::Bytes(10)).unwrap();
        assert_eq!(
            r.url.as_str(),
            "https://www.googleapis.com/drive/v3/files/id1/export?mimeType=text%2Fhtml"
        );
    }

    #[test]
    fn parses_upload_and_metadata() {
        let resp = NetResponse {
            status: 200,
            content_type: Some("application/json".into()),
            retry_after: None,
            body: br#"{"id":"f1","webViewLink":"https://docs.google.com/document/d/f1/edit?usp=drivesdk"}"#.to_vec(),
            final_url: Url::parse("https://www.googleapis.com/").unwrap(),
        };
        let r = parse_upload_response(&resp, "document").unwrap();
        assert_eq!(r.file_id, "f1");
        let resp = NetResponse {
            body: br#"{"id":"f2"}"#.to_vec(),
            ..resp
        };
        assert_eq!(
            parse_upload_response(&resp, "spreadsheets")
                .unwrap()
                .web_view_link,
            "https://docs.google.com/spreadsheets/d/f2/edit"
        );
        let resp = NetResponse {
            body: br#"{"id":"f3","name":"Plan","mimeType":"application/vnd.google-apps.document","modifiedTime":"2026-11-01T10:00:00.000Z"}"#.to_vec(),
            ..resp
        };
        let m = parse_metadata(&resp).unwrap();
        assert_eq!(m.name, "Plan");
        assert_eq!(m.mime_type, MIME_GOOGLE_DOC);
    }
}

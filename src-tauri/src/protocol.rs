//! The `emp-asset` URI scheme (D-09, SPEC §9.7, §11.1 "Binary data and files").
//!
//! `emp-asset://localhost/<assetId>` on macOS and Linux and `http://emp-asset.localhost/<assetId>` on Windows (Tauri
//! maps custom schemes to that form there). Assets are decrypted on the fly; `Range` requests are answered with
//! `206 Partial Content` so media can seek. While the vault is locked every request gets `403`.

use std::io::Read;

use tauri::http::{Request, Response, StatusCode, header};

/// Largest slice served for one open-ended or suffix range.
pub const RANGE_CHUNK: u64 = 4 * 1024 * 1024;
/// Largest body served without a `Range` header (images are capped at 50 MiB on import; anything larger is served
/// in [`RANGE_CHUNK`] slices so a handful of concurrent requests cannot buffer gigabytes).
pub const MAX_FULL_BODY: u64 = 64 * 1024 * 1024;

/// The URL prefix of asset URLs on this platform (handed to the store, which builds `AssetDTO.url`).
#[must_use]
pub const fn asset_url_base() -> &'static str {
    if cfg!(windows) {
        "http://emp-asset.localhost/"
    } else {
        "emp-asset://localhost/"
    }
}

/// Extracts the asset id from a request path (`/<32 hex>`, optionally followed by `/<name>`), or `None`.
#[must_use]
pub fn asset_id_from_path(path: &str) -> Option<&str> {
    let p = path.strip_prefix('/')?;
    let id = p.split('/').next()?;
    emp_store::model::ids::is_asset_id(id).then_some(id)
}

/// A resolved byte range (inclusive end).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ByteRange {
    /// First byte.
    pub start: u64,
    /// Last byte (inclusive).
    pub end: u64,
}

impl ByteRange {
    /// Number of bytes.
    #[must_use]
    pub fn len(&self) -> u64 {
        self.end - self.start + 1
    }

    /// Never true (a range holds at least one byte); present for API symmetry.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        false
    }
}

/// The outcome of parsing a `Range` header against a resource of `size` bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RangeRequest {
    /// No (usable) range: serve the whole body.
    Full,
    /// Serve this slice with `206`.
    Partial(ByteRange),
    /// The range cannot be satisfied: `416`.
    Unsatisfiable,
}

/// Parses `bytes=a-b`, `bytes=a-` and `bytes=-n` (only the first range of a list is honoured). Open-ended and suffix
/// ranges are capped at [`RANGE_CHUNK`] bytes.
#[must_use]
pub fn parse_range(header: Option<&str>, size: u64) -> RangeRequest {
    let Some(h) = header else {
        return RangeRequest::Full;
    };
    let Some(spec) = h.trim().strip_prefix("bytes=") else {
        return RangeRequest::Full;
    };
    let first = spec.split(',').next().unwrap_or("").trim();
    let Some((a, b)) = first.split_once('-') else {
        return RangeRequest::Full;
    };
    if size == 0 {
        return RangeRequest::Unsatisfiable;
    }
    let last = size - 1;
    let (a, b) = (a.trim(), b.trim());
    let range = if a.is_empty() {
        let Ok(n) = b.parse::<u64>() else {
            return RangeRequest::Full;
        };
        if n == 0 {
            return RangeRequest::Unsatisfiable;
        }
        let n = n.min(size).min(RANGE_CHUNK);
        ByteRange {
            start: size - n,
            end: last,
        }
    } else {
        let Ok(start) = a.parse::<u64>() else {
            return RangeRequest::Full;
        };
        if start > last {
            return RangeRequest::Unsatisfiable;
        }
        let end = if b.is_empty() {
            last.min(start.saturating_add(RANGE_CHUNK - 1))
        } else {
            let Ok(end) = b.parse::<u64>() else {
                return RangeRequest::Full;
            };
            if end < start {
                return RangeRequest::Unsatisfiable;
            }
            end.min(last).min(start.saturating_add(RANGE_CHUNK - 1))
        };
        ByteRange { start, end }
    };
    RangeRequest::Partial(range)
}

/// Decodes `%XX` escapes (invalid escapes are kept verbatim; invalid UTF-8 is replaced).
#[must_use]
pub fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let hex = |b: u8| (b as char).to_digit(16).and_then(|d| u8::try_from(d).ok());
    while let Some(&b) = bytes.get(i) {
        if b == b'%' {
            if let (Some(h), Some(l)) = (
                bytes.get(i + 1).copied().and_then(hex),
                bytes.get(i + 2).copied().and_then(hex),
            ) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// MIME types served for inline display (SPEC §9.7): raster images, and video/audio for `<video>` / `<audio>`.
/// SVG is deliberately not on the list (it is served as a download type, stricter than §9.7).
pub const INLINE_TYPES: &[&str] = &[
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "video/mp4",
    "video/webm",
];

/// `true` for an `audio/<subtype>` type with a plain subtype.
fn is_inline_audio(m: &str) -> bool {
    m.strip_prefix("audio/").is_some_and(|sub| {
        !sub.is_empty()
            && sub
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || matches!(b, b'-' | b'.'))
    })
}

/// A safe `Content-Type` for an asset: only the inline allowlist ([`INLINE_TYPES`], `audio/*`) keeps its type;
/// everything else (HTML, SVG, XML, scripts, PDFs, text, unknown) is served as an opaque download type so it can
/// never be interpreted in the app origin.
#[must_use]
pub fn safe_content_type(mime: &str) -> &str {
    if is_inline_type(mime) {
        mime
    } else {
        "application/octet-stream"
    }
}

/// `true` when `mime` (exactly, lowercase, no parameters) may be displayed inline.
#[must_use]
pub fn is_inline_type(mime: &str) -> bool {
    INLINE_TYPES.contains(&mime) || is_inline_audio(mime)
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    let mut r = Response::new(Vec::new());
    *r.status_mut() = status;
    r.headers_mut().insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    r
}

fn with_common(mut r: Response<Vec<u8>>, mime: &str) -> Response<Vec<u8>> {
    let h = r.headers_mut();
    if let Ok(v) = header::HeaderValue::from_str(safe_content_type(mime)) {
        h.insert(header::CONTENT_TYPE, v);
    }
    h.insert(
        header::CACHE_CONTROL,
        header::HeaderValue::from_static("no-store"),
    );
    h.insert(
        header::ACCEPT_RANGES,
        header::HeaderValue::from_static("bytes"),
    );
    h.insert(
        "x-content-type-options",
        header::HeaderValue::from_static("nosniff"),
    );
    h.insert(
        header::CONTENT_SECURITY_POLICY,
        header::HeaderValue::from_static("default-src 'none'; sandbox"),
    );
    if !is_inline_type(mime) {
        h.insert(
            header::CONTENT_DISPOSITION,
            header::HeaderValue::from_static("attachment"),
        );
    }
    r
}

/// Serves one asset request from `store` (blocking; call it from the blocking pool).
pub fn serve(store: Option<&emp_store::Store>, req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if req.method() != tauri::http::Method::GET && req.method() != tauri::http::Method::HEAD {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }
    let Some(store) = store.filter(|s| s.is_unlocked()) else {
        return empty(StatusCode::FORBIDDEN);
    };
    let Some(id) = asset_id_from_path(req.uri().path()) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(meta) = store.asset_get(&[id.to_owned()]) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some(meta) = meta.into_iter().next() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let size = meta.size;
    let range_header = req
        .headers()
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok());
    let head = req.method() == tauri::http::Method::HEAD;
    match parse_range(range_header, size) {
        RangeRequest::Unsatisfiable => {
            let mut r = empty(StatusCode::RANGE_NOT_SATISFIABLE);
            if let Ok(v) = header::HeaderValue::from_str(&format!("bytes */{size}")) {
                r.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            r
        }
        RangeRequest::Partial(range) => {
            let body = if head {
                Vec::new()
            } else {
                match store.asset_read_range(id, range.start, range.len()) {
                    Ok(b) => b,
                    Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
                }
            };
            let end = range.start + (body.len() as u64).max(1) - 1;
            let end = if head { range.end } else { end };
            let mut r = with_common(Response::new(body), &meta.mime);
            *r.status_mut() = StatusCode::PARTIAL_CONTENT;
            if let Ok(v) =
                header::HeaderValue::from_str(&format!("bytes {}-{end}/{size}", range.start))
            {
                r.headers_mut().insert(header::CONTENT_RANGE, v);
            }
            r
        }
        RangeRequest::Full => {
            if size > MAX_FULL_BODY {
                // Too large to buffer: serve the first chunk as a partial response.
                let range = ByteRange {
                    start: 0,
                    end: RANGE_CHUNK - 1,
                };
                let body = if head {
                    Vec::new()
                } else {
                    match store.asset_read_range(id, 0, range.len()) {
                        Ok(b) => b,
                        Err(_) => return empty(StatusCode::INTERNAL_SERVER_ERROR),
                    }
                };
                let mut r = with_common(Response::new(body), &meta.mime);
                *r.status_mut() = StatusCode::PARTIAL_CONTENT;
                if let Ok(v) =
                    header::HeaderValue::from_str(&format!("bytes 0-{}/{size}", range.end))
                {
                    r.headers_mut().insert(header::CONTENT_RANGE, v);
                }
                return r;
            }
            let body = if head {
                Vec::new()
            } else {
                let Ok(mut stream) = store.asset_open(id) else {
                    return empty(StatusCode::INTERNAL_SERVER_ERROR);
                };
                let mut buf = Vec::with_capacity(usize::try_from(size).unwrap_or(0));
                if stream
                    .reader
                    .by_ref()
                    .take(MAX_FULL_BODY)
                    .read_to_end(&mut buf)
                    .is_err()
                {
                    return empty(StatusCode::INTERNAL_SERVER_ERROR);
                }
                buf
            };
            with_common(Response::new(body), &meta.mime)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "0123456789abcdef0123456789abcdef";

    #[test]
    fn extracts_asset_ids() {
        assert_eq!(asset_id_from_path(&format!("/{ID}")), Some(ID));
        assert_eq!(asset_id_from_path(&format!("/{ID}/photo.png")), Some(ID));
        assert_eq!(asset_id_from_path("/../vault.db"), None);
        assert_eq!(asset_id_from_path("/"), None);
        assert_eq!(asset_id_from_path(ID), None);
        assert_eq!(asset_id_from_path(&format!("/{}", ID.to_uppercase())), None);
    }

    #[test]
    fn parses_ranges() {
        let r = |h: &str, size| parse_range(Some(h), size);
        assert_eq!(parse_range(None, 10), RangeRequest::Full);
        assert_eq!(
            r("bytes=0-4", 10),
            RangeRequest::Partial(ByteRange { start: 0, end: 4 })
        );
        assert_eq!(
            r("bytes=5-", 10),
            RangeRequest::Partial(ByteRange { start: 5, end: 9 })
        );
        assert_eq!(
            r("bytes=-3", 10),
            RangeRequest::Partial(ByteRange { start: 7, end: 9 })
        );
        assert_eq!(
            r("bytes=0-100", 10),
            RangeRequest::Partial(ByteRange { start: 0, end: 9 })
        );
        assert_eq!(r("bytes=10-", 10), RangeRequest::Unsatisfiable);
        assert_eq!(r("bytes=5-2", 10), RangeRequest::Unsatisfiable);
        assert_eq!(r("bytes=-0", 10), RangeRequest::Unsatisfiable);
        assert_eq!(r("bytes=0-", 0), RangeRequest::Unsatisfiable);
        assert_eq!(r("items=0-1", 10), RangeRequest::Full);
        assert_eq!(r("bytes=x-1", 10), RangeRequest::Full);
        assert_eq!(
            r("bytes=0-1, 4-5", 10),
            RangeRequest::Partial(ByteRange { start: 0, end: 1 })
        );
    }

    #[test]
    fn caps_open_ranges() {
        let big = 100 * 1024 * 1024;
        match parse_range(Some("bytes=0-"), big) {
            RangeRequest::Partial(r) => assert_eq!(r.len(), RANGE_CHUNK),
            other => panic!("{other:?}"),
        }
        match parse_range(Some("bytes=0-99999999"), big) {
            RangeRequest::Partial(r) => assert_eq!(r.len(), RANGE_CHUNK),
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn decodes_percent_escapes() {
        assert_eq!(percent_decode("caf%C3%A9%20menu.png"), "café menu.png");
        assert_eq!(percent_decode("100%"), "100%");
        assert_eq!(percent_decode("%zz"), "%zz");
        assert_eq!(percent_decode("a%2"), "a%2");
    }

    #[test]
    fn neutralises_active_content_types() {
        assert_eq!(safe_content_type("image/png"), "image/png");
        assert_eq!(
            safe_content_type("image/svg+xml"),
            "application/octet-stream"
        );
        assert_eq!(safe_content_type("text/html"), "application/octet-stream");
        assert_eq!(safe_content_type(""), "application/octet-stream");
        assert_eq!(
            safe_content_type("text/plain\r\nx: y"),
            "application/octet-stream"
        );
    }

    #[test]
    fn only_allowlisted_types_render_inline() {
        for m in [
            "image/png",
            "image/jpeg",
            "image/webp",
            "video/mp4",
            "audio/mpeg",
            "audio/ogg",
        ] {
            assert_eq!(safe_content_type(m), m);
        }
        for m in [
            "text/plain",
            "text/css",
            "application/pdf",
            "application/json",
            "image/x-icon",
            "image/svg+xml",
            "text/xml",
            "multipart/x-mixed-replace",
            "IMAGE/PNG",
            "image/png; charset=x",
            "audio/",
            "audio/x;y",
        ] {
            assert_eq!(safe_content_type(m), "application/octet-stream", "{m}");
        }
    }

    #[test]
    fn locked_store_is_forbidden() {
        let req = Request::builder()
            .uri(format!("emp-asset://localhost/{ID}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(serve(None, &req).status(), StatusCode::FORBIDDEN);
        let post = Request::builder()
            .method("POST")
            .uri(format!("emp-asset://localhost/{ID}"))
            .body(Vec::new())
            .unwrap();
        assert_eq!(serve(None, &post).status(), StatusCode::METHOD_NOT_ALLOWED);
    }

    #[test]
    fn url_base_matches_d09() {
        let base = asset_url_base();
        assert!(base == "emp-asset://localhost/" || base == "http://emp-asset.localhost/");
    }

    fn temp_store() -> (tempfile::TempDir, emp_store::Store) {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = emp_store::StoreOptions::new(dir.path().join("device.key"));
        opts.background_indexing = false;
        let created = emp_store::Store::create(
            dir.path(),
            emp_store::CreateOptions {
                password: None,
                kdf: emp_crypto::KdfParams::INSECURE_TEST,
                auto_lock: emp_store::model::AutoLock::default(),
                workspace_name: Some("Test".into()),
            },
            opts,
        )
        .unwrap();
        (dir, created.store)
    }

    /// A valid 1×1 PNG.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1F,
        0x15, 0xC4, 0x89, 0x00, 0x00, 0x00, 0x0D, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9C, 0x63, 0x00,
        0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0D, 0x0A, 0x2D, 0xB4, 0x00, 0x00, 0x00, 0x00, 0x49,
        0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82,
    ];

    fn get(store: &emp_store::Store, id: &str, range: Option<&str>) -> Response<Vec<u8>> {
        let mut b = Request::builder().uri(format!("emp-asset://localhost/{id}"));
        if let Some(r) = range {
            b = b.header(header::RANGE, r);
        }
        serve(Some(store), &b.body(Vec::new()).unwrap())
    }

    #[test]
    fn serves_assets_and_ranges_from_a_real_store() {
        let (_dir, store) = temp_store();
        let ws = store.workspace_list().unwrap().remove(0);
        let body: Vec<u8> = (0..=255u8).cycle().take(10_000).collect();
        let asset = store
            .asset_import_bytes(&ws.id, "data.bin", "application/octet-stream", &body)
            .unwrap();
        assert!(asset.url.starts_with(asset_url_base()));

        let full = get(&store, &asset.id, None);
        assert_eq!(full.status(), StatusCode::OK);
        assert_eq!(full.body(), &body);
        assert_eq!(full.headers()["x-content-type-options"], "nosniff");
        assert_eq!(full.headers()[header::CACHE_CONTROL], "no-store");
        // Not an inline type: an opaque download, never rendered.
        assert_eq!(
            full.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(full.headers()[header::CONTENT_DISPOSITION], "attachment");

        let png = store
            .asset_import_bytes(&ws.id, "pixel.png", "image/png", PNG_1X1)
            .unwrap();
        let img = get(&store, &png.id, None);
        assert_eq!(img.status(), StatusCode::OK);
        assert_eq!(img.headers()[header::CONTENT_TYPE], "image/png");
        assert!(img.headers().get(header::CONTENT_DISPOSITION).is_none());

        let html = store
            .asset_import_bytes(
                &ws.id,
                "page.html",
                "text/html",
                b"<script>alert(1)</script>",
            )
            .unwrap();
        let page = get(&store, &html.id, None);
        assert_eq!(
            page.headers()[header::CONTENT_TYPE],
            "application/octet-stream"
        );
        assert_eq!(page.headers()[header::CONTENT_DISPOSITION], "attachment");
        assert_eq!(
            page.headers()[header::CONTENT_SECURITY_POLICY],
            "default-src 'none'; sandbox"
        );

        let part = get(&store, &asset.id, Some("bytes=100-199"));
        assert_eq!(part.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(part.body().as_slice(), &body[100..200]);
        assert_eq!(part.headers()[header::CONTENT_RANGE], "bytes 100-199/10000");

        let tail = get(&store, &asset.id, Some("bytes=-10"));
        assert_eq!(tail.body().as_slice(), &body[9_990..]);

        let bad = get(&store, &asset.id, Some("bytes=20000-"));
        assert_eq!(bad.status(), StatusCode::RANGE_NOT_SATISFIABLE);

        let missing = get(&store, &"f".repeat(32), None);
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);

        store.lock().unwrap();
        assert_eq!(get(&store, &asset.id, None).status(), StatusCode::FORBIDDEN);
        store.close().unwrap();
    }

    #[test]
    fn locked_store_errors_map_to_locked() {
        let (_dir, store) = temp_store();
        store.lock().unwrap();
        let e: crate::error::ApiError = store.workspace_list().unwrap_err().into();
        assert_eq!(e.code, crate::error::ErrorCode::Locked);
        store.close().unwrap();
    }
}

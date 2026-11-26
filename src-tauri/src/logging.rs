//! Logging (SPEC §9.23 "Logging").
//!
//! `tracing` writes to `<data>/logs/emp.log`, rotated at 5 × 5 MiB, at level `info` in release builds. A redaction
//! formatter drops every field whose name contains `token`, `secret`, `password` or `key`. Callers must still never
//! log record content, titles, queries, file names or URLs with query strings — hash them instead
//! ([`hash_for_log`]).

use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use parking_lot::Mutex;
use sha2::{Digest, Sha256};
use tracing::field::Field;
use tracing_subscriber::fmt::MakeWriter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;

/// Rotate when the active file reaches this size.
pub const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;
/// Files kept: `emp.log` plus `emp.log.1` … `emp.log.4`.
pub const LOG_FILES: usize = 5;
/// The active log file name.
pub const LOG_FILE: &str = "emp.log";

/// `true` for field names the redaction layer drops.
#[must_use]
pub fn is_redacted_field(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    ["token", "secret", "password", "key"]
        .iter()
        .any(|p| n.contains(p))
}

/// A short, non-reversible tag for values that must not be logged verbatim (file names, ids of user content).
#[must_use]
pub fn hash_for_log(value: &str) -> String {
    let d = Sha256::digest(value.as_bytes());
    hex::encode(&d[..6])
}

/// A size-rotated log file.
pub struct RotatingFile {
    dir: PathBuf,
    file: Option<File>,
    size: u64,
    max_bytes: u64,
    keep: usize,
}

fn open_private(path: &Path) -> io::Result<File> {
    let mut o = OpenOptions::new();
    o.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

impl RotatingFile {
    /// Opens (or creates) `dir/emp.log`.
    pub fn open(dir: &Path, max_bytes: u64, keep: usize) -> io::Result<Self> {
        std::fs::create_dir_all(dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
        }
        let path = dir.join(LOG_FILE);
        let file = open_private(&path)?;
        let size = file.metadata().map(|m| m.len()).unwrap_or(0);
        Ok(Self {
            dir: dir.to_path_buf(),
            file: Some(file),
            size,
            max_bytes: max_bytes.max(1024),
            keep: keep.max(1),
        })
    }

    fn rotated(&self, n: usize) -> PathBuf {
        self.dir.join(format!("{LOG_FILE}.{n}"))
    }

    fn rotate(&mut self) -> io::Result<()> {
        self.file = None;
        let oldest = self.rotated(self.keep - 1);
        if self.keep > 1 {
            let _ = std::fs::remove_file(&oldest);
            for n in (1..self.keep - 1).rev() {
                let from = self.rotated(n);
                if from.exists() {
                    std::fs::rename(&from, self.rotated(n + 1))?;
                }
            }
            std::fs::rename(self.dir.join(LOG_FILE), self.rotated(1))?;
        } else {
            std::fs::remove_file(self.dir.join(LOG_FILE))?;
        }
        self.file = Some(open_private(&self.dir.join(LOG_FILE))?);
        self.size = 0;
        Ok(())
    }
}

impl Write for RotatingFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if self.size > 0 && self.size + buf.len() as u64 > self.max_bytes {
            self.rotate()?;
        }
        let f = self
            .file
            .as_mut()
            .ok_or_else(|| io::Error::other("log file closed"))?;
        let n = f.write(buf)?;
        self.size += n as u64;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.as_mut().map_or(Ok(()), Write::flush)
    }
}

/// A cloneable writer handle for `tracing_subscriber`.
#[derive(Clone)]
pub struct SharedLog(Arc<Mutex<RotatingFile>>);

/// One write through [`SharedLog`].
pub struct SharedLogGuard(Arc<Mutex<RotatingFile>>);

impl Write for SharedLogGuard {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        self.0.lock().write(buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.0.lock().flush()
    }
}

impl<'a> MakeWriter<'a> for SharedLog {
    type Writer = SharedLogGuard;
    fn make_writer(&'a self) -> Self::Writer {
        SharedLogGuard(Arc::clone(&self.0))
    }
}

fn redacting_fields()
-> impl for<'w> tracing_subscriber::fmt::FormatFields<'w> + Send + Sync + 'static {
    tracing_subscriber::fmt::format::debug_fn(
        |w: &mut tracing_subscriber::fmt::format::Writer<'_>,
         field: &Field,
         value: &dyn std::fmt::Debug| {
            if is_redacted_field(field.name()) {
                return Ok(());
            }
            if field.name() == "message" {
                write!(w, "{value:?} ")
            } else {
                write!(w, "{}={value:?} ", field.name())
            }
        },
    )
}

/// Crates whose events are logged at the build's level; every other target (HTTP, TLS, D-Bus, webview internals)
/// is limited to warnings, so dependency debug output (request URLs with query strings, message dumps) never reaches
/// the log file even in debug builds.
pub const EMP_TARGETS: &[&str] = &[
    "emp_lib",
    "emp_app",
    "emp_store",
    "emp_crypto",
    "emp_sheets",
    "emp_finance",
    "emp_integrations",
];

/// The per-target filter used by [`init`].
#[must_use]
pub fn log_filter(level: tracing::Level) -> tracing_subscriber::filter::Targets {
    EMP_TARGETS.iter().fold(
        tracing_subscriber::filter::Targets::new().with_default(tracing::Level::WARN),
        |t, name| t.with_target(*name, level),
    )
}

/// Installs the global subscriber. Logs go to `logs_dir/emp.log`; debug builds also log to stderr. Failure to open
/// the file leaves stderr-only logging in debug builds and no logging in release builds.
pub fn init(logs_dir: &Path) {
    let level = if cfg!(debug_assertions) {
        tracing::Level::DEBUG
    } else {
        tracing::Level::INFO
    };
    let filter = log_filter(level);
    let file_layer = RotatingFile::open(logs_dir, MAX_LOG_BYTES, LOG_FILES)
        .ok()
        .map(|f| {
            tracing_subscriber::fmt::layer()
                .with_ansi(false)
                .with_target(true)
                .fmt_fields(redacting_fields())
                .with_writer(SharedLog(Arc::new(Mutex::new(f))))
        });
    let stderr_layer = cfg!(debug_assertions).then(|| {
        tracing_subscriber::fmt::layer()
            .with_target(true)
            .fmt_fields(redacting_fields())
            .with_writer(io::stderr)
    });
    let _ = tracing_subscriber::registry()
        .with(filter)
        .with(file_layer)
        .with(stderr_layer)
        .try_init();
}

/// Installs a panic hook that logs only the panic location (never the payload, which may hold user data) and, for
/// panics outside [`crate::jobs::catch_panics`], schedules a lock with reason `panic`.
pub fn install_panic_hook() {
    std::panic::set_hook(Box::new(|info| {
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown".into());
        let contained = crate::jobs::in_panic_boundary();
        tracing::error!(%location, contained, "panic");
        if !contained {
            // Outside a catch_unwind boundary: the ticker locks the vault (D-15).
            crate::state::PANICKED.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_sensitive_field_names() {
        for f in [
            "token",
            "access_token",
            "apiKey",
            "secret_id",
            "password",
            "KEY",
            "keychain",
        ] {
            assert!(is_redacted_field(f), "{f}");
        }
        for f in ["message", "count", "code", "kind", "status"] {
            assert!(!is_redacted_field(f), "{f}");
        }
    }

    #[test]
    fn dependency_debug_output_is_filtered() {
        use tracing::Level;
        let f = log_filter(Level::DEBUG);
        let enabled = |target: &str, level: Level| f.would_enable(target, &level);
        assert!(enabled("emp_lib::commands::app", Level::DEBUG));
        assert!(enabled("emp_integrations::netguard", Level::INFO));
        assert!(!enabled("reqwest::connect", Level::DEBUG));
        assert!(!enabled("hyper_util::client", Level::INFO));
        assert!(!enabled("zbus::connection", Level::INFO));
        assert!(enabled("zbus::connection", Level::WARN));
        let release = log_filter(Level::INFO);
        assert!(!release.would_enable("emp_store::vault", &Level::DEBUG));
        assert!(release.would_enable("emp_store::vault", &Level::INFO));
    }

    #[test]
    fn hashes_are_short_and_stable() {
        assert_eq!(hash_for_log("report.csv"), hash_for_log("report.csv"));
        assert_eq!(hash_for_log("x").len(), 12);
        assert_ne!(hash_for_log("a"), hash_for_log("b"));
    }

    #[test]
    fn rotates_by_size_and_keeps_five_files() {
        let dir = tempfile::tempdir().unwrap();
        let mut f = RotatingFile::open(dir.path(), 1024, 5).unwrap();
        let line = vec![b'x'; 300];
        for _ in 0..40 {
            f.write_all(&line).unwrap();
        }
        f.flush().unwrap();
        let mut names: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            [
                "emp.log",
                "emp.log.1",
                "emp.log.2",
                "emp.log.3",
                "emp.log.4"
            ]
        );
        for n in &names {
            let len = std::fs::metadata(dir.path().join(n)).unwrap().len();
            assert!(len <= 1024, "{n} is {len} bytes");
        }
    }

    #[cfg(unix)]
    #[test]
    fn log_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        let _f = RotatingFile::open(&logs, 1024, 5).unwrap();
        let mode = std::fs::metadata(logs.join(LOG_FILE))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o077, 0);
        let mode = std::fs::metadata(&logs).unwrap().permissions().mode();
        assert_eq!(mode & 0o077, 0);
    }
}

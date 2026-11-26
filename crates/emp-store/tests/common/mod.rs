#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicI64, Ordering};

use emp_crypto::{KdfParams, SecretString};
use emp_store::model::{AutoLock, DocOwnerKind, PageCreate, PageKind, TipTapDoc, TipTapNode};
use emp_store::{Clock, CreateOptions, Store, StoreOptions};

pub const PASSWORD: &str = "correct horse battery staple";
pub const T0: i64 = 1_790_000_000_000;

#[derive(Debug)]
pub struct ManualClock(pub AtomicI64);

impl Clock for ManualClock {
    fn now_ms(&self) -> i64 {
        self.0.load(Ordering::SeqCst)
    }
}

pub struct Env {
    pub dir: tempfile::TempDir,
    pub clock: Arc<ManualClock>,
    pub store: Store,
}

impl Env {
    pub fn advance(&self, ms: i64) {
        self.clock.0.fetch_add(ms, Ordering::SeqCst);
    }

    pub fn vault_dir(&self) -> PathBuf {
        self.store.paths().root().to_owned()
    }

    pub fn opts(&self) -> StoreOptions {
        options(self.dir.path(), &self.clock)
    }

    /// Closes the store and reopens it (locked).
    pub fn reopen(&mut self) {
        let dir = self.vault_dir();
        self.store.close().unwrap();
        self.store = Store::open(&dir, self.opts()).unwrap();
    }

    pub fn workspace(&self) -> String {
        self.store.workspace_list().unwrap().remove(0).id
    }

    pub fn page(&self, parent: Option<&str>, title: &str) -> String {
        let ws = self.workspace();
        self.store
            .page_create(PageCreate::new(&ws, parent, PageKind::Doc, title))
            .unwrap()
            .meta
            .id
    }

    pub fn save_text(&self, page: &str, paragraphs: &[&str]) -> i64 {
        let rev = self.store.page_get(page).unwrap().doc_rev;
        self.store
            .page_save_doc(page, DocOwnerKind::Page, doc_of(paragraphs), rev)
            .unwrap()
    }

    pub fn db(&self) -> rusqlite::Connection {
        rusqlite::Connection::open(self.vault_dir().join("vault.db")).unwrap()
    }
}

pub fn pw(s: &str) -> SecretString {
    SecretString::from(s.to_owned())
}

pub fn options(data: &Path, clock: &Arc<ManualClock>) -> StoreOptions {
    let mut o = StoreOptions::new(data.join("device.key"));
    o.clock = clock.clone();
    o.background_indexing = false;
    o
}

pub fn env(encrypted: bool) -> Env {
    let dir = tempfile::tempdir().unwrap();
    let clock = Arc::new(ManualClock(AtomicI64::new(T0)));
    let created = Store::create(
        dir.path(),
        CreateOptions {
            password: encrypted.then(|| pw(PASSWORD)),
            kdf: KdfParams::INSECURE_TEST,
            auto_lock: AutoLock::default(),
            workspace_name: Some("Personal".into()),
        },
        options(dir.path(), &clock),
    )
    .unwrap();
    assert_eq!(created.recovery_words.is_some(), encrypted);
    Env {
        dir,
        clock,
        store: created.store,
    }
}

pub fn para(text: &str) -> TipTapNode {
    TipTapNode::new("paragraph").with_content(if text.is_empty() {
        vec![]
    } else {
        vec![TipTapNode::text(text)]
    })
}

pub fn doc_of(paragraphs: &[&str]) -> TipTapDoc {
    TipTapDoc::from_blocks(
        paragraphs
            .iter()
            .map(|p| emp_store::doc::schema::container(para(p), None).unwrap())
            .collect(),
    )
}

pub fn mention(page_id: &str) -> TipTapNode {
    TipTapNode::new("mention")
        .with_attr("kind", serde_json::json!("page"))
        .with_attr("pageId", serde_json::json!(page_id))
}

/// Raw `payload` bytes of a row.
pub fn raw_payload(
    conn: &rusqlite::Connection,
    table: &str,
    key_col: &str,
    id: &str,
) -> (i64, Vec<u8>) {
    conn.query_row(
        &format!("SELECT enc, payload FROM {table} WHERE {key_col} = ?1"),
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .unwrap()
}

pub fn contains(hay: &[u8], needle: &[u8]) -> bool {
    hay.windows(needle.len()).any(|w| w == needle)
}

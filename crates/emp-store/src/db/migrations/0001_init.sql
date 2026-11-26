-- EMP migration 0001 (SPEC §10.2). Copied verbatim from the spec; user_version is set by the migrator.
CREATE TABLE vault_meta (key TEXT PRIMARY KEY, value BLOB NOT NULL) STRICT;
-- keys: format_version(1), vault_id(16 bytes), encryption('on'|'off'), created_day('YYYY-MM-DD'),
--       failed_unlocks(int), lockout_until(ms), header_mac(32 bytes), app_min_version, pending_payload_migrations(json)

CREATE TABLE keyslots (
  slot_id     INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('password','recovery','device')),
  kdf         TEXT NOT NULL CHECK (kdf IN ('argon2id-v13','hkdf-sha256','none')),
  kdf_params  BLOB NOT NULL,
  salt        BLOB NOT NULL,
  nonce       BLOB NOT NULL CHECK (length(nonce) = 24),
  wrapped_dek BLOB NOT NULL CHECK (length(wrapped_dek) = 48),
  key_epoch   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE vault_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  write_counter INTEGER NOT NULL,
  mset_root BLOB NOT NULL CHECK (length(mset_root) = 32),
  state_mac BLOB NOT NULL CHECK (length(state_mac) = 32)
) STRICT;

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, sort_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL     -- WorkspacePayload
) STRICT;

CREATE TABLE pages (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES pages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('doc','database','sheet','app','dashboard')),
  sort_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  deleted_at INTEGER, trash_root INTEGER NOT NULL DEFAULT 0,        -- 1 on the page the user deleted
  rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- PagePayload
) STRICT;
CREATE INDEX pages_tree  ON pages(workspace_id, parent_id, sort_key) WHERE deleted_at IS NULL;
CREATE INDEX pages_trash ON pages(workspace_id, deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE page_docs (
  owner_id TEXT PRIMARY KEY,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('page','row')),
  rev INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- DocPayload {v, format:'tiptap-json@1', doc}
) STRICT;

CREATE TABLE databases (
  id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  schema_rev INTEGER NOT NULL DEFAULT 0, data_rev INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- DatabasePayload
) STRICT;

CREATE TABLE db_properties (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- PropertyPayload {v,name,type,config,role?,hidden}
) STRICT;
CREATE INDEX db_properties_db ON db_properties(database_id, sort_key);

CREATE TABLE db_rows (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER,
  rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- RowPayload {v, values:{propId:CellValue}, icon?, tags?:['sample']}
) STRICT;
CREATE INDEX db_rows_db ON db_rows(database_id, sort_key) WHERE deleted_at IS NULL;

CREATE TABLE db_views (
  id TEXT PRIMARY KEY,
  database_id TEXT NOT NULL REFERENCES databases(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL, deleted_at INTEGER, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- ViewPayload
) STRICT;
CREATE INDEX db_views_db ON db_views(database_id, sort_key);

CREATE TABLE workbooks (
  id TEXT PRIMARY KEY REFERENCES pages(id) ON DELETE CASCADE,
  rev INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v, styles[], namedRanges, calc:{iterative,maxIter,maxChange,date1904}}
) STRICT;

CREATE TABLE sheets (
  id TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id) ON DELETE CASCADE,
  sort_key TEXT NOT NULL, rev INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,name,color,hidden,frozen,colWidths,rowHeights,merges,condFormats,validations,charts,maxRow,maxCol}
) STRICT;

CREATE TABLE sheet_bands (
  sheet_id TEXT NOT NULL REFERENCES sheets(id) ON DELETE CASCADE,
  band INTEGER NOT NULL,                                             -- row >> 8 (256 rows)
  rev INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,  -- {v, cells:[[rowOff,col,input,cached,styleId],...]}
  PRIMARY KEY (sheet_id, band)
) STRICT;

CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  blob_name TEXT NOT NULL,
  stored_size INTEGER NOT NULL,
  wrapped_fk BLOB,                                                   -- NULL when vault unencrypted
  key_epoch INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,name,mime,size,width?,height?,source,originUrl?}
) STRICT;
CREATE INDEX assets_blob ON assets(blob_name);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  target_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('page_doc','db_row','db_schema','sheet','workbook')),
  created_at INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('auto','manual','pre_restore','pre_import','pre_bulk','pre_migration','pre_lifeapp')),
  stored_size INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,label?,snapshot} (zstd always)
) STRICT;
CREATE INDEX versions_target ON versions(target_id, created_at DESC);

CREATE TABLE settings (
  scope TEXT NOT NULL CHECK (scope IN ('device','vault')),
  key TEXT NOT NULL, updated_at INTEGER NOT NULL,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,
  PRIMARY KEY (scope, key),
  CHECK (scope = 'vault' OR enc = 0)                                 -- device scope readable pre-unlock; never sensitive
) STRICT;

CREATE TABLE secrets (
  id TEXT PRIMARY KEY,                                               -- 'secret:<random16 hex>'
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc = 1),
  payload BLOB NOT NULL                                              -- {v, provider, label, kind:'api_key'|'oauth'|'client'|'field', allowedHosts[], data, last4?}
) STRICT;

CREATE TABLE kv (
  ns TEXT NOT NULL, key TEXT NOT NULL,                               -- sensitive namespaces store hex(HMAC(k_blind, key))[..32]
  updated_at INTEGER NOT NULL, expires_at INTEGER,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,
  PRIMARY KEY (ns, key)
) STRICT;
CREATE INDEX kv_expiry ON kv(expires_at) WHERE expires_at IS NOT NULL;
-- namespaces: ui.*, market.quote, market.bars, market.search, market.alerts, fx.rates, net.log, gcal.sync, search.recent, lifeapp.cache

CREATE TABLE watchlists (
  id TEXT PRIMARY KEY, sort_key TEXT NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v,name,symbols:[{key,alertAbove?,alertBelow?,alertPct?}]}
) STRICT;

CREATE TABLE lifeapp_instances (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  app_id TEXT NOT NULL,                                              -- plaintext: 'money-hq' etc. (documented leakage: which apps are installed)
  installed_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v, manifestVersion, answers, keyMap:{templateKey:recordId}, touched:{recordId:[field]}, muted:{ruleId:until}, detached:bool, rootPageId, checklist:{itemId:doneAt}}
) STRICT;

CREATE TABLE sync_links (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL, local_id TEXT NOT NULL,
  remote_key TEXT NOT NULL, updated_at INTEGER NOT NULL, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL,  -- {v, remoteId, etag, accountId, lastSyncedRev}
  UNIQUE (provider, remote_key)
) STRICT;
CREATE INDEX sync_links_local ON sync_links(local_id);

CREATE TABLE outbox (
  id TEXT PRIMARY KEY, provider TEXT NOT NULL,
  created_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL
) STRICT;
CREATE INDEX outbox_due ON outbox(next_attempt_at);

CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  fire_at INTEGER NOT NULL, fired_at INTEGER, rev INTEGER NOT NULL DEFAULT 0,
  enc INTEGER NOT NULL CHECK (enc IN (0,1)), payload BLOB NOT NULL   -- {v, targetKind, targetId, blockId?, text}
) STRICT;
CREATE INDEX reminders_due ON reminders(fire_at) WHERE fired_at IS NULL;

CREATE TABLE security_log (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL,
  event TEXT NOT NULL CHECK (event IN ('unlock_ok','unlock_fail','lock','pw_change','recovery_regen','recovery_unlock',
        'enc_on','enc_off','export_plain','backup_create','backup_restore','integrity_fail','reseal','secret_reveal','integration_connect'))
) STRICT;

CREATE TRIGGER rows_purge_docs  AFTER DELETE ON db_rows BEGIN DELETE FROM page_docs WHERE owner_id = OLD.id; DELETE FROM versions WHERE target_id = OLD.id; END;
CREATE TRIGGER pages_purge_docs AFTER DELETE ON pages   BEGIN DELETE FROM page_docs WHERE owner_id = OLD.id; DELETE FROM versions WHERE target_id = OLD.id; END;

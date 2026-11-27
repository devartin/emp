/**
 * backup_create / backup_restore (§9.21) for the browser preview, plus the `.empbackup` / `.empsnap` container the
 * snapshot mock shares.
 *
 * The real container is `magic || version || manifest(CBOR) || sqlite || mac` sealed with XChaCha20-Poly1305 under
 * keys from Argon2id. The preview keeps the same shape with WebCrypto: a random data key (DEK) encrypts the
 * gzipped database dump with AES-GCM; each keyslot wraps the DEK under a key derived from a secret (PBKDF2-SHA256);
 * an HMAC over everything before it makes the file tamper-evident. Restoring never overwrites in place: the dump is
 * opened as a *new* vault (new vault id) and the app restarts into it.
 */
import { BackendError } from '../../errors';
import type { MockCallCtx, MockCtx, MockHandlers } from '../ctx';
import type { DbSnapshot } from '../db';
import { saveVault, statusOf, vaultRecord, type VaultRecord } from '../lib/vault';
import { randomHex } from '../rng';

export const CONTAINER_MAGIC = 'EMPBACKUP';
export const SNAPSHOT_MAGIC = 'EMPSNAP';
export const CONTAINER_VERSION = 1;
const PBKDF2_ITERATIONS = 150_000;
const MAX_RESTORE_BYTES = 512 * 1024 * 1024;

export type SlotKind = 'password' | 'recovery' | 'backup';

interface Keyslot {
  kind: SlotKind;
  salt: string;
  iter: number;
  iv: string;
  wrapped: string;
}

export interface ContainerManifest {
  vaultId: string;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  writeCounter: number;
  counts: { pages: number; rows: number; assets: number; workspaces: number };
  /** Uncompressed dump size. */
  bytes: number;
}

export interface Container {
  magic: string;
  version: number;
  manifest: ContainerManifest;
  protection: 'none' | 'vault' | 'password';
  keyslots: Keyslot[];
  iv?: string;
  /** base64 of (gzip of JSON dump), encrypted when protected. */
  payload: string;
  mac: string;
}

// ───────────────────────────────────────────────────────────────────────────── encoding helpers

const enc = new TextEncoder();
const dec = new TextDecoder();

export function toB64(bytes: Uint8Array): string {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) s += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const hex = (bytes: ArrayBuffer | Uint8Array) =>
  Array.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new BackendError('UNSUPPORTED', 'This browser cannot encrypt backups (WebCrypto is unavailable)');
  return s;
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

const buf = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as { CompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).CompressionStream;
  if (!CS) return bytes;
  const stream = new Blob([buf(bytes)]).stream().pipeThrough(new CS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  // gzip magic 1f 8b; anything else was stored uncompressed.
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new BackendError('UNSUPPORTED', 'This browser cannot read compressed backups');
  const stream = new Blob([buf(bytes)]).stream().pipeThrough(new DS('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === 'string' ? enc.encode(data) : data;
  return hex(await subtle().digest('SHA-256', buf(bytes)));
}

async function kek(secret: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(enc.encode(secret.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey({ name: 'PBKDF2', salt: buf(salt), iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function macKey(dek: Uint8Array | null, vaultId: string): Promise<CryptoKey> {
  // k_backup_mac: derived from the data key; plaintext containers still get a (keyless) tamper check.
  const material = dek ? await sha256Hex(new Uint8Array([...enc.encode('emp/v1/backup-mac:'), ...dek])) : await sha256Hex(`emp/v1/backup-mac:${vaultId}`);
  return subtle().importKey('raw', buf(enc.encode(material)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

function macInput(c: Omit<Container, 'mac'>): Uint8Array {
  return enc.encode(JSON.stringify([c.magic, c.version, c.manifest, c.protection, c.keyslots, c.iv ?? '', c.payload]));
}

const recoverySecret = (words: string[]) => words.map((w) => w.trim().toLowerCase()).join(' ');

// ───────────────────────────────────────────────────────────────────────────── database dump

interface EncodedBlob {
  __blob: true;
  mime: string;
  b64: string;
}

/** Snapshot of every persisted table; Blobs become base64 so the dump is plain JSON. */
export async function dumpDb(ctx: MockCtx, opts: { onAssets?: (done: number, total: number) => void; signal?: AbortSignal } = {}): Promise<DbSnapshot> {
  const snap = ctx.db.snapshot();
  const blobs = (snap.asset_blobs ?? []) as { id: string; blob: Blob }[];
  const encoded: { id: string; blob: EncodedBlob }[] = [];
  for (let i = 0; i < blobs.length; i++) {
    if (opts.signal?.aborted) throw new BackendError('CANCELLED', 'Cancelled');
    const b = blobs[i].blob;
    if (b instanceof Blob) encoded.push({ id: blobs[i].id, blob: { __blob: true, mime: b.type, b64: toB64(new Uint8Array(await b.arrayBuffer())) } });
    opts.onAssets?.(i + 1, blobs.length);
  }
  if (blobs.length) snap.asset_blobs = encoded;
  return snap;
}

function reviveDb(snap: DbSnapshot): DbSnapshot {
  const blobs = snap.asset_blobs as { id: string; blob: EncodedBlob | Blob }[] | undefined;
  if (blobs) {
    snap.asset_blobs = blobs.map((r) => {
      const b = r.blob as EncodedBlob;
      return b && b.__blob ? { id: r.id, blob: new Blob([buf(fromB64(b.b64))], { type: b.mime }) } : r;
    });
  }
  return snap;
}

export function countsOf(snap: DbSnapshot): ContainerManifest['counts'] {
  const pages = (snap.pages ?? []) as { deletedAt?: number }[];
  return {
    pages: pages.filter((p) => !p.deletedAt).length,
    rows: (snap.db_rows ?? []).length,
    assets: (snap.assets ?? []).length,
    workspaces: (snap.workspaces ?? []).length,
  };
}

// ───────────────────────────────────────────────────────────────────────────── seal / open

export interface SealSecrets {
  /** Vault password + recovery words (vault-protected containers). */
  vault?: { password: string; recoveryWords?: string[] };
  /** A separate backup password. */
  backupPassword?: string;
}

export async function sealContainer(
  ctx: MockCtx,
  dump: DbSnapshot,
  secrets: SealSecrets,
  magic = CONTAINER_MAGIC,
): Promise<{ text: string; container: Container }> {
  const v = vaultRecord(ctx);
  const json = enc.encode(JSON.stringify(dump));
  const packed = await gzip(json);
  const manifest: ContainerManifest = {
    vaultId: v.vaultId ?? 'unknown',
    createdAt: ctx.clock.now(),
    appVersion: '1.0.0',
    schemaVersion: 1,
    writeCounter: ctx.db.version,
    counts: countsOf(dump),
    bytes: json.length,
  };
  const keyslots: Keyslot[] = [];
  let protection: Container['protection'] = 'none';
  let payload: string;
  let iv: string | undefined;
  let dek: Uint8Array | null = null;
  const slotSecrets: [SlotKind, string][] = [];
  if (secrets.backupPassword) slotSecrets.push(['backup', secrets.backupPassword]);
  if (secrets.vault?.password) slotSecrets.push(['password', secrets.vault.password]);
  if (secrets.vault?.recoveryWords?.length) slotSecrets.push(['recovery', recoverySecret(secrets.vault.recoveryWords)]);
  if (slotSecrets.length) {
    protection = secrets.backupPassword ? 'password' : 'vault';
    dek = randomBytes(32);
    const key = await aesKey(dek);
    const ivBytes = randomBytes(12);
    iv = toB64(ivBytes);
    payload = toB64(new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(ivBytes) }, key, buf(packed))));
    for (const [kind, secret] of slotSecrets) {
      const salt = randomBytes(16);
      const slotIv = randomBytes(12);
      const k = await kek(secret, salt, PBKDF2_ITERATIONS);
      const wrapped = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(slotIv) }, k, buf(dek)));
      keyslots.push({ kind, salt: toB64(salt), iter: PBKDF2_ITERATIONS, iv: toB64(slotIv), wrapped: toB64(wrapped) });
    }
  } else {
    payload = toB64(packed);
  }
  const body: Omit<Container, 'mac'> = { magic, version: CONTAINER_VERSION, manifest, protection, keyslots, ...(iv ? { iv } : {}), payload };
  const mac = hex(await subtle().sign('HMAC', await macKey(dek, manifest.vaultId), buf(macInput(body))));
  const container: Container = { ...body, mac };
  return { text: `${magic}\n${JSON.stringify(container)}\n`, container };
}

/** Parse and check the header (magic, version, shape). Throws INVALID / SCHEMA_TOO_NEW. */
export function parseContainer(text: string): Container {
  const nl = text.indexOf('\n');
  const head = nl > 0 ? text.slice(0, nl).trim() : '';
  if (head !== CONTAINER_MAGIC && head !== SNAPSHOT_MAGIC) throw new BackendError('INVALID', 'This isn’t an Ultranote backup file');
  let c: Container;
  try {
    c = JSON.parse(text.slice(nl + 1)) as Container;
  } catch {
    throw new BackendError('INTEGRITY', 'This backup is damaged and can’t be read');
  }
  if (!c || c.magic !== head || typeof c.payload !== 'string' || typeof c.mac !== 'string' || !c.manifest) {
    throw new BackendError('INTEGRITY', 'This backup is damaged and can’t be read');
  }
  if (c.version > CONTAINER_VERSION) throw new BackendError('SCHEMA_TOO_NEW', 'This backup was made by a newer version of Ultranote. Update Ultranote to restore it.');
  return c;
}

export async function openContainer(c: Container, secrets: { password?: string; recoveryWords?: string[] }): Promise<DbSnapshot> {
  let dek: Uint8Array | null = null;
  let packed: Uint8Array;
  if (c.protection === 'none') {
    packed = fromB64(c.payload);
  } else {
    const tries: Keyslot[] = [];
    if (secrets.recoveryWords?.length) tries.push(...c.keyslots.filter((s) => s.kind === 'recovery'));
    if (secrets.password) tries.push(...c.keyslots.filter((s) => s.kind !== 'recovery'));
    if (!tries.length) {
      throw new BackendError('AUTH_REQUIRED', c.protection === 'password' ? 'Enter the backup password' : 'Enter the password or recovery key that was current when this backup was made');
    }
    for (const slot of tries) {
      const secret = slot.kind === 'recovery' ? recoverySecret(secrets.recoveryWords ?? []) : (secrets.password ?? '');
      try {
        const k = await kek(secret, fromB64(slot.salt), slot.iter);
        dek = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromB64(slot.iv)) }, k, buf(fromB64(slot.wrapped))));
        break;
      } catch {
        /* wrong secret for this slot */
      }
    }
    if (!dek) {
      throw new BackendError(secrets.recoveryWords?.length && !secrets.password ? 'CRYPTO' : 'BAD_PASSWORD', secrets.recoveryWords?.length && !secrets.password ? 'Those words don’t open this backup' : 'Incorrect password');
    }
  }
  const { mac, ...body } = c;
  const ok = await subtle().verify('HMAC', await macKey(dek, c.manifest.vaultId), buf(fromHex(mac)), buf(macInput(body)));
  if (!ok) throw new BackendError('INTEGRITY', 'This backup was modified outside Ultranote and can’t be trusted');
  if (dek && c.iv) {
    try {
      packed = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromB64(c.iv)) }, await aesKey(dek), buf(fromB64(c.payload))));
    } catch {
      throw new BackendError('INTEGRITY', 'This backup is damaged and can’t be decrypted');
    }
  } else if (dek) {
    throw new BackendError('INTEGRITY', 'This backup is damaged and can’t be decrypted');
  } else {
    packed = fromB64(c.payload);
  }
  const json = dec.decode(await gunzip(packed));
  let snap: DbSnapshot;
  try {
    snap = JSON.parse(json) as DbSnapshot;
  } catch {
    throw new BackendError('INTEGRITY', 'This backup is damaged and can’t be read');
  }
  // §9.21 step 3: only expected objects. The dump must be a map of arrays of keyed records.
  for (const [name, rows] of Object.entries(snap)) {
    if (!/^[a-z_][a-z0-9_.]*$/i.test(name) || !Array.isArray(rows) || rows.some((r) => !r || typeof (r as { id?: unknown }).id !== 'string')) {
      throw new BackendError('INTEGRITY', 'This backup contains unexpected data and was rejected');
    }
  }
  return reviveDb(snap);
}

function fromHex(s: string): Uint8Array {
  const out = new Uint8Array(Math.floor(s.length / 2));
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function vaultSecrets(ctx: MockCtx): SealSecrets['vault'] | undefined {
  const v = vaultRecord(ctx);
  return v.encrypted && v.password ? { password: v.password, recoveryWords: v.recoveryWords } : undefined;
}

const step = async (ctx: MockCallCtx, done: number, total: number, label: string, ms = 120) => {
  ctx.checkCancelled();
  ctx.progress(done, total, label);
  await ctx.sleep(ms, ctx.signal);
};

// ───────────────────────────────────────────────────────────────────────────── handlers

export const handlers: MockHandlers = {
  backup_create: async (req, ctx) => {
    if (typeof req.password === 'string' && req.password.length > 0 && [...req.password].length < 8) {
      throw new BackendError('INVALID', 'Use at least 8 characters for the backup password', { field: 'password' });
    }
    const total = 5;
    await step(ctx, 0, total, 'Saving pending changes');
    await step(ctx, 1, total, 'Copying the database');
    const dump = await dumpDb(ctx, {
      signal: ctx.signal,
      onAssets: (d, t) => ctx.progress(2, total, `Copying attachments (${d} of ${t})`),
    });
    await step(ctx, 2, total, 'Copying attachments', 80);
    const secrets: SealSecrets = { vault: vaultSecrets(ctx) };
    if (req.password) secrets.backupPassword = req.password;
    ctx.progress(3, total, secrets.vault || secrets.backupPassword ? 'Encrypting' : 'Packing');
    const { text } = await sealContainer(ctx, dump, secrets);
    await step(ctx, 4, total, 'Writing the backup file', 100);
    const bytes = ctx.grants.write(req.grantId, text, 'application/x-emp-backup');
    ctx.progress(total, total, 'Done');
    ctx.vault.securityLog('backup_create');
    ctx.db.setMeta('backup.lastManual', { at: ctx.clock.now(), bytes, protected: !!(secrets.vault || secrets.backupPassword) });
    return { bytes };
  },

  backup_restore: async (req, ctx) => {
    const file = ctx.grants.read(req.grantId);
    if (file.size > MAX_RESTORE_BYTES) throw new BackendError('TOO_LARGE', 'Backups up to 512 MB can be restored in the browser preview');
    const total = 6;
    await step(ctx, 0, total, 'Checking the file');
    const c = parseContainer(await file.text());
    await step(ctx, 1, total, c.protection === 'none' ? 'Verifying' : 'Unlocking with your key', 60);
    const snap = await openContainer(c, { password: req.password, recoveryWords: req.recoveryWords });
    await step(ctx, 2, total, 'Verifying the seal and manifest');
    await step(ctx, 3, total, 'Checking the database');
    await step(ctx, 4, total, 'Creating a new vault');

    // Restore always opens as a NEW vault: fresh vault id, unlocked, keyslots as they were when the backup was made.
    const current = vaultRecord(ctx);
    const meta = (snap._meta ?? []) as { id: string; value: unknown }[];
    const restoredVault = (meta.find((m) => m.id === 'vault')?.value ?? null) as VaultRecord | null;
    ctx.db.load(snap);
    const v: VaultRecord = restoredVault
      ? { ...restoredVault }
      : { ...current, encrypted: c.protection === 'vault' && !!req.password, password: req.password };
    v.vaultId = randomHex(ctx.rng, 16);
    v.state = 'unlocked';
    v.failedAttempts = 0;
    v.lockoutUntil = 0;
    v.lastActivity = ctx.clock.now();
    v.unlockedAt = ctx.clock.now();
    v.integrity = 'ok';
    if (c.protection === 'vault' && req.password) v.password = req.password.normalize('NFKC');
    saveVault(ctx, v);
    ctx.vault.securityLog('backup_restore');
    await step(ctx, 5, total, 'Opening the restored vault', 80);
    ctx.progress(total, total, 'Done');
    ctx.emit('vault:status', statusOf(ctx));
    return { vaultId: v.vaultId ?? '', pages: c.manifest.counts.pages };
  },
};

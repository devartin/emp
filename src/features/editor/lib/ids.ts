/** Block ids (§7.1): 12-character nanoid over `[0-9A-Za-z_-]`. */
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_-';
const POOL_SIZE = 12 * 64;
let pool: Uint8Array<ArrayBuffer> | null = null;
let offset = POOL_SIZE;

function refill(): Uint8Array<ArrayBuffer> {
  if (!pool) pool = new Uint8Array(POOL_SIZE);
  crypto.getRandomValues(pool);
  offset = 0;
  return pool;
}

export function newBlockId(): string {
  const bytes = offset + 12 > POOL_SIZE || !pool ? refill() : pool;
  let id = '';
  for (let i = 0; i < 12; i++) id += ALPHABET[bytes[offset + i] & 63];
  offset += 12;
  return id;
}

export const BLOCK_ID_RE = /^[0-9A-Za-z_-]{12}$/;

#!/usr/bin/env python3
"""Independent generator for the emp-crypto known-answer vectors.

Re-implements the EMP formats of SPEC §9.4–§9.8 from scratch on top of Python's hashlib/hmac and the
`cryptography` package (Argon2id, ChaCha20-Poly1305 + a local HChaCha20 for XChaCha), so the Rust
implementation is checked against a second, independent implementation of the spec rather than against itself.

Usage: python3 -I gen_vectors.py <output-dir>     (requires cryptography >= 44)
"""
import hashlib, hmac, json, struct, sys, unicodedata
from cryptography.hazmat.primitives.ciphers.aead import ChaCha20Poly1305
from cryptography.hazmat.primitives.kdf.argon2 import Argon2id

def rotl(v, c): return ((v << c) & 0xffffffff) | (v >> (32 - c))
def qr(s, a, b, c, d):
    s[a] = (s[a] + s[b]) & 0xffffffff; s[d] = rotl(s[d] ^ s[a], 16)
    s[c] = (s[c] + s[d]) & 0xffffffff; s[b] = rotl(s[b] ^ s[c], 12)
    s[a] = (s[a] + s[b]) & 0xffffffff; s[d] = rotl(s[d] ^ s[a], 8)
    s[c] = (s[c] + s[d]) & 0xffffffff; s[b] = rotl(s[b] ^ s[c], 7)
def hchacha20(key, nonce16):
    s = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] + list(struct.unpack('<8I', key)) + list(struct.unpack('<4I', nonce16))
    for _ in range(10):
        qr(s, 0, 4, 8, 12); qr(s, 1, 5, 9, 13); qr(s, 2, 6, 10, 14); qr(s, 3, 7, 11, 15)
        qr(s, 0, 5, 10, 15); qr(s, 1, 6, 11, 12); qr(s, 2, 7, 8, 13); qr(s, 3, 4, 9, 14)
    return struct.pack('<8I', *(s[0:4] + s[12:16]))
def xseal(key, nonce24, pt, aad):
    sub = hchacha20(key, nonce24[:16])
    return ChaCha20Poly1305(sub).encrypt(b'\0\0\0\0' + nonce24[16:], pt, aad)

def lp(b): return struct.pack('>I', len(b)) + b
def hkdf(ikm, salt, info, n=32):
    prk = hmac.new(salt, ikm, hashlib.sha256).digest()
    t, out, i = b'', b'', 1
    while len(out) < n:
        t = hmac.new(prk, t + info + bytes([i]), hashlib.sha256).digest(); out += t; i += 1
    return out[:n]
def hm(k, m): return hmac.new(k, m, hashlib.sha256).digest()
def argon2id(pw, salt, m, t, p, secret=None, ad=None):
    return Argon2id(salt=salt, length=32, iterations=t, lanes=p, memory_cost=m, ad=ad, secret=secret).derive(pw)
def padme(L):
    if L < 2: return L
    E = L.bit_length() - 1; S = (E.bit_length() - 1) + 1; z = E - S; mask = (1 << z) - 1
    return (L + mask) & ~mask
def cbor_uint(v):
    if v < 24: return bytes([v])
    if v < 256: return bytes([0x18, v])
    if v < 65536: return b'\x19' + struct.pack('>H', v)
    return b'\x1a' + struct.pack('>I', v)
def cbor_params(m, t, p): return b'\xa3' + b'\x61m' + cbor_uint(m) + b'\x61p' + cbor_uint(p) + b'\x61t' + cbor_uint(t)
H = lambda b: b.hex()

def main(out):
    v = {}
    # ---- RFC 9106 §5.3 Argon2id ----
    rfc = argon2id(b'\x01' * 32, b'\x02' * 16, 32, 3, 4, secret=b'\x03' * 8, ad=b'\x04' * 12)
    v['argon2id_rfc9106'] = dict(password=H(b'\x01'*32), salt=H(b'\x02'*16), secret=H(b'\x03'*8), ad=H(b'\x04'*12),
                                 m_kib=32, t=3, p=4, tag=H(rfc))
    # EMP wrapper: NFKC(password), no secret / ad.
    pw = 'correct horse ﬁbattery'
    norm = unicodedata.normalize('NFKC', pw).encode()
    v['argon2id_emp'] = [
        dict(password=pw, salt=H(bytes(range(16))), m_kib=8, t=1, p=1, kek=H(argon2id(norm, bytes(range(16)), 8, 1, 1))),
        dict(password=pw, salt=H(bytes(range(16))), m_kib=65536, t=3, p=4, kek=H(argon2id(norm, bytes(range(16)), 65536, 3, 4))),
    ]
    # ---- HKDF (RFC 5869 A.1–A.3) and HMAC (RFC 4231 TC1, TC2, TC6) ----
    v['hkdf_rfc5869'] = [
        dict(ikm=H(b'\x0b'*22), salt=H(bytes(range(13))), info=H(bytes(range(0xf0, 0xfa))), okm=H(hkdf(b'\x0b'*22, bytes(range(13)), bytes(range(0xf0, 0xfa)), 42))),
        dict(ikm=H(bytes(range(0x50))), salt=H(bytes(range(0x60, 0xb0))), info=H(bytes(range(0xb0, 0x100))), okm=H(hkdf(bytes(range(0x50)), bytes(range(0x60, 0xb0)), bytes(range(0xb0, 0x100)), 82))),
        dict(ikm=H(b'\x0b'*22), salt='', info='', okm=H(hkdf(b'\x0b'*22, b'', b'', 42))),
    ]
    v['hmac_rfc4231'] = [
        dict(key=H(b'\x0b'*20), data=H(b'Hi There'), mac=H(hm(b'\x0b'*20, b'Hi There'))),
        dict(key=H(b'Jefe'), data=H(b'what do ya want for nothing?'), mac=H(hm(b'Jefe', b'what do ya want for nothing?'))),
        dict(key=H(b'\xaa'*131), data=H(b'Test Using Larger Than Block-Size Key - Hash Key First'), mac=H(hm(b'\xaa'*131, b'Test Using Larger Than Block-Size Key - Hash Key First'))),
    ]
    # ---- draft-irtf-cfrg-xchacha-03 §A.3.1 ----
    xk = bytes(range(0x80, 0xa0)); xn = bytes(range(0x40, 0x58)); xa = bytes.fromhex('50515253c0c1c2c3c4c5c6c7')
    xp = b"Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it."
    v['xchacha_draft'] = dict(key=H(xk), nonce=H(xn), aad=H(xa), plaintext=H(xp), sealed=H(xseal(xk, xn, xp, xa)))

    # ---- EMP fixed vectors ----
    dek = bytes([0x5a] * 32); vid = bytes(range(0xa0, 0xb0)); epoch = 1
    labels = ['emp/v1/records', 'emp/v1/assets', 'emp/v1/secrets', 'emp/v1/manifest', 'emp/v1/blob-id',
              'emp/v1/backup-mac', 'emp/v1/header-mac', 'emp/v1/search', 'emp/v1/blind-index']
    sub = {l: hkdf(dek, vid, l.encode()) for l in labels}
    emp = dict(dek=H(dek), vault_id=H(vid), epoch=epoch, subkeys={l: H(k) for l, k in sub.items()})

    def envelope(table_tag, rid, kind, rev, extra, body, nonce, pad, key):
        flags = 0b10 if pad else 0
        header = bytes([1, flags]) + struct.pack('<H', epoch)
        inner = bytes([flags]) + struct.pack('>I', len(body)) + body
        if pad: inner += b'\0' * (padme(len(inner)) - len(inner))
        aad = b'EMP-REC-v1' + vid + bytes([table_tag]) + lp(rid.encode()) + lp(kind.encode()) + struct.pack('>Q', rev) + header + lp(extra)
        return header + nonce + xseal(key, nonce, inner, aad)
    kv_extra = lp(b'ui') + lp(b'sidebar.width')
    envs = []
    for (tag, rid, kind, rev, extra, body, pad, keyname) in [
        (2, '0190f0f0-aaaa-7bbb-8ccc-0123456789ab', 'doc', 7, b'', b'{"v":1,"title":"Hello"}', True, 'emp/v1/records'),
        (8, 'row-1', 'row', 0, b'', b'{"v":1}', False, 'emp/v1/records'),
        (17, '', '', 0, kv_extra, b'{"v":1,"px":280}', True, 'emp/v1/records'),
        (16, 'secret:0011223344556677', '', 3, b'', b'{"v":1,"provider":"finnhub","value":"sk-test"}', True, 'emp/v1/secrets'),
    ]:
        nonce = hashlib.sha256(b'nonce' + rid.encode() + bytes([tag])).digest()[:24]
        envs.append(dict(table_tag=tag, id=rid, kind=kind, rev=rev, extra=H(extra), body=H(body), pad=pad, nonce=H(nonce),
                         envelope=H(envelope(tag, rid, kind, rev, extra, body, nonce, pad, sub[keyname]))))
    emp['envelopes'] = envs

    # Keyslots.
    def slot_aad(slot_id, kind, kdf, params, ep):
        return b'EMP-KEYSLOT-v1' + vid + struct.pack('>I', slot_id) + bytes([kind]) + lp(kdf) + lp(params) + struct.pack('>I', ep)
    salt = bytes(range(0x10, 0x20)); knonce = bytes(range(0x30, 0x48))
    params = cbor_params(8, 1, 1)
    kek_pw = argon2id(unicodedata.normalize('NFKC', 'hunter2 hunter2').encode(), salt, 8, 1, 1)
    emp['keyslot_password'] = dict(slot_id=1, password='hunter2 hunter2', m_kib=8, t=1, p=1, salt=H(salt), nonce=H(knonce),
                                   kdf_params=H(params), wrapped_dek=H(xseal(kek_pw, knonce, dek, slot_aad(1, 1, b'argon2id-v13', params, epoch))))
    rk = bytes([0x00] * 32)  # "abandon" x23 + "art"
    kek_rec = hkdf(rk, vid, b'emp/v1/kek/recovery')
    rnonce = bytes(range(0x60, 0x78))
    emp['keyslot_recovery'] = dict(slot_id=2, recovery_entropy=H(rk), nonce=H(rnonce), kek=H(kek_rec),
                                   wrapped_dek=H(xseal(kek_rec, rnonce, dek, slot_aad(2, 2, b'hkdf-sha256', b'\xa0', epoch))))

    # Manifest.
    payload = bytes.fromhex(envs[0]['envelope'])
    rowmsg = bytes([2]) + lp(envs[0]['id'].encode()) + lp(b'') + struct.pack('>Q', 7) + hashlib.sha256(payload).digest()
    row_h = hm(sub['emp/v1/manifest'], rowmsg)
    rowmsg2 = bytes([17]) + lp(b'') + lp(kv_extra) + struct.pack('>Q', 0) + hashlib.sha256(bytes.fromhex(envs[2]['envelope'])).digest()
    row_h2 = hm(sub['emp/v1/manifest'], rowmsg2)
    root = bytes(a ^ b for a, b in zip(row_h, row_h2))
    ks_digest = bytes([0x77] * 32)
    state = hm(sub['emp/v1/manifest'], b'EMP-STATE-v1' + vid + struct.pack('>Q', 42) + root + ks_digest)
    emp['manifest'] = dict(row_hash_0=H(row_h), row_hash_2=H(row_h2), mset_root=H(root), write_counter=42,
                           keyslots_digest=H(ks_digest), state_mac=H(state))

    # Blob.
    content = bytes((i * 7) % 256 for i in range(70000))
    name = hm(sub['emp/v1/blob-id'], hashlib.sha256(content).digest())[:16].hex()
    fk = bytes([0x33] * 32); fnonce = bytes(range(0x90, 0xa8))
    wrapped_fk = fnonce + xseal(sub['emp/v1/assets'], fnonce, fk, b'EMP-BLOBKEY-v1' + vid + name.encode() + struct.pack('>I', epoch))
    prefix = bytes(range(0xc0, 0xc0 + 19))
    padded = padme(len(content) + 8)
    header = b'EMPBLOB\x01' + prefix + struct.pack('>Q', padded)
    plain = struct.pack('>Q', len(content)) + content + b'\0' * (padded - 8 - len(content))
    chunks = [plain[i:i + 65536] for i in range(0, len(plain), 65536)]
    body = b''
    for i, c in enumerate(chunks):
        last = 1 if i == len(chunks) - 1 else 0
        body += xseal(fk, prefix + struct.pack('>I', i) + bytes([last]), c, header)
    emp['blob'] = dict(content_len=len(content), content_sha256=H(hashlib.sha256(content).digest()), blob_name=name,
                       file_key=H(fk), wrap_nonce=H(fnonce), wrapped_fk=H(wrapped_fk), prefix=H(prefix),
                       file_sha256=H(hashlib.sha256(header + body).digest()), file_len=len(header + body))
    v['emp'] = emp
    with open(f'{out}/vectors.json', 'w') as f:
        json.dump(v, f, indent=1, sort_keys=True)
        f.write('\n')

if __name__ == '__main__':
    main(sys.argv[1])

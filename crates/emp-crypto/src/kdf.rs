//! Argon2id password KDF (SPEC §9.2, §9.3): parameter presets, bounds checks, canonical CBOR encoding,
//! NFKC password normalisation and the device calibration helper.
//!
//! Every function here is CPU- and memory-heavy (hundreds of MiB, ~1 s). Call them from `spawn_blocking`.

use std::time::{Duration, Instant};

use argon2::{Algorithm, Argon2, Params, Version};
use secrecy::{ExposeSecret, SecretString};
use serde::{Deserialize, Serialize};
use unicode_normalization::UnicodeNormalization;
use zeroize::Zeroizing;

use crate::error::{CryptoError, Result};
use crate::keys::{KEY_LEN, Kek};

/// Salt length for Argon2id keyslots and password containers.
pub const SALT_LEN: usize = 16;
/// Maximum password length in bytes after NFKC normalisation.
pub const MAX_PASSWORD_BYTES: usize = 1024;

/// Argon2id v0x13 cost parameters `{m, t, p}` (memory in KiB, passes, lanes).
///
/// Serialises (serde) as `{ "mKiB": .., "t": .., "p": .. }` for IPC; on disk it is stored as canonical CBOR via
/// [`KdfParams::to_cbor`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct KdfParams {
    /// Memory cost in KiB.
    #[serde(rename = "mKiB")]
    pub m_kib: u32,
    /// Number of passes.
    pub t: u32,
    /// Degree of parallelism (lanes).
    pub p: u32,
}

impl KdfParams {
    /// Floor profile: calibration never goes below this (64 MiB, t = 3, p = 4).
    pub const FLOOR: Self = Self {
        m_kib: 65_536,
        t: 3,
        p: 4,
    };
    /// Standard profile, the default (256 MiB, t = 3, p = 4).
    pub const STANDARD: Self = Self {
        m_kib: 262_144,
        t: 3,
        p: 4,
    };
    /// High ("Paranoid") profile (1 GiB, t = 4, p = 4).
    pub const HIGH: Self = Self {
        m_kib: 1_048_576,
        t: 4,
        p: 4,
    };

    /// Tiny parameters (8 KiB, t = 1, p = 1) that are accepted **only** in this crate's unit tests or when the
    /// `insecure-test-kdf` feature is on (which must only ever be enabled from `[dev-dependencies]`).
    #[cfg(any(test, feature = "insecure-test-kdf"))]
    pub const INSECURE_TEST: Self = Self {
        m_kib: 8,
        t: 1,
        p: 1,
    };

    /// Minimum accepted memory cost (KiB).
    pub const MIN_M_KIB: u32 = 65_536;
    /// Maximum accepted memory cost (KiB).
    pub const MAX_M_KIB: u32 = 4_194_304;
    /// Minimum accepted passes.
    pub const MIN_T: u32 = 3;
    /// Maximum accepted passes.
    pub const MAX_T: u32 = 20;
    /// Minimum accepted lanes.
    pub const MIN_P: u32 = 1;
    /// Maximum accepted lanes.
    pub const MAX_P: u32 = 16;

    /// Checks the §9.3 read-time bounds. Every KDF entry point calls this **before** running Argon2.
    pub fn validate(&self) -> Result<()> {
        #[cfg(any(test, feature = "insecure-test-kdf"))]
        if *self == Self::INSECURE_TEST {
            return Ok(());
        }
        if !(Self::MIN_M_KIB..=Self::MAX_M_KIB).contains(&self.m_kib) {
            return Err(CryptoError::InvalidKdfParams("memory cost out of bounds"));
        }
        if !(Self::MIN_T..=Self::MAX_T).contains(&self.t) {
            return Err(CryptoError::InvalidKdfParams("pass count out of bounds"));
        }
        if !(Self::MIN_P..=Self::MAX_P).contains(&self.p) {
            return Err(CryptoError::InvalidKdfParams("parallelism out of bounds"));
        }
        Ok(())
    }

    /// `true` if these parameters are weaker than `reference` in memory, passes or lanes
    /// (drives the "Strengthen key derivation" prompt; pass the device's current Standard calibration).
    #[must_use]
    pub fn is_weaker_than(&self, reference: &KdfParams) -> bool {
        self.m_kib < reference.m_kib || self.t < reference.t || self.p < reference.p
    }

    /// Canonical (RFC 8949 §4.2 deterministic) CBOR map `{ "m": m, "p": p, "t": t }`.
    #[must_use]
    pub fn to_cbor(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(20);
        out.push(0xa3); // map(3)
        for (key, value) in [(b'm', self.m_kib), (b'p', self.p), (b't', self.t)] {
            out.extend_from_slice(&[0x61, key]); // text(1)
            cbor_uint(&mut out, value);
        }
        out
    }

    /// Parses canonical CBOR written by [`to_cbor`](Self::to_cbor). Non-canonical encodings, extra keys,
    /// missing keys and trailing bytes are rejected. Bounds are **not** checked here; call [`validate`](Self::validate).
    pub fn from_cbor(bytes: &[u8]) -> Result<Self> {
        const ERR: CryptoError = CryptoError::Malformed("kdf params");
        let mut r = crate::codec::Reader::new(bytes, "kdf params");
        if r.u8()? != 0xa3 {
            return Err(ERR);
        }
        let mut vals = [0u32; 3];
        for (slot, key) in vals.iter_mut().zip(*b"mpt") {
            if r.array::<2>()? != [0x61, key] {
                return Err(ERR);
            }
            *slot = read_cbor_uint(&mut r)?;
        }
        r.finish()?;
        let [m_kib, p, t] = vals;
        let params = Self { m_kib, t, p };
        // Re-encoding must reproduce the input byte for byte (rejects non-minimal integers).
        if params.to_cbor() != bytes {
            return Err(ERR);
        }
        Ok(params)
    }

    /// Memory cost in bytes.
    #[must_use]
    pub fn memory_bytes(&self) -> u64 {
        u64::from(self.m_kib) * 1024
    }
}

/// The two user-selectable profiles (`vault_create.profile`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum KdfProfile {
    /// [`KdfParams::STANDARD`] (or the device calibration of it).
    Standard,
    /// [`KdfParams::HIGH`].
    High,
}

impl KdfProfile {
    /// The fixed preset for this profile.
    #[must_use]
    pub fn params(self) -> KdfParams {
        match self {
            Self::Standard => KdfParams::STANDARD,
            Self::High => KdfParams::HIGH,
        }
    }
}

fn cbor_uint(out: &mut Vec<u8>, v: u32) {
    match v {
        0..=23 => out.push(v as u8),
        24..=0xff => out.extend_from_slice(&[0x18, v as u8]),
        0x100..=0xffff => {
            out.push(0x19);
            out.extend_from_slice(&(v as u16).to_be_bytes());
        }
        _ => {
            out.push(0x1a);
            out.extend_from_slice(&v.to_be_bytes());
        }
    }
}

fn read_cbor_uint(r: &mut crate::codec::Reader<'_>) -> Result<u32> {
    let ib = r.u8()?;
    Ok(match ib {
        0..=23 => u32::from(ib),
        0x18 => u32::from(r.u8()?),
        0x19 => u32::from(r.u16be()?),
        0x1a => r.u32be()?,
        _ => return Err(CryptoError::Malformed("kdf params")),
    })
}

/// NFKC-normalises a password into a zeroizing buffer, refusing results over [`MAX_PASSWORD_BYTES`].
///
/// The buffer is allocated once with enough capacity that it never reallocates (which would leave unzeroized
/// copies on the heap).
pub fn normalize_password(password: &SecretString) -> Result<Zeroizing<String>> {
    let mut out = Zeroizing::new(String::with_capacity(MAX_PASSWORD_BYTES + 4));
    for c in password.expose_secret().nfkc() {
        if out.len() + c.len_utf8() > MAX_PASSWORD_BYTES {
            return Err(CryptoError::PasswordTooLong);
        }
        out.push(c);
    }
    Ok(out)
}

fn argon2(params: &KdfParams) -> Result<Argon2<'static>> {
    let p = Params::new(params.m_kib, params.t, params.p, Some(KEY_LEN))
        .map_err(|_| CryptoError::InvalidKdfParams("rejected by argon2"))?;
    Ok(Argon2::new(Algorithm::Argon2id, Version::V0x13, p))
}

/// Raw Argon2id into `out`, no bounds checks (callers check, or use it for calibration on dummy input).
pub(crate) fn argon2id_raw(
    password: &[u8],
    salt: &[u8],
    params: &KdfParams,
    out: &mut [u8],
) -> Result<()> {
    argon2(params)?
        .hash_password_into(password, salt, out)
        .map_err(|_| CryptoError::Internal)
}

/// Argon2id(NFKC(password), salt, params) → `KEK_pw`. Bounds and salt length are checked before the KDF runs.
pub(crate) fn derive_password_kek(
    password: &SecretString,
    salt: &[u8],
    params: &KdfParams,
) -> Result<Kek> {
    params.validate()?;
    if salt.len() != SALT_LEN {
        return Err(CryptoError::InvalidKdfParams("salt must be 16 bytes"));
    }
    let normalized = normalize_password(password)?;
    Kek::fill_with(|out| argon2id_raw(normalized.as_bytes(), salt, params, out))
}

/// Result of [`calibrate`].
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Calibration {
    /// The chosen Standard-profile parameters for this device.
    pub params: KdfParams,
    /// Measured duration of a single pass at `params.m_kib`, in milliseconds.
    pub per_pass_ms: u64,
    /// Estimated unlock time with `params`, in milliseconds (`estMs` in `VaultStatus.kdf`).
    pub estimated_ms: u64,
}

/// Target used to choose `t` at the full 256 MiB (SPEC §9.3 step 2).
pub const CALIBRATION_TARGET: Duration = Duration::from_millis(800);
/// Minimum total time kept when stepping memory down (SPEC §9.3 step 3).
pub const CALIBRATION_MIN_TOTAL: Duration = Duration::from_millis(500);
/// Upper end of the Standard target window; a smaller `m` is accepted once `3` passes fit in it.
pub const CALIBRATION_MAX_TOTAL: Duration = Duration::from_millis(1500);
/// Devices with less available RAM than this step memory down.
pub const CALIBRATION_RAM_THRESHOLD: u64 = 4 * 1024 * 1024 * 1024;
/// Memory steps tried below 256 MiB, in KiB.
pub const CALIBRATION_STEPS_KIB: [u32; 3] = [196_608, 131_072, 65_536];

/// Times one Argon2id run with `params` on a dummy input (no bounds check; `t = 1` is allowed here).
pub fn measure_kdf(params: &KdfParams) -> Result<Duration> {
    let mut out = Zeroizing::new([0u8; KEY_LEN]);
    let start = Instant::now();
    argon2id_raw(
        b"emp-calibration-dummy-password",
        &[0u8; SALT_LEN],
        params,
        out.as_mut_slice(),
    )?;
    Ok(start.elapsed())
}

/// Calibrates the Standard profile on this device (SPEC §9.3) using real Argon2 runs.
///
/// `available_ram_bytes = None` means "unknown", which is treated as plenty. Takes a few seconds.
pub fn calibrate(available_ram_bytes: Option<u64>) -> Result<Calibration> {
    calibrate_with(available_ram_bytes, measure_kdf)
}

fn ceil_div_duration(target: Duration, per_pass: Duration) -> u32 {
    let per = per_pass.as_nanos().max(1);
    let n = target.as_nanos().div_ceil(per);
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

/// [`calibrate`] with an injectable timer (`measure(params)` returns how long one run with `params` took).
///
/// 1. `T1` = time of `m = 256 MiB, t = 1, p = 4`.
/// 2. If `T1 ≤ 0.8 s` and RAM ≥ 4 GiB (or unknown): `t = clamp(ceil(0.8 s / T1), 3, 10)` at 256 MiB.
/// 3. Otherwise step `m` down through 192, 128, 64 MiB. A step is usable when it fits the RAM cap
///    (`RAM / 16`, only applied under 4 GiB) and, if the device was slow, when 3 passes fit in 1.5 s; 64 MiB is
///    always accepted. `t` is then raised to keep the total at or above 0.5 s: `clamp(ceil(0.5 s / T_m), 3, 20)`.
pub fn calibrate_with(
    available_ram_bytes: Option<u64>,
    mut measure: impl FnMut(&KdfParams) -> Result<Duration>,
) -> Result<Calibration> {
    let p = KdfParams::STANDARD.p;
    let low_ram = available_ram_bytes.is_some_and(|r| r < CALIBRATION_RAM_THRESHOLD);
    let full = KdfParams {
        m_kib: KdfParams::STANDARD.m_kib,
        t: 1,
        p,
    };
    let t1 = measure(&full)?;
    let slow = t1 > CALIBRATION_TARGET;

    if !slow && !low_ram {
        let t = ceil_div_duration(CALIBRATION_TARGET, t1).clamp(3, 10);
        let params = KdfParams {
            m_kib: full.m_kib,
            t,
            p,
        };
        return Ok(Calibration {
            params,
            per_pass_ms: ms(t1),
            estimated_ms: ms(t1).saturating_mul(u64::from(t)),
        });
    }

    let ram_cap_kib = available_ram_bytes
        .filter(|_| low_ram)
        .map(|r| r / 16 / 1024);
    let mut chosen = None;
    for (i, &m_kib) in CALIBRATION_STEPS_KIB.iter().enumerate() {
        let is_last = i + 1 == CALIBRATION_STEPS_KIB.len();
        if !is_last && ram_cap_kib.is_some_and(|cap| u64::from(m_kib) > cap) {
            continue;
        }
        let tm = measure(&KdfParams { m_kib, t: 1, p })?;
        let fits_time = !slow || tm.saturating_mul(3) <= CALIBRATION_MAX_TOTAL;
        if fits_time || is_last {
            chosen = Some((m_kib, tm));
            break;
        }
    }
    let (m_kib, tm) = chosen.ok_or(CryptoError::Internal)?;
    let t = ceil_div_duration(CALIBRATION_MIN_TOTAL, tm).clamp(KdfParams::MIN_T, KdfParams::MAX_T);
    let params = KdfParams { m_kib, t, p };
    params.validate()?;
    Ok(Calibration {
        params,
        per_pass_ms: ms(tm),
        estimated_ms: ms(tm).saturating_mul(u64::from(t)),
    })
}

/// Estimates the run time of `params` from a measured single-pass time at `measured_m_kib`
/// (Argon2 cost is roughly linear in `m · t`).
#[must_use]
pub fn estimate_ms(params: &KdfParams, per_pass_ms: u64, measured_m_kib: u32) -> u64 {
    if measured_m_kib == 0 {
        return 0;
    }
    let num = u128::from(per_pass_ms) * u128::from(params.m_kib) * u128::from(params.t);
    u64::try_from(num / u128::from(measured_m_kib)).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::keys::KEY_LEN;

    fn pw(s: &str) -> SecretString {
        SecretString::from(s.to_owned())
    }

    #[test]
    fn presets_valid() {
        KdfParams::FLOOR.validate().unwrap();
        KdfParams::STANDARD.validate().unwrap();
        KdfParams::HIGH.validate().unwrap();
        KdfParams::INSECURE_TEST.validate().unwrap();
        assert_eq!(KdfProfile::Standard.params(), KdfParams::STANDARD);
        assert_eq!(KdfProfile::High.params(), KdfParams::HIGH);
    }

    #[test]
    fn bounds() {
        let ok = KdfParams::FLOOR;
        let cases = [
            KdfParams {
                m_kib: 65_535,
                ..ok
            },
            KdfParams {
                m_kib: 4_194_305,
                ..ok
            },
            KdfParams { t: 2, ..ok },
            KdfParams { t: 21, ..ok },
            KdfParams { p: 0, ..ok },
            KdfParams { p: 17, ..ok },
            KdfParams {
                m_kib: 8,
                t: 1,
                p: 2,
            }, // close to, but not exactly, INSECURE_TEST
        ];
        for c in cases {
            assert!(
                matches!(c.validate(), Err(CryptoError::InvalidKdfParams(_))),
                "{c:?}"
            );
        }
        KdfParams {
            m_kib: 4_194_304,
            t: 20,
            p: 16,
        }
        .validate()
        .unwrap();
        KdfParams {
            m_kib: 65_536,
            t: 3,
            p: 1,
        }
        .validate()
        .unwrap();
    }

    #[test]
    fn bounds_checked_before_kdf_runs() {
        // A huge m would take forever / OOM if the KDF ran; it must be rejected instantly.
        let start = Instant::now();
        let bad = KdfParams {
            m_kib: u32::MAX,
            t: 3,
            p: 4,
        };
        assert!(matches!(
            derive_password_kek(&pw("x"), &[0; 16], &bad),
            Err(CryptoError::InvalidKdfParams(_))
        ));
        let bad_t = KdfParams {
            m_kib: 65_536,
            t: 1_000_000,
            p: 4,
        };
        assert!(derive_password_kek(&pw("x"), &[0; 16], &bad_t).is_err());
        assert!(start.elapsed() < Duration::from_millis(200));
        // Salt length.
        assert!(matches!(
            derive_password_kek(&pw("x"), &[0; 15], &KdfParams::INSECURE_TEST),
            Err(CryptoError::InvalidKdfParams(_))
        ));
    }

    #[test]
    fn cbor_roundtrip_and_canonical() {
        for p in [
            KdfParams::FLOOR,
            KdfParams::STANDARD,
            KdfParams::HIGH,
            KdfParams::INSECURE_TEST,
        ] {
            let c = p.to_cbor();
            assert_eq!(KdfParams::from_cbor(&c).unwrap(), p);
        }
        // Standard: {"m": 262144, "p": 4, "t": 3}
        assert_eq!(
            KdfParams::STANDARD.to_cbor(),
            vec![
                0xa3, 0x61, b'm', 0x1a, 0x00, 0x04, 0x00, 0x00, 0x61, b'p', 0x04, 0x61, b't', 0x03
            ]
        );
        // Non-minimal integer encoding is rejected.
        let non_min = vec![
            0xa3, 0x61, b'm', 0x1a, 0x00, 0x04, 0x00, 0x00, 0x61, b'p', 0x18, 0x04, 0x61, b't',
            0x03,
        ];
        assert!(KdfParams::from_cbor(&non_min).is_err());
        // Wrong key order, trailing bytes, truncation.
        let swapped = vec![
            0xa3, 0x61, b'p', 0x04, 0x61, b'm', 0x1a, 0x00, 0x04, 0x00, 0x00, 0x61, b't', 0x03,
        ];
        assert!(KdfParams::from_cbor(&swapped).is_err());
        let mut trailing = KdfParams::STANDARD.to_cbor();
        trailing.push(0);
        assert!(KdfParams::from_cbor(&trailing).is_err());
        let c = KdfParams::STANDARD.to_cbor();
        for n in 0..c.len() {
            assert!(KdfParams::from_cbor(&c[..n]).is_err());
        }
    }

    #[test]
    fn json_shape() {
        let j = serde_json::to_string(&KdfParams::STANDARD).unwrap();
        assert_eq!(j, r#"{"mKiB":262144,"t":3,"p":4}"#);
    }

    #[test]
    fn normalization() {
        // NFKC: "ﬁ" (U+FB01) → "fi", composed and decomposed é agree.
        assert_eq!(normalize_password(&pw("\u{FB01}")).unwrap().as_str(), "fi");
        assert_eq!(
            normalize_password(&pw("e\u{301}")).unwrap().as_str(),
            normalize_password(&pw("\u{e9}")).unwrap().as_str()
        );
        assert!(normalize_password(&pw(&"a".repeat(1024))).is_ok());
        assert_eq!(
            normalize_password(&pw(&"a".repeat(1025))),
            Err(CryptoError::PasswordTooLong)
        );
        // "é" is 2 bytes: 512 × é = 1024 bytes OK; 513 × é = 1026 bytes too long.
        assert!(normalize_password(&pw(&"\u{e9}".repeat(512))).is_ok());
        assert!(normalize_password(&pw(&"\u{e9}".repeat(513))).is_err());
    }

    #[test]
    fn derive_deterministic_and_sensitive() {
        let p = KdfParams::INSECURE_TEST;
        let a = derive_password_kek(&pw("correct horse"), &[1; 16], &p).unwrap();
        let b = derive_password_kek(&pw("correct horse"), &[1; 16], &p).unwrap();
        let c = derive_password_kek(&pw("correct horsf"), &[1; 16], &p).unwrap();
        let d = derive_password_kek(&pw("correct horse"), &[2; 16], &p).unwrap();
        assert_eq!(a.expose(), b.expose());
        assert_ne!(a.expose(), c.expose());
        assert_ne!(a.expose(), d.expose());
        // Normalisation is applied: compatibility forms derive the same key.
        let e = derive_password_kek(&pw("\u{FB01}"), &[1; 16], &p).unwrap();
        let f = derive_password_kek(&pw("fi"), &[1; 16], &p).unwrap();
        assert_eq!(e.expose(), f.expose());
        assert_eq!(a.expose().len(), KEY_LEN);
    }

    fn fake_timer(per_256_ms: u64) -> impl FnMut(&KdfParams) -> Result<Duration> {
        move |p: &KdfParams| {
            let ms = per_256_ms * u64::from(p.m_kib) * u64::from(p.t) / 262_144;
            Ok(Duration::from_millis(ms))
        }
    }

    #[test]
    fn calibration_fast_device() {
        // 200 ms per pass ⇒ t = ceil(800/200) = 4.
        let c = calibrate_with(Some(16 << 30), fake_timer(200)).unwrap();
        assert_eq!(
            c.params,
            KdfParams {
                m_kib: 262_144,
                t: 4,
                p: 4
            }
        );
        assert_eq!(c.estimated_ms, 800);
        // Very fast ⇒ clamped to 10. Very "slow-ish" (0.5 s) ⇒ clamped to 3 (ceil(1.6)=2 → 3).
        assert_eq!(calibrate_with(None, fake_timer(10)).unwrap().params.t, 10);
        assert_eq!(calibrate_with(None, fake_timer(500)).unwrap().params.t, 3);
    }

    #[test]
    fn calibration_slow_device_steps_down() {
        // 1200 ms per pass at 256 MiB ⇒ 192 MiB = 900 ms (3× > 1.5 s), 128 MiB = 600 ms (no), 64 MiB = 300 ms.
        let c = calibrate_with(None, fake_timer(1200)).unwrap();
        assert_eq!(c.params.m_kib, 65_536);
        assert_eq!(c.params.t, 3); // ceil(500/300) = 2 → 3
        // 900 ms ⇒ 192 MiB = 675 ms (no), 128 MiB = 450 ms (3×450 = 1350 ≤ 1500, yes).
        let c = calibrate_with(None, fake_timer(900)).unwrap();
        assert_eq!(c.params.m_kib, 131_072);
        // Absurdly slow device still lands on the floor.
        let c = calibrate_with(None, fake_timer(100_000)).unwrap();
        assert_eq!(
            c.params,
            KdfParams {
                m_kib: 65_536,
                t: 3,
                p: 4
            }
        );
    }

    #[test]
    fn calibration_low_ram() {
        // Fast CPU but 3 GiB RAM ⇒ cap 192 MiB; t raised to keep ≥ 0.5 s (192 MiB = 30 ms ⇒ t = 17).
        let c = calibrate_with(Some(3 << 30), fake_timer(40)).unwrap();
        assert_eq!(c.params.m_kib, 196_608);
        assert_eq!(c.params.t, 17);
        // 1.5 GiB ⇒ cap 96 MiB ⇒ 64 MiB; t capped at 20.
        let c = calibrate_with(Some(3 << 29), fake_timer(10)).unwrap();
        assert_eq!(
            c.params,
            KdfParams {
                m_kib: 65_536,
                t: 20,
                p: 4
            }
        );
        c.params.validate().unwrap();
    }

    #[test]
    fn measure_runs() {
        let d = measure_kdf(&KdfParams::INSECURE_TEST).unwrap();
        assert!(d < Duration::from_secs(5));
    }

    #[test]
    fn estimate() {
        assert_eq!(estimate_ms(&KdfParams::STANDARD, 300, 262_144), 900);
        assert_eq!(estimate_ms(&KdfParams::FLOOR, 300, 262_144), 225);
        assert_eq!(estimate_ms(&KdfParams::FLOOR, 300, 0), 0);
    }

    #[test]
    fn weaker_than() {
        assert!(KdfParams::FLOOR.is_weaker_than(&KdfParams::STANDARD));
        assert!(!KdfParams::HIGH.is_weaker_than(&KdfParams::STANDARD));
        assert!(!KdfParams::STANDARD.is_weaker_than(&KdfParams::STANDARD));
    }
}

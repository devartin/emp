//! EMP extensions: `STOCK`, `FX`, `CRYPTO` (SPEC §14.3). They read only the host's local cache, return
//! `#FETCH!` while data is pending, and record the key so the app can fetch it outside the engine.

use super::FnSpec;
use crate::eval::{Ev, EvalCtx, R};
use crate::fspec;
use crate::host::{ExternalKey, ExternalValue};
use crate::value::{ErrorKind, Value};

/// Valid `STOCK` fields.
pub const STOCK_FIELDS: &[&str] = &[
    "price",
    "change",
    "changepct",
    "open",
    "high",
    "low",
    "prevclose",
    "volume",
    "name",
    "currency",
];

/// EMP function table.
pub static SPECS: &[FnSpec] = &[
    fspec!(
        "STOCK",
        Emp,
        1,
        2,
        [Value],
        stock,
        "STOCK(symbol, [field])",
        "Cached market data for a symbol (price, change, changepct, open, high, low, prevclose, volume, name, currency).",
        "=STOCK(\"AAPL\",\"price\")"
    ),
    fspec!(
        "FX",
        Emp,
        2,
        3,
        [Value],
        fx,
        "FX(from, to, [date])",
        "Cached exchange rate between two currencies.",
        "=FX(\"USD\",\"EUR\")"
    ),
    fspec!(
        "CRYPTO",
        Emp,
        1,
        2,
        [Value],
        crypto,
        "CRYPTO(id, [field])",
        "Cached crypto-asset data.",
        "=CRYPTO(\"BTC\")"
    ),
];

fn resolve(ctx: &mut EvalCtx, key: ExternalKey) -> R {
    let ans = ctx.host.external(&key);
    ctx.note_external(key);
    match ans {
        ExternalValue::Ready(v) => Ok(Ev::V(v)),
        ExternalValue::Pending => Err(ErrorKind::Fetch),
        ExternalValue::Unavailable => Err(ErrorKind::NA),
    }
}

fn field(ctx: &mut EvalCtx, a: &[Ev], i: usize) -> Result<String, ErrorKind> {
    Ok(ctx.opt_text(a, i, "price")?.trim().to_ascii_lowercase())
}

fn stock(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let symbol = ctx.text(&a[0])?.trim().to_ascii_uppercase();
    if symbol.is_empty() || symbol.len() > 32 {
        return Err(ErrorKind::Value);
    }
    let f = field(ctx, a, 1)?;
    if !STOCK_FIELDS.contains(&f.as_str()) {
        return Err(ErrorKind::Value);
    }
    resolve(ctx, ExternalKey::Stock { symbol, field: f })
}

fn fx(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let from = ctx.text(&a[0])?.trim().to_ascii_uppercase();
    let to = ctx.text(&a[1])?.trim().to_ascii_uppercase();
    if from.len() != 3
        || to.len() != 3
        || !from
            .chars()
            .chain(to.chars())
            .all(|c| c.is_ascii_alphabetic())
    {
        return Err(ErrorKind::Value);
    }
    if from == to {
        return Ok(Ev::V(Value::Number(1.0)));
    }
    let date = match a.get(2) {
        None | Some(Ev::Missing) => None,
        Some(ev) => {
            let s = ctx.num(ev)?;
            Some(crate::datetime::serial_to_iso(s.floor(), ctx.date1904()).ok_or(ErrorKind::Num)?)
        }
    };
    resolve(ctx, ExternalKey::Fx { from, to, date })
}

fn crypto(ctx: &mut EvalCtx, a: &[Ev]) -> R {
    let id = ctx.text(&a[0])?.trim().to_ascii_lowercase();
    if id.is_empty() || id.len() > 64 {
        return Err(ErrorKind::Value);
    }
    let f = field(ctx, a, 1)?;
    if !STOCK_FIELDS.contains(&f.as_str()) {
        return Err(ErrorKind::Value);
    }
    resolve(ctx, ExternalKey::Crypto { id, field: f })
}

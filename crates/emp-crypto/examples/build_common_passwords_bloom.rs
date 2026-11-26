//! Builds `common-passwords.bloom` (SPEC §9.10) from a newline-separated password list.
//!
//! ```text
//! cargo run -p emp-crypto --example build_common_passwords_bloom -- top-100k.txt common-passwords.bloom [fp_rate]
//! ```
//!
//! The default false-positive rate is 1e-6 (about 360 KB for 100k entries).

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (Some(input), Some(output)) = (args.get(1), args.get(2)) else {
        eprintln!("usage: build_common_passwords_bloom <list.txt> <out.bloom> [fp_rate]");
        return ExitCode::from(2);
    };
    let fp_rate = match args.get(3).map(|s| s.parse::<f64>()) {
        None => 1e-6,
        Some(Ok(v)) => v,
        Some(Err(_)) => {
            eprintln!("fp_rate must be a number");
            return ExitCode::from(2);
        }
    };
    let text = match std::fs::read_to_string(input) {
        Ok(t) => t,
        Err(e) => {
            eprintln!("cannot read {input}: {e}");
            return ExitCode::FAILURE;
        }
    };
    let items: Vec<&str> = text
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect();
    let filter = match emp_crypto::password::CommonPasswords::build(items.iter().copied(), fp_rate)
    {
        Ok(f) => f,
        Err(e) => {
            eprintln!("cannot build filter: {e}");
            return ExitCode::FAILURE;
        }
    };
    let bytes = filter.to_bytes();
    if let Err(e) = std::fs::write(output, &bytes) {
        eprintln!("cannot write {output}: {e}");
        return ExitCode::FAILURE;
    }
    println!(
        "{} entries -> {} bytes ({filter:?})",
        items.len(),
        bytes.len()
    );
    ExitCode::SUCCESS
}

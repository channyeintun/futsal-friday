//! What the shared logic answers, for a test that cannot link against it.
//!
//! The browser suites under `web/test/` are plain Node, and neither half of the
//! shared logic is reachable from there: `futsal-core` is Rust and its twin is
//! Kite. Re-implementing a rule inside a test would let two wrong copies agree,
//! so instead the test asks the real implementation, through this.
//!
//! Deliberately tiny, and deliberately not a general CLI: one subcommand per
//! question a test actually asks, printing one line.

use std::process::ExitCode;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = args.first().map(String::as_str) else {
        eprintln!("usage: futsal-says <command> [args…]");
        return ExitCode::FAILURE;
    };

    match command {
        // vietqr <bankBin> <accountNumber> <amount> <reference>
        "vietqr" => {
            if args.len() != 5 {
                eprintln!("usage: futsal-says vietqr <bankBin> <account> <amount> <reference>");
                return ExitCode::FAILURE;
            }
            let Ok(amount) = args[3].parse::<i64>() else {
                eprintln!("amount must be a whole number of dong, got {:?}", args[3]);
                return ExitCode::FAILURE;
            };
            let input = futsal_core::vietqr::VietQrInput {
                amount: Some(amount),
                reference: Some(&args[4]),
                ..futsal_core::vietqr::VietQrInput::new(&args[1], &args[2])
            };
            match futsal_core::vietqr::build_vietqr_payload(&input) {
                Ok(payload) => {
                    println!("{payload}");
                    ExitCode::SUCCESS
                }
                Err(why) => {
                    eprintln!("{why}");
                    ExitCode::FAILURE
                }
            }
        }
        // money <total> <count> <granularity> — the shares, comma separated.
        "money" => {
            if args.len() != 4 {
                eprintln!("usage: futsal-says money <total> <count> <granularity>");
                return ExitCode::FAILURE;
            }
            let parsed: Result<Vec<i64>, _> = args[1..4].iter().map(|a| a.parse::<i64>()).collect();
            let Ok(n) = parsed else {
                eprintln!("money takes three whole numbers");
                return ExitCode::FAILURE;
            };
            let shares = futsal_core::money::split_equally(n[0], n[1], n[2]);
            println!(
                "{}",
                shares.iter().map(i64::to_string).collect::<Vec<_>>().join(",")
            );
            ExitCode::SUCCESS
        }
        other => {
            eprintln!("no such question: {other}");
            ExitCode::FAILURE
        }
    }
}

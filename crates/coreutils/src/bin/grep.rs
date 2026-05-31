//! grep — print lines matching a pattern (substring), from files or stdin (FR-18).

use std::io::{self, BufRead, BufReader, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: grep PATTERN [FILE...]");
        std::process::exit(2);
    }
    let pattern = &args[0];
    let files = &args[1..];
    let mut out = io::stdout();
    let mut matched = false;

    if files.is_empty() {
        let stdin = io::stdin();
        filter(stdin.lock(), pattern, &mut out, &mut matched);
    } else {
        for f in files {
            match std::fs::File::open(f) {
                Ok(file) => filter(BufReader::new(file), pattern, &mut out, &mut matched),
                Err(_) => eprintln!("grep: {f}: No such file or directory"),
            }
        }
    }
    // grep exits 0 if any line matched, 1 otherwise.
    std::process::exit(i32::from(!matched));
}

fn filter<R: BufRead>(reader: R, pattern: &str, out: &mut impl Write, matched: &mut bool) {
    for line in reader.lines().map_while(Result::ok) {
        if line.contains(pattern) {
            let _ = writeln!(out, "{line}");
            *matched = true;
        }
    }
}

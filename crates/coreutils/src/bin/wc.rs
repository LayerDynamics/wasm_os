//! wc — count lines, words, and bytes from files or stdin (FR-18).

use std::io::{self, Read};

fn main() {
    wasmos_sys::chdir_to_pwd(); // relative paths resolve against $PWD, not the preopen root
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        let mut buf = Vec::new();
        let _ = io::stdin().read_to_end(&mut buf);
        report(&buf, None);
        return;
    }
    for path in &args {
        match std::fs::read(path) {
            Ok(bytes) => report(&bytes, Some(path)),
            Err(_) => eprintln!("wc: {path}: No such file or directory"),
        }
    }
}

fn report(bytes: &[u8], name: Option<&str>) {
    // Count over raw bytes so lines/words/bytes all describe the same input. Going
    // through String::from_utf8_lossy would substitute U+FFFD for invalid UTF-8 and
    // drift the line/word counts away from the byte count on binary input. Counting
    // newline bytes also matches canonical `wc -l`.
    let lines = bytes.iter().filter(|&&b| b == b'\n').count();
    let words = bytes.split(|b| b.is_ascii_whitespace()).filter(|w| !w.is_empty()).count();
    let count = bytes.len();
    match name {
        Some(n) => println!("{lines:>8} {words:>7} {count:>7} {n}"),
        None => println!("{lines:>8} {words:>7} {count:>7}"),
    }
}

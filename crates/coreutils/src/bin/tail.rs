//! tail — print the last N lines (default 10) of a file or stdin (FR-18).

use std::io::{self, BufRead, BufReader};

fn main() {
    let (n, file) = parse(std::env::args().skip(1).collect());
    let lines: Vec<String> = match file {
        Some(path) => match std::fs::File::open(&path) {
            Ok(f) => read_lines(BufReader::new(f)),
            Err(_) => {
                eprintln!("tail: {path}: No such file or directory");
                std::process::exit(1);
            }
        },
        None => read_lines(io::stdin().lock()),
    };
    let start = lines.len().saturating_sub(n);
    for line in &lines[start..] {
        println!("{line}");
    }
}

fn parse(args: Vec<String>) -> (usize, Option<String>) {
    let mut n = 10;
    let mut file = None;
    let mut i = 0;
    while i < args.len() {
        if args[i] == "-n" {
            i += 1;
            n = args.get(i).and_then(|v| v.parse().ok()).unwrap_or(10);
        } else {
            file = Some(args[i].clone());
        }
        i += 1;
    }
    (n, file)
}

fn read_lines<R: BufRead>(r: R) -> Vec<String> {
    r.lines().map_while(Result::ok).collect()
}

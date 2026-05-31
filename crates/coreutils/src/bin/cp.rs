//! cp — copy SRC to DST (FR-18).

use std::io::Read;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: cp SRC DST");
        std::process::exit(2);
    }
    let mut f = match std::fs::File::open(&args[0]) {
        Ok(f) => f,
        Err(_) => {
            eprintln!("cp: {}: No such file or directory", args[0]);
            std::process::exit(1);
        }
    };
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match f.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(_) => break,
        }
    }
    if std::fs::write(&args[1], &buf).is_err() {
        eprintln!("cp: cannot create {}", args[1]);
        std::process::exit(1);
    }
}

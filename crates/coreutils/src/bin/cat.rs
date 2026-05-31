//! cat — concatenate files (or stdin) to stdout (FR-18).

use std::io::{self, Read, Write};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut out = io::stdout();
    if args.is_empty() {
        let mut buf = Vec::new();
        let _ = io::stdin().read_to_end(&mut buf);
        let _ = out.write_all(&buf);
        return;
    }
    let mut status = 0;
    for path in &args {
        match read_all(path) {
            Ok(bytes) => {
                let _ = out.write_all(&bytes);
            }
            Err(_) => {
                eprintln!("cat: {path}: No such file or directory");
                status = 1;
            }
        }
    }
    std::process::exit(status);
}

/// Read a whole file with an explicit loop (does not rely on `fd_filestat_get`).
fn read_all(path: &str) -> io::Result<Vec<u8>> {
    let mut f = std::fs::File::open(path)?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        let n = f.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    Ok(buf)
}

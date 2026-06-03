//! whoami — print the effective user name. WASM_OS runs as a single unprivileged
//! user; the name is read from real config: $USER if set, else the first non-root
//! account in /etc/passwd, falling back to "user".

use std::fs;

fn main() {
    if let Ok(u) = std::env::var("USER") {
        if !u.is_empty() {
            println!("{u}");
            return;
        }
    }
    let name = fs::read_to_string("/etc/passwd")
        .ok()
        .and_then(|c| {
            c.lines().find_map(|line| {
                let f: Vec<&str> = line.split(':').collect();
                // name:x:uid:gid:... — the first account whose uid isn't 0 (root).
                match (f.first(), f.get(2)) {
                    (Some(n), Some(uid)) if *uid != "0" && !n.is_empty() => Some((*n).to_string()),
                    _ => None,
                }
            })
        })
        .unwrap_or_else(|| "user".to_string());
    println!("{name}");
}

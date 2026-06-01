//! spinner — M4 concurrency stress fixture (FR-3).
//!
//! Does a little real work — each iteration makes a syscall (`fd_write`), so the
//! kernel accounts scheduler ticks that `ps`/`top` can show — then parks on stdin
//! so 32 instances coexist as live processes without burning CPU. A read of EOF
//! (or SIGTERM, M4-T5) ends it.

use std::io::{Read, Write};

fn main() {
    let mut acc: u64 = 0;
    let mut out = std::io::stdout();
    for i in 0..100u64 {
        acc = acc.wrapping_add(i.wrapping_mul(i));
        // A real syscall each iteration registers kernel activity (CPU ticks).
        let _ = out.write_all(b".");
    }
    let _ = out.flush();
    std::hint::black_box(acc);

    // Stay alive without spinning: park on stdin. Closing stdin (EOF) — or a
    // SIGTERM delivered in M4-T5 — ends the process cleanly.
    let mut byte = [0u8; 1];
    let _ = std::io::stdin().read(&mut byte);
}

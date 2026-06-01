//! sigdemo — M4-T5 cooperative-signal fixture.
//!
//! Demonstrates catchable SIGTERM handling. The process blocks in `sig_wait`
//! (zero CPU — it parks until a signal is delivered, no busy-poll), and when it
//! observes SIGTERM it shuts down gracefully: it writes a marker file and exits
//! 0. This is the counterpart to an uncatchable SIGKILL (which a process cannot
//! observe or handle — the kernel just reaps it). The E2E checks the marker file
//! appears for SIGTERM but never for SIGKILL.

use wasmos_sys::{sig_wait, SIGTERM};

fn main() {
    loop {
        let signals = sig_wait(); // parks until at least one signal is delivered
        if signals.contains(&SIGTERM) {
            let _ = std::fs::write("/home/sig-out.txt", b"TERMINATED-GRACEFULLY");
            std::process::exit(0);
        }
        // Any other signal: ignore and keep waiting.
    }
}

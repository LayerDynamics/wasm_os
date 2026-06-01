//! kill — send a signal to a process (M4-T5, FR-8/FR-34). `kill [-SIG] <pid>`.
//!
//! Mirrors the shell's `kill` builtin but as a standalone `/bin/kill` for use by
//! full path or in pipelines. It calls the `wasmos_kernel` `kill` syscall, which
//! requires the Signal capability — the shell delegates that capability when it
//! spawns `kill` (a process cannot signal others without it).

use wasmos_sys::{kill, SIGKILL, SIGTERM};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut sig = SIGTERM;
    let mut pid_tok: Option<String> = None;
    for a in &args {
        if let Some(spec) = a.strip_prefix('-') {
            sig = match spec {
                "9" | "KILL" | "SIGKILL" => SIGKILL,
                "15" | "TERM" | "SIGTERM" => SIGTERM,
                other => match other.parse::<u8>() {
                    Ok(n) => n,
                    Err(_) => {
                        eprintln!("kill: invalid signal `{a}`");
                        std::process::exit(2);
                    }
                },
            };
        } else {
            pid_tok = Some(a.clone());
        }
    }
    let pid = match pid_tok.and_then(|p| p.parse::<u32>().ok()) {
        Some(p) => p,
        None => {
            eprintln!("usage: kill [-SIG] <pid>");
            std::process::exit(2);
        }
    };
    match kill(pid, sig) {
        0 => {}
        76 => {
            eprintln!("kill: ({pid}) - operation not permitted");
            std::process::exit(1);
        }
        71 => {
            eprintln!("kill: ({pid}) - no such process");
            std::process::exit(1);
        }
        e => {
            eprintln!("kill: ({pid}) - errno {e}");
            std::process::exit(1);
        }
    }
}

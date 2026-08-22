//! renice — change a running process's scheduling priority (runtime priority, FR-8).
//! `renice <priority> <pid>`. A higher priority number schedules sooner (the
//! kernel re-buckets the process in the run queue immediately).
//!
//! Renicing another process requires the Signal capability, which the shell
//! delegates when it spawns `renice` (mirrors `kill`). Like `kill`, it calls a
//! `wasmos_kernel` syscall (`set_priority`) rather than plain WASI.

use wasmos_sys::set_priority;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 2 {
        eprintln!("usage: renice <priority> <pid>");
        std::process::exit(2);
    }
    let priority: u8 = match args[0].parse() {
        Ok(p) => p,
        Err(_) => {
            eprintln!("renice: invalid priority `{}` (0-255)", args[0]);
            std::process::exit(2);
        }
    };
    let pid: u32 = match args[1].parse() {
        Ok(p) => p,
        Err(_) => {
            eprintln!("renice: invalid pid `{}`", args[1]);
            std::process::exit(2);
        }
    };
    match set_priority(pid, priority) {
        0 => println!("renice: pid {pid} priority set to {priority}"),
        76 => {
            eprintln!("renice: ({pid}) - operation not permitted");
            std::process::exit(1);
        }
        e => {
            eprintln!("renice: ({pid}) - errno {e}");
            std::process::exit(1);
        }
    }
}

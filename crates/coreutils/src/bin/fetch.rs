//! fetch — fetch a URL through the host network broker (network broker, OQ-2). `fetch <url>`.
//!
//! WASM_OS processes are sandboxed and cannot open sockets; networking is a
//! brokered host capability (Assumption 9 / FR-NG-1). `fetch` calls the
//! `wasmos_kernel` net_request syscall, which the kernel gates on the Net
//! capability and the host performs as a real `fetch`. The shell delegates Net to
//! this coreutil (mirroring how it delegates Signal to `kill`). The body is written
//! to stdout (redirect it to a file with `>`).

use std::io::Write;
use wasmos_sys::net_request;

fn main() {
    let url = match std::env::args().nth(1) {
        Some(u) => u,
        None => {
            eprintln!("usage: fetch <url>");
            std::process::exit(2);
        }
    };
    match net_request(&url) {
        Ok(body) => {
            let _ = std::io::stdout().write_all(&body);
        }
        Err(76) => {
            eprintln!("fetch: {url}: operation not permitted (no Net capability)");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("fetch: {url}: errno {e}");
            std::process::exit(1);
        }
    }
}

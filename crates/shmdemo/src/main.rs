//! shmdemo — M4-T4 shared-memory fixture.
//!
//! One binary, two roles. The **writer** (no `reader` arg) creates a shm region,
//! fills it, spawns a **reader** child (passing the shm-id via argv), grants the
//! child access, then releases a channel barrier. The reader waits on the barrier
//! (so it maps only AFTER the grant lands — race-free), maps the region, reads it,
//! and writes the bytes to `/home/shm-out.txt` for the E2E to verify. This proves
//! real cross-process shared memory: the reader observes bytes the writer wrote
//! into a region in a different address space (FR-6).

use wasmos_sys::{chan_open, chan_recv, chan_send, shm_create, shm_grant, shm_map, shm_read, shm_write, spawn, wait, Stdio};

const PATTERN: &[u8] = b"SHARED-MEMORY-WORKS";
const SYNC_CHANNEL: &str = "shmsync";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let reader_id = args
        .iter()
        .position(|a| a == "reader")
        .and_then(|i| args.get(i + 1))
        .and_then(|s| s.parse::<u32>().ok());

    match reader_id {
        Some(id) => reader(id),
        None => writer(),
    }
}

/// Create + populate a region, hand it to a freshly spawned child, then unblock it.
fn writer() {
    let id = match shm_create(64) {
        Ok(i) => i,
        Err(_) => std::process::exit(1),
    };
    if shm_write(id, 0, PATTERN) != 0 {
        std::process::exit(2);
    }
    // Open the sync channel BEFORE spawning so the child's connect always finds it.
    let (cid, _end) = match chan_open(SYNC_CHANNEL) {
        Ok(v) => v,
        Err(_) => std::process::exit(3),
    };
    let stdio = [Stdio::Terminal, Stdio::Terminal, Stdio::Terminal];
    let child = match spawn("/bin/shmdemo", &["shmdemo", "reader", &id.to_string()], &stdio, "/", false, false, false) {
        Ok(p) => p,
        Err(_) => std::process::exit(4),
    };
    // Grant the child access, THEN release the barrier — the child maps only after
    // it receives "go", which is sent only after this grant succeeds.
    if shm_grant(id, child) != 0 {
        std::process::exit(5);
    }
    let _ = chan_send(cid, b"go");
    // The creator owns the region's lifetime — keep it alive until the reader has
    // finished, otherwise this process's exit would free the region mid-read.
    let _ = wait(child);
}

/// Wait for the writer's grant, then map + read the shared region and persist it.
fn reader(id: u32) {
    let (cid, _end) = match chan_open(SYNC_CHANNEL) {
        Ok(v) => v,
        Err(_) => std::process::exit(1),
    };
    let _ = chan_recv(cid); // parks until the writer sends "go" (post-grant)
    if shm_map(id) != 0 {
        std::process::exit(2);
    }
    match shm_read(id, 0, PATTERN.len() as u32) {
        Ok(buf) => {
            let _ = std::fs::write("/home/shm-out.txt", &buf);
        }
        Err(_) => std::process::exit(3),
    }
}

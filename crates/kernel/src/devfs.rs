//! devfs — synthetic `/dev` device nodes with **real** semantics handled at the
//! syscall layer (not stored bytes):
//!   /dev/null    writes discarded, reads return EOF
//!   /dev/zero    reads return zero bytes
//!   /dev/full    writes fail with ENOSPC, reads return zero bytes
//!   /dev/random  } reads return bytes from a generator seeded at boot with REAL host
//!   /dev/urandom } CSPRNG entropy (the deterministic kernel has no RNG of its own, so
//!                  the seed is plumbed in from the host's `crypto` — see seed_entropy).
//!   /dev/tty     the controlling terminal (writes go to it; reads return EOF here)
//!
//! `/dev/[u]random` is a host-entropy-seeded splitmix64 stream: the seed is true
//! randomness from the host, so each boot differs — it is not a fixed/simulated stream.

use crate::vfs::DirEntry;

pub const NODES: [&str; 6] = ["null", "zero", "full", "random", "urandom", "tty"];

pub fn is_dev(path: &str) -> bool {
    path == "/dev" || path.starts_with("/dev/")
}

/// `readdir("/dev")` — the device nodes. `None` if `path` is not `/dev`.
pub fn readdir(path: &str) -> Option<Vec<DirEntry>> {
    if path.trim_end_matches('/') != "/dev" {
        return None;
    }
    Some(NODES.iter().map(|n| DirEntry { name: (*n).to_string(), is_dir: false }).collect())
}

/// Whether `path` names an existing device node or `/dev` itself.
pub fn exists(path: &str) -> bool {
    if path == "/dev" {
        return true;
    }
    path.strip_prefix("/dev/").map(|n| NODES.contains(&n)).unwrap_or(false)
}

pub fn is_dir(path: &str) -> bool {
    path == "/dev"
}

/// Read semantics for a device. `len` is the requested byte count; `rng` is the
/// shared device RNG state (advanced for random/urandom). Returns the bytes, or
/// `None` if `path` is not a readable device node.
pub fn read(path: &str, len: usize, rng: &mut u64) -> Option<Vec<u8>> {
    match path.strip_prefix("/dev/")? {
        "null" | "tty" => Some(Vec::new()),       // EOF
        "zero" | "full" => Some(vec![0u8; len]),  // an endless run of zeros
        "random" | "urandom" => Some(random_bytes(rng, len)),
        _ => None,
    }
}

/// What a write to a device node does.
#[derive(PartialEq, Eq, Debug)]
pub enum DevWrite {
    /// Bytes are accepted and discarded (/dev/null, /dev/zero, /dev/random, …).
    Discard,
    /// The device is full — writes fail with ENOSPC (/dev/full).
    NoSpace,
    /// Goes to the controlling terminal (/dev/tty).
    Tty,
    /// Not a device node.
    NotDevice,
}

pub fn classify_write(path: &str) -> DevWrite {
    match path.strip_prefix("/dev/") {
        Some("full") => DevWrite::NoSpace,
        Some("tty") => DevWrite::Tty,
        Some(n) if NODES.contains(&n) => DevWrite::Discard,
        _ => DevWrite::NotDevice,
    }
}

/// splitmix64 — generate `len` bytes from the seeded device RNG, advancing it.
fn random_bytes(state: &mut u64, len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(len);
    while out.len() < len {
        *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = *state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^= z >> 31;
        out.extend_from_slice(&z.to_le_bytes());
    }
    out.truncate(len);
    out
}

/// Fold a host entropy seed (arbitrary length) into the 64-bit RNG state.
pub fn seed_state(seed: &[u8]) -> u64 {
    let mut s: u64 = 0xCBF2_9CE4_8422_2325; // FNV offset basis
    for &b in seed {
        s = (s ^ b as u64).wrapping_mul(0x0000_0100_0000_01B3);
    }
    s | 1 // never all-zero
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn null_zero_full_semantics() {
        let mut rng = seed_state(b"seed");
        assert_eq!(read("/dev/null", 16, &mut rng).unwrap().len(), 0);
        assert_eq!(read("/dev/zero", 16, &mut rng).unwrap(), vec![0u8; 16]);
        assert_eq!(read("/dev/full", 8, &mut rng).unwrap(), vec![0u8; 8]);
        assert_eq!(classify_write("/dev/null"), DevWrite::Discard);
        assert_eq!(classify_write("/dev/full"), DevWrite::NoSpace);
        assert_eq!(classify_write("/dev/tty"), DevWrite::Tty);
        assert_eq!(classify_write("/etc/x"), DevWrite::NotDevice);
    }

    #[test]
    fn random_is_seeded_and_varies() {
        let mut a = seed_state(b"entropy-A");
        let mut b = seed_state(b"entropy-B");
        let ra = read("/dev/urandom", 32, &mut a).unwrap();
        let rb = read("/dev/urandom", 32, &mut b).unwrap();
        assert_eq!(ra.len(), 32);
        assert_ne!(ra, rb); // different seeds → different streams
        // Successive reads from the same state advance (not a repeating block).
        let ra2 = read("/dev/random", 32, &mut a).unwrap();
        assert_ne!(ra, ra2);
    }

    #[test]
    fn readdir_and_exists() {
        assert!(readdir("/dev").unwrap().iter().any(|e| e.name == "null"));
        assert!(exists("/dev/urandom"));
        assert!(!exists("/dev/nope"));
        assert!(is_dir("/dev"));
    }
}

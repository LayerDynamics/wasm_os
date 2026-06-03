//! Thin VFS helpers for guests. On wasm32-wasip1 these map to WASI path/fd syscalls;
//! on the host they use std::fs (so the library is testable natively).

use std::io;

pub fn load_object(path: &str) -> io::Result<Vec<u8>> {
    std::fs::read(path)
}

pub fn write_file(path: &str, bytes: &[u8]) -> io::Result<()> {
    std::fs::write(path, bytes)
}

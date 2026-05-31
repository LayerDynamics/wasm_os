//! M1 smoke guest: write a line to stdout and exit 0. Proves a real Rust
//! `wasm32-wasip1` binary runs as a process and its `fd_write` is routed
//! through the SAB syscall ring to the kernel's captured stdout (FR-4, FR-9).

fn main() {
    println!("hello from wasm_os");
}

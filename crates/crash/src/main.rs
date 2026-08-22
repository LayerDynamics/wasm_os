//! WASI process runtime fault-injection guest: force a hard WASM trap (not a clean exit) to prove
//! crash containment (FR-34). `std::process::abort()` lowers to the wasm
//! `unreachable` instruction on `wasm32-wasip1`, so the process worker observes
//! a `RuntimeError` rather than a `proc_exit` — the kernel and peer processes
//! must survive and this process must become a zombie.

fn main() {
    std::process::abort();
}

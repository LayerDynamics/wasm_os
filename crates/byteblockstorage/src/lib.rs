//! byteblockstorage — a document stored as a self-executing wasm32-wasip1 module.
//! See docs/specs/SPEC-2-byteblockstorage.md.
//!
//! Re-exports grow module-by-module as the implementation lands (TDD order:
//! format → mint → io). Empty `mod` files below are valid empty modules.

mod format;
mod io;
mod mint;
pub mod wasi;

pub use format::{Error, Header, Tier};
pub use mint::mint;

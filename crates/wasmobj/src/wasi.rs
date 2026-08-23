//! VFS-facing document helpers for guests. On wasm32-wasip1 these map to WASI
//! path/fd syscalls; on the host they use std::fs (so the library is testable
//! natively).
//!
//! The editor and nano both use this module for the complete document lifecycle:
//! a valid `.wasm` object is opened as text, an existing executable `.wasm` is
//! treated as opaque bytes, and a saved object is minted or re-packed before it
//! is written back. Keeping that policy here prevents the two editors from
//! drifting into different object formats.

use std::io;

use crate::{extract, save, verify, Tier};

/// Bytes loaded for an editor, plus the object state needed when it saves.
pub struct EditableDocument {
    /// Plain file bytes or the content window of a valid wasmobj.
    pub content: Vec<u8>,
    /// `Some` for a wasmobj document, including a missing `.wasm` that will be
    /// minted on its first save. Existing executable `.wasm` files remain `None`.
    pub object: Option<Vec<u8>>,
    /// Whether the path did not exist when it was opened.
    pub is_new: bool,
}

pub fn load_object(path: &str) -> io::Result<Vec<u8>> {
    std::fs::read(path)
}

pub fn write_file(path: &str, bytes: &[u8]) -> io::Result<()> {
    std::fs::write(path, bytes)
}

/// Load a path for editing without letting an executable `.wasm` be mistaken for
/// a document. Missing `.wasm` paths start as new wasmobj documents; missing
/// other paths start as new plain files.
pub fn load_editable(path: &str) -> io::Result<EditableDocument> {
    match load_object(path) {
        Ok(bytes) if path.ends_with(".wasm") && verify(&bytes).is_ok() => Ok(EditableDocument {
            content: extract(&bytes).unwrap_or_default(),
            object: Some(bytes),
            is_new: false,
        }),
        Ok(bytes) => Ok(EditableDocument {
            content: bytes,
            object: None,
            is_new: false,
        }),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(EditableDocument {
            content: Vec::new(),
            object: path.ends_with(".wasm").then(Vec::new),
            is_new: true,
        }),
        Err(e) => Err(e),
    }
}

/// Save editor bytes using the same object policy for both graphical editor
/// frontends. Plain files are written as-is; object files are saved in place when
/// they fit and re-packed to the next tier when they do not.
pub fn save_editable(path: &str, object: &mut Option<Vec<u8>>, content: &[u8]) -> io::Result<()> {
    if let Some(bytes) = object {
        if verify(bytes).is_err() {
            let tier = Tier::for_len(content.len() as u32 + 4).unwrap_or(Tier::K64);
            *bytes = crate::mint(tier, 0);
        }
        save(bytes, content).map_err(|e| io::Error::other(format!("wasmobj: {e:?}")))?;
        write_file(path, bytes)
    } else {
        write_file(path, content)
    }
}

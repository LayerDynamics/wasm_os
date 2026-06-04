# byteblockstorage Implementation Plan (V1: M-BBS-1..3)

> **For Claude:** REQUIRED SUB-SKILL: Use lore:execute to implement this plan task-by-task.
> **Scope guard:** Do ONLY what is listed here. If you discover adjacent issues, note them as a TODO and continue. Do NOT fix them.

**Goal:** Implement `crates/byteblockstorage` — a guest/userland Rust library that stores a document as a self-executing `wasm32-wasip1` module — and wire it into the editor, per [SPEC-2](../specs/SPEC-2-byteblockstorage.md) milestones M-BBS-1..3.

**Architecture:** A document is a hand-emitted, deterministic `wasm32-wasip1` module with one active data segment (the "window") pre-filled with `0x20`. The window's first 4 bytes are `content_len` (u32 LE), followed by content, padded with `0x20` to the tier capacity. The module's fixed `_start` reads `content_len` from its own linear memory and writes the content to stdout via `fd_write` (FR-9 self-execution) — so the code section never changes when content does. A `bbs0` custom section records `{version, window_offset, capacity, content_len, content_type}` for external readers. Save (FR-5) overwrites the window in place (content fits) or re-packs to the next power-of-two tier (FR-6). The editor links the crate and branches on whether the opened file is a wasm object.

**Tech Stack:** Rust 2021 (`wasm32-wasip1` target), `proptest` + `wasmparser` + `wasmtime`/`wasmtime-wasi` as dev-dependencies, cargo tests (native), Playwright E2E.

**Practices:** Contract-first (freeze the byte layout before coding), Typed-first (define `Tier`/`Header`/`Error` + signatures before logic), TDD (failing test → minimal impl → passing test → commit), per-task.

**Required skills:** none (pure Rust + existing WASM_OS conventions).

---

## Design contract (frozen — Task 1 implements exactly this)

### On-disk byte layout of a wasm object

A valid `wasm32-wasip1` module emitted in this exact section order. **All sections except the data section's bytes and the `bbs0` field values are byte-for-byte constant** for a given tier — that is the in-place invariant.

```text
magic+version : 00 61 73 6d 01 00 00 00
type    (1)   : 2 types — type0 = fd_write (i32 i32 i32 i32)->i32 ; type1 = ()->()
import  (2)   : "wasi_snapshot_preview1"."fd_write" func type0          → func index 0
function(3)   : 1 local func, type1                                     → func index 1 (_start)
memory  (5)   : 1 memory, min = pages (see below), no max
export  (7)   : "memory" mem0 ; "_start" func1
code    (10)  : _start body (FIXED — reads content_len from memory, calls fd_write)
data    (11)  : 1 active segment, memidx0, offset = i32.const 256,
                bytes = WINDOW (length = capacity)            ← window_offset points here
custom  (0)   : name "bbs0", payload = HEADER (14 bytes)
```

**WINDOW (length = `capacity` = tier bytes), lives in linear memory at offset 256:**
```text
[ content_len : u32 LE (4 bytes) ][ content bytes ][ 0x20 padding … up to capacity ]
content_capacity = capacity - 4
```

**HEADER (`bbs0` custom-section payload, 14 bytes, all little-endian):**
```text
offset size field
0      1    version       = 1
1      4    window_offset  u32 — FILE offset of the first WINDOW byte
5      4    capacity       u32 — window length (== data segment length)
9      4    content_len    u32 — valid content bytes (mirrors the in-band prefix)
13     1    content_type   0 = text, 1 = binary
```
The section **name** `bbs0` is the magic (no separate magic field). `content_len` appears twice — in-band (read by the running module) and in `bbs0` (read by external tools); save updates both. Both are fixed-width and outside the code section, so updating them never changes any LEB length.

**`_start` body (fixed bytes — content-independent):** builds an iovec at mem[16] = `{buf: 260, len: *mem[256]}`, calls `fd_write(1, 16, 1, 8)`, drops, ends. (260 = window_offset_in_mem 256 + 4; content_len read from mem[256].)

**Tiers (powers of two, `capacity` in bytes):** `256, 1024, 4096, 16384, 65536`. `Tier::for_len(n)` returns the smallest tier whose `capacity ≥ n` (caller passes `content.len() + 4`); `None` if `n > 65536`.

**Memory pages:** `pages = ((256 + capacity + 65535) / 65536).max(1)` (window starts at mem offset 256; 64 KiB tier needs 2 pages).

---

## Task 0: Create the crate and register it

**Files:**
- Create: `crates/byteblockstorage/Cargo.toml`
- Create: `crates/byteblockstorage/src/lib.rs`
- Modify: `Cargo.toml` (root, add to `members`)
- Modify: `package.json` (`test:rust` script)

**Step 1: Write `crates/byteblockstorage/Cargo.toml`**
```toml
[package]
name = "byteblockstorage"
edition.workspace = true
version.workspace = true
license.workspace = true

# A document container that IS a wasm32-wasip1 module: a fixed-size data-segment
# "window" pre-filled with 0x20 holds the content; the module's _start renders
# that content to stdout (self-executing). See docs/specs/SPEC-2-byteblockstorage.md.
[lib]
name = "byteblockstorage"
path = "src/lib.rs"

[dev-dependencies]
proptest = "1"
wasmparser = "0.221"
wasmtime = "27"
wasmtime-wasi = "27"
```
> Note: pin `wasmparser`/`wasmtime` to whatever resolves under the workspace `Cargo.lock`; if `27` is unavailable run `cargo add --dev wasmtime wasmtime-wasi wasmparser proptest -p byteblockstorage` and accept the resolved versions. These are **dev-only** — they are NOT pulled into the `wasm32-wasip1` guest build.

**Step 2: Write `crates/byteblockstorage/src/lib.rs` (module wiring only)**
```rust
//! byteblockstorage — a document stored as a self-executing wasm32-wasip1 module.
//! See docs/specs/SPEC-2-byteblockstorage.md.

mod format;
mod mint;
mod io;
pub mod wasi;

pub use format::{Error, Header, Tier};
pub use io::{extract, read, repack, save, verify, write_in_place};
pub use mint::mint;
```

**Step 3: Register in the root workspace** — `Cargo.toml`, add to `members` after `"crates/byteblockstorage"` does not yet exist; insert `    "crates/byteblockstorage",` into the `members = [ … ]` list.

**Step 4: Make `cargo test` run the crate** — `package.json`, change:
```json
"test:rust": "cargo test -p kernel -p wasmgfx",
```
to:
```json
"test:rust": "cargo test -p kernel -p wasmgfx -p byteblockstorage",
```

**Step 5: Verify it builds (empty modules will fail to compile until Task 1; create stub module files first)**
Create empty `src/format.rs`, `src/mint.rs`, `src/io.rs`, `src/wasi.rs` so `cargo build -p byteblockstorage` parses. Expected: compile errors about missing items — that is fine; the next tasks fill them. Run `cargo build -p byteblockstorage 2>&1 | head` to confirm the crate is recognized by the workspace.

**Step 6: Commit**
`git add crates/byteblockstorage Cargo.toml package.json && git commit -m "feat(byteblockstorage): scaffold crate + workspace + test wiring"`

---

## Task 1 (contract-first + typed-first): `format.rs` — types, LEB/section helpers, header codec, window scanner

**Files:**
- Modify: `crates/byteblockstorage/src/format.rs`

**Step 1: Write the failing tests** (append to `format.rs`)
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leb_roundtrips() {
        for v in [0u32, 1, 127, 128, 256, 16384, 65536, u32::MAX] {
            let mut buf = Vec::new();
            leb_u32(v, &mut buf);
            let mut pos = 0;
            assert_eq!(read_leb_u32(&buf, &mut pos), Some(v));
            assert_eq!(pos, buf.len());
        }
    }

    #[test]
    fn tier_for_len_picks_smallest() {
        assert_eq!(Tier::for_len(0), Some(Tier::B256));
        assert_eq!(Tier::for_len(256), Some(Tier::B256));
        assert_eq!(Tier::for_len(257), Some(Tier::K1));
        assert_eq!(Tier::for_len(65536), Some(Tier::K64));
        assert_eq!(Tier::for_len(65537), None);
    }

    #[test]
    fn header_encodes_to_14_le_bytes() {
        let h = Header { version: 1, window_offset: 0x11223344, capacity: 4096, content_len: 7, content_type: 0 };
        let b = h.encode();
        assert_eq!(b.len(), 14);
        assert_eq!(&b[1..5], &0x11223344u32.to_le_bytes());
        assert_eq!(Header::decode(&b).unwrap(), h);
    }
}
```

**Step 2: Run to verify it fails** — `cargo test -p byteblockstorage format` → Expected: FAIL (items undefined).

**Step 3: Write the implementation** (prepend above the test module in `format.rs`)
```rust
//! Byte layout, types, and low-level encoders. See the "Design contract" in
//! docs/plans/2026-06-03-byteblockstorage-impl.md.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tier { B256, K1, K4, K16, K64 }

impl Tier {
    pub const ALL: [Tier; 5] = [Tier::B256, Tier::K1, Tier::K4, Tier::K16, Tier::K64];
    pub fn bytes(self) -> u32 {
        match self { Tier::B256 => 256, Tier::K1 => 1024, Tier::K4 => 4096, Tier::K16 => 16384, Tier::K64 => 65536 }
    }
    /// Smallest tier whose capacity >= n; None if n exceeds the top tier.
    pub fn for_len(n: u32) -> Option<Tier> {
        Tier::ALL.into_iter().find(|t| t.bytes() >= n)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub version: u8,
    pub window_offset: u32,
    pub capacity: u32,
    pub content_len: u32,
    pub content_type: u8,
}

impl Header {
    pub const SIZE: usize = 14;
    pub fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(Self::SIZE);
        b.push(self.version);
        b.extend_from_slice(&self.window_offset.to_le_bytes());
        b.extend_from_slice(&self.capacity.to_le_bytes());
        b.extend_from_slice(&self.content_len.to_le_bytes());
        b.push(self.content_type);
        b
    }
    pub fn decode(b: &[u8]) -> Result<Header, Error> {
        if b.len() < Self::SIZE { return Err(Error::Malformed); }
        Ok(Header {
            version: b[0],
            window_offset: u32::from_le_bytes([b[1], b[2], b[3], b[4]]),
            capacity: u32::from_le_bytes([b[5], b[6], b[7], b[8]]),
            content_len: u32::from_le_bytes([b[9], b[10], b[11], b[12]]),
            content_type: b[13],
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Error { BadVersion, OutOfBounds, TooLarge, Malformed }

pub(crate) fn leb_u32(mut v: u32, out: &mut Vec<u8>) {
    loop {
        let mut byte = (v & 0x7f) as u8;
        v >>= 7;
        if v != 0 { byte |= 0x80; }
        out.push(byte);
        if v == 0 { break; }
    }
}

/// Decode an unsigned LEB128 u32 at `*pos`, advancing `*pos`. None on overflow/truncation.
pub(crate) fn read_leb_u32(b: &[u8], pos: &mut usize) -> Option<u32> {
    let mut result: u32 = 0;
    let mut shift = 0u32;
    loop {
        let byte = *b.get(*pos)?;
        *pos += 1;
        if shift >= 32 { return None; }
        result |= ((byte & 0x7f) as u32).checked_shl(shift)?;
        if byte & 0x80 == 0 { return Some(result); }
        shift += 7;
    }
}

pub(crate) fn section(id: u8, payload: &[u8], out: &mut Vec<u8>) {
    out.push(id);
    leb_u32(payload.len() as u32, out);
    out.extend_from_slice(payload);
}

/// Located `bbs0` metadata + the file offset of its content_len field.
pub(crate) struct Located {
    pub header: Header,
    /// File offset of the 4-byte content_len field inside the bbs0 section data.
    pub bbs0_content_len_off: usize,
}

/// Manually scan the module sections for the `bbs0` custom section (no wasmparser
/// in the guest hot path). Returns the header + the file offset of its content_len.
pub(crate) fn locate(obj: &[u8]) -> Result<Located, Error> {
    if obj.len() < 8 || &obj[0..4] != b"\0asm" { return Err(Error::Malformed); }
    let mut pos = 8usize;
    while pos < obj.len() {
        let id = obj[pos]; pos += 1;
        let len = read_leb_u32(obj, &mut pos).ok_or(Error::Malformed)? as usize;
        let body_start = pos;
        let body_end = body_start.checked_add(len).ok_or(Error::Malformed)?;
        if body_end > obj.len() { return Err(Error::Malformed); }
        if id == 0 {
            // custom section: name then data
            let mut np = body_start;
            let name_len = read_leb_u32(obj, &mut np).ok_or(Error::Malformed)? as usize;
            let name_end = np.checked_add(name_len).ok_or(Error::Malformed)?;
            if name_end <= body_end && &obj[np..name_end] == b"bbs0" {
                let data = &obj[name_end..body_end];
                let header = Header::decode(data)?;
                if header.version != 1 { return Err(Error::BadVersion); }
                // content_len is at header offset 9 within the section data.
                let cl_off = name_end + 9;
                // Bounds: window must fit inside the file.
                let wend = (header.window_offset as usize)
                    .checked_add(header.capacity as usize).ok_or(Error::Malformed)?;
                if wend > obj.len() || header.capacity < 4 { return Err(Error::OutOfBounds); }
                if header.content_len + 4 > header.capacity { return Err(Error::OutOfBounds); }
                return Ok(Located { header, bbs0_content_len_off: cl_off });
            }
        }
        pos = body_end;
    }
    Err(Error::Malformed)
}
```

**Step 4: Run to verify it passes** — `cargo test -p byteblockstorage format` → Expected: PASS.

**Step 5: Commit**
`git add crates/byteblockstorage/src/format.rs && git commit -m "feat(byteblockstorage): byte-layout contract — types, LEB/section codecs, bbs0 scanner"`

---

## Task 2: `mint.rs` — emit a valid, self-executing object

**Files:**
- Modify: `crates/byteblockstorage/src/mint.rs`

**Step 1: Write the failing test**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{locate, Tier};

    #[test]
    fn mint_is_locatable_blank_and_well_formed() {
        let obj = mint(Tier::K4, 0);
        let loc = locate(&obj).expect("locatable");
        assert_eq!(loc.header.capacity, 4096);
        assert_eq!(loc.header.content_len, 0);
        assert_eq!(loc.header.content_type, 0);
        // window starts at window_offset; first 4 bytes are the in-band len (0), rest 0x20.
        let w = loc.header.window_offset as usize;
        assert_eq!(&obj[w..w + 4], &0u32.to_le_bytes());
        assert!(obj[w + 4..w + 4096].iter().all(|&b| b == 0x20));
    }

    #[test]
    fn mint_validates_with_wasmparser() {
        for t in Tier::ALL {
            let obj = mint(t, 0);
            wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
                .validate_all(&obj)
                .unwrap_or_else(|e| panic!("tier {:?} invalid: {e}", t));
        }
    }
}
```

**Step 2: Run to verify it fails** — `cargo test -p byteblockstorage mint` → Expected: FAIL.

**Step 3: Write the implementation**
```rust
//! Deterministic emitter for wasm objects. The non-data sections are fixed bytes;
//! only the memory page count, data segment length/bytes, and bbs0 vary by tier.

use crate::format::{leb_u32, section, Header, Tier};

const WIN_MEM_OFFSET: u32 = 256; // linear-memory address of the window

/// Emit a fresh wasm object at `tier`, window pre-filled with 0x20 and content_len 0.
pub fn mint(tier: Tier, content_type: u8) -> Vec<u8> {
    let capacity = tier.bytes();
    let pages = ((256 + capacity + 0xFFFF) / 0x10000).max(1);

    let mut out = Vec::new();
    out.extend_from_slice(b"\0asm");
    out.extend_from_slice(&1u32.to_le_bytes());

    // --- type section (id 1): type0 = (i32 i32 i32 i32)->i32 ; type1 = ()->()
    let type_payload = [
        0x02, // 2 types
        0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f, // fd_write
        0x60, 0x00, 0x00, // _start
    ];
    section(1, &type_payload, &mut out);

    // --- import section (id 2): wasi_snapshot_preview1.fd_write : func type0
    let mut imp = Vec::new();
    imp.push(0x01); // 1 import
    let module = b"wasi_snapshot_preview1";
    leb_u32(module.len() as u32, &mut imp); imp.extend_from_slice(module);
    let field = b"fd_write";
    leb_u32(field.len() as u32, &mut imp); imp.extend_from_slice(field);
    imp.push(0x00); // import kind: func
    leb_u32(0, &mut imp); // type index 0
    section(2, &imp, &mut out);

    // --- function section (id 3): one local func, type1
    section(3, &[0x01, 0x01], &mut out);

    // --- memory section (id 5): 1 memory, min = pages
    let mut mem = Vec::new();
    mem.push(0x01); // 1 memory
    mem.push(0x00); // limits: min only
    leb_u32(pages, &mut mem);
    section(5, &mem, &mut out);

    // --- export section (id 7): "memory" mem0 ; "_start" func1
    let mut exp = Vec::new();
    exp.push(0x02);
    leb_u32(6, &mut exp); exp.extend_from_slice(b"memory"); exp.push(0x02); leb_u32(0, &mut exp);
    leb_u32(6, &mut exp); exp.extend_from_slice(b"_start"); exp.push(0x00); leb_u32(1, &mut exp);
    section(7, &exp, &mut out);

    // --- code section (id 10): _start body (FIXED, content-independent)
    // (i32.store 16 260)          ; iov.buf = window_data_start (256+4)
    // (i32.store 20 (i32.load 256)) ; iov.len = content_len (in-band)
    // (call fd_write 1 16 1 8) drop
    let body: &[u8] = &[
        0x00, // 0 locals
        0x41, 0x10, 0x41, 0x84, 0x02, 0x36, 0x02, 0x00,             // store buf=260 @16
        0x41, 0x14, 0x41, 0x80, 0x02, 0x28, 0x02, 0x00, 0x36, 0x02, 0x00, // store len=*256 @20
        0x41, 0x01, 0x41, 0x10, 0x41, 0x01, 0x41, 0x08, 0x10, 0x00, 0x1a, // call fd_write; drop
        0x0b, // end
    ];
    let mut code = Vec::new();
    code.push(0x01); // 1 function body
    leb_u32(body.len() as u32, &mut code);
    code.extend_from_slice(body);
    section(10, &code, &mut out);

    // --- data section (id 11): 1 active segment @ i32.const 256
    let mut data = Vec::new();
    data.push(0x01); // 1 segment
    data.push(0x00); // active, memidx 0
    data.extend_from_slice(&[0x41, 0x80, 0x02, 0x0b]); // i32.const 256; end
    leb_u32(capacity, &mut data); // segment byte length
    // Offset of the window bytes WITHIN the data payload (after the 6-byte preamble
    // + the LEB capacity), captured right before appending the window:
    let window_start_in_data = data.len();
    let mut window = vec![0x20u8; capacity as usize];
    window[0..4].copy_from_slice(&0u32.to_le_bytes()); // content_len = 0
    data.extend_from_slice(&window);
    // section() prepends: 1 id byte + LEB(payload len). The window's FILE offset is
    // therefore: current out.len() + 1 (id) + LEB(data.len()).len() + window_start_in_data.
    let mut leb_len = Vec::new();
    leb_u32(data.len() as u32, &mut leb_len);
    let window_offset = (out.len() + 1 + leb_len.len() + window_start_in_data) as u32;
    section(11, &data, &mut out);

    // --- custom section (id 0): "bbs0" header
    let header = Header { version: 1, window_offset, capacity, content_len: 0, content_type };
    let mut custom = Vec::new();
    leb_u32(4, &mut custom); custom.extend_from_slice(b"bbs0");
    custom.extend_from_slice(&header.encode());
    section(0, &custom, &mut out);

    out
}
```
> Implementation note for the executor: the `window_offset` math must equal the index in `out` where the first window byte lands. Verify it against `locate()` in the Task 2 tests (the `mint_is_locatable_blank_and_well_formed` test asserts the window bytes at `window_offset` are `[0,0,0,0, 0x20…]`). If the assertion fails, the offset arithmetic is wrong — fix it (do not adjust the test).

**Step 4: Run to verify it passes** — `cargo test -p byteblockstorage mint` → Expected: PASS (both tests, including wasmparser validation of all tiers).

**Step 5: Commit**
`git add crates/byteblockstorage/src/mint.rs && git commit -m "feat(byteblockstorage): deterministic mint of valid self-executing wasm objects"`

---

## Task 3: `io.rs` — `verify`, `read`, `extract`

**Files:**
- Modify: `crates/byteblockstorage/src/io.rs`

**Step 1: Write the failing test**
```rust
#[cfg(test)]
mod tests {
    use super::*;
    use crate::{mint, Tier};

    #[test]
    fn read_blank_is_empty() {
        let obj = mint(Tier::K4, 0);
        assert_eq!(read(&obj).unwrap(), Vec::<u8>::new());
        assert!(verify(&obj).is_ok());
    }

    #[test]
    fn malformed_never_panics() {
        assert!(verify(b"not wasm").is_err());
        assert!(read(&[0u8; 4]).is_err());
        let mut obj = mint(Tier::B256, 0);
        obj.truncate(10);
        assert!(verify(&obj).is_err());
    }
}
```

**Step 2: Run to verify it fails** — `cargo test -p byteblockstorage io` → Expected: FAIL.

**Step 3: Write the implementation** (the rest — `write_in_place`/`repack`/`save` — lands in Task 4/5, but include their `use` now)
```rust
//! The operations over object bytes: read, verify, write-in-place, repack, save.

use crate::format::{locate, Error, Header};
use crate::mint::mint as mint_obj;
use crate::Tier;

/// Validate the bbs0 header + window bounds; returns the parsed header.
pub fn verify(obj: &[u8]) -> Result<Header, Error> {
    Ok(locate(obj)?.header)
}

/// Read exactly content_len content bytes (excludes the in-band length prefix + padding).
pub fn read(obj: &[u8]) -> Result<Vec<u8>, Error> {
    let loc = locate(obj)?;
    let h = loc.header;
    let start = h.window_offset as usize + 4;
    let end = start + h.content_len as usize;
    obj.get(start..end).map(|s| s.to_vec()).ok_or(Error::OutOfBounds)
}

/// Alias of `read`, named for the FR-7b plain-export intent.
pub fn extract(obj: &[u8]) -> Result<Vec<u8>, Error> { read(obj) }
```

**Step 4: Run to verify it passes** — `cargo test -p byteblockstorage io` → Expected: PASS.

**Step 5: Commit**
`git add crates/byteblockstorage/src/io.rs && git commit -m "feat(byteblockstorage): verify/read/extract over wasm objects"`

---

## Task 4: `write_in_place` + the in-place invariant

**Files:**
- Modify: `crates/byteblockstorage/src/io.rs`

**Step 1: Write the failing test** (append to `io.rs` tests)
```rust
    #[test]
    fn write_in_place_roundtrips_and_preserves_non_window_bytes() {
        let mut obj = mint(Tier::K4, 0);
        let before = obj.clone();
        let h = verify(&obj).unwrap();
        let w = h.window_offset as usize;
        let cap = h.capacity as usize;

        let content = b"hello byteblockstorage".to_vec();
        write_in_place(&mut obj, &content).unwrap();

        assert_eq!(read(&obj).unwrap(), content);
        // in-band len + bbs0 content_len both updated
        assert_eq!(verify(&obj).unwrap().content_len as usize, content.len());
        assert_eq!(&obj[w..w + 4], &(content.len() as u32).to_le_bytes());
        // padding after content is 0x20
        assert!(obj[w + 4 + content.len()..w + cap].iter().all(|&b| b == 0x20));
        // EVERYTHING outside the window AND outside the bbs0 content_len field is unchanged
        assert_eq!(obj.len(), before.len());
        for i in 0..obj.len() {
            let in_window = i >= w && i < w + cap;
            let in_cl = (locate_cl(&before)..locate_cl(&before) + 4).contains(&i);
            if !in_window && !in_cl {
                assert_eq!(obj[i], before[i], "byte {i} changed unexpectedly");
            }
        }
    }

    #[test]
    fn write_too_large_errors() {
        let mut obj = mint(Tier::B256, 0);
        let too_big = vec![b'x'; 256]; // > capacity-4
        assert!(matches!(write_in_place(&mut obj, &too_big), Err(crate::Error::TooLarge)));
    }

    // test helper: file offset of bbs0 content_len in a freshly minted/clean object
    fn locate_cl(obj: &[u8]) -> usize { crate::format::locate(obj).unwrap().bbs0_content_len_off }
```
> `locate` is `pub(crate)`; the test accesses it via `crate::format::locate`. Confirm `format` exposes `locate`/`Located.bbs0_content_len_off` at `pub(crate)` (Task 1 already does).

**Step 2: Run to verify it fails** — `cargo test -p byteblockstorage write_in_place` → Expected: FAIL.

**Step 3: Write the implementation** (append to `io.rs`)
```rust
/// Overwrite the window in place: content + 0x20 padding, update both content_len
/// copies. No module re-encode. Errors if content exceeds capacity-4.
pub fn write_in_place(obj: &mut [u8], content: &[u8]) -> Result<(), Error> {
    let loc = locate(obj)?;
    let h = loc.header;
    let cap = h.capacity as usize;
    let content_capacity = cap - 4;
    if content.len() > content_capacity { return Err(Error::TooLarge); }
    let w = h.window_offset as usize;
    let len = content.len() as u32;
    // in-band length prefix
    obj[w..w + 4].copy_from_slice(&len.to_le_bytes());
    // content
    obj[w + 4..w + 4 + content.len()].copy_from_slice(content);
    // padding
    for b in &mut obj[w + 4 + content.len()..w + cap] { *b = 0x20; }
    // mirror into bbs0
    let cl = loc.bbs0_content_len_off;
    obj[cl..cl + 4].copy_from_slice(&len.to_le_bytes());
    Ok(())
}
```

**Step 4: Run to verify it passes** — `cargo test -p byteblockstorage write_in_place` → Expected: PASS.

**Step 5: Commit**
`git add crates/byteblockstorage/src/io.rs && git commit -m "feat(byteblockstorage): in-place window overwrite preserving all non-window bytes (FR-5)"`

---

## Task 5: `repack` + `save` + property tests (FR-6, FR-10)

**Files:**
- Modify: `crates/byteblockstorage/src/io.rs`
- Create: `crates/byteblockstorage/tests/properties.rs`

**Step 1: Write the failing tests**

Append to `io.rs` tests:
```rust
    #[test]
    fn save_repacks_when_content_exceeds_capacity() {
        let mut obj = mint(Tier::B256, 0); // content_capacity = 252
        let content = vec![b'z'; 1000]; // needs K4 (4096)
        let res = save(&mut obj, &content).unwrap();
        assert!(res.is_some(), "should have re-packed");
        assert_eq!(verify(&obj).unwrap().capacity, 4096);
        assert_eq!(read(&obj).unwrap(), content);
    }

    #[test]
    fn save_in_place_when_fits() {
        let mut obj = mint(Tier::K4, 0);
        let res = save(&mut obj, b"small").unwrap();
        assert!(res.is_none(), "should NOT re-pack");
        assert_eq!(read(&obj).unwrap(), b"small");
    }
```

Create `crates/byteblockstorage/tests/properties.rs`:
```rust
use byteblockstorage::{mint, read, save, verify, Tier};
use proptest::prelude::*;

proptest! {
    // For any content within the top tier, save → read round-trips exactly and the
    // result validates as a wasm module.
    #[test]
    fn roundtrip_any_content(content in proptest::collection::vec(any::<u8>(), 0..65532usize)) {
        let mut obj = mint(Tier::B256, 1);
        save(&mut obj, &content).unwrap();
        prop_assert_eq!(read(&obj).unwrap(), content.clone());
        prop_assert!(verify(&obj).is_ok());
        wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
            .validate_all(&obj)
            .map_err(|e| TestCaseError::fail(format!("invalid module: {e}")))?;
    }
}
```
> Add `wasmparser` usage in this integration test; it is already a dev-dependency (Task 0).

**Step 2: Run to verify it fails** — `cargo test -p byteblockstorage` → Expected: FAIL (`save`/`repack` undefined).

**Step 3: Write the implementation** (append to `io.rs`)
```rust
/// Emit a new object at the smallest tier that fits `content`, carrying it forward.
pub fn repack(obj: &[u8], content: &[u8]) -> Result<Vec<u8>, Error> {
    let ct = verify(obj)?.content_type;
    let tier = Tier::for_len(content.len() as u32 + 4).ok_or(Error::TooLarge)?;
    let mut fresh = mint_obj(tier, ct);
    write_in_place(&mut fresh, content)?;
    Ok(fresh)
}

/// Save content into `obj`: in place if it fits (Ok(None)), else re-pack and replace
/// `obj` with the larger object (Ok(Some(new_bytes))).
pub fn save(obj: &mut Vec<u8>, content: &[u8]) -> Result<Option<Vec<u8>>, Error> {
    let cap = verify(obj)?.capacity as usize;
    if content.len() <= cap - 4 {
        write_in_place(obj, content)?;
        Ok(None)
    } else {
        let fresh = repack(obj, content)?;
        *obj = fresh.clone();
        Ok(Some(fresh))
    }
}
```

**Step 4: Run to verify it passes** — `cargo test -p byteblockstorage` → Expected: PASS (unit + proptest).

**Step 5: Commit**
`git add crates/byteblockstorage/src/io.rs crates/byteblockstorage/tests/properties.rs && git commit -m "feat(byteblockstorage): repack + save + proptest round-trip/validity (FR-6,FR-10)"`

---

## Task 6: Self-execution proof with wasmtime (FR-9)

**Files:**
- Create: `crates/byteblockstorage/tests/self_exec.rs`

**Step 1: Write the failing test**
```rust
//! Proves FR-9: a filled object, run as a wasip1 module, writes its content to stdout.
use byteblockstorage::{mint, save, Tier};
use wasmtime::*;
use wasmtime_wasi::preview1::{self, WasiP1Ctx};
use wasmtime_wasi::pipe::MemoryOutputPipe;
use wasmtime_wasi::WasiCtxBuilder;

#[test]
fn filled_object_renders_its_content_to_stdout() {
    let mut obj = mint(Tier::K4, 0);
    save(&mut obj, b"the document renders itself").unwrap();

    let engine = Engine::default();
    let module = Module::new(&engine, &obj).expect("module loads");
    let stdout = MemoryOutputPipe::new(4096);
    let wasi: WasiP1Ctx = WasiCtxBuilder::new().stdout(stdout.clone()).build_p1();
    let mut store = Store::new(&engine, wasi);
    let mut linker: Linker<WasiP1Ctx> = Linker::new(&engine);
    preview1::add_to_linker_sync(&mut linker, |c| c).unwrap();
    let inst = linker.instantiate(&mut store, &module).unwrap();
    let start = inst.get_typed_func::<(), ()>(&mut store, "_start").unwrap();
    start.call(&mut store, ()).unwrap();
    drop(store);

    let out = stdout.contents();
    assert_eq!(&out[..], b"the document renders itself");
}
```
> The exact `wasmtime_wasi` API names depend on the resolved version. If `WasiP1Ctx`/`preview1` differ, adapt to the resolved crate's preview1 sync API (the intent is fixed: build a WASI ctx with a capturing stdout, link preview1, instantiate, call `_start`, assert stdout). Run `cargo doc -p wasmtime-wasi --open` if the path is unclear.

**Step 2: Run to verify it fails** — `cargo test -p byteblockstorage --test self_exec` → Expected: FAIL (until APIs line up / module correct).

**Step 3: Make it pass** — no library code should be needed if Tasks 2/4 are correct; this test *validates* them. If it fails because the module traps or prints wrong bytes, the defect is in `mint`'s code body or `write_in_place` — fix the library, not the test.

**Step 4: Run to verify it passes** — `cargo test -p byteblockstorage --test self_exec` → Expected: PASS.

**Step 5: Commit**
`git add crates/byteblockstorage/tests/self_exec.rs && git commit -m "test(byteblockstorage): wasmtime proof that objects self-execute (FR-9)"`

**M-BBS-1 + M-BBS-2 (library core) exit criteria now met: FR-1..6,8,9,10,11 verified.**

---

## Task 7: `wasi.rs` glue + confirm the guest target builds

**Files:**
- Modify: `crates/byteblockstorage/src/wasi.rs`

**Step 1: Write the implementation** (no separate unit test — exercised by the editor + E2E)
```rust
//! Thin VFS helpers for guests. On wasm32-wasip1 these map to WASI path/fd syscalls;
//! on the host they use std::fs (so the library is testable natively).

use std::io;

pub fn load_object(path: &str) -> io::Result<Vec<u8>> {
    std::fs::read(path)
}

pub fn write_file(path: &str, bytes: &[u8]) -> io::Result<()> {
    std::fs::write(path, bytes)
}
```

**Step 2: Build for the guest target** — `cargo build -p byteblockstorage --target wasm32-wasip1 --release` → Expected: builds clean (the dev-deps wasmtime/proptest are NOT compiled for this target).

**Step 3: Commit**
`git add crates/byteblockstorage/src/wasi.rs && git commit -m "feat(byteblockstorage): WASI VFS glue; builds on wasm32-wasip1"`

---

## Task 8: Editor integration (FR-12, FR-7)

**Files:**
- Modify: `crates/apps/editor/Cargo.toml` (add dependency)
- Modify: `crates/apps/editor/src/main.rs:27-54` (struct + load + save)

**Step 1: Add the dependency** — `crates/apps/editor/Cargo.toml`, under `[dependencies]` add:
```toml
byteblockstorage = { path = "../../byteblockstorage" }
```

**Step 2: Modify the `Editor` struct** (`main.rs:27-34`) — add an `obj` field:
```rust
struct Editor {
    path: String,
    lines: Vec<String>,
    row: usize,
    col: usize,
    scroll: usize,
    modified: bool,
    obj: Option<Vec<u8>>, // Some(bytes) when the file is a wasm object (FR-12)
}
```

**Step 3: Branch `load`** (`main.rs:37-47`) — replace the body:
```rust
    fn load(path: String) -> Editor {
        // A wasm object? (path ends .wasm AND verifies). Read content out of it.
        let bytes = std::fs::read(&path).unwrap_or_default();
        let (text, obj) = if path.ends_with(".wasm") && byteblockstorage::verify(&bytes).is_ok() {
            let content = byteblockstorage::read(&bytes).unwrap_or_default();
            (String::from_utf8_lossy(&content).into_owned(), Some(bytes))
        } else if path.ends_with(".wasm") {
            // New wasm doc that doesn't exist yet: start blank, save will mint.
            (String::new(), Some(Vec::new()))
        } else {
            (String::from_utf8_lossy(&bytes).into_owned(), None)
        };
        let mut lines: Vec<String> = text
            .split('\n')
            .map(|s| s.chars().filter(|c| (' '..='~').contains(c)).collect())
            .collect();
        if lines.is_empty() {
            lines.push(String::new());
        }
        Editor { path, lines, row: 0, col: 0, scroll: 0, modified: false, obj }
    }
```

**Step 4: Branch `save`** (`main.rs:49-54`) — replace the body:
```rust
    fn save(&mut self) {
        let text = self.lines.join("\n");
        let ok = match &mut self.obj {
            Some(obj) => {
                // Ensure we have a live object to write into; mint one sized to content.
                if byteblockstorage::verify(obj).is_err() {
                    let tier = byteblockstorage::Tier::for_len(text.len() as u32 + 4)
                        .unwrap_or(byteblockstorage::Tier::K64);
                    *obj = byteblockstorage::mint(tier, 0);
                }
                byteblockstorage::save(obj, text.as_bytes()).is_ok()
                    && std::fs::write(&self.path, &obj[..]).is_ok()
            }
            None => std::fs::write(&self.path, text.as_bytes()).is_ok(),
        };
        if ok {
            self.modified = false;
        }
    }
```

**Step 5: Build the editor for the guest target**
`cargo build -p editor --target wasm32-wasip1 --release` → Expected: builds clean.

**Step 6: Commit**
`git add crates/apps/editor/Cargo.toml crates/apps/editor/src/main.rs && git commit -m "feat(editor): open/save documents as wasm objects via byteblockstorage (FR-7,FR-12)"`

---

## Task 9: Rebuild guests + sanity check (the binder/build pipeline)

**Files:** none (build only) — verifies the editor still ships.

**Step 1: Rebuild all guests** — `npm run build:guests` → Expected: succeeds; `packages/host/guests/editor.wasm` is regenerated.
> The crate is a *library* dependency of `editor`, so it does NOT need a line in the `build:guests` `-p` list. Confirm `editor.wasm` rebuilt (check its mtime).

**Step 2: Run the Rust + clippy gates** — `npm run lint && npm run test:rust` → Expected: PASS (clippy clean — fix any warnings; `test:rust` now includes `byteblockstorage`).

**Step 3: Commit** (only if lint required fixes; otherwise skip)
`git add -A && git commit -m "chore(byteblockstorage): clippy-clean across workspace"`

---

> **As-built deviation (Task 8 + Task 10):** the canvas **editor** is unreachable as a document opener — the shell can't launch GUI apps (no `Gpu`/`Input` caps) and host spawn can't pass an argv path. The reachable integration shipped in **nano** (terminal editor, shell-launchable with argv; in scope per "editor/nano"). The editor keeps the same guarded branch as forward-looking code. Both guard against mint-overwriting an existing non-document `.wasm` (only a non-existent `.wasm` path becomes a new document). The E2E below was implemented against nano (`e2e/byteblockstorage.spec.ts`) and additionally **runs the saved object in WASM_OS** (typing `/home/note.wasm` in the terminal) to prove FR-9 through the real kernel, not only under wasmtime.

## Task 10: Real E2E — create → edit → save → reload → reopen → run (M-BBS-3)

**Files:**
- Create: `e2e/byteblockstorage.spec.ts`

**Step 1: Write the test** (model it on `probe-boot-persist.mjs` + existing `e2e/*.spec.ts`)
```typescript
import { test, expect } from "@playwright/test";
// Mirror the harness setup used by the existing editor/persistence specs in e2e/.

test("a document is saved as a wasm object and survives reload", async ({ page }) => {
  await page.goto("/");
  // boot to desktop (reuse the project's existing ready-wait helper/pattern)
  await page.waitForFunction(() => (globalThis as any).__wasmos_ready === true);

  // 1. Launch the editor on a new .wasm document, type content, Ctrl+S.
  //    (Use the same launch path the editor specs use — argv = "/home/note.wasm".)
  await launchEditor(page, "/home/note.wasm");
  await typeIntoEditor(page, "wasm objects persist");
  await page.keyboard.press("Control+s");
  await flushVfs(page); // await the host blockstore flush (as boot-persist does)

  // 2. The saved file is a valid wasm object whose content reads back.
  const saved = await readVfsFile(page, "/home/note.wasm");
  expect(saved.slice(0, 4)).toEqual(new Uint8Array([0x00, 0x61, 0x73, 0x6d])); // \0asm

  // 3. Reload the tab; re-open the document; assert the content is intact.
  await page.reload();
  await page.waitForFunction(() => (globalThis as any).__wasmos_ready === true);
  await launchEditor(page, "/home/note.wasm");
  const shown = await editorVisibleText(page);
  expect(shown).toContain("wasm objects persist");
});
```
> The helper functions (`launchEditor`, `typeIntoEditor`, `flushVfs`, `readVfsFile`, `editorVisibleText`) must be implemented against the project's existing E2E harness — copy the exact mechanisms from the current editor/persistence specs in `e2e/` and the `probe-*.mjs` files (e.g. how `probe-editor-keys.mjs` drives keys and how `probe-boot-persist.mjs` flushes + reads VFS). Do NOT invent new host hooks; reuse what those probes already expose.

**Step 2: Run to verify it fails** (before wiring helpers, or if save path is wrong) — `npx playwright test e2e/byteblockstorage.spec.ts --project=fast` → Expected: FAIL initially.

**Step 3: Make it pass** — implement helpers from existing probes; fix any real defect surfaced (e.g. editor not branching on `.wasm`). The test must exercise the **real** stack: browser → editor guest → kernel VFS → OPFS/IndexedDB → reload → reread. No mocks.

**Step 4: Run to verify it passes** — `npx playwright test e2e/byteblockstorage.spec.ts --project=fast` → Expected: PASS.

**Step 5: Commit**
`git add e2e/byteblockstorage.spec.ts && git commit -m "test(e2e): document saved as wasm object survives reload + reopens (M-BBS-3)"`

---

## Task 11: Crate README + full verify gate (M-BBS-3 close)

**Files:**
- Modify: `crates/byteblockstorage/README.md` (replace the one-line seed)

**Step 1: Replace `crates/byteblockstorage/README.md`** with a real description: what a wasm object is, the `bbs0` header + window layout (link to SPEC-2 and this plan), the public API (`mint`/`read`/`save`/`verify`/`extract`), and how the editor uses it. Tag all code blocks with their language.

**Step 2: Run the full gate** — `npm run verify` → Expected: PASS (build → guests → binder:kernel-check → lint → typecheck → test:rust → test:host → test:e2e). Fix anything red before claiming done; do not skip a stage.

**Step 3: Commit**
`git add crates/byteblockstorage/README.md && git commit -m "docs(byteblockstorage): document the wasm-object format and editor integration"`

---

## Verification summary (maps to SPEC-2 success criteria)

| SPEC-2 metric | Proven by |
|---------------|-----------|
| Object validity (FR-2) | Task 2 + Task 5 proptest — `wasmparser` validates every minted/re-packed object |
| Round-trip fidelity (FR-4/5/6) | Task 5 proptest `read(save(mint,c)) == c` for random content |
| In-place = no re-encode (FR-5) | Task 4 — non-window/non-content_len bytes byte-identical |
| Self-execution (FR-9) | Task 6 — wasmtime runs `_start`, asserts stdout == content |
| Create→edit→save→reload→reopen (FR-7/12) | Task 10 — real browser E2E |
| Plain-file no regression (Constraint 5) | Task 10 + existing editor specs still green under `npm run verify` |

## Out of scope (V1) — note as TODOs, do NOT implement
- `wobj` CLI (FR-13), plain-text export wiring (FR-7b), `bbs0` extra metadata (FR-14), richer content-type (FR-15) → M-BBS-4.
- Payloads > 64 KiB (FR-NG-4), compression/encryption (FR-NG-1), multi-writer (FR-NG-2).
- Open questions OQ-2 (crate rename), OQ-4 (save-as destination UX), OQ-5 (`0x20` vs `0x00` padding) — leave as specified unless the user resolves them.

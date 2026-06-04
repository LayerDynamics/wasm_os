# wasmobj

A document container that **is a WebAssembly module**. A `wasmobj`
"wasm object" is a valid `wasm32-wasip1` module with a fixed-size data-segment
**window** pre-filled with `0x20` (ASCII space). An app writes the document's
content over that placeholder window; the result is a self-describing,
self-executing `.wasm` file. Running it prints its own content to stdout.

This is the userland (guest) library for [SPEC-2](../../docs/specs/SPEC-2-wasmobj.md).
It runs inside a `wasm32-wasip1` process and reaches files only through WASI —
it is unrelated to the host TypeScript `Blockstore` (`packages/host/src/blockstore/`),
which is a kernel-imported key/value store at a different layer.

## How an object is laid out

A standard wasm module with two wasmobj additions:

```text
\0asm 0x01000000
type / import(fd_write) / function / memory / export(memory,_start)
code   : _start reads the in-band content_len from memory and writes the
         window content to stdout via fd_write  (self-executing, FR-9)
data   : one active segment @ i32.const 256 — the WINDOW (length = capacity)
custom : "wob0" header
```

The **window** (linear-memory offset 256) holds the payload:

```text
[ content_len : u32 LE (4 bytes) ][ content bytes ][ 0x20 padding … to capacity ]
content_capacity = capacity - 4
```

The **`wob0`** custom section is the self-describing header (the section name is
the magic):

```text
version:u8 | window_offset:u32 | capacity:u32 | content_len:u32 | content_type:u8
```

`content_len` lives both in-band (so the running module knows its own length) and
in `wob0` (for external readers). Because the data segment's length is fixed per
object (`capacity`), every section offset and LEB128 length is stable — so a save
that fits is a pure overwrite of the window, **never a re-encode**.

## Tiers and saving

The window capacity is a power-of-two **tier**: `256, 1024, 4096, 16384, 65536`.

- **Fits** (`content ≤ capacity-4`): `write_in_place` overwrites the window and
  patches both `content_len` copies. No re-encode.
- **Outgrows the tier**: `repack` mints a new object at the smallest fitting tier
  and carries the content forward.

## API

```rust
use wasmobj::{mint, read, save, verify, write_in_place, repack, extract, Tier};

// Create a blank object (window all 0x20).
let mut obj: Vec<u8> = mint(Tier::K4, /*content_type=*/ 0);

// Save content: in place if it fits, else repack (returns Some(new_bytes)).
let repacked: Option<Vec<u8>> = save(&mut obj, b"hello").unwrap();

// Read the content back (exactly content_len bytes, no padding).
let content: Vec<u8> = read(&obj).unwrap();

// Validate the header + window bounds.
let header = verify(&obj).unwrap();

// Lower-level: in-place only (Err(TooLarge) if content > capacity-4); repack only;
// extract == read, named for the plain-file export intent (FR-7b).
write_in_place(&mut obj, b"hi").unwrap();
let bigger = repack(&obj, &vec![0u8; 5000]).unwrap();
let bytes = extract(&obj).unwrap();
```

`Error` variants: `BadVersion`, `OutOfBounds`, `TooLarge`, `Malformed`. Malformed
input always returns a typed `Err` — it never panics.

## Editor integration

`nano` links this crate (`crates/apps/nano`): opening `nano /home/doc.wasm` reads
the content out of a verified object, and Ctrl-O saves the buffer back into a wasm
object. The canvas `editor` has the same branch for when a GUI launch path can pass
it an argv. Both guard against clobbering a non-document `.wasm`: only a path that
does not exist yet becomes a new mintable document.

## Tests

- `cargo test -p wasmobj` — unit + `proptest` round-trip/validity
  (`wasmparser`) + a `wasmtime` proof that an object self-executes (FR-9).
- `e2e/wasmobj.spec.ts` — full browser flow: nano creates a wasm object,
  it survives a tab reload, reopens to its content, and appends.

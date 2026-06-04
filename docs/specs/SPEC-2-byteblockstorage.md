# SPEC-2: byteblockstorage — the wasm-object document container

> A guest/userland Rust library that stores a document **as a WebAssembly module**: a fixed-size byte window inside the `.wasm` binary is pre-filled with placeholder ASCII, an app edits it, and on save the content is written over the placeholder and persisted as a new `.wasm` file (with an optional plain-text export) — a document that is a live, rewritable, self-executing wasm module.

**Date:** 2026-06-03
**Author:** LayerDynamics + Claude
**Status:** Draft
**Version:** 1.0
**Crate:** `crates/byteblockstorage` (Rust, `wasm32-wasi`)
**Relates to:** [SPEC-1: WASM_OS](SPEC-1-wasm-os.md) (L1 WASI process ABI, L2 userland, L3 editor app)

---

## 0. Reading Guide

This spec defines a **userland library**, not a kernel subsystem. It deliberately does **not** touch the existing host TypeScript `Blockstore` (`packages/host/src/blockstore/`), which is a kernel-imported, sync-over-async OPFS/IndexedDB key/value store at a different layer. `byteblockstorage` runs *inside a `wasm32-wasi` guest process*, reaches files only through WASI syscalls, and produces/consumes ordinary VFS files. The names collide (“blockstore”) but the layers do not.

The core trick the whole design rests on: **a fixed-size active data segment is a contiguous, length-stable byte window in the `.wasm` file.** Because its LEB128 length prefix and all downstream section offsets never move, writing content that fits is a pure overwrite — no parsing, no re-encoding the module. That single invariant is the reason the README says “pre-fill with spaces and write over them.”

---

## 1. Background

### 1.1 Problem Statement

WASM_OS is built on one idea taken to its limit: *everything is a WebAssembly module* — the kernel, the guests, the apps. One thing is **not** wasm: the documents users create. A text file saved by the editor is just bytes in the VFS, indistinguishable from any other blob and inert on its own. `byteblockstorage` closes that gap by making a **document itself a wasm module** — a self-describing, self-executing, single-file container whose payload region can be rewritten in place. The README states the mechanism precisely: create a wasm object pre-filled with spaces/ASCII; when it is loaded in the OS and the user presses save, overwrite the placeholder region with the saved content, emitting the result as a new file.

### 1.2 Current State

- The editor and `nano` (L2/L3) read and write **plain byte files** through the kernel VFS (`path_open` + `fd_read`/`fd_write`). There is no document container format.
- The host `Blockstore` persists VFS blocks to OPFS/IndexedDB (`packages/host/src/blockstore/`), bridged to the kernel’s synchronous imports by a write-back cache (`cached.ts`). It stores opaque bytes; it has no notion of a document being a module.
- Nothing in the tree mints, validates, or rewrites `.wasm` modules from *inside* a guest. `tools/binder` transpiles the kernel ABI at build time on the host — a different concern.
- `crates/byteblockstorage` exists today only as a one-line `README.md`; it is **not** a workspace member yet.

### 1.3 Target Users

- **WASM_OS app developers** (the project author first) who want a document type that is uniform with the rest of the system and can be loaded/run as a module.
- **End users of WASM_OS** who open, edit, and save documents in the editor — for them this is invisible plumbing whose only visible effect is the create→edit→save→reload flow working.
- **Onlookers / the curious** — an explicit goal is demonstrability: *“to show people it’s possible”* that a document can be a rewritable wasm module.

### 1.4 Motivation

The user selected four reasons, all of which shape scope:

1. **Uniformity** — `kernel.wasm`, `editor.wasm`, `mydoc.wasm`: documents become first-class citizens of a wasm-native OS.
2. **Self-executing docs** — a document can also be *run*; executing it renders its own content (FR-9), so the container is live, not inert.
3. **Portable single file** — content plus self-describing metadata travel together in one standard `.wasm` file that any engine can at least load.
4. **Proof / demonstrability** — a concrete, runnable demonstration that wasm data-segment rewriting works in practice.

### 1.5 Assumptions

- A1. The runtime is WASM_OS as built through M5 (SPEC-1): a `wasm32-wasi` guest can `path_open`/`fd_read`/`fd_write` against the VFS, and the editor app can be extended to call a Rust dependency.
- A2. Documents in V1 are **text-first** but the byte window is content-agnostic (arbitrary bytes are storable; a content-type tag records intent — FR-15).
- A3. Single-writer at a time per object. No concurrent multi-process editing of the same object in V1.
- A4. Block tiers are powers of two; the largest V1 tier is 64 KiB (text documents). Larger payloads are an explicit later concern (OQ-3).
- A5. Standard WebAssembly binary format (MVP + custom sections); no proposals beyond what `wasm32-wasi` guests already rely on are required for the *format*.

### 1.6 The Save Model (the resolved design decision)

A real conflict surfaced during discovery: an early answer had **save** extracting content to a plain `mydoc.txt`. That choice quietly gutted the project — it made the durable artifact a plain file, so the in-place-overwrite / re-pack machinery (FR-5/FR-6) and the self-executing property (FR-9) became dead code in the primary flow, and three of the four stated purposes (§1.4: uniformity, self-executing, portable) no longer held for anything a user keeps. The conflict was surfaced and the design was resolved the way that *doesn't* conflict with the README or the purposes (Decision Log D-3):

> **Save writes the content into a new, content-bearing wasm object** (`mydoc.wasm`). This is the literal README reading — “writes over the space or ascii with the saved content **in a new file**”, where the new file is itself a wasm object. The flow is: load template → overwrite the placeholder window with content (in place if it fits, else re-pack) → persist the filled object as the new file.

Every design goal now holds without contradiction:
- **In-place / re-pack machinery is load-bearing** — the filled object is what gets persisted, so FR-5/FR-6 do real work on the durable artifact.
- **Self-executing (FR-9) is real and durable** — the saved `mydoc.wasm` can be run and renders its own content; not just an in-session trick.
- **Uniformity & portability hold** — saved documents *are* wasm modules, uniform with `kernel.wasm`/`editor.wasm`, and travel as one self-describing file.
- **Proof / demonstrability** — the observable act of rewriting a wasm data segment and running the result is exactly the demonstration the README is after.

**Secondary, non-conflicting convenience:** because WASM_OS is Unix-flavoured (`cat`, `grep`, pipes), the library *also* offers an **extract-to-plain-file** path (FR-7b) so content can be exported as ordinary bytes for interop. This is additive — it does not replace the wasm-object save, so it introduces no conflict. The reusable blank template is never mutated by either path (save-as semantics).

---

## 2. Requirements

### 2.1 Functional Requirements

| ID | Priority | Requirement |
|----|----------|-------------|
| FR-1 | MUST | The library MUST mint a **wasm object**: a valid `wasm32` module containing one **active data segment** of a requested block-tier `capacity`, pre-filled entirely with the placeholder byte `0x20` (ASCII space). |
| FR-2 | MUST | Every minted or re-packed object MUST be a valid WebAssembly module (passes `wasm-tools validate`) and MUST load without error in the WASM_OS runtime. |
| FR-3 | MUST | The object MUST embed a self-describing header in a **custom section** named `bbs0`, recording: magic, format version, the writable window’s **byte offset within the file**, its `capacity`, the current `content_len`, and a `content_type` tag. |
| FR-4 | MUST | Given any object this library recognizes, the library MUST locate the writable window via the `bbs0` header and read back exactly `content_len` content bytes (excluding placeholder padding). |
| FR-5 | MUST | On save where `content_len ≤ capacity`, the library MUST overwrite the window **in place with no module re-encode**: write the content bytes, pad the remainder with `0x20`, and update `content_len` in the `bbs0` header. |
| FR-6 | MUST | On save where `content_len > capacity`, the library MUST **re-pack**: emit a new valid object whose window is the smallest block tier ≥ `content_len`, carrying the content forward. |
| FR-7 | MUST | When the user presses **save**, the system MUST write the current content into a **new content-bearing wasm object** at the chosen destination path (e.g. `mydoc.wasm`): overwrite the placeholder window with the content (in place if it fits — FR-5; else re-pack — FR-6), then persist the filled object. The reusable blank template is left byte-for-byte unmodified (save-as). |
| FR-7b | SHOULD | The library SHOULD additionally offer **extract-to-plain-file**: write the current content as an ordinary VFS file (e.g. `mydoc.txt`) for Unix-tool interop (`cat`/`grep`/pipes). Additive to FR-7, never a replacement. |
| FR-8 | MUST | The library MUST function as a `wasm32-wasi` guest dependency, using only WASI fd/path syscalls for I/O — **no** dependency on the host TypeScript `Blockstore` or any host-only API. |
| FR-9 | MUST | A minted/filled object MUST be **self-executing**: running the saved `mydoc.wasm` as a WASM_OS process writes its current window content (`content_len` bytes) to stdout, rendering the document as a live module (§1.6). |
| FR-10 | SHOULD | Block tiers SHOULD be powers of two — `256 B, 1 KiB, 4 KiB, 16 KiB, 64 KiB` — to bound re-pack frequency and keep the window aligned. |
| FR-11 | SHOULD | The library SHOULD verify a candidate object (header magic/version present, offset + capacity in-bounds, capacity matches the data segment length) and reject malformed or forged objects with a typed error rather than panicking. |
| FR-12 | SHOULD | The **editor** app SHOULD support the full open-wasm-object → edit → save flow end-to-end in V1 (this is the V1 milestone’s demoable proof). |
| FR-13 | COULD | A coreutils-style CLI (`wobj new｜info｜cat｜extract`) COULD let the terminal mint, inspect, and extract objects. |
| FR-14 | COULD | An object COULD record optional document metadata in `bbs0` (e.g. title, created/modified tick) beyond the core header fields. |
| FR-15 | COULD | The `bbs0` header COULD carry a richer `content_type` (e.g. `text/plain`, `application/octet-stream`) so one container format holds text or binary. |

#### Explicit Non-Goals (V1)

| ID | Priority | The library WILL NOT (in V1) |
|----|----------|------------------------------|
| FR-NG-1 | WONT | Compress or encrypt content — the window is stored as plaintext bytes. |
| FR-NG-2 | WONT | Support concurrent multi-writer editing of a single object (single-writer assumption A3). |
| FR-NG-3 | WONT | Parse, relocate, or rewrite arbitrary third-party `.wasm` modules — only objects bearing a valid `bbs0` header are read/written. |
| FR-NG-4 | WONT | Stream payloads larger than the 64 KiB top tier (chained/streamed blocks deferred — OQ-3). |
| FR-NG-5 | WONT | Replace or modify the host VFS `Blockstore`; it operates strictly above the VFS via WASI. |

### 2.2 Non-Functional Requirements

> All numeric targets are **[PROPOSED]** until an owner fixes them (§8 OQ-1). They are written as measurable statements so they are testable once confirmed. Targets are framed for a single-user, browser-local guest — not a server. Measured as guest CPU time unless noted.

#### Performance

| Metric | Target [PROPOSED] | Measurement |
|--------|-------------------|-------------|
| Mint a fresh object (≤ 64 KiB tier) | < 5 ms | Microbench: `mint(tier)` wall time in a `wasm32-wasi` harness |
| In-place save (`content ≤ capacity`) | < 2 ms for ≤ 4 KiB; cost is one contiguous window write + header patch, **no full re-encode** | Bench `write_in_place`; assert no re-encode path taken |
| Re-pack save (`content > capacity`) | < 10 ms for ≤ 64 KiB | Bench `repack` from tier N→N+1 |
| Read-back content | < 1 ms for ≤ 4 KiB | Bench `read` from a minted object |
| Object overhead beyond the window | < 1 KiB (module preamble + `bbs0` header) | `len(object) − capacity` for an empty object at each tier |

#### Reliability

| Metric | Target [PROPOSED] |
|--------|-------------------|
| Output validity | 100% of minted and re-packed objects pass `wasm-tools validate` (property test over random tiers + content lengths). |
| Round-trip fidelity | For all content `c` with `len(c) ≤ tier`, `read(write(mint(tier), c)) == c` exactly (no padding leakage, no truncation). |
| In-place invariant | After an in-place save, every byte of the file outside the window is byte-for-byte identical to before (diff test). |
| Save durability | The saved `.wasm` object survives a tab reload and re-opens to identical content — guaranteed by the existing OPFS/IndexedDB durability (SPEC-1 §2.2), provided the host flushes after FR-7 (see Risk R-3). |
| Malformed-input safety | Feeding non-`bbs0` or corrupted bytes returns a typed `Err`, never panics/traps the guest (fuzz/`Result` test). |

#### Security

- **Trust boundary:** the library runs inside an already-sandboxed `wasm32-wasi` process; it gains no new capability. Its only external effect is reading/writing VFS files the process was already granted (SPEC-1 capability model).
- **Forgery resistance:** the `bbs0` header is validated before any in-place write (FR-11); an object whose declared window offset/capacity does not match its actual data segment is rejected, so a crafted object cannot steer a write outside the window.
- **No code injection via content:** content bytes live only in a data segment, never in a code section. A minted object’s executable code (the `render` export, FR-9) is emitted by this library, not derived from user content.
- **Data classification:** documents are user-private to the origin, same as all `/home` files; no telemetry, no network. No PII/PHI handling in scope.

#### Scalability & Footprint

- Content size is bounded by the top tier (64 KiB) in V1; memory use is bounded by one tier-sized buffer. No unbounded buffering.
- Re-pack frequency is bounded by power-of-two tier growth (FR-10): a document doubling in size triggers at most `log2(64KiB/256B) = 8` re-packs over its lifetime.
- The format is forward-versioned (`bbs0` → `bbs1`…) so larger tiers or chained blocks (OQ-3) can be added without breaking readers of older objects.

### 2.3 Constraints

1. **Pure `wasm32-wasi` guest.** No host APIs; builds under the existing workspace with the `wasm32-wasi` target and the project toolchain (`rust-toolchain.toml`). I/O is WASI `path_open`/`fd_read`/`fd_write` only.
2. **In-place rewrite requires a length-stable window.** The writable region MUST be a single **active data segment whose byte length never changes** across an in-place save. Its LEB128 length prefix and every following section offset stay fixed; only then is a save a pure overwrite (this is the load-bearing invariant). Content shorter than capacity is padded with `0x20`; content longer forces re-pack (FR-6).
3. **Metadata lives only in a custom section.** Per the WebAssembly spec, custom sections are the sole standard place for non-executable metadata and are ignored by engines — so the `bbs0` header (FR-3) cannot disturb module validity or execution.
4. **Layer separation from the host `Blockstore`.** This crate MUST NOT import, wrap, or depend on `packages/host/src/blockstore/`; the shared word “blockstore” is incidental (see §0).
5. **Editor integration must not regress plain files.** Adding wasm-object support to the editor (FR-12) MUST leave existing plain-file open/save working unchanged.
6. **Workspace registration.** `crates/byteblockstorage` must be added to the root `Cargo.toml` `members` and gain a `Cargo.toml` using the workspace `edition`/`version`/`license` (matching sibling crates like `catfile`).

---

## 3. Architecture

### 3.1 System Overview

```text
 WASM_OS guest process (wasm32-wasi)            VFS (kernel, SPEC-1)
┌───────────────────────────────────────┐     ┌─────────────────────────┐
│ editor app  ── links ──▶ byteblockstorage│   │ /home/templates/blank.wasm│
│                          ┌────────────┐ │     │ /home/mydoc.wasm  (saved) │
│  open(path) ────────────▶│ io::read   │─┼──▶ path_open + fd_read  ───────▶│
│  edit (in app buffer)    │ format::*  │ │     │ /home/mydoc.txt  (FR-7b)  │
│  save(path) ────────────▶│ io::save   │─┼──▶ fd_write (filled .wasm obj)─▶│
│                          │   ├ in-place│ │     │  (host flush → OPFS/IDB)  │
│                          │   └ repack  │ │     └─────────────────────────┘
│  run mydoc.wasm (FR-9)──▶│ render exp │ │      durability: SPEC-1 §2.2
│                          └────────────┘ │
└───────────────────────────────────────┘
   the saved document IS a .wasm module; save overwrites the placeholder
   window with content and persists the filled object as the new file.
```

The library is a dependency the editor links. It owns the **wasm-object format** and the four operations over it (mint, read, write-in-place, repack); the host app owns the edit buffer and the save UI; the kernel VFS owns persistence.

### 3.2 Component Design

#### Component: `format`
- **Responsibility:** Define the on-disk wasm-object layout and the `bbs0` header; encode/decode the header; enumerate block tiers.
- **Technology:** Rust, `no_std`-friendly where practical.
- **Interfaces:** `Header { magic, version, window_offset, capacity, content_len, content_type }`; `Tier` enum + `tier_for(len) -> Tier`; `parse_header(&[u8]) -> Result<Header>`, `patch_content_len(&mut [u8], n)`.
- **Dependencies:** none beyond core/alloc.

#### Component: `mint`
- **Responsibility:** Emit a fresh, valid module at a given tier — module preamble, a memory, one active data segment of `capacity` × `0x20`, the `bbs0` custom section pointing at that segment’s file offset, and the `render` export (FR-9, MUST).
- **Technology:** Rust; hand-emit the binary (deterministic byte layout so the window offset is known exactly) — no heavyweight wasm-builder dependency required.
- **Interfaces:** `mint(tier: Tier, content_type: u8) -> Vec<u8>`.
- **Dependencies:** `format`.

#### Component: `io`
- **Responsibility:** The four operations against object bytes: `read`, `write_in_place`, `repack`, `extract`.
- **Technology:** Rust.
- **Interfaces:** `read(obj: &[u8]) -> Result<Vec<u8>>`; `write_in_place(obj: &mut [u8], content: &[u8]) -> Result<()>` (errors if `content > capacity`); `repack(obj: &[u8], content: &[u8]) -> Result<Vec<u8>>`; `save(obj: &mut Vec<u8>, content: &[u8])` (chooses in-place vs repack); `extract(obj: &[u8]) -> Result<Vec<u8>>` (== `read`, named for the FR-7b plain-export intent).
- **Dependencies:** `format`, `mint`.

#### Component: `wasi` (VFS glue)
- **Responsibility:** Thin helpers to load an object from and write a file to the VFS via WASI.
- **Technology:** Rust + `wasi`/`std::fs` over `wasm32-wasi`.
- **Interfaces:** `load_object(path) -> Result<Vec<u8>>`; `write_file(path, bytes) -> Result<()>`.
- **Dependencies:** WASI syscalls (SPEC-1 ABI).

#### Component: editor integration (FR-12, V1)
- **Responsibility:** Detect a wasm object on open (header present) → load content into the edit buffer; on save → fill the window and write a new `.wasm` object (FR-7), optionally also exporting a plain file (FR-7b).
- **Technology:** Rust (`crates/apps/editor`), linking `byteblockstorage`.
- **Interfaces:** internal to the editor’s open/save handlers.
- **Dependencies:** `byteblockstorage`.

#### Component: `wobj` CLI (FR-13, COULD — later)
- **Responsibility:** Terminal mint/inspect/extract.
- **Technology:** Rust coreutils-style binary.
- **Interfaces:** `wobj new|info|cat|extract`.
- **Dependencies:** `byteblockstorage`.

### 3.3 Data Model

A wasm object is a standard WebAssembly module with two additions:

```text
┌────────────────────────────────────────────────────────────────┐
│ \0asm 0x01000000                       (8-byte preamble)         │
│ type / function / memory / export …    (minimal module skeleton) │
│ code section: `render` fn              (FR-9 self-executing, MUST)│
│ ── DATA SECTION ──────────────────────────────────────────────  │
│   active segment 0:  memidx=0  offset=(i32.const 0)              │
│     length = capacity (LEB128, NEVER changes on in-place save)   │
│     bytes  = [content_len bytes of content][padding 0x20 …]  ◀── writable window
│ ── CUSTOM SECTION "bbs0" ─────────────────────────────────────  │
│   Header { magic="BBS0", version=1,                              │
│            window_offset:u32  (file offset of first window byte),│
│            capacity:u32, content_len:u32, content_type:u8 }      │
└────────────────────────────────────────────────────────────────┘
```

**Entities & lifecycle:**
- **Template object** — minted with `content_len = 0`, window all `0x20`. Reusable; never mutated by save-as (FR-7).
- **Window** — the `capacity`-byte region; the only mutable payload region. Created at mint, overwritten in place on fitting saves, re-created (larger) on re-pack.
- **`bbs0` header** — created at mint; `content_len` patched on every save; `capacity`/`window_offset` change only on re-pack.
- **Saved object** — produced on save (FR-7): a new content-bearing `.wasm` file (window = content, padded to its tier); the durable, runnable user-facing artifact.
- **Exported file** (optional, FR-7b) — a plain VFS file of exactly `content_len` content bytes for Unix-tool interop; additive, not the primary artifact.

**Consistency:** single-writer (A3); a save is atomic at the file level (write full new bytes, then the host flush). In-place save preserves all non-window bytes (Reliability invariant).

### 3.4 API & Interface Design

```rust
// crate root: byteblockstorage

pub enum Tier { B256, K1, K4, K16, K64 }
impl Tier { pub fn bytes(self) -> usize; pub fn for_len(n: usize) -> Option<Tier>; }

pub struct Header {
    pub version: u8,
    pub window_offset: u32,
    pub capacity: u32,
    pub content_len: u32,
    pub content_type: u8,
}

pub enum Error { BadMagic, BadVersion, OutOfBounds, TooLarge, Malformed }

/// FR-1/FR-3/FR-9: emit a fresh object at `tier`, window pre-filled with 0x20.
pub fn mint(tier: Tier, content_type: u8) -> Vec<u8>;

/// FR-4: read back exactly content_len bytes.
pub fn read(obj: &[u8]) -> Result<Vec<u8>, Error>;

/// FR-11: validate header + window bounds.
pub fn verify(obj: &[u8]) -> Result<Header, Error>;

/// FR-5: in-place overwrite; Err(TooLarge) if content > capacity. No re-encode.
pub fn write_in_place(obj: &mut [u8], content: &[u8]) -> Result<(), Error>;

/// FR-6: emit a new, larger object carrying `content`.
pub fn repack(obj: &[u8], content: &[u8]) -> Result<Vec<u8>, Error>;

/// FR-5+FR-6: in-place if it fits, else repack (returns Some(new_bytes) on repack).
pub fn save(obj: &mut Vec<u8>, content: &[u8]) -> Result<Option<Vec<u8>>, Error>;

/// FR-7b: extract content for the optional plain-file export (== read, intent-named).
pub fn extract(obj: &[u8]) -> Result<Vec<u8>, Error>;

// wasi glue (wasm32-wasi only)
pub mod wasi {
    pub fn load_object(path: &str) -> std::io::Result<Vec<u8>>;
    pub fn write_file(path: &str, bytes: &[u8]) -> std::io::Result<()>;
}
```

### 3.5 Data Flow

**Create → edit → save → run (the README workflow, FR-1/4/5/6/7/9):**
1. `mint(Tier::K4, TEXT)` → a 4 KiB-window object, all spaces → `wasi::write_file("/home/templates/blank.wasm", obj)`.
2. Editor opens a template (or an existing object): `wasi::load_object(path)` → `verify` → `read` → edit buffer.
3. User types content.
4. On **save** to `/home/mydoc.wasm`: `save(&mut obj, content)` overwrites the window — `write_in_place` if `content.len() ≤ capacity` (pads with `0x20`, patches `content_len`, **no re-encode**), else `repack` → a new object at the next tier (FR-6). The **blank template on disk is untouched** (save-as).
5. The **filled object is persisted**: `wasi::write_file("/home/mydoc.wasm", obj)`; the host flushes → durable. The saved document *is* a wasm module (FR-7) — this is what makes `write_in_place`/`repack` load-bearing on a real artifact.
6. **Run it (FR-9):** `spawn /home/mydoc.wasm` → its `render` export reads its own window and writes `content_len` bytes to stdout → the terminal shows the document rendering itself as a live module. The proof.

**Interop export (FR-7b, SHOULD):** the editor/CLI may additionally `extract(&obj)` → content bytes → `wasi::write_file("/home/mydoc.txt", content)` so plain Unix tools can consume the content. Additive; the `.wasm` object remains the primary saved artifact.

### 3.6 Integration Points

- **Kernel VFS / WASI ABI (SPEC-1):** the only system dependency — `path_open`, `fd_read`, `fd_write`.
- **Editor app (`crates/apps/editor`):** open/save handlers gain a “this is a wasm object” branch (FR-12).
- **Host save flush (`packages/host`):** FR-7 durability relies on the host flushing the VFS write after save (Risk R-3).
- **Workspace build:** new member in root `Cargo.toml`; built by `npm run build:guests` like other guests.

### 3.7 Security Architecture

Covered in §2.2 Security. Summary: no new capabilities; header validation before any in-place write prevents out-of-window writes (FR-11); content never enters a code section; user-private, no network. The `render` code is library-emitted, never user-derived.

### 3.8 Resilience Design

- **Malformed input:** `verify` gates every operation; bad magic/version/bounds → typed `Err`, never a trap (Reliability target).
- **Partial/failed save:** save writes the full destination file then relies on host flush; a crash mid-flush leaves either old or new file (no torn window, since the object is built fully in memory before write).
- **Re-pack failure:** if `repack` fails validation it returns `Err` and the original object/file is left intact; the app surfaces the error rather than writing a corrupt file.
- **No retries/circuit-breakers/caching needed** — this is a synchronous, local, single-call library; those production patterns do not apply (deliberately omitted, not overlooked).

### 3.9 Observability

- The library returns rich typed `Error`s (no silent failures); the editor surfaces them in its status line.
- A `wobj info` (FR-13) / `verify` path prints the decoded `bbs0` header (version, offset, capacity, content_len, type) for inspection.
- Tests emit the validity/round-trip/diff assertions as the primary signal; no runtime metrics infrastructure is warranted for a local library.

### 3.10 Infrastructure & Deployment

- Built as a `wasm32-wasi` guest dependency via the existing `npm run build:guests`; no new infra.
- Shipped as static assets with the rest of WASM_OS (no server).
- CI: add the crate’s unit/property tests to the Rust gate of `npm run verify`; add the editor E2E to the e2e gate.

---

## 4. Implementation Plan

### 4.1 Build Phases

#### Phase 1: Format + library core
- **Goal:** A working, tested `byteblockstorage` crate.
- **Scope:** `Cargo.toml` + workspace registration; `format` (header + tiers); `mint`; `io` (`read`/`write_in_place`/`repack`/`save`/`extract`/`verify`); unit + property tests.
- **Exit criteria:** All FR-1…FR-6, FR-10, FR-11 met; 100% of minted/re-packed objects pass `wasm-tools validate`; round-trip + in-place-invariant property tests green.

#### Phase 2: WASI glue + self-execution
- **Goal:** The library works from inside a real guest and an object can render itself.
- **Scope:** `wasi` module; the `render` export (FR-9, MUST); a tiny guest test binary that mints→writes→reads via the VFS.
- **Exit criteria:** FR-8, FR-9 met; a guest can mint an object to `/home`, reload it, and read back identical content; running the object prints its content.

#### Phase 3: Editor integration + E2E (V1 milestone)
- **Goal:** The full create→edit→save→reload flow works in the OS.
- **Scope:** Editor open/save branch for wasm objects (FR-12, FR-7); run-the-document action (FR-9); preserve plain-file behavior (Constraint 5).
- **Exit criteria:** FR-7, FR-9, FR-12 met; a real-browser E2E opens a template object, types, saves a new `.wasm` object, reloads the tab, re-opens it to identical content, **and runs it to render its own content** — no regression to plain-file open/save.

#### Phase 4 (optional, post-V1): CLI + richer content types
- **Scope:** `wobj` command (FR-13), plain-text export polish (FR-7b), document metadata in `bbs0` (FR-14), richer content-type tag (FR-15).
- **Exit criteria:** `wobj new/info/cat/extract` work in the shell; round-trips a binary payload.

### 4.2 Testing Strategy

- **Unit:** each `format`/`io` function, including every `Error` branch.
- **Property:** for random `(tier, content_len ≤ capacity)`, `read(write(mint, c)) == c`; for `content_len > capacity`, `save` re-packs and round-trips; in-place save leaves all non-window bytes byte-identical.
- **Validity:** every minted/re-packed object → `wasm-tools validate` (invoked in-test or in CI).
- **Fuzz/negative:** random/corrupted bytes into `verify`/`read` never panic; always `Err`.
- **E2E (Phase 3):** Playwright flow in `e2e/` — open template → type → save a new `.wasm` object → reload tab → re-open and assert content → **run the saved object and assert it prints its own content** (matches the project’s existing boot-persist probes, e.g. `probe-boot-persist.mjs`). This is a **real** E2E: browser → host → kernel VFS → OPFS/IndexedDB → reload → read back + spawn, no mocks.

### 4.3 Rollout Strategy

- Additive: new crate + an editor code path behind a content sniff (header present). Plain files untouched.
- Land Phase 1–2 (library, no UI surface) first; Phase 3 flips the editor on. Easy to revert the editor branch alone if needed (per global rule: surgical `Edit`, not nuclear checkout).

### 4.4 Operational Readiness

- Before merge: Rust gate (unit+property) and e2e gate of `npm run verify` green; `wasm-tools validate` clean on generated objects; editor plain-file regression test green.
- Docs: add a short `crates/byteblockstorage/README.md` replacement describing the format and the `bbs0` header (the current one-liner is the seed, not the doc).

---

## 5. Milestones

| Milestone | Goal | Exit Criteria | Target | Owner |
|-----------|------|---------------|--------|-------|
| M-BBS-1 | Library core | FR-1..6,10,11; validate + round-trip + invariant tests green | — | LayerDynamics |
| M-BBS-2 | Guest + self-exec | FR-8,9; mint→VFS→reload→read identical; object renders itself | — | LayerDynamics |
| M-BBS-3 (V1) | Editor E2E | FR-7,9,12; browser E2E create→edit→save-`.wasm`→reload→re-open→run; no plain-file regression | — | LayerDynamics |
| M-BBS-4 (opt) | CLI + export + types | FR-7b,13,14,15; `wobj` round-trips text + binary; plain-text export | — | LayerDynamics |

### Dependency Graph

```text
M-BBS-1 (format + io + tests)
   └─▶ M-BBS-2 (wasi glue + render export)
          └─▶ M-BBS-3  V1: editor integration + E2E
                 └─▶ M-BBS-4 (optional: wobj CLI, plain-text export, metadata/content types)
```

---

## 6. Success Criteria

### 6.1 Launch Metrics

| Metric | Target | Measurement Method |
|--------|--------|--------------------|
| Object validity | 100% generated objects valid | `wasm-tools validate` over the property-test corpus |
| Round-trip fidelity | 100% for `content ≤ tier` | Property test `read(write(mint,c)) == c` |
| In-place save = no re-encode | true for all fitting saves | Test asserts re-pack path not taken + non-window bytes unchanged |
| Create→edit→save-`.wasm`→reload→re-open | passes in real browser | Phase-3 Playwright E2E |
| Saved object self-executes | running `mydoc.wasm` prints its content | Phase-3 E2E spawns the saved object (FR-9) |
| Plain-file regression | zero | Existing editor open/save E2E still green |

### 6.2 Ongoing Monitoring

- The crate’s tests run in `npm run verify` on every change; the E2E runs in the e2e gate. Regression = a red gate. No runtime dashboards (local library).

### 6.3 Remediation Triggers

- Any generated object failing `wasm-tools validate` → block merge.
- Any in-place save mutating bytes outside the window → block merge (corruption risk).
- E2E content mismatch after reload → block merge (durability/extraction broken).

---

## 7. Risks

| ID | Risk | Impact | Likelihood | Mitigation | Contingency |
|----|------|--------|-----------|------------|-------------|
| R-1 | LEB128 length prefix of the data segment changes if capacity is chosen such that its encoded length differs across edits, breaking the in-place invariant | High (corruption) | Low | Capacity is fixed per object and never changes on in-place save (Constraint 2); only re-pack changes it, and re-pack re-encodes fully | Property test asserts non-window bytes identical; fail closed |
| R-2 | Hand-emitting the wasm binary produces a subtly invalid module on some tier | High | Medium | `wasm-tools validate` every minted/re-packed object in tests + CI; keep the emitted skeleton minimal and deterministic | Fall back to a vetted wasm-builder crate for `mint` if hand-emit proves fragile |
| R-3 | Host does not flush the VFS after save → saved object lost on reload (FR-7 durability) | High | Medium | Reuse the host’s existing flush-before-reload path (as the boot-persist E2E does); assert in the Phase-3 E2E | Have the editor call an explicit flush; document the requirement |
| R-4 | Editor integration regresses plain-file open/save | Medium | Medium | Branch only when a valid `bbs0` header is detected; keep a plain-file regression E2E (Constraint 5) | Gate the wasm-object path behind a setting until proven |
| R-5 | Content > 64 KiB top tier has no path in V1 (FR-NG-4) | Low–Med | Medium | Documented non-goal; `for_len` returns `None` → typed `Err(TooLarge)` surfaced to the user | Add chained blocks / larger tiers (OQ-3) post-V1 |
| R-6 | “blockstore” name collision with the host `Blockstore` confuses contributors | Low | High | §0 + Constraint 4 state the separation explicitly; consider a clearer crate description in its README | Rename crate if confusion persists (OQ-2) |
| R-7 | Editor save-as defaults are unclear: a user expecting a plain text file gets a `.wasm`, or vice-versa, causing confusion or “lost” files | Medium | Medium | Default save target is `.wasm` (FR-7); offer an explicit “Export as text” for FR-7b; make the chosen extension visible in the save dialog | Remember per-document last-used format; surface both files in the file manager (OQ-4) |

---

## 8. Open Questions

| # | Question | Owner | Due |
|---|----------|-------|-----|
| OQ-1 | Confirm the [PROPOSED] performance/footprint targets in §2.2 (or mark them advisory). | LayerDynamics | Before M-BBS-1 close |
| OQ-2 | Keep the crate name `byteblockstorage`, or rename to avoid collision with the host `Blockstore` (e.g. `wasmobj`)? | LayerDynamics | Before M-BBS-1 |
| OQ-3 | Post-V1: support payloads > 64 KiB via larger tiers or chained blocks (FR-NG-4)? Which? | LayerDynamics | Post-V1 |
| OQ-4 | Default destination on save-as — same dir as template, or a user-chosen path each time? Affects FR-7 UX. | LayerDynamics | Before M-BBS-3 |
| OQ-5 | ✅ **RESOLVED** — padding byte is ASCII space `0x20` (matches the README's "spaces or ascii" seed; keeps the reserved window human-readable). The one downside (content→padding boundary is ambiguous in a raw hex dump when text content ends in spaces) is inert: `read`/`extract`/`_start` all use `content_len`, never the padding, so nothing infers the boundary from bytes. Eyeball-debugging is served by `wobj info` (FR-13) printing the header. | LayerDynamics | Resolved 2026-06-04 |
| OQ-6 | Does the `render` export (FR-9) write to stdout, or also draw to a compositor surface for non-text content? | LayerDynamics | Before M-BBS-2 |
| OQ-7 | Should opening an existing `mydoc.wasm` and re-saving overwrite the same file in place (true in-place FR-5 on the persisted file) or always write a new file? Affects whether FR-5’s no-re-encode win is realized on disk or only in memory. | LayerDynamics | Before M-BBS-3 |

---

## Appendices

### Appendix A — Glossary

| Term | Meaning |
|------|---------|
| **wasm object** | A standard `.wasm` module used as a document container: its active data segment holds the content; a `bbs0` custom section describes it. |
| **window** | The fixed-size, length-stable byte region (the active data segment) that holds content + `0x20` padding; the only mutable payload region. |
| **`bbs0` header** | The custom-section metadata: magic, version, window offset, capacity, content_len, content_type. |
| **in-place save** | Overwriting the window without re-encoding the module (content ≤ capacity). |
| **re-pack** | Emitting a new, larger object when content exceeds capacity. |
| **save-as** | Writing content to a new destination file (a `.wasm` object — FR-7; or a plain export — FR-7b), leaving the reusable blank template unmodified. |
| **tier** | A power-of-two capacity (256 B … 64 KiB). |
| **self-executing doc** | An object that, when run as a process, prints/renders its own content (FR-9). |

### Appendix B — `bbs0` Header Layout (V1)

```text
offset  size  field          notes
0       4     magic          ASCII "BBS0"
4       1     version        = 1
5       4     window_offset  u32 LE — file offset of first window byte
9       4     capacity       u32 LE — window length in bytes (== data segment len)
13      4     content_len    u32 LE — valid content bytes (rest is 0x20 padding)
17      1     content_type   0 = text/plain, 1 = application/octet-stream (FR-15)
                              (carried in a WebAssembly custom section payload)
```

### Appendix C — Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D-1 | A document is a real `.wasm` module, content in its data segment | User selection; uniformity + self-executing + portable + proof (§1.4) |
| D-2 | Fixed-size pre-allocated window, in-place overwrite | User selection “load-bearing pre-allocation”; enables no-re-encode save (Constraint 2) |
| D-3 | Save = write a new **content-bearing wasm object** (`mydoc.wasm`); plain-text extract is a secondary interop export (FR-7b) | An early answer (“raw extracted content” → `.txt`) made the saved artifact a plain file, which left FR-5/FR-6/FR-9 as dead code and broke 3 of 4 purposes (§1.6). The conflict was surfaced; the author then authorized resolving it the non-conflicting way. This matches the README literally (“the saved content **in a new file**”) and makes the in-place/re-pack machinery load-bearing on the durable artifact. Plain-text extract retained as additive convenience for Unix-tool interop. |
| D-4 | Overflow → re-pack to next tier (not error/truncate/chain) | User selection; tiers bound re-pack frequency (FR-6/FR-10) |
| D-5 | Guest/userland Rust library, not a kernel VFS backend or host module | User selection; reaches VFS via WASI only (Constraint 1, 4) |
| D-6 | Metadata in a `bbs0` custom section | Only spec-blessed place for non-executable metadata; keeps module valid (Constraint 3) |
| D-7 | V1 editor integration (FR-12) shipped in **nano**, not the canvas editor | During implementation the canvas editor proved unreachable as a document opener: the shell cannot launch GUI apps (no `Gpu`/`Input` caps to delegate) and the host spawn API cannot pass an argv path, so nothing could open the editor on a `.wasm`. nano is a terminal editor — shell-launchable with argv, no GPU caps — and is within the author's chosen "editor/nano" scope. nano carries the FR-7/FR-12 flow end-to-end (browser E2E); the canvas editor keeps the same (guarded) branch as forward-looking code for when a GUI argv-launch path exists. Both apps guard against mint-overwriting an existing non-document `.wasm`. |

### Appendix D — Validation Checklist (Phase 4 of authoring)

- [x] Every section has real content (no empty/TBD-without-owner sections)
- [x] All functional requirements are testable statements with MoSCoW priority
- [x] All non-functional requirements have measurable targets (project-scaled, marked [PROPOSED])
- [x] Architecture includes ≥1 diagram (§3.1, §3.3, §3.5, dependency graph)
- [x] Every component has a single responsibility (§3.2)
- [x] Data model covers all entities in requirements (§3.3)
- [x] Security section addresses trust boundary, forgery resistance, access (§2.2, §3.7)
- [x] ≥3 risks identified with mitigations (6 — §7)
- [x] Milestones have exit criteria (§5)
- [x] Success metrics are measurable (§6)
- [x] Open questions have owners (§8)

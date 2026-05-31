//! WASI Preview 1 syscall router (FR-4).
//!
//! The kworker drains one syscall request off a process's SAB ring and calls
//! [`dispatch`]; the returned bytes are written back as the response. **All
//! guest-memory marshalling has already happened host-side** (the process
//! worker's JS shim gathered iovecs / will scatter results), so this router
//! only ever sees resolved values — `(fd, bytes, len, …)`, never a guest
//! pointer. That separation is what keeps the kernel host-testable and keeps
//! process isolation clean (the kernel cannot reach into a guest's memory).
//!
//! ## Wire format
//! Little-endian, length-prefixed. Request = `op:u8` then opcode-specific
//! fields. Response = `errno:u16` then opcode-specific fields (always written
//! in full, zero-filled on error, so the shim can decode uniformly). A `bytes`
//! field is `len:u32` followed by the raw bytes; a `string` is a UTF-8 `bytes`.

use crate::types::{DescKind, Descriptor, ProcState, ProcTable, Rights, PREOPEN_FD};
use crate::vfs::Vfs;

/// Syscall opcodes (request byte 0).
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[repr(u8)]
pub enum Op {
    FdWrite = 0x01,
    FdRead = 0x02,
    FdSeek = 0x03,
    FdClose = 0x04,
    PathOpen = 0x05,
    FdReaddir = 0x06,
    FdPrestatGet = 0x07,
    FdPrestatDirName = 0x08,
    FdFdstatGet = 0x09,
    EnvironSizesGet = 0x0A,
    EnvironGet = 0x0B,
    ArgsSizesGet = 0x0C,
    ArgsGet = 0x0D,
    RandomGet = 0x0E,
    ClockTimeGet = 0x0F,
    ProcExit = 0x10,
}

impl Op {
    fn from_u8(b: u8) -> Option<Op> {
        Some(match b {
            0x01 => Op::FdWrite,
            0x02 => Op::FdRead,
            0x03 => Op::FdSeek,
            0x04 => Op::FdClose,
            0x05 => Op::PathOpen,
            0x06 => Op::FdReaddir,
            0x07 => Op::FdPrestatGet,
            0x08 => Op::FdPrestatDirName,
            0x09 => Op::FdFdstatGet,
            0x0A => Op::EnvironSizesGet,
            0x0B => Op::EnvironGet,
            0x0C => Op::ArgsSizesGet,
            0x0D => Op::ArgsGet,
            0x0E => Op::RandomGet,
            0x0F => Op::ClockTimeGet,
            0x10 => Op::ProcExit,
            _ => return None,
        })
    }
}

/// WASI Preview 1 `errno` values (subset we use).
pub mod errno {
    pub const SUCCESS: u16 = 0;
    pub const ACCES: u16 = 2;
    pub const BADF: u16 = 8;
    pub const EXIST: u16 = 20;
    pub const INVAL: u16 = 28;
    pub const ISDIR: u16 = 31;
    pub const NOENT: u16 = 44;
    pub const NOSYS: u16 = 52;
    pub const NOTDIR: u16 = 54;
    pub const NOTCAPABLE: u16 = 76;
}

/// WASI `filetype` values.
pub mod filetype {
    pub const CHARACTER_DEVICE: u8 = 2;
    pub const DIRECTORY: u8 = 3;
    pub const REGULAR_FILE: u8 = 4;
}

/// WASI `whence` values for `fd_seek`.
mod whence {
    pub const SET: u8 = 0;
    pub const CUR: u8 = 1;
    pub const END: u8 = 2;
}

/// WASI `oflags` bits for `path_open`.
mod oflags {
    pub const CREAT: u16 = 1;
    pub const DIRECTORY: u16 = 2;
    pub const EXCL: u16 = 4;
    pub const TRUNC: u16 = 8;
}

/// Deterministic clock value for M1 (ns). A real capability-gated clock broker
/// replaces this later (§3.6); a constant keeps tests reproducible.
const M1_CLOCK_NS: u64 = 1_700_000_000_000_000_000;

// ---------------------------------------------------------------------------
// Little-endian reader / writer
// ---------------------------------------------------------------------------

struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    fn new(buf: &'a [u8]) -> Self {
        Self { buf, pos: 0 }
    }
    fn take(&mut self, n: usize) -> Option<&'a [u8]> {
        let end = self.pos.checked_add(n)?;
        let slice = self.buf.get(self.pos..end)?;
        self.pos = end;
        Some(slice)
    }
    fn u8(&mut self) -> Option<u8> {
        self.take(1).map(|s| s[0])
    }
    fn u16(&mut self) -> Option<u16> {
        self.take(2).map(|s| u16::from_le_bytes([s[0], s[1]]))
    }
    fn u32(&mut self) -> Option<u32> {
        self.take(4).map(|s| u32::from_le_bytes([s[0], s[1], s[2], s[3]]))
    }
    fn u64(&mut self) -> Option<u64> {
        self.take(8)
            .map(|s| u64::from_le_bytes([s[0], s[1], s[2], s[3], s[4], s[5], s[6], s[7]]))
    }
    fn i64(&mut self) -> Option<i64> {
        self.u64().map(|v| v as i64)
    }
    fn bytes(&mut self) -> Option<&'a [u8]> {
        let len = self.u32()? as usize;
        self.take(len)
    }
    fn string(&mut self) -> Option<String> {
        let b = self.bytes()?;
        String::from_utf8(b.to_vec()).ok()
    }
}

struct Writer {
    buf: Vec<u8>,
}

impl Writer {
    fn new() -> Self {
        Self { buf: Vec::new() }
    }
    fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }
    fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn u64(&mut self, v: u64) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    fn bytes(&mut self, b: &[u8]) -> &mut Self {
        self.u32(b.len() as u32);
        self.buf.extend_from_slice(b);
        self
    }
    fn build(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.buf)
    }
}

/// A bare `errno`-only response (used for malformed requests and ops whose
/// response is just the error code).
fn err_only(e: u16) -> Vec<u8> {
    Writer::new().u16(e).build()
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/// Resolve a guest `path_open` path against the directory fd's path. Absolute
/// paths are used as-is; relative paths join under the dir (the preopen "/").
fn resolve_path(dir: &str, path: &str) -> String {
    if path.starts_with('/') {
        path.to_string()
    } else {
        let base = dir.trim_end_matches('/');
        format!("{base}/{path}")
    }
}

/// Immediate child names directly under `dir` (one path segment), de-duplicated.
/// Synthesized from the flat-key VFS listing (provisional until M2 introduces a
/// real hierarchical directory tree + `fd_readdir`).
fn child_names(vfs: &Vfs, dir: &str) -> Vec<String> {
    let entries = vfs.list(dir).unwrap_or_default();
    let base = format!("{}/", dir.trim_end_matches('/'));
    let mut seen: Vec<String> = Vec::new();
    for full in entries {
        if let Some(rest) = full.strip_prefix(&base) {
            let name = rest.split('/').next().unwrap_or(rest);
            if !name.is_empty() && !seen.iter().any(|s| s == name) {
                seen.push(name.to_string());
            }
        }
    }
    seen
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Route one WASI Preview 1 syscall for `pid`. Returns the binary response.
pub fn dispatch(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, req: &[u8]) -> Vec<u8> {
    let mut r = Reader::new(req);
    let op = match r.u8().and_then(Op::from_u8) {
        Some(op) => op,
        None => return err_only(errno::NOSYS),
    };

    match op {
        Op::FdWrite => fd_write(vfs, procs, pid, &mut r),
        Op::FdRead => fd_read(vfs, procs, pid, &mut r),
        Op::FdSeek => fd_seek(vfs, procs, pid, &mut r),
        Op::FdClose => fd_close(procs, pid, &mut r),
        Op::PathOpen => path_open(vfs, procs, pid, &mut r),
        Op::FdReaddir => fd_readdir(vfs, procs, pid, &mut r),
        Op::FdPrestatGet => fd_prestat_get(procs, pid, &mut r),
        Op::FdPrestatDirName => fd_prestat_dir_name(procs, pid, &mut r),
        Op::FdFdstatGet => fd_fdstat_get(procs, pid, &mut r),
        Op::EnvironSizesGet | Op::ArgsSizesGet => {
            // M1 guests get empty args/env.
            Writer::new().u16(errno::SUCCESS).u32(0).u32(0).build()
        }
        Op::EnvironGet | Op::ArgsGet => {
            Writer::new().u16(errno::SUCCESS).bytes(&[]).build()
        }
        Op::RandomGet => random_get(&mut r),
        Op::ClockTimeGet => Writer::new().u16(errno::SUCCESS).u64(M1_CLOCK_NS).build(),
        Op::ProcExit => proc_exit(procs, pid, &mut r),
    }
}

fn fd_write(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(fd), Some(data)) = (r.u32(), r.bytes()) else {
        return Writer::new().u16(errno::INVAL).u32(0).build();
    };
    let resp = |e: u16, n: u32| Writer::new().u16(e).u32(n).build();

    let Some(desc) = procs.fd(pid, fd) else { return resp(errno::BADF, 0) };
    match desc.kind.clone() {
        DescKind::Stdout => {
            procs.push_stdout(pid, data);
            resp(errno::SUCCESS, data.len() as u32)
        }
        DescKind::Stderr => {
            procs.push_stderr(pid, data);
            resp(errno::SUCCESS, data.len() as u32)
        }
        DescKind::File { path } => {
            if !desc.rights.write {
                return resp(errno::ACCES, 0);
            }
            let offset = desc.offset as usize;
            let mut content = match vfs.read(&path) {
                Ok(c) => c,
                Err(crate::vfs::FsError::NotFound) => Vec::new(),
                Err(_) => return resp(errno::INVAL, 0),
            };
            if content.len() < offset {
                content.resize(offset, 0);
            }
            let end = offset + data.len();
            if content.len() < end {
                content.resize(end, 0);
            }
            content[offset..end].copy_from_slice(data);
            if vfs.write(&path, content).is_err() {
                return resp(errno::INVAL, 0);
            }
            if let Some(d) = procs.fd_mut(pid, fd) {
                d.offset = end as u64;
            }
            resp(errno::SUCCESS, data.len() as u32)
        }
        DescKind::Stdin | DescKind::Dir { .. } => resp(errno::BADF, 0),
    }
}

fn fd_read(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(fd), Some(len)) = (r.u32(), r.u32()) else {
        return Writer::new().u16(errno::INVAL).bytes(&[]).build();
    };
    let ok = |data: &[u8]| Writer::new().u16(errno::SUCCESS).bytes(data).build();
    let err = |e: u16| Writer::new().u16(e).bytes(&[]).build();

    let Some(desc) = procs.fd(pid, fd) else { return err(errno::BADF) };
    match desc.kind.clone() {
        DescKind::Stdin => ok(&[]), // EOF at M1 (no stdin source yet)
        DescKind::File { path } => {
            let content = match vfs.read(&path) {
                Ok(c) => c,
                Err(_) => return err(errno::NOENT),
            };
            let Ok(offset) = usize::try_from(desc.offset) else {
                return err(errno::INVAL);
            };
            let start = offset.min(content.len());
            let end = (start + len as usize).min(content.len());
            let slice = &content[start..end];
            if let Some(d) = procs.fd_mut(pid, fd) {
                d.offset = end as u64;
            }
            ok(slice)
        }
        DescKind::Stdout | DescKind::Stderr | DescKind::Dir { .. } => err(errno::BADF),
    }
}

fn fd_seek(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(fd), Some(offset), Some(wh)) = (r.u32(), r.i64(), r.u8()) else {
        return Writer::new().u16(errno::INVAL).u64(0).build();
    };
    let resp = |e: u16, p: u64| Writer::new().u16(e).u64(p).build();

    let Some(desc) = procs.fd(pid, fd) else { return resp(errno::BADF, 0) };
    let DescKind::File { path } = desc.kind.clone() else {
        // Non-seekable (streams/dirs).
        return resp(errno::INVAL, 0);
    };
    let cur = desc.offset as i64;
    let size = vfs.read(&path).map(|c| c.len() as i64).unwrap_or(0);
    let base = match wh {
        whence::SET => 0,
        whence::CUR => cur,
        whence::END => size,
        _ => return resp(errno::INVAL, 0),
    };
    let new = (base + offset).max(0) as u64;
    if let Some(d) = procs.fd_mut(pid, fd) {
        d.offset = new;
    }
    resp(errno::SUCCESS, new)
}

fn fd_close(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let Some(fd) = r.u32() else { return err_only(errno::INVAL) };
    if procs.close_fd(pid, fd) {
        err_only(errno::SUCCESS)
    } else {
        err_only(errno::BADF)
    }
}

fn path_open(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(dirfd), Some(path), Some(of), Some(_rights)) =
        (r.u32(), r.string(), r.u16(), r.u64())
    else {
        return Writer::new().u16(errno::INVAL).u32(0).build();
    };
    let resp = |e: u16, fd: u32| Writer::new().u16(e).u32(fd).build();

    // The dir fd must name a directory.
    let dir_path = match procs.fd(pid, dirfd).map(|d| d.kind.clone()) {
        Some(DescKind::Dir { path }) => path,
        Some(_) => return resp(errno::NOTDIR, 0),
        None => return resp(errno::BADF, 0),
    };
    let full = resolve_path(&dir_path, &path);

    let want_write = of & (oflags::CREAT | oflags::TRUNC) != 0;
    let rights = if want_write { Rights::RW } else { Rights::R };

    // Capability enforcement (FR-31, default-deny).
    if !procs.has_cap(pid, &crate::types::Capability::FsPath { subtree: full.clone(), rights }) {
        return resp(errno::NOTCAPABLE, 0);
    }

    let exists = vfs.read(&full).is_ok();
    if of & oflags::DIRECTORY != 0 {
        // Opening a directory: allow it as a Dir fd (used for readdir).
        let fd = procs
            .open_fd(pid, Descriptor { kind: DescKind::Dir { path: full }, offset: 0, rights })
            .unwrap_or(0);
        return resp(errno::SUCCESS, fd);
    }
    if exists && of & oflags::EXCL != 0 {
        return resp(errno::EXIST, 0);
    }
    if !exists {
        if of & oflags::CREAT != 0 {
            if vfs.write(&full, Vec::new()).is_err() {
                return resp(errno::INVAL, 0);
            }
        } else {
            return resp(errno::NOENT, 0);
        }
    } else if of & oflags::TRUNC != 0 && vfs.write(&full, Vec::new()).is_err() {
        return resp(errno::INVAL, 0);
    }

    let fd = procs
        .open_fd(pid, Descriptor { kind: DescKind::File { path: full }, offset: 0, rights })
        .unwrap_or(0);
    resp(errno::SUCCESS, fd)
}

fn fd_readdir(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(fd), Some(cookie), Some(buf_len)) = (r.u32(), r.u64(), r.u32()) else {
        return Writer::new().u16(errno::INVAL).bytes(&[]).build();
    };
    let err = |e: u16| Writer::new().u16(e).bytes(&[]).build();

    let dir_path = match procs.fd(pid, fd).map(|d| d.kind.clone()) {
        Some(DescKind::Dir { path }) => path,
        Some(_) => return err(errno::NOTDIR),
        None => return err(errno::BADF),
    };

    let names = child_names(vfs, &dir_path);
    // WASI dirent: d_next:u64, d_ino:u64, d_namlen:u32, d_type:u8, then name.
    let mut out: Vec<u8> = Vec::new();
    for (i, name) in names.iter().enumerate().skip(cookie as usize) {
        let mut ent = Vec::new();
        ent.extend_from_slice(&((i as u64) + 1).to_le_bytes()); // d_next
        ent.extend_from_slice(&(i as u64).to_le_bytes()); // d_ino
        ent.extend_from_slice(&(name.len() as u32).to_le_bytes()); // d_namlen
        ent.push(filetype::REGULAR_FILE); // d_type (flat keys → files)
        ent.extend_from_slice(name.as_bytes());
        if out.len() + ent.len() > buf_len as usize {
            break; // libc re-calls with an updated cookie
        }
        out.extend_from_slice(&ent);
    }
    Writer::new().u16(errno::SUCCESS).bytes(&out).build()
}

fn fd_prestat_get(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let Some(fd) = r.u32() else { return Writer::new().u16(errno::INVAL).u32(0).build() };
    // Only fd 3 (the preopen root) reports a prestat; fd >= 4 returns BADF so the
    // guest libc terminates its preopen scan.
    match procs.fd(pid, fd).map(|d| d.kind.clone()) {
        Some(DescKind::Dir { path }) if fd == PREOPEN_FD => {
            Writer::new().u16(errno::SUCCESS).u32(path.len() as u32).build()
        }
        _ => Writer::new().u16(errno::BADF).u32(0).build(),
    }
}

fn fd_prestat_dir_name(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(fd), Some(len)) = (r.u32(), r.u32()) else {
        return Writer::new().u16(errno::INVAL).bytes(&[]).build();
    };
    match procs.fd(pid, fd).map(|d| d.kind.clone()) {
        Some(DescKind::Dir { path }) if fd == PREOPEN_FD => {
            let name = path.as_bytes();
            let n = (len as usize).min(name.len());
            Writer::new().u16(errno::SUCCESS).bytes(&name[..n]).build()
        }
        _ => Writer::new().u16(errno::BADF).bytes(&[]).build(),
    }
}

fn fd_fdstat_get(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let Some(fd) = r.u32() else {
        return Writer::new().u16(errno::INVAL).u8(0).u16(0).u64(0).u64(0).build();
    };
    let Some(desc) = procs.fd(pid, fd) else {
        return Writer::new().u16(errno::BADF).u8(0).u16(0).u64(0).u64(0).build();
    };
    let ft = match desc.kind {
        DescKind::Stdin | DescKind::Stdout | DescKind::Stderr => filetype::CHARACTER_DEVICE,
        DescKind::Dir { .. } => filetype::DIRECTORY,
        DescKind::File { .. } => filetype::REGULAR_FILE,
    };
    // Grant the full rights set at M1 (capabilities are enforced at path_open).
    Writer::new()
        .u16(errno::SUCCESS)
        .u8(ft)
        .u16(0)
        .u64(u64::MAX)
        .u64(u64::MAX)
        .build()
}

fn random_get(r: &mut Reader) -> Vec<u8> {
    let Some(len) = r.u32() else {
        return Writer::new().u16(errno::INVAL).bytes(&[]).build();
    };
    // Deterministic fill for M1 (a real capability-gated entropy broker replaces
    // this later, §3.6). A small LCG keeps output reproducible across runs.
    let mut state: u32 = 0x9E37_79B9 ^ len;
    let mut bytes = Vec::with_capacity(len as usize);
    for _ in 0..len {
        state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        bytes.push((state >> 24) as u8);
    }
    Writer::new().u16(errno::SUCCESS).bytes(&bytes).build()
}

fn proc_exit(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let code = r.u32().unwrap_or(0) as i32;
    procs.set_exit(pid, code);
    procs.set_state(pid, ProcState::Zombie);
    err_only(errno::SUCCESS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Backend, Capability, CapabilitySet};
    use crate::vfs::Blockstore;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct MemStore(BTreeMap<String, Vec<u8>>);
    impl Blockstore for MemStore {
        fn get(&self, k: &str) -> Option<Vec<u8>> {
            self.0.get(k).cloned()
        }
        fn put(&mut self, k: &str, v: Vec<u8>) -> bool {
            self.0.insert(k.into(), v);
            true
        }
        fn list(&self, p: &str) -> Vec<String> {
            self.0.keys().filter(|k| k.starts_with(p)).cloned().collect()
        }
        fn delete(&mut self, k: &str) -> bool {
            self.0.remove(k).is_some()
        }
    }

    /// (vfs with /mnt mounted on idb, proc table, pid with full FS rights).
    fn setup() -> (Vfs, ProcTable, u32) {
        let mut vfs = Vfs::new(Box::new(MemStore::default()), Box::new(MemStore::default()));
        vfs.mount("/mnt", Backend::Idb).unwrap();
        let mut procs = ProcTable::new();
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
        let pid = procs.spawn("t", 5, caps);
        procs.set_state(pid, ProcState::Running);
        (vfs, procs, pid)
    }

    // --- request encoders (mirror the host JS shim) ---
    fn req_fd_write(fd: u32, data: &[u8]) -> Vec<u8> {
        Writer::new().u8(Op::FdWrite as u8).u32(fd).bytes(data).build()
    }
    fn req_fd_read(fd: u32, len: u32) -> Vec<u8> {
        Writer::new().u8(Op::FdRead as u8).u32(fd).u32(len).build()
    }
    fn req_fd_seek(fd: u32, off: i64, wh: u8) -> Vec<u8> {
        Writer::new().u8(Op::FdSeek as u8).u32(fd).u64(off as u64).u8(wh).build()
    }
    fn req_fd_close(fd: u32) -> Vec<u8> {
        Writer::new().u8(Op::FdClose as u8).u32(fd).build()
    }
    fn req_path_open(dirfd: u32, path: &str, of: u16) -> Vec<u8> {
        Writer::new()
            .u8(Op::PathOpen as u8)
            .u32(dirfd)
            .bytes(path.as_bytes())
            .u16(of)
            .u64(0)
            .build()
    }
    fn req_simple(op: Op) -> Vec<u8> {
        Writer::new().u8(op as u8).build()
    }

    fn read_u16(b: &[u8]) -> u16 {
        u16::from_le_bytes([b[0], b[1]])
    }
    fn read_u32_at(b: &[u8], at: usize) -> u32 {
        u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
    }
    /// Decode a `errno:u16` + `bytes` response into the bytes payload.
    fn resp_bytes(b: &[u8]) -> Vec<u8> {
        let len = read_u32_at(b, 2) as usize;
        b[6..6 + len].to_vec()
    }

    #[test]
    fn fd_write_to_stdout_and_stderr_is_captured() {
        let (mut vfs, mut procs, pid) = setup();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_fd_write(1, b"hello "));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(read_u32_at(&resp, 2), 6); // nwritten
        dispatch(&mut vfs, &mut procs, pid, &req_fd_write(1, b"world"));
        dispatch(&mut vfs, &mut procs, pid, &req_fd_write(2, b"warn"));
        let (out, err) = procs.take_capture(pid);
        assert_eq!(out, b"hello world");
        assert_eq!(err, b"warn");
    }

    #[test]
    fn proc_exit_records_code_and_zombifies() {
        let (mut vfs, mut procs, pid) = setup();
        let req = Writer::new().u8(Op::ProcExit as u8).u32(0).build();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(procs.exit_code(pid), Some(0));
        assert_eq!(procs.get(pid).unwrap().state, ProcState::Zombie);
    }

    #[test]
    fn path_open_then_fd_read_returns_vfs_bytes() {
        let (mut vfs, mut procs, pid) = setup();
        vfs.write("/mnt/in.txt", b"payload".to_vec()).unwrap();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_path_open(PREOPEN_FD, "/mnt/in.txt", 0));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let fd = read_u32_at(&resp, 2);
        assert!(fd >= 4);
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_fd_read(fd, 1024));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(resp_bytes(&resp), b"payload");
    }

    #[test]
    fn fd_seek_moves_cursor_and_partial_reads_work() {
        let (mut vfs, mut procs, pid) = setup();
        vfs.write("/mnt/f", b"abcdef".to_vec()).unwrap();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_path_open(PREOPEN_FD, "/mnt/f", 0));
        let fd = read_u32_at(&resp, 2);
        // seek to 2 (SET)
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_fd_seek(fd, 2, whence::SET));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        // read 3 → "cde"
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_fd_read(fd, 3));
        assert_eq!(resp_bytes(&resp), b"cde");
        // cursor now at 5; read 10 → "f"
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_fd_read(fd, 10));
        assert_eq!(resp_bytes(&resp), b"f");
    }

    #[test]
    fn fd_close_then_use_is_badf() {
        let (mut vfs, mut procs, pid) = setup();
        vfs.write("/mnt/f", b"x".to_vec()).unwrap();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_path_open(PREOPEN_FD, "/mnt/f", 0));
        let fd = read_u32_at(&resp, 2);
        assert_eq!(read_u16(&dispatch(&mut vfs, &mut procs, pid, &req_fd_close(fd))), errno::SUCCESS);
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_fd_read(fd, 1));
        assert_eq!(read_u16(&resp), errno::BADF);
    }

    #[test]
    fn path_open_outside_capability_subtree_is_denied() {
        // pid granted only /home; opening /mnt must be denied (default-deny).
        let mut vfs = Vfs::new(Box::new(MemStore::default()), Box::new(MemStore::default()));
        vfs.mount("/mnt", Backend::Idb).unwrap();
        vfs.write("/mnt/secret", b"s".to_vec()).unwrap();
        let mut procs = ProcTable::new();
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/home".into(), rights: Rights::RW });
        let pid = procs.spawn("t", 5, caps);
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_path_open(PREOPEN_FD, "/mnt/secret", 0));
        assert_eq!(read_u16(&resp), errno::NOTCAPABLE);
        assert_eq!(read_u32_at(&resp, 2), 0); // no fd handed out
    }

    #[test]
    fn args_and_environ_sizes_then_get_roundtrip() {
        let (mut vfs, mut procs, pid) = setup();
        for op in [Op::ArgsSizesGet, Op::EnvironSizesGet] {
            let resp = dispatch(&mut vfs, &mut procs, pid, &req_simple(op));
            assert_eq!(read_u16(&resp), errno::SUCCESS);
            assert_eq!(read_u32_at(&resp, 2), 0); // count
            assert_eq!(read_u32_at(&resp, 6), 0); // buf_size
        }
        for op in [Op::ArgsGet, Op::EnvironGet] {
            let resp = dispatch(&mut vfs, &mut procs, pid, &req_simple(op));
            assert_eq!(read_u16(&resp), errno::SUCCESS);
            assert!(resp_bytes(&resp).is_empty());
        }
    }

    #[test]
    fn fd_prestat_scan_terminates_at_fd4() {
        let (mut vfs, mut procs, pid) = setup();
        // fd 3 (preopen "/") → SUCCESS with name_len 1.
        let req3 = Writer::new().u8(Op::FdPrestatGet as u8).u32(3).build();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req3);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(read_u32_at(&resp, 2), 1); // "/".len()
        // fd 4 → BADF (ends the libc scan).
        let req4 = Writer::new().u8(Op::FdPrestatGet as u8).u32(4).build();
        assert_eq!(read_u16(&dispatch(&mut vfs, &mut procs, pid, &req4)), errno::BADF);
        // dir name of fd 3 is "/".
        let reqn = Writer::new().u8(Op::FdPrestatDirName as u8).u32(3).u32(16).build();
        let resp = dispatch(&mut vfs, &mut procs, pid, &reqn);
        assert_eq!(resp_bytes(&resp), b"/");
    }

    #[test]
    fn random_get_fills_len_bytes() {
        let (mut vfs, mut procs, pid) = setup();
        let req = Writer::new().u8(Op::RandomGet as u8).u32(16).build();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(resp_bytes(&resp).len(), 16);
    }

    #[test]
    fn clock_time_get_is_nonzero_deterministic() {
        let (mut vfs, mut procs, pid) = setup();
        let req = Writer::new().u8(Op::ClockTimeGet as u8).u32(0).u64(0).build();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let t = u64::from_le_bytes([resp[2], resp[3], resp[4], resp[5], resp[6], resp[7], resp[8], resp[9]]);
        assert_eq!(t, M1_CLOCK_NS);
        assert!(t > 0);
    }

    #[test]
    fn fd_readdir_synthesizes_entries_from_flat_list() {
        let (mut vfs, mut procs, pid) = setup();
        vfs.write("/mnt/a.txt", b"1".to_vec()).unwrap();
        vfs.write("/mnt/b.txt", b"2".to_vec()).unwrap();
        // Open /mnt as a directory.
        let resp = dispatch(&mut vfs, &mut procs, pid, &req_path_open(PREOPEN_FD, "/mnt", oflags::DIRECTORY));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let dirfd = read_u32_at(&resp, 2);
        let req = Writer::new().u8(Op::FdReaddir as u8).u32(dirfd).u64(0).u32(4096).build();
        let resp = dispatch(&mut vfs, &mut procs, pid, &req);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let entries = resp_bytes(&resp);
        // Two dirents present; their names appear in the buffer.
        assert!(!entries.is_empty());
        let s = String::from_utf8_lossy(&entries);
        assert!(s.contains("a.txt"));
        assert!(s.contains("b.txt"));
    }

    #[test]
    fn unknown_opcode_is_nosys() {
        let (mut vfs, mut procs, pid) = setup();
        let resp = dispatch(&mut vfs, &mut procs, pid, &[0xFF]);
        assert_eq!(read_u16(&resp), errno::NOSYS);
    }
}

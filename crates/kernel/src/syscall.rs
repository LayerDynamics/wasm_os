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

use crate::pipe::PipeTable;
use crate::types::{
    Capability, CapabilitySet, DescKind, Descriptor, ProcState, ProcTable, Rights, WaitReason,
    PREOPEN_FD,
};
use crate::vfs::Vfs;

/// Scheduling priority for processes spawned by a guest shell (M2).
const SPAWN_PRIORITY: u8 = 5;

/// Outcome of routing one syscall (M2 park/resume). Most syscalls complete
/// immediately (`reply = Some`); a blocking read with no data yet **parks**
/// (`reply = None`) and is re-driven later when an event wakes it.
pub struct SyscallOutcome {
    /// `None` => parked (no response yet); `Some` => reply bytes for the ring.
    pub reply: Option<Vec<u8>>,
    /// pids whose parked syscalls are now runnable (the kworker re-drives them).
    pub wakeups: Vec<u32>,
    /// bytes a terminal-bound fd produced during this syscall (M2-T4 streams it).
    pub term_output: Vec<u8>,
    /// A child the kernel allocated this syscall (KSPAWN) that the kworker must
    /// now bring to life — load the image from the VFS and create its worker+ring.
    pub spawn: Option<SpawnRequest>,
    /// pids the kworker must force-terminate (SIGKILL, M4-T5): the kernel has
    /// already zombified them; the host tears down their worker + ring.
    pub reap: Vec<u32>,
    /// A brokered network request (M5-T6, OQ-2): the caller parked on `net_request`
    /// and the kworker must perform the fetch, then `deliver_net` the response.
    pub net: Option<NetRequest>,
}

/// A capability-gated network request the kworker must broker (M5-T6, FR-NG-1):
/// the kernel checked the `Net` capability; the host performs the actual fetch.
#[derive(Clone, Debug)]
pub struct NetRequest {
    pub pid: u32,
    pub url: String,
}

/// A child process the kernel registered, awaiting the kworker to instantiate it.
#[derive(Clone, Debug)]
pub struct SpawnRequest {
    pub pid: u32,
    pub image_path: String,
}

impl SyscallOutcome {
    /// A completed syscall with its reply bytes.
    pub fn ready(bytes: Vec<u8>) -> Self {
        Self { reply: Some(bytes), wakeups: Vec::new(), term_output: Vec::new(), spawn: None, reap: Vec::new(), net: None }
    }
    /// A parked syscall (no reply yet).
    pub fn parked() -> Self {
        Self { reply: None, wakeups: Vec::new(), term_output: Vec::new(), spawn: None, reap: Vec::new(), net: None }
    }
}

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
    // FS mutation (M2 — mkdir/rm/mv coreutils).
    PathCreateDirectory = 0x11,
    PathUnlinkFile = 0x12,
    PathRemoveDirectory = 0x13,
    PathRename = 0x14,
    PathFilestatGet = 0x15,
    // wasmos_kernel extension (guest process control, M2).
    KSpawn = 0x20,
    KPipe = 0x21,
    KWait = 0x22,
    // wasmos_kernel compositor extension (M3). win_surface allocates a surface
    // id under the Gpu capability; win_present is handled host-side in the
    // process worker (pixels never enter the ring), so it is NOT an opcode here.
    WinSurface = 0x23,
    // win_read_input drains brokered keyboard/mouse events (Input capability),
    // parking until the compositor delivers some (M3-T3).
    WinReadInput = 0x25,
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
            0x11 => Op::PathCreateDirectory,
            0x12 => Op::PathUnlinkFile,
            0x13 => Op::PathRemoveDirectory,
            0x14 => Op::PathRename,
            0x15 => Op::PathFilestatGet,
            0x20 => Op::KSpawn,
            0x21 => Op::KPipe,
            0x22 => Op::KWait,
            0x23 => Op::WinSurface,
            0x25 => Op::WinReadInput,
            _ => return None,
        })
    }
}

/// WASI Preview 1 `errno` values (subset we use).
pub mod errno {
    pub const SUCCESS: u16 = 0;
    pub const ACCES: u16 = 2;
    pub const BADF: u16 = 8;
    pub const IO: u16 = 29; // I/O error (M5-T6 net_request fetch failure)
    pub const EXIST: u16 = 20;
    pub const INVAL: u16 = 28;
    pub const ISDIR: u16 = 31;
    pub const NOENT: u16 = 44;
    pub const NOSYS: u16 = 52;
    pub const NOTDIR: u16 = 54;
    pub const NOTEMPTY: u16 = 55;
    pub const PIPE: u16 = 64;
    pub const SRCH: u16 = 71; // no such process (M4-T5 signals)
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

/// Resolve a guest `path_open` path against the directory fd's path and
/// normalize `.`/`..`. Absolute paths ignore the dir; relative paths join under
/// it (the dir is the process's preopen / cwd).
fn resolve_path(dir: &str, path: &str) -> String {
    let combined = if path.starts_with('/') {
        path.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), path)
    };
    normalize(&combined)
}

/// Collapse `.`/`..` and redundant slashes into a clean absolute path.
fn normalize(p: &str) -> String {
    let mut parts: Vec<&str> = Vec::new();
    for seg in p.split('/').filter(|s| !s.is_empty()) {
        match seg {
            "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/// Route one syscall for `pid`. Returns a [`SyscallOutcome`] — usually a ready
/// reply, but a blocking read with no data parks (the kworker defers the ring).
pub fn dispatch(
    vfs: &mut Vfs,
    procs: &mut ProcTable,
    pipes: &mut PipeTable,
    pid: u32,
    req: &[u8],
) -> SyscallOutcome {
    let mut r = Reader::new(req);
    let op = match r.u8().and_then(Op::from_u8) {
        Some(op) => op,
        None => return SyscallOutcome::ready(err_only(errno::NOSYS)),
    };

    match op {
        // fd_read/fd_write/fd_close can park or wake (stdin/pipes) — they return
        // the outcome directly.
        Op::FdRead => fd_read(vfs, procs, pipes, pid, &mut r),
        Op::FdWrite => fd_write(vfs, procs, pipes, pid, &mut r),
        Op::FdClose => fd_close(procs, pipes, pid, &mut r),
        // Every other syscall completes immediately; wrap its reply bytes.
        Op::FdSeek => SyscallOutcome::ready(fd_seek(vfs, procs, pid, &mut r)),
        Op::PathOpen => SyscallOutcome::ready(path_open(vfs, procs, pid, &mut r)),
        Op::FdReaddir => SyscallOutcome::ready(fd_readdir(vfs, procs, pid, &mut r)),
        Op::FdPrestatGet => SyscallOutcome::ready(fd_prestat_get(procs, pid, &mut r)),
        Op::FdPrestatDirName => SyscallOutcome::ready(fd_prestat_dir_name(procs, pid, &mut r)),
        Op::FdFdstatGet => SyscallOutcome::ready(fd_fdstat_get(procs, pid, &mut r)),
        Op::EnvironSizesGet => {
            // M2 guests get an empty environment.
            SyscallOutcome::ready(Writer::new().u16(errno::SUCCESS).u32(0).u32(0).build())
        }
        Op::EnvironGet => SyscallOutcome::ready(Writer::new().u16(errno::SUCCESS).bytes(&[]).build()),
        Op::ArgsSizesGet => {
            // count + total NUL-terminated byte size of argv.
            let argv = procs.argv(pid);
            let count = argv.len() as u32;
            let buf_size: u32 = argv.iter().map(|a| a.len() as u32 + 1).sum();
            SyscallOutcome::ready(Writer::new().u16(errno::SUCCESS).u32(count).u32(buf_size).build())
        }
        Op::ArgsGet => {
            // argv as a NUL-terminated, NUL-joined blob; the shim lays out the
            // pointer array into guest memory.
            let mut blob = Vec::new();
            for a in procs.argv(pid) {
                blob.extend_from_slice(a.as_bytes());
                blob.push(0);
            }
            SyscallOutcome::ready(Writer::new().u16(errno::SUCCESS).bytes(&blob).build())
        }
        Op::RandomGet => SyscallOutcome::ready(random_get(&mut r)),
        Op::ClockTimeGet => {
            SyscallOutcome::ready(Writer::new().u16(errno::SUCCESS).u64(M1_CLOCK_NS).build())
        }
        Op::ProcExit => proc_exit(procs, pipes, pid, &mut r),
        // FS mutation (M2).
        Op::PathCreateDirectory => SyscallOutcome::ready(path_create_directory(vfs, procs, pid, &mut r)),
        Op::PathUnlinkFile => SyscallOutcome::ready(path_unlink_file(vfs, procs, pid, &mut r)),
        Op::PathRemoveDirectory => SyscallOutcome::ready(path_remove_directory(vfs, procs, pid, &mut r)),
        Op::PathRename => SyscallOutcome::ready(path_rename(vfs, procs, pid, &mut r)),
        Op::PathFilestatGet => SyscallOutcome::ready(path_filestat_get(vfs, procs, pid, &mut r)),
        // wasmos_kernel extension (guest process control).
        Op::KSpawn => k_spawn(vfs, procs, pipes, pid, &mut r),
        Op::KPipe => k_pipe(procs, pipes, pid, &mut r),
        Op::KWait => k_wait(procs, pid, &mut r),
        // wasmos_kernel compositor extension (M3).
        Op::WinSurface => win_surface(procs, pid, &mut r),
        Op::WinReadInput => win_read_input(procs, pid, &mut r),
    }
}

fn fd_write(
    vfs: &mut Vfs,
    procs: &mut ProcTable,
    pipes: &mut PipeTable,
    pid: u32,
    r: &mut Reader,
) -> SyscallOutcome {
    let (Some(fd), Some(data)) = (r.u32(), r.bytes()) else {
        return SyscallOutcome::ready(Writer::new().u16(errno::INVAL).u32(0).build());
    };
    let resp = |e: u16, n: u32| Writer::new().u16(e).u32(n).build();

    let Some(desc) = procs.fd(pid, fd) else {
        return SyscallOutcome::ready(resp(errno::BADF, 0));
    };
    match desc.kind.clone() {
        DescKind::Stdout => {
            procs.push_stdout(pid, data);
            SyscallOutcome::ready(resp(errno::SUCCESS, data.len() as u32))
        }
        DescKind::Stderr => {
            procs.push_stderr(pid, data);
            SyscallOutcome::ready(resp(errno::SUCCESS, data.len() as u32))
        }
        DescKind::Terminal => {
            // Stream the bytes to the interactive terminal (xterm) live.
            SyscallOutcome {
                reply: Some(resp(errno::SUCCESS, data.len() as u32)),
                wakeups: Vec::new(),
                term_output: data.to_vec(),
                spawn: None,
                reap: Vec::new(),
                net: None,
            }
        }
        DescKind::PipeWrite { id } => {
            if !pipes.read_open(id) {
                // No readers left — writing would be lost (SIGPIPE/EPIPE).
                return SyscallOutcome::ready(resp(errno::PIPE, 0));
            }
            if pipes.space(id) == 0 {
                // Full pipe — park the writer until a reader drains it.
                procs.set_blocked(pid, WaitReason::PipeWrite(id));
                return SyscallOutcome::parked();
            }
            let n = pipes.write(id, data);
            // Wake any readers parked on this pipe.
            let wakeups = procs.take_blocked_on(&WaitReason::PipeRead(id));
            SyscallOutcome { reply: Some(resp(errno::SUCCESS, n as u32)), wakeups, term_output: Vec::new(), spawn: None, reap: Vec::new(), net: None }
        }
        DescKind::File { path } => {
            if !desc.rights.write {
                return SyscallOutcome::ready(resp(errno::ACCES, 0));
            }
            let offset = desc.offset as usize;
            let mut content = match vfs.read(&path) {
                Ok(c) => c,
                Err(crate::vfs::FsError::NotFound) => Vec::new(),
                Err(_) => return SyscallOutcome::ready(resp(errno::INVAL, 0)),
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
                return SyscallOutcome::ready(resp(errno::INVAL, 0));
            }
            if let Some(d) = procs.fd_mut(pid, fd) {
                d.offset = end as u64;
            }
            SyscallOutcome::ready(resp(errno::SUCCESS, data.len() as u32))
        }
        DescKind::Stdin | DescKind::Dir { .. } | DescKind::PipeRead { .. } => {
            SyscallOutcome::ready(resp(errno::BADF, 0))
        }
    }
}

fn fd_read(
    vfs: &mut Vfs,
    procs: &mut ProcTable,
    pipes: &mut PipeTable,
    pid: u32,
    r: &mut Reader,
) -> SyscallOutcome {
    let (Some(fd), Some(len)) = (r.u32(), r.u32()) else {
        return SyscallOutcome::ready(Writer::new().u16(errno::INVAL).bytes(&[]).build());
    };
    let ok = |data: &[u8]| Writer::new().u16(errno::SUCCESS).bytes(data).build();
    let err = |e: u16| Writer::new().u16(e).bytes(&[]).build();

    let Some(desc) = procs.fd(pid, fd) else {
        return SyscallOutcome::ready(err(errno::BADF));
    };
    match desc.kind.clone() {
        DescKind::PipeRead { id } => {
            if pipes.buf_len(id) > 0 {
                let data = pipes.read(id, len as usize);
                // Draining the pipe may unblock writers parked on a full buffer.
                let wakeups = procs.take_blocked_on(&WaitReason::PipeWrite(id));
                SyscallOutcome { reply: Some(ok(&data)), wakeups, term_output: Vec::new(), spawn: None, reap: Vec::new(), net: None }
            } else if pipes.write_open(id) {
                // Empty but writers remain — park until a write arrives.
                procs.set_blocked(pid, WaitReason::PipeRead(id));
                SyscallOutcome::parked()
            } else {
                SyscallOutcome::ready(ok(&[])) // all writers closed → EOF
            }
        }
        DescKind::Stdin => {
            if procs.stdin_len(pid) > 0 {
                // Data buffered — return up to `len` bytes immediately.
                let data = procs.read_stdin(pid, len as usize);
                SyscallOutcome::ready(ok(&data))
            } else if procs.stdin_is_eof(pid) {
                SyscallOutcome::ready(ok(&[])) // closed → EOF
            } else {
                // No data and open — PARK; a later `deliver_stdin` re-drives this.
                procs.set_blocked(pid, WaitReason::Stdin);
                SyscallOutcome::parked()
            }
        }
        DescKind::File { path } => {
            let content = match vfs.read(&path) {
                Ok(c) => c,
                Err(_) => return SyscallOutcome::ready(err(errno::NOENT)),
            };
            let Ok(offset) = usize::try_from(desc.offset) else {
                return SyscallOutcome::ready(err(errno::INVAL));
            };
            let start = offset.min(content.len());
            let end = (start + len as usize).min(content.len());
            let slice = &content[start..end];
            if let Some(d) = procs.fd_mut(pid, fd) {
                d.offset = end as u64;
            }
            SyscallOutcome::ready(ok(slice))
        }
        DescKind::Stdout
        | DescKind::Stderr
        | DescKind::Terminal
        | DescKind::Dir { .. }
        | DescKind::PipeWrite { .. } => SyscallOutcome::ready(err(errno::BADF)),
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

fn fd_close(
    procs: &mut ProcTable,
    pipes: &mut PipeTable,
    pid: u32,
    r: &mut Reader,
) -> SyscallOutcome {
    let Some(fd) = r.u32() else {
        return SyscallOutcome::ready(err_only(errno::INVAL));
    };
    // Closing a pipe end updates ref counts and may wake the peer end: closing
    // the last writer gives parked readers EOF; closing the last reader gives
    // parked writers EPIPE (re-driven and resolved by the wakeup).
    let kind = procs.fd(pid, fd).map(|d| d.kind.clone());
    let mut wakeups = Vec::new();
    match kind {
        Some(DescKind::PipeWrite { id }) => {
            pipes.close_writer(id);
            wakeups = procs.take_blocked_on(&WaitReason::PipeRead(id));
        }
        Some(DescKind::PipeRead { id }) => {
            pipes.close_reader(id);
            wakeups = procs.take_blocked_on(&WaitReason::PipeWrite(id));
        }
        _ => {}
    }
    let reply = if procs.close_fd(pid, fd) {
        err_only(errno::SUCCESS)
    } else {
        err_only(errno::BADF)
    };
    SyscallOutcome { reply: Some(reply), wakeups, term_output: Vec::new(), spawn: None, reap: Vec::new(), net: None }
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

    // Real immediate children from the hierarchical VFS (M2).
    let entries = match vfs.readdir(&dir_path) {
        Ok(e) => e,
        Err(_) => return err(errno::NOTDIR),
    };
    // WASI `dirent` is a **24-byte** struct (8-byte aligned): d_next:u64,
    // d_ino:u64, d_namlen:u32, d_type:u8, then 3 padding bytes, then the name.
    // (The padding is essential — libc reads sizeof(dirent)=24 per header.)
    let mut out: Vec<u8> = Vec::new();
    let skip_count = usize::try_from(cookie).unwrap_or(usize::MAX);
    for (i, entry) in entries.iter().enumerate().skip(skip_count) {
        let d_type = if entry.is_dir { filetype::DIRECTORY } else { filetype::REGULAR_FILE };
        let mut ent = Vec::new();
        ent.extend_from_slice(&((i as u64) + 1).to_le_bytes()); // d_next
        ent.extend_from_slice(&(i as u64).to_le_bytes()); // d_ino
        ent.extend_from_slice(&(entry.name.len() as u32).to_le_bytes()); // d_namlen
        ent.push(d_type); // d_type
        ent.extend_from_slice(&[0u8; 3]); // padding to 24 bytes
        ent.extend_from_slice(entry.name.as_bytes());
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
        DescKind::Stdin
        | DescKind::Stdout
        | DescKind::Stderr
        | DescKind::Terminal
        | DescKind::PipeRead { .. }
        | DescKind::PipeWrite { .. } => filetype::CHARACTER_DEVICE,
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

fn proc_exit(procs: &mut ProcTable, pipes: &mut PipeTable, pid: u32, r: &mut Reader) -> SyscallOutcome {
    let code = r.u32().unwrap_or(0) as i32;
    procs.set_exit(pid, code);
    procs.set_state(pid, ProcState::Zombie);

    // Release the kernel-side ownership of any compositor surfaces (M3). The host
    // tears down their windows when the worker dies (M3-T9); here we just keep the
    // surface-id authority's map clean so ids don't leak.
    procs.free_surfaces_of(pid);

    // Release every pipe end the dying process still holds, exactly as fd_close
    // would. This is what lets a pipeline terminate (and contains a crash inside
    // one, FR-34): closing the last writer gives a parked reader EOF; closing the
    // last reader gives a parked writer EPIPE. Without this, a peer blocked on the
    // pipe of an exiting/trapped stage would park forever and wedge the shell.
    let mut wakeups = Vec::new();
    let pipe_ends: Vec<DescKind> = procs
        .get(pid)
        .map(|p| {
            p.fds
                .values()
                .filter(|d| matches!(d.kind, DescKind::PipeRead { .. } | DescKind::PipeWrite { .. }))
                .map(|d| d.kind.clone())
                .collect()
        })
        .unwrap_or_default();
    for kind in pipe_ends {
        match kind {
            DescKind::PipeWrite { id } => {
                pipes.close_writer(id);
                wakeups.extend(procs.take_blocked_on(&WaitReason::PipeRead(id)));
            }
            DescKind::PipeRead { id } => {
                pipes.close_reader(id);
                wakeups.extend(procs.take_blocked_on(&WaitReason::PipeWrite(id)));
            }
            _ => {}
        }
    }

    // Wake any parent parked in wait() on this child.
    wakeups.extend(procs.take_blocked_on(&WaitReason::Wait(pid)));
    SyscallOutcome { reply: Some(err_only(errno::SUCCESS)), wakeups, term_output: Vec::new(), spawn: None, reap: Vec::new(), net: None }
}

// ---------------------------------------------------------------------------
// FS mutation (M2 — mkdir/rm/mv coreutils)
// ---------------------------------------------------------------------------

/// Resolve a `(dirfd, path)` pair to an absolute path and enforce the process's
/// FS capability (FR-31). Returns the errno on failure.
fn resolve_for(
    procs: &ProcTable,
    pid: u32,
    dirfd: u32,
    path: &str,
    rights: Rights,
) -> Result<String, u16> {
    let dir = match procs.fd(pid, dirfd).map(|d| d.kind.clone()) {
        Some(DescKind::Dir { path }) => path,
        Some(_) => return Err(errno::NOTDIR),
        None => return Err(errno::BADF),
    };
    let full = resolve_path(&dir, path);
    if !procs.has_cap(pid, &Capability::FsPath { subtree: full.clone(), rights }) {
        return Err(errno::NOTCAPABLE);
    }
    Ok(full)
}

fn path_create_directory(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(dirfd), Some(path)) = (r.u32(), r.string()) else { return err_only(errno::INVAL) };
    let full = match resolve_for(procs, pid, dirfd, &path, Rights::RW) {
        Ok(f) => f,
        Err(e) => return err_only(e),
    };
    match vfs.mkdir(&full) {
        Ok(()) => err_only(errno::SUCCESS),
        Err(crate::vfs::FsError::Exists) => err_only(errno::EXIST),
        Err(_) => err_only(errno::NOENT),
    }
}

fn path_unlink_file(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(dirfd), Some(path)) = (r.u32(), r.string()) else { return err_only(errno::INVAL) };
    let full = match resolve_for(procs, pid, dirfd, &path, Rights::RW) {
        Ok(f) => f,
        Err(e) => return err_only(e),
    };
    match vfs.delete(&full) {
        Ok(()) => err_only(errno::SUCCESS),
        Err(crate::vfs::FsError::IsDir) => err_only(errno::ISDIR),
        Err(_) => err_only(errno::NOENT),
    }
}

fn path_remove_directory(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(dirfd), Some(path)) = (r.u32(), r.string()) else { return err_only(errno::INVAL) };
    let full = match resolve_for(procs, pid, dirfd, &path, Rights::RW) {
        Ok(f) => f,
        Err(e) => return err_only(e),
    };
    match vfs.rmdir(&full) {
        Ok(()) => err_only(errno::SUCCESS),
        Err(crate::vfs::FsError::NotEmpty) => err_only(errno::NOTEMPTY),
        Err(_) => err_only(errno::NOENT),
    }
}

/// `path_filestat_get` — stat a path (used by `read_dir` to type each entry).
/// Returns `errno, filetype:u8, size:u64`.
fn path_filestat_get(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let out = |e: u16, ft: u8, size: u64| Writer::new().u16(e).u8(ft).u64(size).build();
    let (Some(dirfd), Some(path)) = (r.u32(), r.string()) else { return out(errno::INVAL, 0, 0) };
    let full = match resolve_for(procs, pid, dirfd, &path, Rights::R) {
        Ok(f) => f,
        Err(e) => return out(e, 0, 0),
    };
    if vfs.is_dir(&full) {
        out(errno::SUCCESS, filetype::DIRECTORY, 0)
    } else if let Ok(content) = vfs.read(&full) {
        out(errno::SUCCESS, filetype::REGULAR_FILE, content.len() as u64)
    } else {
        out(errno::NOENT, 0, 0)
    }
}

fn path_rename(vfs: &mut Vfs, procs: &mut ProcTable, pid: u32, r: &mut Reader) -> Vec<u8> {
    let (Some(old_dirfd), Some(old_path), Some(new_dirfd), Some(new_path)) =
        (r.u32(), r.string(), r.u32(), r.string())
    else {
        return err_only(errno::INVAL);
    };
    let from = match resolve_for(procs, pid, old_dirfd, &old_path, Rights::RW) {
        Ok(f) => f,
        Err(e) => return err_only(e),
    };
    let to = match resolve_for(procs, pid, new_dirfd, &new_path, Rights::RW) {
        Ok(f) => f,
        Err(e) => return err_only(e),
    };
    match vfs.rename(&from, &to) {
        Ok(()) => err_only(errno::SUCCESS),
        Err(crate::vfs::FsError::Exists) => err_only(errno::EXIST),
        Err(_) => err_only(errno::NOENT),
    }
}

// ---------------------------------------------------------------------------
// wasmos_kernel extension — guest process control (M2)
// ---------------------------------------------------------------------------

/// One of a child's stdio fds, as the shell requests it. File `mode`: 0 = read
/// (`<`), 1 = write/truncate (`>`), 2 = write/append (`>>`).
fn parse_fd_spec(r: &mut Reader) -> Option<FdSpec> {
    Some(match r.u8()? {
        0 => FdSpec::Terminal,
        1 => FdSpec::PipeRead(r.u32()?),
        2 => FdSpec::PipeWrite(r.u32()?),
        3 => {
            let path = r.string()?;
            let mode = r.u8()?;
            FdSpec::File { path, mode }
        }
        _ => return None,
    })
}

enum FdSpec {
    Terminal,
    PipeRead(u32),
    PipeWrite(u32),
    File { path: String, mode: u8 },
}

/// `wasmos_kernel.spawn(path, argv, stdio)` — register a child process and ask
/// the kworker (via `outcome.spawn`) to instantiate it from the VFS image.
fn k_spawn(
    vfs: &mut Vfs,
    procs: &mut ProcTable,
    pipes: &mut PipeTable,
    pid: u32,
    r: &mut Reader,
) -> SyscallOutcome {
    let resp = |e: u16, child: u32| Writer::new().u16(e).u32(child).build();
    // Only a process holding the Spawn capability may launch children (FR-31).
    if !procs.has_cap(pid, &Capability::Spawn) {
        return SyscallOutcome::ready(resp(errno::NOTCAPABLE, 0));
    }
    let Some(path) = r.string() else { return SyscallOutcome::ready(resp(errno::INVAL, 0)) };
    let Some(argc) = r.u32() else { return SyscallOutcome::ready(resp(errno::INVAL, 0)) };
    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        match r.string() {
            Some(a) => argv.push(a),
            None => return SyscallOutcome::ready(resp(errno::INVAL, 0)),
        }
    }
    let mut specs = Vec::with_capacity(3);
    for _ in 0..3 {
        match parse_fd_spec(r) {
            Some(s) => specs.push(s),
            None => return SyscallOutcome::ready(resp(errno::INVAL, 0)),
        }
    }
    // Working directory for the child (its preopen / relative-path base).
    let cwd = r.string().unwrap_or_else(|| "/".to_string());
    // Capability delegation (M3): the parent may grant the child Gpu/Input, but
    // ONLY caps it holds itself (a process cannot hand out authority it lacks).
    // Older callers omit these bytes → default 0 (no grant).
    let want_gpu = r.u8().unwrap_or(0) != 0;
    let want_input = r.u8().unwrap_or(0) != 0;
    let want_signal = r.u8().unwrap_or(0) != 0;
    let want_net = r.u8().unwrap_or(0) != 0;

    // The child inherits a broad FS grant (the shell's children operate on the
    // user's files); never Shm, never Spawn (only the shell/file-manager spawns).
    let mut caps = CapabilitySet::default();
    caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
    if want_gpu && procs.has_cap(pid, &Capability::Gpu) {
        caps.grant(Capability::Gpu);
    }
    if want_input && procs.has_cap(pid, &Capability::Input) {
        caps.grant(Capability::Input);
    }
    // Signal delegation (M4-T5): the shell hands process-control authority to a
    // spawned `kill` so it can signal other processes — only if the shell holds it.
    if want_signal && procs.has_cap(pid, &Capability::Signal) {
        caps.grant(Capability::Signal);
    }
    // Net delegation (M5-T6): the shell hands brokered networking to a spawned
    // `fetch` — only if the shell holds Net.
    if want_net && procs.has_cap(pid, &Capability::Net) {
        caps.grant(Capability::Net);
    }
    let name = path.rsplit('/').next().unwrap_or(&path).to_string();
    let child = procs.spawn(&name, SPAWN_PRIORITY, caps);
    let argv = if argv.is_empty() { vec![name] } else { argv };
    procs.set_argv(child, argv);

    // Configure stdio fds 0/1/2 from the shell's spec.
    for (idx, spec) in specs.into_iter().enumerate() {
        let fd = idx as u32;
        let desc = match spec {
            FdSpec::Terminal => {
                let kind = if fd == 0 { DescKind::Stdin } else { DescKind::Terminal };
                Descriptor { kind, offset: 0, rights: Rights::RW }
            }
            FdSpec::PipeRead(id) => {
                pipes.add_reader(id);
                Descriptor { kind: DescKind::PipeRead { id }, offset: 0, rights: Rights::R }
            }
            FdSpec::PipeWrite(id) => {
                pipes.add_writer(id);
                Descriptor { kind: DescKind::PipeWrite { id }, offset: 0, rights: Rights::RW }
            }
            FdSpec::File { path, mode } => {
                let (rights, offset) = match mode {
                    1 => {
                        let _ = vfs.write(&path, Vec::new()); // `>` truncate-create
                        (Rights::RW, 0)
                    }
                    2 => {
                        // `>>` append: start the cursor at the current file end.
                        let end = vfs.read(&path).map(|c| c.len() as u64).unwrap_or(0);
                        (Rights::RW, end)
                    }
                    _ => (Rights::R, 0), // `<` read
                };
                Descriptor { kind: DescKind::File { path }, offset, rights }
            }
        };
        procs.set_fd(child, fd, desc);
    }
    // Set the child's preopen (fd 3) to its cwd so relative paths resolve there.
    procs.set_fd(
        child,
        PREOPEN_FD,
        Descriptor { kind: DescKind::Dir { path: cwd }, offset: 0, rights: Rights::RWX },
    );
    procs.set_state(child, ProcState::Ready);

    SyscallOutcome {
        reply: Some(resp(errno::SUCCESS, child)),
        wakeups: Vec::new(),
        term_output: Vec::new(),
        spawn: Some(SpawnRequest { pid: child, image_path: path }),
        reap: Vec::new(),
        net: None,
    }
}

/// `wasmos_kernel.pipe()` — create a pipe; return `(read_fd, write_fd)` in the
/// caller's fd table.
fn k_pipe(procs: &mut ProcTable, pipes: &mut PipeTable, pid: u32, _r: &mut Reader) -> SyscallOutcome {
    let id = pipes.create();
    let rfd = procs
        .open_fd(pid, Descriptor { kind: DescKind::PipeRead { id }, offset: 0, rights: Rights::R })
        .unwrap_or(0);
    let wfd = procs
        .open_fd(pid, Descriptor { kind: DescKind::PipeWrite { id }, offset: 0, rights: Rights::RW })
        .unwrap_or(0);
    // Return the caller's fds (to close after spawning) AND the pipe id (to pass
    // as a child's stdio spec).
    SyscallOutcome::ready(Writer::new().u16(errno::SUCCESS).u32(rfd).u32(wfd).u32(id).build())
}

/// Largest surface dimension the kernel will allocate (guards host SAB OOM).
const MAX_SURFACE_DIM: u32 = 4096;

/// `wasmos_kernel.win_surface(width, height)` — allocate a compositor surface
/// (M3, FR-23). Requires the Gpu capability (default-deny, FR-31). The kernel is
/// the surface-id authority; the owning process worker allocates the framebuffer
/// SAB and the compositor blits it (pixels never enter the kernel ring). Request:
/// `[0x23][w u32][h u32]`. Reply: `[errno u16][surface_id u32]`.
fn win_surface(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> SyscallOutcome {
    let resp = |e: u16, id: u32| Writer::new().u16(e).u32(id).build();
    if !procs.has_cap(pid, &Capability::Gpu) {
        return SyscallOutcome::ready(resp(errno::NOTCAPABLE, 0));
    }
    let (Some(w), Some(h)) = (r.u32(), r.u32()) else {
        return SyscallOutcome::ready(resp(errno::INVAL, 0));
    };
    if w == 0 || h == 0 || w > MAX_SURFACE_DIM || h > MAX_SURFACE_DIM {
        return SyscallOutcome::ready(resp(errno::INVAL, 0));
    }
    let id = procs.alloc_surface(pid);
    SyscallOutcome::ready(resp(errno::SUCCESS, id))
}

/// One brokered input event is a fixed-size record (see `INPUT_EVENT_SIZE` in the
/// compositor + `wasmos_sys::InputEvent`). Reads drain whole records only.
const INPUT_EVENT_SIZE: usize = 12;

/// `wasmos_kernel.win_read_input(max)` — drain queued keyboard/mouse events for
/// this process (M3-T3, FR-25). Requires the Input capability (default-deny). If
/// nothing is queued, PARKS on `WaitReason::Input`; a later `deliver_input`
/// re-drives it. Reply: `[errno u16][len u32][event bytes]` (whole records).
fn win_read_input(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> SyscallOutcome {
    if !procs.has_cap(pid, &Capability::Input) {
        return SyscallOutcome::ready(err_only(errno::NOTCAPABLE));
    }
    // Drain whole records only (floor the cap to a multiple of the record size).
    let cap = (r.u32().unwrap_or(0) as usize / INPUT_EVENT_SIZE) * INPUT_EVENT_SIZE;
    if procs.input_len(pid) > 0 {
        let data = procs.read_input(pid, cap.max(INPUT_EVENT_SIZE));
        SyscallOutcome::ready(Writer::new().u16(errno::SUCCESS).bytes(&data).build())
    } else {
        procs.set_blocked(pid, WaitReason::Input);
        SyscallOutcome::parked()
    }
}

/// `wasmos_kernel.wait(pid)` — return a child's exit code, parking until it exits.
fn k_wait(procs: &mut ProcTable, pid: u32, r: &mut Reader) -> SyscallOutcome {
    let resp = |e: u16, code: i32| Writer::new().u16(e).u32(code as u32).build();
    let Some(child) = r.u32() else { return SyscallOutcome::ready(resp(errno::INVAL, 0)) };
    if let Some(code) = procs.exit_code(child) {
        SyscallOutcome::ready(resp(errno::SUCCESS, code))
    } else if procs.get(child).is_none() {
        SyscallOutcome::ready(resp(errno::NOENT, 0)) // no such child
    } else {
        procs.set_blocked(pid, WaitReason::Wait(child));
        SyscallOutcome::parked()
    }
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

    /// (vfs with /mnt mounted on idb, proc table, pipe table, pid w/ full FS rights).
    fn setup() -> (Vfs, ProcTable, PipeTable, u32) {
        let mut vfs = Vfs::new(Box::new(MemStore::default()), Box::new(MemStore::default()));
        vfs.mount("/mnt", Backend::Idb).unwrap();
        let mut procs = ProcTable::new();
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
        let pid = procs.spawn("t", 5, caps);
        procs.set_state(pid, ProcState::Running);
        (vfs, procs, PipeTable::new(), pid)
    }

    /// Drive a syscall expected to complete immediately; unwrap its reply bytes.
    fn drive(
        vfs: &mut Vfs,
        procs: &mut ProcTable,
        pipes: &mut PipeTable,
        pid: u32,
        req: &[u8],
    ) -> Vec<u8> {
        dispatch(vfs, procs, pipes, pid, req).reply.expect("syscall unexpectedly parked")
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
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_write(1, b"hello "));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(read_u32_at(&resp, 2), 6); // nwritten
        drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_write(1, b"world"));
        drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_write(2, b"warn"));
        let (out, err) = procs.take_capture(pid);
        assert_eq!(out, b"hello world");
        assert_eq!(err, b"warn");
    }

    #[test]
    fn proc_exit_records_code_and_zombifies() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        let req = Writer::new().u8(Op::ProcExit as u8).u32(0).build();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(procs.exit_code(pid), Some(0));
        assert_eq!(procs.get(pid).unwrap().state, ProcState::Zombie);
    }

    #[test]
    fn path_open_then_fd_read_returns_vfs_bytes() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        vfs.write("/mnt/in.txt", b"payload".to_vec()).unwrap();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_path_open(PREOPEN_FD, "/mnt/in.txt", 0));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let fd = read_u32_at(&resp, 2);
        assert!(fd >= 4);
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(fd, 1024));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(resp_bytes(&resp), b"payload");
    }

    #[test]
    fn fd_seek_moves_cursor_and_partial_reads_work() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        vfs.write("/mnt/f", b"abcdef".to_vec()).unwrap();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_path_open(PREOPEN_FD, "/mnt/f", 0));
        let fd = read_u32_at(&resp, 2);
        // seek to 2 (SET)
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_seek(fd, 2, whence::SET));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        // read 3 → "cde"
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(fd, 3));
        assert_eq!(resp_bytes(&resp), b"cde");
        // cursor now at 5; read 10 → "f"
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(fd, 10));
        assert_eq!(resp_bytes(&resp), b"f");
    }

    #[test]
    fn fd_close_then_use_is_badf() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        vfs.write("/mnt/f", b"x".to_vec()).unwrap();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_path_open(PREOPEN_FD, "/mnt/f", 0));
        let fd = read_u32_at(&resp, 2);
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_close(fd))), errno::SUCCESS);
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(fd, 1));
        assert_eq!(read_u16(&resp), errno::BADF);
    }

    #[test]
    fn path_open_outside_capability_subtree_is_denied() {
        // pid granted only /home; opening /mnt must be denied (default-deny).
        let mut vfs = Vfs::new(Box::new(MemStore::default()), Box::new(MemStore::default()));
        vfs.mount("/mnt", Backend::Idb).unwrap();
        vfs.write("/mnt/secret", b"s".to_vec()).unwrap();
        let mut procs = ProcTable::new();
        let mut pipes = PipeTable::new();
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/home".into(), rights: Rights::RW });
        let pid = procs.spawn("t", 5, caps);
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_path_open(PREOPEN_FD, "/mnt/secret", 0));
        assert_eq!(read_u16(&resp), errno::NOTCAPABLE);
        assert_eq!(read_u32_at(&resp, 2), 0); // no fd handed out
    }

    #[test]
    fn args_reflect_argv_and_environ_is_empty() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        // The setup process has argv = ["t"] (its name); environ is empty.
        procs.set_argv(pid, vec!["ls".into(), "-la".into()]);
        let sz = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_simple(Op::ArgsSizesGet));
        assert_eq!(read_u16(&sz), errno::SUCCESS);
        assert_eq!(read_u32_at(&sz, 2), 2); // count = argc
        assert_eq!(read_u32_at(&sz, 6), 7); // "ls\0-la\0" = 3 + 4
        let blob = resp_bytes(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_simple(Op::ArgsGet)));
        assert_eq!(blob, b"ls\0-la\0");
        // environ stays empty.
        let esz = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_simple(Op::EnvironSizesGet));
        assert_eq!(read_u32_at(&esz, 2), 0);
        assert!(resp_bytes(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_simple(Op::EnvironGet))).is_empty());
    }

    #[test]
    fn fd_prestat_scan_terminates_at_fd4() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        // fd 3 (preopen "/") → SUCCESS with name_len 1.
        let req3 = Writer::new().u8(Op::FdPrestatGet as u8).u32(3).build();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req3);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(read_u32_at(&resp, 2), 1); // "/".len()
        // fd 4 → BADF (ends the libc scan).
        let req4 = Writer::new().u8(Op::FdPrestatGet as u8).u32(4).build();
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req4)), errno::BADF);
        // dir name of fd 3 is "/".
        let reqn = Writer::new().u8(Op::FdPrestatDirName as u8).u32(3).u32(16).build();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &reqn);
        assert_eq!(resp_bytes(&resp), b"/");
    }

    #[test]
    fn random_get_fills_len_bytes() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        let req = Writer::new().u8(Op::RandomGet as u8).u32(16).build();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(resp_bytes(&resp).len(), 16);
    }

    #[test]
    fn clock_time_get_is_nonzero_deterministic() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        let req = Writer::new().u8(Op::ClockTimeGet as u8).u32(0).u64(0).build();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req);
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let t = u64::from_le_bytes([resp[2], resp[3], resp[4], resp[5], resp[6], resp[7], resp[8], resp[9]]);
        assert_eq!(t, M1_CLOCK_NS);
        assert!(t > 0);
    }

    #[test]
    fn fd_readdir_lists_directory_entries() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        vfs.write("/mnt/a.txt", b"1".to_vec()).unwrap();
        vfs.write("/mnt/b.txt", b"2".to_vec()).unwrap();
        // Open /mnt as a directory.
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_path_open(PREOPEN_FD, "/mnt", oflags::DIRECTORY));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let dirfd = read_u32_at(&resp, 2);
        let req = Writer::new().u8(Op::FdReaddir as u8).u32(dirfd).u64(0).u32(4096).build();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req);
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
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &[0xFF]);
        assert_eq!(read_u16(&resp), errno::NOSYS);
    }

    // --- M2: stdin park/resume ---

    #[test]
    fn fd_read_on_empty_open_stdin_parks() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(0, 64));
        assert!(out.reply.is_none()); // PARKED — no response yet
        assert_eq!(procs.blocked_on(pid), Some(crate::types::WaitReason::Stdin));
    }

    #[test]
    fn fd_read_stdin_returns_buffered_then_parks_then_eof() {
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        procs.push_stdin(pid, b"hello");
        // Buffered data returns immediately, up to the requested length.
        assert_eq!(resp_bytes(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(0, 3))), b"hel");
        assert_eq!(resp_bytes(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(0, 10))), b"lo");
        // Drained + still open → parks.
        assert!(dispatch(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(0, 10)).reply.is_none());
        // Closed stdin → EOF (empty read), not a park.
        procs.clear_blocked(pid);
        procs.close_stdin(pid);
        assert_eq!(resp_bytes(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_fd_read(0, 10))), b"");
    }

    // --- M2: kernel pipes (park/resume) ---

    /// (vfs, procs, pipes, reader_pid, writer_pid, pipe_id, read_fd, write_fd)
    fn pipe_setup() -> (Vfs, ProcTable, PipeTable, u32, u32, u32, u32, u32) {
        let (vfs, mut procs, mut pipes, reader) = setup();
        let writer = procs.spawn("w", 5, CapabilitySet::default());
        procs.set_state(writer, ProcState::Running);
        let id = pipes.create();
        let rfd = procs
            .open_fd(reader, Descriptor { kind: DescKind::PipeRead { id }, offset: 0, rights: Rights::R })
            .unwrap();
        let wfd = procs
            .open_fd(writer, Descriptor { kind: DescKind::PipeWrite { id }, offset: 0, rights: Rights::RW })
            .unwrap();
        (vfs, procs, pipes, reader, writer, id, rfd, wfd)
    }

    #[test]
    fn pipe_read_parks_then_write_wakes_and_delivers() {
        let (mut vfs, mut procs, mut pipes, reader, writer, id, rfd, wfd) = pipe_setup();
        // Reader reads the empty pipe → parks on PipeRead(id).
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 64));
        assert!(out.reply.is_none());
        assert_eq!(procs.blocked_on(reader), Some(WaitReason::PipeRead(id)));
        // Writer writes → reader is woken.
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, b"hi pipe"));
        assert_eq!(out.wakeups, vec![reader]);
        assert_eq!(read_u16(&out.reply.unwrap()), errno::SUCCESS);
        // Re-driving the reader's read now returns the bytes.
        let resp = drive(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 64));
        assert_eq!(resp_bytes(&resp), b"hi pipe");
    }

    #[test]
    fn pipe_eof_when_writer_closes() {
        let (mut vfs, mut procs, mut pipes, reader, writer, _id, rfd, wfd) = pipe_setup();
        // Close the only writer → reads return EOF (empty), not a park.
        let close = dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_close(wfd));
        assert_eq!(read_u16(&close.reply.unwrap()), errno::SUCCESS);
        let resp = drive(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 64));
        assert_eq!(resp_bytes(&resp), b""); // EOF
    }

    #[test]
    fn pipe_epipe_when_reader_closed() {
        let (mut vfs, mut procs, mut pipes, reader, writer, _id, rfd, wfd) = pipe_setup();
        dispatch(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_close(rfd));
        // Writing to a pipe with no readers → EPIPE.
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, b"x"));
        assert_eq!(read_u16(&out.reply.unwrap()), errno::PIPE);
    }

    #[test]
    fn pipe_backpressure_writer_parks_when_full_then_read_wakes_it() {
        let (mut vfs, mut procs, mut pipes, reader, writer, id, rfd, wfd) = pipe_setup();
        // Fill the pipe to capacity in one write (partial write returns nwritten).
        let big = vec![b'a'; crate::pipe::PIPE_CAPACITY];
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, &big));
        assert_eq!(read_u32_at(&out.reply.unwrap(), 2), crate::pipe::PIPE_CAPACITY as u32);
        // Now full → the next write parks the writer.
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, b"more"));
        assert!(out.reply.is_none());
        assert_eq!(procs.blocked_on(writer), Some(WaitReason::PipeWrite(id)));
        // A read drains the pipe → the parked writer is woken.
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 1024));
        assert_eq!(out.wakeups, vec![writer]);
    }

    // --- M2: crash containment (FR-34) — exit releases pipe ends ---

    #[test]
    fn proc_exit_of_writer_gives_parked_reader_eof() {
        // A reader blocked on the empty pipe must be woken with EOF when the writer
        // process EXITS (e.g. it trapped), not only when it explicitly fd_closes.
        let (mut vfs, mut procs, mut pipes, reader, writer, id, rfd, _wfd) = pipe_setup();
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 64));
        assert!(out.reply.is_none());
        assert_eq!(procs.blocked_on(reader), Some(WaitReason::PipeRead(id)));
        // Writer exits → its write end is released → the parked reader is woken.
        let exit = dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_proc_exit(134));
        assert!(exit.wakeups.contains(&reader));
        // Re-driving the read now returns EOF (empty), not another park.
        let resp = drive(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 64));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(resp_bytes(&resp), b"");
    }

    #[test]
    fn proc_exit_of_reader_gives_parked_writer_epipe() {
        // A writer blocked on a full pipe must be woken with EPIPE when the reader
        // process EXITS, so a crash at the tail of a pipeline cannot wedge the head.
        let (mut vfs, mut procs, mut pipes, reader, writer, id, _rfd, wfd) = pipe_setup();
        let big = vec![b'a'; crate::pipe::PIPE_CAPACITY];
        dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, &big));
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, b"more"));
        assert!(out.reply.is_none());
        assert_eq!(procs.blocked_on(writer), Some(WaitReason::PipeWrite(id)));
        // Reader exits → its read end is released → the parked writer is woken.
        let exit = dispatch(&mut vfs, &mut procs, &mut pipes, reader, &req_proc_exit(0));
        assert!(exit.wakeups.contains(&writer));
        // Re-driving the write now returns EPIPE (no readers), not another park.
        let resp = drive(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, b"more"));
        assert_eq!(read_u16(&resp), errno::PIPE);
    }

    #[test]
    fn proc_exit_of_writer_delivers_buffered_bytes_then_eof() {
        // No data loss: a stage that writes bytes then immediately exits must still
        // hand those buffered bytes to a slower reader BEFORE the reader sees EOF.
        // (This is the normal `a | b` path, not just the empty-crash path.)
        let (mut vfs, mut procs, mut pipes, reader, writer, _id, rfd, wfd) = pipe_setup();
        let n = read_u32_at(
            &dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_fd_write(wfd, b"payload")).reply.unwrap(),
            2,
        );
        assert_eq!(n, 7);
        // Writer exits with bytes still buffered in the pipe.
        dispatch(&mut vfs, &mut procs, &mut pipes, writer, &req_proc_exit(0));
        // The reader still gets the buffered bytes...
        let resp = drive(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 64));
        assert_eq!(resp_bytes(&resp), b"payload");
        // ...and only THEN sees EOF.
        let resp = drive(&mut vfs, &mut procs, &mut pipes, reader, &req_fd_read(rfd, 64));
        assert_eq!(resp_bytes(&resp), b"");
    }

    // --- M2: wasmos_kernel extension (spawn / pipe / wait) ---

    /// A caller process holding the Spawn capability (a shell).
    fn shell_setup() -> (Vfs, ProcTable, PipeTable, u32) {
        let (vfs, mut procs, pipes, _t) = setup();
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::Spawn);
        caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
        let sh = procs.spawn("sh", 5, caps);
        procs.set_state(sh, ProcState::Running);
        (vfs, procs, pipes, sh)
    }
    /// KSPAWN request with all stdio inheriting the terminal (tag 0).
    fn req_kspawn_term(path: &str, argv: &[&str]) -> Vec<u8> {
        let mut w = Writer::new();
        w.u8(Op::KSpawn as u8).bytes(path.as_bytes()).u32(argv.len() as u32);
        for a in argv {
            w.bytes(a.as_bytes());
        }
        for _ in 0..3 {
            w.u8(0); // terminal
        }
        w.build()
    }
    fn req_kwait(child: u32) -> Vec<u8> {
        Writer::new().u8(Op::KWait as u8).u32(child).build()
    }
    fn req_proc_exit(code: u32) -> Vec<u8> {
        Writer::new().u8(Op::ProcExit as u8).u32(code).build()
    }

    #[test]
    fn kspawn_allocates_child_with_argv_stdio_and_requests_instantiation() {
        let (mut vfs, mut procs, mut pipes, sh) = shell_setup();
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, sh, &req_kspawn_term("/bin/echo", &["echo", "hi"]));
        let resp = out.reply.expect("ready");
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let child = read_u32_at(&resp, 2);
        assert!(child > sh);
        // The kworker is asked to instantiate the child from the VFS image.
        let sr = out.spawn.expect("spawn request");
        assert_eq!(sr.pid, child);
        assert_eq!(sr.image_path, "/bin/echo");
        // argv + terminal-bound stdout reached the child.
        assert_eq!(procs.argv(child), vec!["echo".to_string(), "hi".to_string()]);
        assert_eq!(procs.fd(child, 1).unwrap().kind, DescKind::Terminal);
        assert_eq!(procs.fd(child, 0).unwrap().kind, DescKind::Stdin);
    }

    #[test]
    fn kspawn_denied_without_spawn_capability() {
        let (mut vfs, mut procs, mut pipes, pid) = setup(); // no Spawn cap
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, pid, &req_kspawn_term("/bin/echo", &["echo"]));
        assert_eq!(read_u16(&out.reply.unwrap()), errno::NOTCAPABLE);
        assert!(out.spawn.is_none());
    }

    #[test]
    fn kpipe_returns_two_fds_in_the_caller() {
        let (mut vfs, mut procs, mut pipes, sh) = shell_setup();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, sh, &req_simple(Op::KPipe));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        let rfd = read_u32_at(&resp, 2);
        let wfd = read_u32_at(&resp, 6);
        assert!(rfd >= 4 && wfd >= 4 && rfd != wfd);
        assert!(matches!(procs.fd(sh, rfd).unwrap().kind, DescKind::PipeRead { .. }));
        assert!(matches!(procs.fd(sh, wfd).unwrap().kind, DescKind::PipeWrite { .. }));
    }

    #[test]
    fn fs_mutation_syscalls_mkdir_unlink_rmdir_rename() {
        let (mut vfs, mut procs, mut pipes, pid) = setup(); // fd3 = Dir "/", caps "/" RWX
        let p1 = |op: u8, path: &str| Writer::new().u8(op).u32(PREOPEN_FD).bytes(path.as_bytes()).build();
        let p2 = |op: u8, a: &str, b: &str| {
            Writer::new().u8(op).u32(PREOPEN_FD).bytes(a.as_bytes()).u32(PREOPEN_FD).bytes(b.as_bytes()).build()
        };
        // mkdir /mnt/d
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &p1(0x11, "/mnt/d"))), errno::SUCCESS);
        assert!(vfs.is_dir("/mnt/d"));
        // mkdir existing → EEXIST
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &p1(0x11, "/mnt/d"))), errno::EXIST);
        // unlink a file
        vfs.write("/mnt/f", b"x".to_vec()).unwrap();
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &p1(0x12, "/mnt/f"))), errno::SUCCESS);
        assert_eq!(vfs.read("/mnt/f"), Err(crate::vfs::FsError::NotFound));
        // rename a file
        vfs.write("/mnt/a", b"1".to_vec()).unwrap();
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &p2(0x14, "/mnt/a", "/mnt/b"))), errno::SUCCESS);
        assert_eq!(vfs.read("/mnt/b").unwrap(), b"1");
        // rmdir the (empty) dir
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &p1(0x13, "/mnt/d"))), errno::SUCCESS);
        assert!(!vfs.is_dir("/mnt/d"));
    }

    #[test]
    fn fs_mutation_respects_capabilities() {
        // pid granted only /home; mutating /mnt must be denied (default-deny).
        let mut vfs = Vfs::new(Box::new(MemStore::default()), Box::new(MemStore::default()));
        vfs.mount("/mnt", Backend::Idb).unwrap();
        let mut procs = ProcTable::new();
        let mut pipes = PipeTable::new();
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/home".into(), rights: Rights::RW });
        let pid = procs.spawn("t", 5, caps);
        let req = Writer::new().u8(0x11).u32(PREOPEN_FD).bytes(b"/mnt/x").build();
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req)), errno::NOTCAPABLE);
    }

    #[test]
    fn kwait_parks_until_child_exits_then_returns_code() {
        let (mut vfs, mut procs, mut pipes, sh) = shell_setup();
        let child = read_u32_at(
            &dispatch(&mut vfs, &mut procs, &mut pipes, sh, &req_kspawn_term("/bin/echo", &["echo"]))
                .reply
                .unwrap(),
            2,
        );
        // Parent waits → parks (child has not exited).
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, sh, &req_kwait(child));
        assert!(out.reply.is_none());
        assert_eq!(procs.blocked_on(sh), Some(WaitReason::Wait(child)));
        // Child exits(0) → the waiting parent is woken.
        let exit = dispatch(&mut vfs, &mut procs, &mut pipes, child, &req_proc_exit(0));
        assert_eq!(exit.wakeups, vec![sh]);
        // Re-driving the parent's wait now returns the exit code.
        let resp = drive(&mut vfs, &mut procs, &mut pipes, sh, &req_kwait(child));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(read_u32_at(&resp, 2), 0); // exit code
    }

    // --- M3: compositor surfaces (win_surface) ---

    fn gpu_proc(procs: &mut ProcTable) -> u32 {
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::Gpu);
        let pid = procs.spawn("gfx", 5, caps);
        procs.set_state(pid, ProcState::Running);
        pid
    }
    fn req_win_surface(w: u32, h: u32) -> Vec<u8> {
        Writer::new().u8(Op::WinSurface as u8).u32(w).u32(h).build()
    }

    #[test]
    fn win_surface_requires_gpu_capability() {
        // The default setup() process holds no Gpu cap → default-deny (FR-31).
        let (mut vfs, mut procs, mut pipes, pid) = setup();
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_surface(64, 48));
        assert_eq!(read_u16(&resp), errno::NOTCAPABLE);
        assert_eq!(read_u32_at(&resp, 2), 0); // no surface id handed out
    }

    #[test]
    fn win_surface_with_gpu_allocates_unique_ids_and_validates_dims() {
        let (mut vfs, mut procs, mut pipes, _t) = setup();
        let pid = gpu_proc(&mut procs);
        // Valid request → SUCCESS + a nonzero surface id.
        let r1 = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_surface(64, 48));
        assert_eq!(read_u16(&r1), errno::SUCCESS);
        let id1 = read_u32_at(&r1, 2);
        assert!(id1 >= 1);
        // A second surface gets a distinct id.
        let r2 = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_surface(10, 10));
        assert_ne!(id1, read_u32_at(&r2, 2));
        // Zero and oversized dimensions are rejected (host SAB OOM guard).
        assert_eq!(read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_surface(0, 10))), errno::INVAL);
        assert_eq!(
            read_u16(&drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_surface(99999, 10))),
            errno::INVAL
        );
    }

    #[test]
    fn proc_exit_frees_owned_surfaces() {
        let (mut vfs, mut procs, mut pipes, _t) = setup();
        let pid = gpu_proc(&mut procs);
        drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_surface(8, 8));
        drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_surface(8, 8));
        // proc_exit releases kernel-side surface ownership.
        drive(&mut vfs, &mut procs, &mut pipes, pid, &req_proc_exit(0));
        assert!(procs.free_surfaces_of(pid).is_empty());
    }

    // --- M3: brokered input (win_read_input / deliver_input, FR-25) ---

    fn input_proc(procs: &mut ProcTable) -> u32 {
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::Input);
        let pid = procs.spawn("inp", 5, caps);
        procs.set_state(pid, ProcState::Running);
        pid
    }
    fn req_win_read_input(cap: u32) -> Vec<u8> {
        Writer::new().u8(Op::WinReadInput as u8).u32(cap).build()
    }

    #[test]
    fn win_read_input_requires_input_capability() {
        let (mut vfs, mut procs, mut pipes, pid) = setup(); // no Input cap
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_read_input(120));
        assert_eq!(read_u16(&resp), errno::NOTCAPABLE);
    }

    #[test]
    fn win_read_input_parks_on_empty_then_returns_delivered_events() {
        let (mut vfs, mut procs, mut pipes, _t) = setup();
        let pid = input_proc(&mut procs);
        // Empty queue → parks on Input.
        let out = dispatch(&mut vfs, &mut procs, &mut pipes, pid, &req_win_read_input(120));
        assert!(out.reply.is_none());
        assert_eq!(procs.blocked_on(pid), Some(WaitReason::Input));
        // A 12-byte event is delivered; the parked reader becomes runnable.
        let ev: [u8; 12] = [1, 0, 5, 0, 7, 0, 0, 0, 0, 0, 0, 0];
        procs.push_input(pid, &ev);
        assert_eq!(procs.take_blocked_on(&WaitReason::Input), vec![pid]);
        // Re-driving the read now returns exactly the event bytes.
        let resp = drive(&mut vfs, &mut procs, &mut pipes, pid, &req_win_read_input(120));
        assert_eq!(read_u16(&resp), errno::SUCCESS);
        assert_eq!(resp_bytes(&resp), &ev);
    }

    // --- M3: capability delegation on spawn (file manager launches apps) ---

    fn req_kspawn_grant(path: &str, argv: &[&str], gpu: bool, input: bool) -> Vec<u8> {
        let mut w = Writer::new();
        w.u8(Op::KSpawn as u8).bytes(path.as_bytes()).u32(argv.len() as u32);
        for a in argv {
            w.bytes(a.as_bytes());
        }
        for _ in 0..3 {
            w.u8(0); // terminal stdio
        }
        w.bytes(b"/"); // cwd
        w.u8(gpu as u8).u8(input as u8);
        w.build()
    }
    fn spawner(procs: &mut ProcTable, gpu: bool, input: bool) -> u32 {
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::Spawn);
        if gpu {
            caps.grant(Capability::Gpu);
        }
        if input {
            caps.grant(Capability::Input);
        }
        let pid = procs.spawn("launcher", 5, caps);
        procs.set_state(pid, ProcState::Running);
        pid
    }

    #[test]
    fn kspawn_delegates_gpu_input_only_from_a_holder() {
        let (mut vfs, mut procs, mut pipes, _t) = setup();
        // A spawner WITHOUT Gpu/Input cannot delegate them, even if it asks.
        let a = spawner(&mut procs, false, false);
        let ca = read_u32_at(
            &dispatch(&mut vfs, &mut procs, &mut pipes, a, &req_kspawn_grant("/bin/x", &["x"], true, true))
                .reply
                .unwrap(),
            2,
        );
        assert!(!procs.has_cap(ca, &Capability::Gpu));
        assert!(!procs.has_cap(ca, &Capability::Input));

        // A spawner holding Gpu+Input delegates exactly what is requested.
        let b = spawner(&mut procs, true, true);
        let granted = read_u32_at(
            &dispatch(&mut vfs, &mut procs, &mut pipes, b, &req_kspawn_grant("/bin/x", &["x"], true, true))
                .reply
                .unwrap(),
            2,
        );
        assert!(procs.has_cap(granted, &Capability::Gpu));
        assert!(procs.has_cap(granted, &Capability::Input));
        // Not requested → not granted (least privilege).
        let plain = read_u32_at(
            &dispatch(&mut vfs, &mut procs, &mut pipes, b, &req_kspawn_grant("/bin/x", &["x"], false, false))
                .reply
                .unwrap(),
            2,
        );
        assert!(!procs.has_cap(plain, &Capability::Gpu));
        assert!(!procs.has_cap(plain, &Capability::Input));
    }
}

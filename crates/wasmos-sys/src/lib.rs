//! Guest-side bindings for the **wasmos_kernel** process-control extension (M2).
//!
//! A guest (the shell) imports a single `wasmos_kernel.syscall` function and
//! marshals typed calls (`spawn`/`pipe`/`wait`) over it using the same binary
//! wire format the kernel router decodes (opcodes `0x20..`). The logical ABI is
//! documented in `wit/kernel.wit`; the Binder's `kernel-check` verifies this
//! crate exposes the matching function set (FR-36 drift gate).
//!
//! On non-wasm targets the import is replaced with a stub so the crate still
//! type-checks under host `cargo test`.

#[cfg(target_arch = "wasm32")]
#[link(wasm_import_module = "wasmos_kernel")]
extern "C" {
    fn syscall(req_ptr: *const u8, req_len: usize, resp_ptr: *mut u8, resp_cap: usize) -> usize;
}

#[cfg(not(target_arch = "wasm32"))]
unsafe fn syscall(_req_ptr: *const u8, _req_len: usize, _resp_ptr: *mut u8, _resp_cap: usize) -> usize {
    0
}

// Opcodes — must match `crates/kernel/src/syscall.rs` `Op`.
const FD_CLOSE: u8 = 0x04;
const KSPAWN: u8 = 0x20;
const KPIPE: u8 = 0x21;
const KWAIT: u8 = 0x22;
const WIN_SURFACE: u8 = 0x23;
/// `win_present` is intercepted by the host process worker (it copies the guest
/// framebuffer into the surface's shared SAB and notifies the compositor); it
/// never reaches the kernel ring. The opcode is the marker the shim matches on.
const WIN_PRESENT: u8 = 0x24;
const WIN_READ_INPUT: u8 = 0x25;
const TTY_SET_RAW: u8 = 0x26;
const PROC_LIST: u8 = 0x30;
const SET_PRIORITY: u8 = 0x31;
const CHAN_OPEN: u8 = 0x32;
const CHAN_SEND: u8 = 0x33;
const CHAN_RECV: u8 = 0x34;
const SHM_CREATE: u8 = 0x35;
const SHM_MAP: u8 = 0x36;
const SHM_READ: u8 = 0x37;
const SHM_WRITE: u8 = 0x38;
const SHM_GRANT: u8 = 0x39;
const KILL: u8 = 0x3A;
const SIG_WAIT: u8 = 0x3B;
const NET_REQUEST: u8 = 0x40;

/// Signal numbers (M4-T5) — match POSIX. SIGTERM is catchable (cooperative
/// shutdown via [`sig_wait`]); SIGKILL is uncatchable + forceful.
pub const SIGTERM: u8 = 15;
pub const SIGKILL: u8 = 9;

/// File open mode for a stdio redirect.
pub const FILE_READ: u8 = 0; // `<`
pub const FILE_TRUNC: u8 = 1; // `>`
pub const FILE_APPEND: u8 = 2; // `>>`

/// How a child's stdio fd (0/1/2) is wired.
pub enum Stdio {
    /// Inherit the interactive terminal (read keystrokes / write to xterm).
    Terminal,
    /// The read end of a pipe (id).
    PipeRead(u32),
    /// The write end of a pipe (id).
    PipeWrite(u32),
    /// A file in the VFS opened with `mode` (FILE_READ/TRUNC/APPEND).
    File { path: String, mode: u8 },
}

struct W(Vec<u8>);
impl W {
    fn new() -> Self {
        W(Vec::new())
    }
    fn u8(&mut self, v: u8) {
        self.0.push(v);
    }
    fn u32(&mut self, v: u32) {
        self.0.extend_from_slice(&v.to_le_bytes());
    }
    fn bytes(&mut self, b: &[u8]) {
        self.u32(b.len() as u32);
        self.0.extend_from_slice(b);
    }
    fn stdio(&mut self, s: &Stdio) {
        match s {
            Stdio::Terminal => self.u8(0),
            Stdio::PipeRead(id) => {
                self.u8(1);
                self.u32(*id);
            }
            Stdio::PipeWrite(id) => {
                self.u8(2);
                self.u32(*id);
            }
            Stdio::File { path, mode } => {
                self.u8(3);
                self.bytes(path.as_bytes());
                self.u8(*mode);
            }
        }
    }
}

fn call(req: &[u8]) -> Vec<u8> {
    let mut resp = vec![0u8; 256];
    let n = unsafe { syscall(req.as_ptr(), req.len(), resp.as_mut_ptr(), resp.len()) };
    resp.truncate(n.min(resp.len()));
    resp
}

fn rd_u16(b: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([b[at], b[at + 1]])
}
fn rd_u32(b: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([b[at], b[at + 1], b[at + 2], b[at + 3]])
}
fn rd_u64(b: &[u8], at: usize) -> u64 {
    let mut v = [0u8; 8];
    v.copy_from_slice(&b[at..at + 8]);
    u64::from_le_bytes(v)
}

/// Spawn a child process from a VFS image with argv and stdio wiring. Returns
/// the child PID, or the kernel errno on failure.
// The grant_* flags mirror the kernel spawn wire format 1:1 (delegation bytes);
// keeping them as positional args matches that format rather than hiding it.
#[allow(clippy::too_many_arguments)]
pub fn spawn(
    path: &str,
    argv: &[&str],
    stdio: &[Stdio; 3],
    cwd: &str,
    grant_gpu: bool,
    grant_input: bool,
    grant_signal: bool,
    grant_net: bool,
) -> Result<u32, u16> {
    let mut w = W::new();
    w.u8(KSPAWN);
    w.bytes(path.as_bytes());
    w.u32(argv.len() as u32);
    for a in argv {
        w.bytes(a.as_bytes());
    }
    for s in stdio {
        w.stdio(s);
    }
    w.bytes(cwd.as_bytes());
    // Capability delegation: ask the kernel to also grant the child Gpu/Input (M3)
    // and Signal (M4-T5) — each only honoured if THIS process holds it. Ordinary
    // coreutils pass false/false/false; the shell delegates Signal to `kill`.
    w.u8(grant_gpu as u8);
    w.u8(grant_input as u8);
    w.u8(grant_signal as u8);
    w.u8(grant_net as u8);
    let resp = call(&w.0);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok(rd_u32(&resp, 2))
}

/// Create a pipe; returns `(read_fd, write_fd, pipe_id)`. The fds are the
/// caller's ends (close them after spawning the stages); the id is passed as a
/// child's stdio spec (`Stdio::PipeRead/PipeWrite`).
pub fn pipe() -> Result<(u32, u32, u32), u16> {
    let resp = call(&[KPIPE]);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok((rd_u32(&resp, 2), rd_u32(&resp, 6), rd_u32(&resp, 10)))
}

/// Close a file descriptor in this process (a WASI `fd_close`, used by the shell
/// to release its pipe ends so EOF/EPIPE propagate between pipeline stages).
pub fn close(fd: u32) -> u16 {
    let mut w = W::new();
    w.u8(FD_CLOSE);
    w.u32(fd);
    rd_u16(&call(&w.0), 0)
}

/// Wait for a child to exit; returns its exit code (blocks until it exits).
pub fn wait(pid: u32) -> Result<i32, u16> {
    let mut w = W::new();
    w.u8(KWAIT);
    w.u32(pid);
    let resp = call(&w.0);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok(rd_u32(&resp, 2) as i32)
}

/// `win_surface(width, height)` — request a compositor canvas surface (M3, FR-23).
/// Requires the `Gpu` capability. Returns the kernel-allocated `surface_id`; the
/// host allocates a `width*height*4` RGBA framebuffer shared with the compositor.
/// Present pixels with [`win_present`].
pub fn win_surface(width: u32, height: u32) -> Result<u32, u16> {
    let mut w = W::new();
    w.u8(WIN_SURFACE);
    w.u32(width);
    w.u32(height);
    let resp = call(&w.0);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok(rd_u32(&resp, 2))
}

/// `win_present(surface_id, framebuffer)` — publish a frame. `framebuffer` is
/// `width*height*4` RGBA bytes in guest memory; the host process worker copies it
/// into the surface's shared buffer and the compositor blits it to the canvas on
/// the next animation frame. The pixel bytes never enter the kernel ring.
pub fn win_present(surface_id: u32, framebuffer: &[u8]) {
    let mut w = W::new();
    w.u8(WIN_PRESENT);
    w.u32(surface_id);
    w.u32(framebuffer.as_ptr() as usize as u32); // guest linear-memory address
    w.u32(framebuffer.len() as u32);
    let _ = call(&w.0);
}

/// Size of one brokered input record on the wire (must match the compositor's
/// encoder and `crates/kernel` `INPUT_EVENT_SIZE`).
pub const INPUT_EVENT_SIZE: usize = 12;

/// Brokered input event kinds (M3-T3, FR-25).
pub const EV_POINTER_MOVE: u8 = 1;
pub const EV_POINTER_DOWN: u8 = 2;
pub const EV_POINTER_UP: u8 = 3;
pub const EV_KEY_DOWN: u8 = 4;
pub const EV_KEY_UP: u8 = 5;

/// Named-key codes in the `InputEvent::key` field. A printable key carries its
/// actual character code (`key < 0x100`); these are the non-printable keys.
pub const KEY_ENTER: u32 = 0x100;
pub const KEY_BACKSPACE: u32 = 0x101;
pub const KEY_LEFT: u32 = 0x102;
pub const KEY_RIGHT: u32 = 0x103;
pub const KEY_UP: u32 = 0x104;
pub const KEY_DOWN: u32 = 0x105;
pub const KEY_TAB: u32 = 0x106;
pub const KEY_ESCAPE: u32 = 0x107;
pub const KEY_DELETE: u32 = 0x108;
pub const KEY_HOME: u32 = 0x109;
pub const KEY_END: u32 = 0x10a;

/// A decoded keyboard/mouse event delivered to a process's focused window.
#[derive(Clone, Copy, Debug)]
pub struct InputEvent {
    /// One of the `EV_*` constants.
    pub kind: u8,
    /// Pointer button (0 = primary) for pointer events.
    pub button: u8,
    /// Surface-local pointer position (pixels).
    pub x: u16,
    pub y: u16,
    /// Key code for key events (a `KeyboardEvent.keyCode`-class value).
    pub key: u32,
    /// Modifier bitfield: 1=Shift, 2=Ctrl, 4=Alt, 8=Meta.
    pub mods: u8,
}

impl InputEvent {
    fn decode(b: &[u8]) -> InputEvent {
        InputEvent {
            kind: b[0],
            button: b[1],
            x: u16::from_le_bytes([b[2], b[3]]),
            y: u16::from_le_bytes([b[4], b[5]]),
            key: u32::from_le_bytes([b[6], b[7], b[8], b[9]]),
            mods: b[10],
        }
    }
}

/// `win_read_input()` — drain queued keyboard/mouse events for the focused window
/// (M3-T3, FR-25). **Blocks** (parks) until at least one event is available.
/// Returns `Err(errno)` if the process lacks the Input capability — callers
/// without input should not poll this in a loop.
pub fn win_read_input() -> Result<Vec<InputEvent>, u16> {
    let mut w = W::new();
    w.u8(WIN_READ_INPUT);
    w.u32((INPUT_EVENT_SIZE * 20) as u32); // up to 20 events per call
    let resp = call(&w.0);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    let len = rd_u32(&resp, 2) as usize;
    let mut events = Vec::with_capacity(len / INPUT_EVENT_SIZE);
    let mut off = 6;
    while off + INPUT_EVENT_SIZE <= 6 + len && off + INPUT_EVENT_SIZE <= resp.len() {
        events.push(InputEvent::decode(&resp[off..off + INPUT_EVENT_SIZE]));
        off += INPUT_EVENT_SIZE;
    }
    Ok(events)
}

/// `tty_set_raw(raw)` — switch the interactive terminal between raw and cooked
/// line discipline. In raw mode the host stops local echo + line buffering and
/// forwards every keystroke (ESC sequences, control bytes, arrows) straight to
/// this process's stdin — what an in-terminal editor like nano needs to read
/// keys one at a time. Call `tty_set_raw(true)` on entry and `tty_set_raw(false)`
/// before exit; if the process dies while raw, the host restores cooked mode so
/// the terminal is never left unusable. Only the foreground process is honored.
pub fn tty_set_raw(raw: bool) -> u16 {
    let mut w = W::new();
    w.u8(TTY_SET_RAW);
    w.u8(u8::from(raw));
    let resp = call(&w.0);
    rd_u16(&resp, 0)
}

// --- M4: process introspection + control (ps/top, FR-33; renice, FR-8) ---

/// Process state as reported by `proc_list`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProcState {
    New,
    Ready,
    Running,
    Blocked,
    Zombie,
    Unknown,
}

impl ProcState {
    /// A short label for `ps`/`top` output.
    pub fn label(self) -> &'static str {
        match self {
            ProcState::New => "new",
            ProcState::Ready => "ready",
            ProcState::Running => "run",
            ProcState::Blocked => "blocked",
            ProcState::Zombie => "zombie",
            ProcState::Unknown => "?",
        }
    }
}

/// A live process-table entry (M4 `ps`/`top`).
#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub state: ProcState,
    pub priority: u8,
    /// Scheduler ticks accounted (one per serviced syscall) — kernel activity.
    pub cpu_ticks: u64,
    pub mem_bytes: u32,
    /// Parent pid, or 0 for a host-spawned root.
    pub parent: u32,
}

/// `proc_list()` — snapshot the live process table (FR-33). Returns every process
/// with its state, priority, CPU-activity ticks, memory, and parent.
pub fn proc_list() -> Vec<ProcInfo> {
    // The table can be large (many processes); use a generous response buffer.
    let req = [PROC_LIST];
    let mut resp = vec![0u8; 16 * 1024];
    let n = unsafe { syscall(req.as_ptr(), req.len(), resp.as_mut_ptr(), resp.len()) };
    resp.truncate(n.min(resp.len()));
    if resp.len() < 6 || rd_u16(&resp, 0) != 0 {
        return Vec::new();
    }
    let count = rd_u32(&resp, 2) as usize;
    let mut out = Vec::with_capacity(count);
    let mut off = 6usize;
    for _ in 0..count {
        if off + 8 > resp.len() {
            break;
        }
        let pid = rd_u32(&resp, off);
        let nlen = rd_u32(&resp, off + 4) as usize;
        off += 8;
        if off + nlen + 18 > resp.len() {
            break;
        }
        let name = String::from_utf8_lossy(&resp[off..off + nlen]).into_owned();
        off += nlen;
        let state = match resp[off] {
            0 => ProcState::New,
            1 => ProcState::Ready,
            2 => ProcState::Running,
            3 => ProcState::Blocked,
            4 => ProcState::Zombie,
            _ => ProcState::Unknown,
        };
        let priority = resp[off + 1];
        let cpu_ticks = rd_u64(&resp, off + 2);
        let mem_bytes = rd_u32(&resp, off + 10);
        let parent = rd_u32(&resp, off + 14);
        off += 18;
        out.push(ProcInfo { pid, name, state, priority, cpu_ticks, mem_bytes, parent });
    }
    out
}

/// `set_priority(pid, priority)` — renice a process (FR-8). Reniceing another
/// process requires the Signal capability; reniceing self is always allowed.
/// Returns the kernel errno (0 = success).
pub fn set_priority(pid: u32, priority: u8) -> u16 {
    let mut w = W::new();
    w.u8(SET_PRIORITY);
    w.u32(pid);
    w.u8(priority);
    rd_u16(&call(&w.0), 0)
}

// --- M4-T3: message channels (named bidirectional message queues) ---

/// `chan_open(name)` — open or connect a named message channel (M4). The first
/// opener creates it (endpoint 0); the second connects (endpoint 1). Returns the
/// opaque `(chan_id, end)` handle, or the kernel errno.
pub fn chan_open(name: &str) -> Result<(u32, u8), u16> {
    let mut req = Vec::with_capacity(1 + name.len());
    req.push(CHAN_OPEN);
    req.extend_from_slice(name.as_bytes());
    let resp = call(&req);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok((rd_u32(&resp, 2), resp[6]))
}

/// `chan_send(chan_id, msg)` — send one message to the peer endpoint (preserving
/// message boundaries). Returns the kernel errno (0 = success; EPIPE if the peer
/// is permanently gone).
pub fn chan_send(chan_id: u32, msg: &[u8]) -> u16 {
    let mut req = Vec::with_capacity(5 + msg.len());
    req.push(CHAN_SEND);
    req.extend_from_slice(&chan_id.to_le_bytes());
    req.extend_from_slice(msg);
    rd_u16(&call(&req), 0)
}

/// `chan_recv(chan_id)` — receive one message (M4). **Blocks** until a message
/// arrives; an empty `Ok(vec)` means EOF (the peer closed and the inbox drained).
pub fn chan_recv(chan_id: u32) -> Result<Vec<u8>, u16> {
    let mut req = vec![CHAN_RECV];
    req.extend_from_slice(&chan_id.to_le_bytes());
    // Messages can be larger than the default reply buffer; use a generous one.
    let mut resp = vec![0u8; 16 * 1024];
    let n = unsafe { syscall(req.as_ptr(), req.len(), resp.as_mut_ptr(), resp.len()) };
    resp.truncate(n.min(resp.len()));
    if resp.len() < 6 {
        return Err(if resp.len() >= 2 { rd_u16(&resp, 0) } else { 28 });
    }
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    let len = rd_u32(&resp, 2) as usize;
    Ok(resp.get(6..6 + len).map(|s| s.to_vec()).unwrap_or_default())
}

// --- M4-T4: shared memory (capability-gated, kernel-arbitrated region, FR-6) ---

/// `shm_create(size)` — create a shared-memory region of `size` bytes (M4). The
/// caller owns it and is granted access; it may [`shm_grant`] other processes.
/// Returns the `shm_id`, or the kernel errno.
pub fn shm_create(size: u32) -> Result<u32, u16> {
    let mut req = vec![SHM_CREATE];
    req.extend_from_slice(&size.to_le_bytes());
    let resp = call(&req);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok(rd_u32(&resp, 2))
}

/// `shm_map(shm_id)` — confirm this process holds access to the region (granted by
/// its owner). Returns the kernel errno (0 = mapped; NOTCAPABLE if not granted).
pub fn shm_map(shm_id: u32) -> u16 {
    let mut req = vec![SHM_MAP];
    req.extend_from_slice(&shm_id.to_le_bytes());
    rd_u16(&call(&req), 0)
}

/// `shm_read(shm_id, off, len)` — copy up to `len` bytes from the region (M4).
/// Returns the bytes (clipped to the region), or the kernel errno (NOTCAPABLE if
/// access was not granted).
pub fn shm_read(shm_id: u32, off: u32, len: u32) -> Result<Vec<u8>, u16> {
    let mut req = vec![SHM_READ];
    req.extend_from_slice(&shm_id.to_le_bytes());
    req.extend_from_slice(&off.to_le_bytes());
    req.extend_from_slice(&len.to_le_bytes());
    let mut resp = vec![0u8; 64 * 1024];
    let n = unsafe { syscall(req.as_ptr(), req.len(), resp.as_mut_ptr(), resp.len()) };
    resp.truncate(n.min(resp.len()));
    if resp.len() < 6 {
        return Err(if resp.len() >= 2 { rd_u16(&resp, 0) } else { 28 });
    }
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    let got = rd_u32(&resp, 2) as usize;
    Ok(resp.get(6..6 + got).map(|s| s.to_vec()).unwrap_or_default())
}

/// `shm_write(shm_id, off, data)` — copy `data` into the region at `off` (clipped
/// to the region). Returns the kernel errno (NOTCAPABLE if access not granted).
pub fn shm_write(shm_id: u32, off: u32, data: &[u8]) -> u16 {
    let mut req = Vec::with_capacity(9 + data.len());
    req.push(SHM_WRITE);
    req.extend_from_slice(&shm_id.to_le_bytes());
    req.extend_from_slice(&off.to_le_bytes());
    req.extend_from_slice(data);
    rd_u16(&call(&req), 0)
}

/// `shm_grant(shm_id, target_pid)` — share access to a region this process owns
/// with another process. Returns the kernel errno (NOTCAPABLE if not the owner).
pub fn shm_grant(shm_id: u32, target_pid: u32) -> u16 {
    let mut req = vec![SHM_GRANT];
    req.extend_from_slice(&shm_id.to_le_bytes());
    req.extend_from_slice(&target_pid.to_le_bytes());
    rd_u16(&call(&req), 0)
}

// --- M4-T5: signals (SIGTERM cooperative + SIGKILL forceful, Signal cap) ---

/// `kill(target_pid, sig)` — send a signal to a process (M4-T5). Signalling
/// another process requires the Signal capability (self always allowed). Use
/// [`SIGTERM`] for a cooperative graceful stop (the target must `sig_wait`) or
/// [`SIGKILL`] for an uncatchable forceful kill. Returns the kernel errno
/// (NOTCAPABLE without Signal, SRCH=71 for an unknown pid).
pub fn kill(target_pid: u32, sig: u8) -> u16 {
    let mut req = vec![KILL];
    req.extend_from_slice(&target_pid.to_le_bytes());
    req.push(sig);
    rd_u16(&call(&req), 0)
}

/// `sig_wait()` — block until at least one signal is pending for this process,
/// then drain + return them (M4-T5). Zero-CPU: the process parks until a signal
/// is delivered. A cooperative guest loops on this and exits when it sees
/// [`SIGTERM`].
pub fn sig_wait() -> Vec<u8> {
    let resp = call(&[SIG_WAIT]);
    if resp.len() < 6 || rd_u16(&resp, 0) != 0 {
        return Vec::new();
    }
    let count = rd_u32(&resp, 2) as usize;
    resp.get(6..6 + count).map(|s| s.to_vec()).unwrap_or_default()
}

// --- M5-T6: brokered networking (the Net capability, OQ-2) ---

/// `net_request(url)` — fetch `url` through the host network broker (M5). Requires
/// the Net capability (default-deny → NOTCAPABLE). Blocks until the fetch completes;
/// returns the response body, or the kernel errno (IO on a fetch failure). The
/// kernel cannot fetch — it parks the caller and the host performs the fetch.
pub fn net_request(url: &str) -> Result<Vec<u8>, u16> {
    let mut req = vec![NET_REQUEST];
    req.extend_from_slice(url.as_bytes());
    // A response can be large; use a generous buffer (one ring payload).
    let mut resp = vec![0u8; 60 * 1024];
    let n = unsafe { syscall(req.as_ptr(), req.len(), resp.as_mut_ptr(), resp.len()) };
    resp.truncate(n.min(resp.len()));
    if resp.len() < 6 {
        return Err(if resp.len() >= 2 { rd_u16(&resp, 0) } else { 29 });
    }
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    let len = rd_u32(&resp, 2) as usize;
    Ok(resp.get(6..6 + len).map(|s| s.to_vec()).unwrap_or_default())
}

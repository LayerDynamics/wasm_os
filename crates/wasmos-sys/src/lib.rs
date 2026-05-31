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

/// Spawn a child process from a VFS image with argv and stdio wiring. Returns
/// the child PID, or the kernel errno on failure.
pub fn spawn(
    path: &str,
    argv: &[&str],
    stdio: &[Stdio; 3],
    cwd: &str,
    grant_gpu: bool,
    grant_input: bool,
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
    // Capability delegation (M3): ask the kernel to also grant the child Gpu/Input
    // (only honoured if THIS process holds them). Coreutils pass false/false.
    w.u8(grant_gpu as u8);
    w.u8(grant_input as u8);
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

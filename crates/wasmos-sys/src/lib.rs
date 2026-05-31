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
const KSPAWN: u8 = 0x20;
const KPIPE: u8 = 0x21;
const KWAIT: u8 = 0x22;

/// How a child's stdio fd (0/1/2) is wired.
pub enum Stdio {
    /// Inherit the interactive terminal (read keystrokes / write to xterm).
    Terminal,
    /// The read end of a pipe (id).
    PipeRead(u32),
    /// The write end of a pipe (id).
    PipeWrite(u32),
    /// A file in the VFS (`write` = open for writing/truncate, used by `>`).
    File { path: String, write: bool },
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
            Stdio::File { path, write } => {
                self.u8(3);
                self.bytes(path.as_bytes());
                self.u8(u8::from(*write));
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
pub fn spawn(path: &str, argv: &[&str], stdio: &[Stdio; 3]) -> Result<u32, u16> {
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
    let resp = call(&w.0);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok(rd_u32(&resp, 2))
}

/// Create a pipe; returns `(read_fd, write_fd)` in this process's fd table.
pub fn pipe() -> Result<(u32, u32), u16> {
    let resp = call(&[KPIPE]);
    let errno = rd_u16(&resp, 0);
    if errno != 0 {
        return Err(errno);
    }
    Ok((rd_u32(&resp, 2), rd_u32(&resp, 6)))
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

//! Core kernel data model: capabilities, process states, the process table,
//! and (M1) the per-process file-descriptor table. The table, capability
//! system, and state machine are real and fully functional — the kernel
//! registers its own `init` process through them at boot, and M1 attaches real
//! WASM instances that drive the fd table through the WASI syscall router.

use std::collections::{BTreeMap, VecDeque};

// ---------------------------------------------------------------------------
// Backends
// ---------------------------------------------------------------------------

/// A backend a path subtree is mounted on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Tmpfs,
    Opfs,
    Idb,
}

// ---------------------------------------------------------------------------
// Capabilities (FR-2, FR-31 — default-deny, unforgeable references)
// ---------------------------------------------------------------------------

/// Access rights for a filesystem capability.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct Rights {
    pub read: bool,
    pub write: bool,
    pub exec: bool,
}

impl Rights {
    pub const R: Rights = Rights { read: true, write: false, exec: false };
    pub const RW: Rights = Rights { read: true, write: true, exec: false };
    pub const RWX: Rights = Rights { read: true, write: true, exec: true };

    /// True if `self` grants at least every right `needed` requires.
    pub fn covers(&self, needed: &Rights) -> bool {
        (self.read || !needed.read) && (self.write || !needed.write) && (self.exec || !needed.exec)
    }
}

/// An unforgeable authority a process holds. Per SPEC-1 §3.3.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Capability {
    /// Access to a filesystem subtree with the given rights.
    FsPath { subtree: String, rights: Rights },
    Net,
    Clock,
    Entropy,
    Input,
    Gpu,
    Spawn,
    Shm,
    Signal,
}

/// True if `requested` lies within (is equal to, or nested under) `holder`.
fn path_within(holder: &str, requested: &str) -> bool {
    if holder == "/" {
        return true;
    }
    let base = holder.trim_end_matches('/');
    requested == base || requested.starts_with(&format!("{base}/"))
}

/// A process's set of granted capabilities. Default-deny: a request is allowed
/// only if a held capability covers it.
#[derive(Clone, Default, Debug)]
pub struct CapabilitySet {
    caps: Vec<Capability>,
}

impl CapabilitySet {
    pub fn grant(&mut self, cap: Capability) {
        if !self.caps.contains(&cap) {
            self.caps.push(cap);
        }
    }

    pub fn revoke(&mut self, cap: &Capability) {
        self.caps.retain(|c| c != cap);
    }

    /// Default-deny authorization check.
    pub fn allows(&self, requested: &Capability) -> bool {
        match requested {
            Capability::FsPath { subtree: req_path, rights: req_rights } => {
                self.caps.iter().any(|held| match held {
                    Capability::FsPath { subtree, rights } => {
                        path_within(subtree, req_path) && rights.covers(req_rights)
                    }
                    _ => false,
                })
            }
            other => self.caps.iter().any(|held| held == other),
        }
    }

    pub fn len(&self) -> usize {
        self.caps.len()
    }

    pub fn is_empty(&self) -> bool {
        self.caps.is_empty()
    }
}

// ---------------------------------------------------------------------------
// File descriptors (FR-4 — the WASI fd surface; per-process, isolated)
// ---------------------------------------------------------------------------

/// What a file descriptor refers to. fds 0/1/2 are the standard streams; fd 3
/// is the preopened root directory (so guest WASI libc can `path_open`); fds
/// >= 4 are opened files/dirs in the VFS.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DescKind {
    Stdin,
    Stdout,                 // captured into Process::stdout
    Stderr,                 // captured into Process::stderr
    Dir { path: String },   // a directory (the preopen "/" or an opened dir)
    File { path: String },  // a regular file backed by the VFS
    PipeRead { id: u32 },   // the read end of a kernel pipe (M2)
    PipeWrite { id: u32 },  // the write end of a kernel pipe (M2)
    Terminal,               // a write end bound to the interactive terminal (M2)
}

/// An open file descriptor: what it points at, the read/write cursor, and the
/// rights it was opened with.
#[derive(Clone, Debug)]
pub struct Descriptor {
    pub kind: DescKind,
    pub offset: u64,
    pub rights: Rights,
}

/// fd number of the preopened root directory (WASI libc scans from fd 3).
pub const PREOPEN_FD: u32 = 3;

// ---------------------------------------------------------------------------
// Process state machine (FR-2, FR-7, FR-34)
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ProcState {
    New,
    Ready,
    Running,
    Blocked,
    Zombie,
}

impl ProcState {
    pub fn as_str(&self) -> &'static str {
        match self {
            ProcState::New => "new",
            ProcState::Ready => "ready",
            ProcState::Running => "running",
            ProcState::Blocked => "blocked",
            ProcState::Zombie => "zombie",
        }
    }
}

/// Why a process is parked on a blocking syscall (M2 park/resume). A parked
/// process stays blocked in `Atomics.wait` while the kworker services others;
/// the matching event returns it in a wakeup list so its syscall is re-driven.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WaitReason {
    /// Blocked reading its own stdin with no buffered data (terminal input).
    Stdin,
    /// Blocked reading an empty pipe (id) whose write end is still open.
    PipeRead(u32),
    /// Blocked writing a full pipe (id) whose read end is still open.
    PipeWrite(u32),
    /// Blocked in `wait()` on a child process (pid) that has not yet exited.
    Wait(u32),
    /// Blocked reading brokered input (keyboard/mouse) with none queued (M3-T3).
    Input,
    /// Blocked receiving on a message channel `(chan_id, end)` with an empty inbox
    /// whose peer is still open (M4-T3).
    ChanRecv(u32, u8),
    /// Blocked in `sig_wait()` with no pending signal; woken when one is delivered
    /// (M4-T5 — zero-CPU signal delivery, no busy-poll).
    SigWait,
}

/// A process table entry. `caps` is the owning capability set (FR-2); `fds` is
/// the per-process descriptor table (FR-4) — isolated from every other process.
#[derive(Clone, Debug)]
pub struct Process {
    pub pid: u32,
    pub name: String,
    pub state: ProcState,
    pub priority: u8,
    pub caps: CapabilitySet,
    pub fds: BTreeMap<u32, Descriptor>,
    pub next_fd: u32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub exit_code: Option<i32>,
    /// Buffered stdin bytes not yet consumed by a `fd_read` (M2).
    pub stdin: VecDeque<u8>,
    /// True once stdin is closed (reads then return EOF instead of parking).
    pub stdin_eof: bool,
    /// Buffered brokered input events (fixed-size records) not yet consumed by a
    /// `win_read_input` (M3-T3). Fed by the compositor for the focused window.
    pub input: VecDeque<u8>,
    /// Set while the process is parked on a blocking syscall (M2 park/resume).
    pub blocked_on: Option<WaitReason>,
    /// Command-line arguments (argv) surfaced via `args_get` (M2). argv[0] is
    /// the program name.
    pub argv: Vec<String>,
    /// Spawning process (M4 `ps`/`top`); `None` for host-spawned roots.
    pub parent: Option<u32>,
    /// Reported guest `WebAssembly.Memory` size in bytes (M4 `top`); 0 until the
    /// process worker reports it after instantiation.
    pub mem_bytes: u32,
    /// Pending signals delivered but not yet consumed via `sig_pending` (M4-T5).
    pub pending_signals: VecDeque<u8>,
    /// Open message channels this process holds: `chan_id -> owned endpoint`
    /// (M4-T3). Opaque handles, not WASI fds.
    pub channels: BTreeMap<u32, u8>,
}

/// Build the standard descriptor table for a fresh process: stdin/stdout/stderr
/// plus the preopened root directory at fd 3. Subsequent opens start at fd 4.
fn std_fds() -> BTreeMap<u32, Descriptor> {
    let mut fds = BTreeMap::new();
    fds.insert(0, Descriptor { kind: DescKind::Stdin, offset: 0, rights: Rights::R });
    fds.insert(1, Descriptor { kind: DescKind::Stdout, offset: 0, rights: Rights::RW });
    fds.insert(2, Descriptor { kind: DescKind::Stderr, offset: 0, rights: Rights::RW });
    fds.insert(
        PREOPEN_FD,
        Descriptor { kind: DescKind::Dir { path: "/".into() }, offset: 0, rights: Rights::RWX },
    );
    fds
}

/// WIT-facing projection of a process (matches wit/control.wit `proc-info`).
/// `cpu_ticks` is filled by the kernel core from the scheduler (M4 `ps`/`top`).
#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub state: String,
    pub priority: u8,
    pub cpu_ticks: u64,
    pub mem_bytes: u32,
    /// Parent pid, or 0 for a host-spawned root.
    pub parent: u32,
}

// ---------------------------------------------------------------------------
// Process table (FR-2)
// ---------------------------------------------------------------------------

/// The process table. Functional at M0: it allocates PIDs, holds capability
/// sets, and drives the state machine. M1 attaches real WASM instances.
pub struct ProcTable {
    procs: Vec<Process>,
    next_pid: u32,
    /// Compositor surfaces (M3). `surface_id -> owning pid`. The kernel is the
    /// surface-id authority (allocated under the Gpu capability in `win_surface`);
    /// the host blits pixels from a per-surface SAB it shares with the owner.
    surface_owners: BTreeMap<u32, u32>,
    next_surface_id: u32,
}

impl Default for ProcTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcTable {
    pub fn new() -> Self {
        // PID 0 is reserved (idle/kernel sentinel); real entries start at 1.
        Self { procs: Vec::new(), next_pid: 1, surface_owners: BTreeMap::new(), next_surface_id: 1 }
    }

    // --- Compositor surfaces (M3) ---

    /// Allocate a new surface id owned by `pid` (called from `win_surface` after
    /// the Gpu capability check). Surface ids are unique across the session.
    pub fn alloc_surface(&mut self, pid: u32) -> u32 {
        let id = self.next_surface_id;
        self.next_surface_id += 1;
        self.surface_owners.insert(id, pid);
        id
    }

    /// Release every surface owned by `pid` (called on process exit, M3-T9), and
    /// return the freed surface ids so the host can tear down their windows.
    pub fn free_surfaces_of(&mut self, pid: u32) -> Vec<u32> {
        let freed: Vec<u32> =
            self.surface_owners.iter().filter(|(_, &p)| p == pid).map(|(&id, _)| id).collect();
        for id in &freed {
            self.surface_owners.remove(id);
        }
        freed
    }

    /// Create a process entry in the `New` state and return its unique PID.
    /// The process starts with the standard descriptor table (stdin/stdout/
    /// stderr + the preopened root dir at fd 3); opens allocate from fd 4.
    pub fn spawn(&mut self, name: &str, priority: u8, caps: CapabilitySet) -> u32 {
        let pid = self.next_pid;
        self.next_pid += 1;
        self.procs.push(Process {
            pid,
            name: name.to_string(),
            state: ProcState::New,
            priority,
            caps,
            fds: std_fds(),
            next_fd: PREOPEN_FD + 1,
            stdout: Vec::new(),
            stderr: Vec::new(),
            exit_code: None,
            stdin: VecDeque::new(),
            stdin_eof: false,
            input: VecDeque::new(),
            blocked_on: None,
            argv: vec![name.to_string()],
            parent: None,
            mem_bytes: 0,
            pending_signals: VecDeque::new(),
            channels: BTreeMap::new(),
        });
        pid
    }

    /// Record that `pid` holds `end` of channel `id` (M4-T3).
    pub fn add_channel(&mut self, pid: u32, id: u32, end: u8) {
        if let Some(p) = self.get_mut(pid) {
            p.channels.insert(id, end);
        }
    }

    /// The endpoint `pid` holds for channel `id`, if any.
    pub fn channel_end(&self, pid: u32, id: u32) -> Option<u8> {
        self.get(pid).and_then(|p| p.channels.get(&id).copied())
    }

    /// All `(chan_id, end)` a process holds — used to release them on exit.
    pub fn channels_of(&self, pid: u32) -> Vec<(u32, u8)> {
        self.get(pid).map(|p| p.channels.iter().map(|(&id, &e)| (id, e)).collect()).unwrap_or_default()
    }

    pub fn get(&self, pid: u32) -> Option<&Process> {
        self.procs.iter().find(|p| p.pid == pid)
    }

    fn get_mut(&mut self, pid: u32) -> Option<&mut Process> {
        self.procs.iter_mut().find(|p| p.pid == pid)
    }

    // --- Per-process file-descriptor table (FR-4) ---

    /// Allocate the next fd (>= 4) for `pid` and bind it to `desc`. Returns the
    /// new fd, or `None` if the pid is unknown.
    pub fn open_fd(&mut self, pid: u32, desc: Descriptor) -> Option<u32> {
        let p = self.get_mut(pid)?;
        let fd = p.next_fd;
        p.next_fd += 1;
        p.fds.insert(fd, desc);
        Some(fd)
    }

    /// Install a descriptor at a specific fd number (used to configure a child's
    /// stdio 0/1/2 at spawn). Replaces any existing descriptor at that fd.
    pub fn set_fd(&mut self, pid: u32, fd: u32, desc: Descriptor) -> bool {
        self.get_mut(pid).map(|p| { p.fds.insert(fd, desc); }).is_some()
    }

    pub fn set_argv(&mut self, pid: u32, argv: Vec<String>) -> bool {
        self.get_mut(pid).map(|p| p.argv = argv).is_some()
    }

    pub fn argv(&self, pid: u32) -> Vec<String> {
        self.get(pid).map(|p| p.argv.clone()).unwrap_or_default()
    }

    pub fn fd(&self, pid: u32, fd: u32) -> Option<&Descriptor> {
        self.get(pid).and_then(|p| p.fds.get(&fd))
    }

    pub fn fd_mut(&mut self, pid: u32, fd: u32) -> Option<&mut Descriptor> {
        self.get_mut(pid).and_then(|p| p.fds.get_mut(&fd))
    }

    /// Close an fd. Returns false if the pid or fd is unknown.
    pub fn close_fd(&mut self, pid: u32, fd: u32) -> bool {
        self.get_mut(pid).is_some_and(|p| p.fds.remove(&fd).is_some())
    }

    /// Append bytes to a process's captured stdout. Returns false if pid unknown.
    pub fn push_stdout(&mut self, pid: u32, bytes: &[u8]) -> bool {
        self.get_mut(pid).map(|p| p.stdout.extend_from_slice(bytes)).is_some()
    }

    /// Append bytes to a process's captured stderr. Returns false if pid unknown.
    pub fn push_stderr(&mut self, pid: u32, bytes: &[u8]) -> bool {
        self.get_mut(pid).map(|p| p.stderr.extend_from_slice(bytes)).is_some()
    }

    /// Drain and return `(stdout, stderr)` for `pid` (empty if unknown).
    pub fn take_capture(&mut self, pid: u32) -> (Vec<u8>, Vec<u8>) {
        match self.get_mut(pid) {
            Some(p) => (std::mem::take(&mut p.stdout), std::mem::take(&mut p.stderr)),
            None => (Vec::new(), Vec::new()),
        }
    }

    /// Record a process's exit code (does not change state; the caller zombifies).
    pub fn set_exit(&mut self, pid: u32, code: i32) -> bool {
        self.get_mut(pid).map(|p| p.exit_code = Some(code)).is_some()
    }

    pub fn exit_code(&self, pid: u32) -> Option<i32> {
        self.get(pid).and_then(|p| p.exit_code)
    }

    // --- Stdin buffer + park/resume state (M2) ---

    /// Append input bytes to a process's stdin buffer (terminal keystrokes).
    pub fn push_stdin(&mut self, pid: u32, bytes: &[u8]) -> bool {
        self.get_mut(pid).map(|p| p.stdin.extend(bytes.iter().copied())).is_some()
    }

    /// Mark a process's stdin as closed (subsequent empty reads return EOF).
    pub fn close_stdin(&mut self, pid: u32) -> bool {
        self.get_mut(pid).map(|p| p.stdin_eof = true).is_some()
    }

    /// Drain up to `max` bytes from the front of a process's stdin buffer.
    pub fn read_stdin(&mut self, pid: u32, max: usize) -> Vec<u8> {
        match self.get_mut(pid) {
            Some(p) => {
                let n = max.min(p.stdin.len());
                p.stdin.drain(..n).collect()
            }
            None => Vec::new(),
        }
    }

    pub fn stdin_len(&self, pid: u32) -> usize {
        self.get(pid).map(|p| p.stdin.len()).unwrap_or(0)
    }

    pub fn stdin_is_eof(&self, pid: u32) -> bool {
        self.get(pid).map(|p| p.stdin_eof).unwrap_or(true)
    }

    // --- Brokered input events (M3-T3) ---

    /// Append brokered input event bytes for a process (compositor → focused win).
    pub fn push_input(&mut self, pid: u32, bytes: &[u8]) -> bool {
        self.get_mut(pid).map(|p| p.input.extend(bytes.iter().copied())).is_some()
    }

    /// Drain up to `max` input bytes from the front of a process's input queue.
    pub fn read_input(&mut self, pid: u32, max: usize) -> Vec<u8> {
        match self.get_mut(pid) {
            Some(p) => {
                let n = max.min(p.input.len());
                p.input.drain(..n).collect()
            }
            None => Vec::new(),
        }
    }

    pub fn input_len(&self, pid: u32) -> usize {
        self.get(pid).map(|p| p.input.len()).unwrap_or(0)
    }

    /// Park a process on a blocking syscall (records why; sets state `Blocked`).
    pub fn set_blocked(&mut self, pid: u32, reason: WaitReason) -> bool {
        if let Some(p) = self.get_mut(pid) {
            p.blocked_on = Some(reason);
            p.state = ProcState::Blocked;
            true
        } else {
            false
        }
    }

    /// Clear a process's parked state (it is runnable again).
    pub fn clear_blocked(&mut self, pid: u32) -> bool {
        if let Some(p) = self.get_mut(pid) {
            p.blocked_on = None;
            if p.state == ProcState::Blocked {
                p.state = ProcState::Running;
            }
            true
        } else {
            false
        }
    }

    pub fn blocked_on(&self, pid: u32) -> Option<WaitReason> {
        self.get(pid).and_then(|p| p.blocked_on.clone())
    }

    /// Find every process parked on `reason`, clear their parked state, and
    /// return their pids (the wakeup list for an event, M2 park/resume).
    pub fn take_blocked_on(&mut self, reason: &WaitReason) -> Vec<u32> {
        let mut woken = Vec::new();
        for p in self.procs.iter_mut() {
            if p.blocked_on.as_ref() == Some(reason) {
                p.blocked_on = None;
                if p.state == ProcState::Blocked {
                    p.state = ProcState::Running;
                }
                woken.push(p.pid);
            }
        }
        woken
    }

    pub fn set_state(&mut self, pid: u32, state: ProcState) -> bool {
        if let Some(p) = self.procs.iter_mut().find(|p| p.pid == pid) {
            p.state = state;
            true
        } else {
            false
        }
    }

    /// Transition a process to `Zombie` (FR-7 kill semantics).
    pub fn kill(&mut self, pid: u32) -> bool {
        self.set_state(pid, ProcState::Zombie)
    }

    /// Remove a zombie from the table, freeing its slot.
    pub fn reap(&mut self, pid: u32) -> bool {
        let before = self.procs.len();
        self.procs.retain(|p| !(p.pid == pid && p.state == ProcState::Zombie));
        self.procs.len() != before
    }

    /// Capability check for a process (FR-31). Unknown PID => deny.
    pub fn has_cap(&self, pid: u32, requested: &Capability) -> bool {
        self.get(pid).is_some_and(|p| p.caps.allows(requested))
    }

    /// Grant a capability to an already-spawned process (M4-T5 — the host confers
    /// Signal on the shell, the user's process-control authority, after spawn).
    pub fn grant_cap(&mut self, pid: u32, cap: Capability) -> bool {
        self.get_mut(pid).map(|p| p.caps.grant(cap)).is_some()
    }

    pub fn count(&self) -> usize {
        self.procs.len()
    }

    pub fn list(&self) -> Vec<ProcInfo> {
        self.procs
            .iter()
            .map(|p| ProcInfo {
                pid: p.pid,
                name: p.name.clone(),
                state: p.state.as_str().to_string(),
                priority: p.priority,
                cpu_ticks: 0, // filled by KernelCore from the scheduler
                mem_bytes: p.mem_bytes,
                parent: p.parent.unwrap_or(0),
            })
            .collect()
    }

    /// Record a process's reported memory size (M4 `top`).
    pub fn set_mem(&mut self, pid: u32, bytes: u32) -> bool {
        self.get_mut(pid).map(|p| p.mem_bytes = bytes).is_some()
    }

    /// Record a process's parent (M4 `ps` tree). Set by guest spawn (k_spawn).
    pub fn set_parent(&mut self, pid: u32, parent: u32) -> bool {
        self.get_mut(pid).map(|p| p.parent = Some(parent)).is_some()
    }

    /// Change a process's scheduling priority (FR-8). Returns the old priority so
    /// the caller can re-bucket it in the scheduler if it is ready.
    pub fn set_priority(&mut self, pid: u32, priority: u8) -> Option<u8> {
        self.get_mut(pid).map(|p| {
            let old = p.priority;
            p.priority = priority;
            old
        })
    }

    /// Push a pending signal for a process; returns false if the pid is unknown.
    pub fn push_signal(&mut self, pid: u32, sig: u8) -> bool {
        self.get_mut(pid).map(|p| p.pending_signals.push_back(sig)).is_some()
    }

    /// Drain and return a process's pending signals (consumed by `sig_pending`).
    pub fn take_signals(&mut self, pid: u32) -> Vec<u8> {
        match self.get_mut(pid) {
            Some(p) => p.pending_signals.drain(..).collect(),
            None => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rights_cover_correctly() {
        assert!(Rights::RWX.covers(&Rights::RW));
        assert!(Rights::RW.covers(&Rights::R));
        assert!(!Rights::R.covers(&Rights::RW));
        assert!(!Rights::RW.covers(&Rights::RWX));
    }

    #[test]
    fn capability_set_is_default_deny() {
        let caps = CapabilitySet::default();
        assert!(!caps.allows(&Capability::Net));
        assert!(!caps.allows(&Capability::FsPath { subtree: "/home".into(), rights: Rights::R }));
    }

    #[test]
    fn fs_capability_respects_subtree_and_rights() {
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/home/user".into(), rights: Rights::RW });
        // within subtree, rights covered
        assert!(caps.allows(&Capability::FsPath { subtree: "/home/user/a.txt".into(), rights: Rights::R }));
        assert!(caps.allows(&Capability::FsPath { subtree: "/home/user".into(), rights: Rights::RW }));
        // outside subtree
        assert!(!caps.allows(&Capability::FsPath { subtree: "/etc".into(), rights: Rights::R }));
        // escalated rights denied
        assert!(!caps.allows(&Capability::FsPath { subtree: "/home/user/a".into(), rights: Rights::RWX }));
    }

    #[test]
    fn root_capability_covers_everything() {
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
        assert!(caps.allows(&Capability::FsPath { subtree: "/any/deep/path".into(), rights: Rights::RW }));
    }

    #[test]
    fn grant_and_revoke() {
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::Spawn);
        assert!(caps.allows(&Capability::Spawn));
        caps.grant(Capability::Spawn); // idempotent
        assert_eq!(caps.len(), 1);
        caps.revoke(&Capability::Spawn);
        assert!(!caps.allows(&Capability::Spawn));
        assert!(caps.is_empty());
    }

    #[test]
    fn proctable_assigns_unique_increasing_pids() {
        let mut t = ProcTable::new();
        let a = t.spawn("a", 5, CapabilitySet::default());
        let b = t.spawn("b", 5, CapabilitySet::default());
        assert_eq!(a, 1);
        assert_eq!(b, 2);
        assert_ne!(a, b);
        assert_eq!(t.count(), 2);
    }

    #[test]
    fn proctable_state_transitions_and_reaping() {
        let mut t = ProcTable::new();
        let pid = t.spawn("p", 5, CapabilitySet::default());
        assert_eq!(t.get(pid).unwrap().state, ProcState::New);
        assert!(t.set_state(pid, ProcState::Ready));
        assert!(t.set_state(pid, ProcState::Running));
        assert!(t.kill(pid));
        assert_eq!(t.get(pid).unwrap().state, ProcState::Zombie);
        assert!(t.reap(pid));
        assert!(t.get(pid).is_none());
        assert_eq!(t.count(), 0);
        // reaping a non-zombie / missing pid is a no-op
        assert!(!t.reap(999));
    }

    #[test]
    fn has_cap_checks_the_named_process_and_denies_unknown() {
        let mut t = ProcTable::new();
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::Spawn);
        let pid = t.spawn("init", 10, caps);
        assert!(t.has_cap(pid, &Capability::Spawn));
        assert!(!t.has_cap(pid, &Capability::Net));
        assert!(!t.has_cap(424242, &Capability::Spawn)); // unknown pid => deny
    }

    // --- M1: per-process fd table (FR-4) ---

    #[test]
    fn spawn_preopens_std_fds() {
        let mut t = ProcTable::new();
        let pid = t.spawn("p", 5, CapabilitySet::default());
        assert_eq!(t.fd(pid, 0).unwrap().kind, DescKind::Stdin);
        assert_eq!(t.fd(pid, 1).unwrap().kind, DescKind::Stdout);
        assert_eq!(t.fd(pid, 2).unwrap().kind, DescKind::Stderr);
        // fd 3 is the preopened root directory (so guest WASI libc can path_open).
        assert_eq!(t.fd(pid, PREOPEN_FD).unwrap().kind, DescKind::Dir { path: "/".into() });
        // No fd 4 yet.
        assert!(t.fd(pid, 4).is_none());
    }

    #[test]
    fn open_fd_allocates_increasing_fds_from_4() {
        let mut t = ProcTable::new();
        let pid = t.spawn("p", 5, CapabilitySet::default());
        let a = t.open_fd(pid, Descriptor { kind: DescKind::File { path: "/a".into() }, offset: 0, rights: Rights::R }).unwrap();
        let b = t.open_fd(pid, Descriptor { kind: DescKind::File { path: "/b".into() }, offset: 0, rights: Rights::R }).unwrap();
        assert_eq!(a, 4); // first open is fd 4 (0/1/2 std + 3 preopen)
        assert_eq!(b, 5);
        assert_eq!(t.fd(pid, a).unwrap().kind, DescKind::File { path: "/a".into() });
        assert!(t.open_fd(999, Descriptor { kind: DescKind::File { path: "/x".into() }, offset: 0, rights: Rights::R }).is_none());
    }

    #[test]
    fn fd_tables_are_per_process_and_do_not_alias() {
        let mut t = ProcTable::new();
        let a = t.spawn("a", 5, CapabilitySet::default());
        let b = t.spawn("b", 5, CapabilitySet::default());
        let fda = t.open_fd(a, Descriptor { kind: DescKind::File { path: "/secret".into() }, offset: 0, rights: Rights::RW }).unwrap();
        // B's table is unaffected by A's open.
        assert!(t.fd(b, fda).is_none());
        // Closing A's fd does not touch B.
        assert!(t.close_fd(a, fda));
        assert!(t.fd(a, fda).is_none());
        // B still has exactly its standard fds.
        assert_eq!(t.fd(b, 1).unwrap().kind, DescKind::Stdout);
    }

    #[test]
    fn stdout_capture_accumulates_and_drains() {
        let mut t = ProcTable::new();
        let pid = t.spawn("p", 5, CapabilitySet::default());
        assert!(t.push_stdout(pid, b"hello "));
        assert!(t.push_stdout(pid, b"world"));
        assert!(t.push_stderr(pid, b"warn"));
        let (out, err) = t.take_capture(pid);
        assert_eq!(out, b"hello world");
        assert_eq!(err, b"warn");
        // Drained: a second take returns empty.
        let (out2, err2) = t.take_capture(pid);
        assert!(out2.is_empty() && err2.is_empty());
        // Unknown pid is a no-op, not a panic.
        assert!(!t.push_stdout(999, b"x"));
        assert_eq!(t.take_capture(999), (Vec::new(), Vec::new()));
    }

    #[test]
    fn set_and_read_exit_code() {
        let mut t = ProcTable::new();
        let pid = t.spawn("p", 5, CapabilitySet::default());
        assert_eq!(t.exit_code(pid), None); // not exited
        assert!(t.set_exit(pid, 0));
        assert_eq!(t.exit_code(pid), Some(0));
        assert!(t.set_exit(pid, 42));
        assert_eq!(t.exit_code(pid), Some(42));
        assert!(!t.set_exit(999, 1)); // unknown pid
        assert_eq!(t.exit_code(999), None);
    }
}

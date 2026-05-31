//! Kernel core: the host-independent kernel logic (VFS + process table +
//! scheduler + capabilities) wired together. The WASM `component` layer in
//! `lib.rs` is a thin WIT adapter over this; `cargo test` exercises it directly
//! on the host with an in-memory blockstore.

use crate::pipe::PipeTable;
use crate::sched::Scheduler;
use crate::syscall;
use crate::types::{
    Backend, Capability, CapabilitySet, DescKind, ProcInfo, ProcState, ProcTable, Rights,
};
use crate::vfs::{Blockstore, FsError, Vfs};

/// Default scheduling priority for user processes spawned at M1 (init is 10).
const USER_PRIORITY: u8 = 5;

pub struct KernelCore {
    vfs: Vfs,
    procs: ProcTable,
    sched: Scheduler,
    pipes: PipeTable,
    booted: bool,
}

impl KernelCore {
    pub fn new(home: Box<dyn Blockstore>, mnt: Box<dyn Blockstore>) -> Self {
        Self {
            vfs: Vfs::new(home, mnt),
            procs: ProcTable::new(),
            sched: Scheduler::new(),
            pipes: PipeTable::new(),
            booted: false,
        }
    }

    /// Idempotent boot: mount the standard layout and register the kernel
    /// `init` process, driving it New -> Ready -> Running through the scheduler.
    /// This exercises the capability system, process table, and scheduler live.
    pub fn boot(&mut self) {
        if self.booted {
            return;
        }
        let _ = self.vfs.mount("/home", Backend::Opfs);
        let _ = self.vfs.mount("/mnt", Backend::Idb);

        // init holds full FS rights and the right to spawn (it launches the
        // userland in M1). Registering it drives the full M0 process path.
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
        caps.grant(Capability::Spawn);

        let init = self.procs.spawn("init", 10, caps);
        self.procs.set_state(init, ProcState::Ready);
        self.sched.enqueue(init, 10);
        if let Some(pid) = self.sched.pick_next() {
            self.procs.set_state(pid, ProcState::Running);
            self.sched.account(pid, 1);
        }
        self.booted = true;
    }

    pub fn is_booted(&self) -> bool {
        self.booted
    }

    // --- VFS surface (delegates) ---
    pub fn mount(&mut self, path: &str, on: Backend) -> Result<(), FsError> {
        self.vfs.mount(path, on)
    }
    pub fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), FsError> {
        self.vfs.write(path, bytes)
    }
    pub fn read(&self, path: &str) -> Result<Vec<u8>, FsError> {
        self.vfs.read(path)
    }
    pub fn list(&self, path: &str) -> Result<Vec<String>, FsError> {
        self.vfs.list(path)
    }
    pub fn delete(&mut self, path: &str) -> Result<(), FsError> {
        self.vfs.delete(path)
    }

    // --- Process/scheduler/capability surface ---
    pub fn list_procs(&self) -> Vec<ProcInfo> {
        self.procs.list()
    }
    pub fn proc_count(&self) -> usize {
        self.procs.count()
    }
    pub fn ready_count(&self) -> usize {
        self.sched.ready_len()
    }
    /// Authorization check for a process against a capability (FR-31).
    pub fn check_cap(&self, pid: u32, cap: &Capability) -> bool {
        self.procs.has_cap(pid, cap)
    }

    // --- Process lifecycle (M1, FR-5) ---

    /// Allocate a process with a minimal capability set and make it `Ready`
    /// (enqueued on the scheduler). `grant_fs` is an optional `(subtree, rights)`
    /// FS grant; `grant_spawn` confers the right to spawn children. The kernel
    /// **never** grants `Shm` here — there is no inter-process memory path at M1
    /// (the structural half of the isolation guarantee, FR-6).
    pub fn spawn(&mut self, name: &str, grant_fs: Option<(&str, Rights)>, grant_spawn: bool) -> u32 {
        let mut caps = CapabilitySet::default();
        if let Some((subtree, rights)) = grant_fs {
            caps.grant(Capability::FsPath { subtree: subtree.to_string(), rights });
        }
        if grant_spawn {
            caps.grant(Capability::Spawn);
        }
        let pid = self.procs.spawn(name, USER_PRIORITY, caps);
        self.procs.set_state(pid, ProcState::Ready);
        self.sched.enqueue(pid, USER_PRIORITY);
        pid
    }

    /// Route one syscall for `pid` (FR-4). Returns a [`syscall::SyscallOutcome`]
    /// — a ready reply, or a park (M2) the kworker defers until a wakeup.
    pub fn service_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        syscall::dispatch(&mut self.vfs, &mut self.procs, &mut self.pipes, pid, req)
    }

    /// Bind a process's stdout + stderr (fd 1/2) to the interactive terminal so
    /// its writes stream to xterm (M2). fd 0 stays stdin, fed by `deliver_stdin`.
    pub fn bind_terminal(&mut self, pid: u32) {
        if let Some(d) = self.procs.fd_mut(pid, 1) {
            d.kind = DescKind::Terminal;
        }
        if let Some(d) = self.procs.fd_mut(pid, 2) {
            d.kind = DescKind::Terminal;
        }
    }

    /// Deliver input bytes to a process's stdin (terminal keystrokes, M2).
    /// Returns the pids whose parked stdin reads are now runnable.
    pub fn deliver_stdin(&mut self, pid: u32, bytes: &[u8]) -> Vec<u32> {
        self.procs.push_stdin(pid, bytes);
        if self.procs.blocked_on(pid) == Some(crate::types::WaitReason::Stdin) {
            self.procs.clear_blocked(pid);
            vec![pid]
        } else {
            vec![]
        }
    }

    /// The process's exit code, if it has exited (FR-5 `wait`).
    pub fn exit_code(&self, pid: u32) -> Option<i32> {
        self.procs.exit_code(pid)
    }

    /// Drain and return a process's captured `(stdout, stderr)`.
    pub fn take_capture(&mut self, pid: u32) -> (Vec<u8>, Vec<u8>) {
        self.procs.take_capture(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct MemStore(BTreeMap<String, Vec<u8>>);
    impl Blockstore for MemStore {
        fn get(&self, k: &str) -> Option<Vec<u8>> { self.0.get(k).cloned() }
        fn put(&mut self, k: &str, v: Vec<u8>) -> bool { self.0.insert(k.into(), v); true }
        fn list(&self, p: &str) -> Vec<String> {
            self.0.keys().filter(|k| k.starts_with(p)).cloned().collect()
        }
        fn delete(&mut self, k: &str) -> bool { self.0.remove(k).is_some() }
    }

    fn core() -> KernelCore {
        KernelCore::new(Box::new(MemStore::default()), Box::new(MemStore::default()))
    }

    #[test]
    fn boot_registers_init_running_with_capabilities() {
        let mut k = core();
        assert!(!k.is_booted());
        k.boot();
        assert!(k.is_booted());

        let procs = k.list_procs();
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].name, "init");
        assert_eq!(procs[0].state, "running"); // scheduler picked it
        assert_eq!(procs[0].pid, 1);

        // init's capabilities are real and enforced (default-deny otherwise).
        assert!(k.check_cap(1, &Capability::Spawn));
        assert!(k.check_cap(1, &Capability::FsPath { subtree: "/home/x".into(), rights: Rights::RW }));
        assert!(!k.check_cap(1, &Capability::Net)); // not granted
    }

    #[test]
    fn boot_is_idempotent() {
        let mut k = core();
        k.boot();
        k.boot();
        assert_eq!(k.proc_count(), 1); // not re-registered
    }

    #[test]
    fn boot_mounts_all_three_backends_and_routes_writes() {
        let mut k = core();
        k.boot();
        k.write("/scratch", b"t".to_vec()).unwrap(); // tmpfs
        k.write("/home/a", b"h".to_vec()).unwrap();   // opfs
        k.write("/mnt/b", b"m".to_vec()).unwrap();    // idb
        assert_eq!(k.read("/scratch").unwrap(), b"t");
        assert_eq!(k.read("/home/a").unwrap(), b"h");
        assert_eq!(k.read("/mnt/b").unwrap(), b"m");
    }

    // --- M1: process lifecycle (FR-5) ---

    /// Encode a syscall request the way the host JS shim does (op byte + LE fields).
    fn fd_write_req(fd: u32, data: &[u8]) -> Vec<u8> {
        let mut v = vec![0x01u8]; // Op::FdWrite
        v.extend_from_slice(&fd.to_le_bytes());
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        v
    }
    fn proc_exit_req(code: u32) -> Vec<u8> {
        let mut v = vec![0x10u8]; // Op::ProcExit
        v.extend_from_slice(&code.to_le_bytes());
        v
    }
    fn fd_read_req(fd: u32, len: u32) -> Vec<u8> {
        let mut v = vec![0x02u8]; // Op::FdRead
        v.extend_from_slice(&fd.to_le_bytes());
        v.extend_from_slice(&len.to_le_bytes());
        v
    }

    #[test]
    fn spawn_then_service_fd_write_then_exit() {
        let mut k = core();
        k.boot();
        let pid = k.spawn("hello", Some(("/", Rights::RW)), false);
        assert!(pid > 1); // init is pid 1
        // Process is Ready and enqueued.
        assert!(k.ready_count() >= 1);
        // Route an fd_write to stdout, then proc_exit(0).
        let resp = k.service_syscall(pid, &fd_write_req(1, b"hi")).reply.expect("ready");
        assert_eq!(u16::from_le_bytes([resp[0], resp[1]]), 0); // SUCCESS
        k.service_syscall(pid, &proc_exit_req(0));
        let (out, _err) = k.take_capture(pid);
        assert_eq!(out, b"hi");
        assert_eq!(k.exit_code(pid), Some(0));
    }

    #[test]
    fn stdin_read_parks_then_deliver_wakes_and_redrives() {
        let mut k = core();
        k.boot();
        let pid = k.spawn("reader", Some(("/", Rights::RW)), false);
        let req = fd_read_req(0, 16); // read stdin (fd 0)

        // No input yet → the syscall PARKS (no reply).
        assert!(k.service_syscall(pid, &req).reply.is_none());

        // Deliver input → the parked reader is woken.
        assert_eq!(k.deliver_stdin(pid, b"hi\n"), vec![pid]);

        // Re-driving the SAME request now returns the delivered bytes.
        let resp = k.service_syscall(pid, &req).reply.expect("ready after deliver");
        assert_eq!(u16::from_le_bytes([resp[0], resp[1]]), 0); // SUCCESS
        let n = u32::from_le_bytes([resp[2], resp[3], resp[4], resp[5]]) as usize;
        assert_eq!(&resp[6..6 + n], b"hi\n");

        // Delivering to a process that is NOT parked yields no wakeups.
        assert!(k.deliver_stdin(pid, b"more").is_empty());
    }

    #[test]
    fn bind_terminal_streams_writes_as_term_output() {
        let mut k = core();
        k.boot();
        let pid = k.spawn("shell", Some(("/", Rights::RW)), false);
        k.bind_terminal(pid);
        // A write to fd 1 (now Terminal) streams out as term_output (→ xterm),
        // and is NOT accumulated in the at-exit capture buffer.
        let out = k.service_syscall(pid, &fd_write_req(1, b"prompt$ "));
        assert_eq!(out.term_output, b"prompt$ ");
        assert_eq!(read_u16(&out.reply.expect("ready")), 0); // SUCCESS
        let (cap, _) = k.take_capture(pid);
        assert!(cap.is_empty());
    }

    fn read_u16(b: &[u8]) -> u16 {
        u16::from_le_bytes([b[0], b[1]])
    }

    #[test]
    fn two_spawns_have_isolated_fd_tables_and_no_shm_cap() {
        let mut k = core();
        k.boot();
        let a = k.spawn("a", Some(("/home", Rights::RW)), false);
        let b = k.spawn("b", Some(("/home", Rights::RW)), false);
        assert_ne!(a, b);
        // Neither holds Shm — there is no inter-process memory path (FR-6).
        assert!(!k.check_cap(a, &Capability::Shm));
        assert!(!k.check_cap(b, &Capability::Shm));
        // Each has exactly the FS grant it asked for, nothing more.
        assert!(k.check_cap(a, &Capability::FsPath { subtree: "/home/x".into(), rights: Rights::R }));
        assert!(!k.check_cap(a, &Capability::FsPath { subtree: "/mnt".into(), rights: Rights::R }));
    }

    #[test]
    fn spawn_grants_only_requested_caps() {
        let mut k = core();
        k.boot();
        // No FS grant, no spawn grant → default-deny everything.
        let pid = k.spawn("bare", None, false);
        assert!(!k.check_cap(pid, &Capability::Spawn));
        assert!(!k.check_cap(pid, &Capability::Shm));
        assert!(!k.check_cap(pid, &Capability::FsPath { subtree: "/".into(), rights: Rights::R }));
        // With spawn grant.
        let p2 = k.spawn("launcher", None, true);
        assert!(k.check_cap(p2, &Capability::Spawn));
    }
}

//! Kernel core: the host-independent kernel logic (VFS + process table +
//! scheduler + capabilities) wired together. The WASM `component` layer in
//! `lib.rs` is a thin WIT adapter over this; `cargo test` exercises it directly
//! on the host with an in-memory blockstore.

use crate::sched::Scheduler;
use crate::types::{Backend, Capability, CapabilitySet, ProcInfo, ProcState, ProcTable, Rights};
use crate::vfs::{Blockstore, FsError, Vfs};

pub struct KernelCore {
    vfs: Vfs,
    procs: ProcTable,
    sched: Scheduler,
    booted: bool,
}

impl KernelCore {
    pub fn new(home: Box<dyn Blockstore>, mnt: Box<dyn Blockstore>) -> Self {
        Self {
            vfs: Vfs::new(home, mnt),
            procs: ProcTable::new(),
            sched: Scheduler::new(),
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
}

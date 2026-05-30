//! Core kernel data model for M0. No processes run yet; the table exists so
//! the structure is in place for M1.

/// A backend a path subtree is mounted on.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Backend {
    Tmpfs,
    Opfs,
    Idb,
}

#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub state: String,
}

/// The process table. Empty at M0 but real — M1 adds spawn().
#[derive(Default)]
pub struct ProcTable {
    procs: Vec<ProcInfo>,
}

impl ProcTable {
    pub fn list(&self) -> Vec<ProcInfo> {
        self.procs.clone()
    }
}

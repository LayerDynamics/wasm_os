//! Core kernel data model for M0: capabilities, process states, the process
//! table. No WASM process is *executed* at M0 (that is M1/FR-5), but the table,
//! capability system, and state machine are real and fully functional — the
//! kernel registers its own `init` process through them at boot.

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

/// A process table entry. `caps` is the owning capability set (FR-2).
#[derive(Clone, Debug)]
pub struct Process {
    pub pid: u32,
    pub name: String,
    pub state: ProcState,
    pub priority: u8,
    pub caps: CapabilitySet,
}

/// WIT-facing projection of a process (matches wit/control.wit `proc-info`).
#[derive(Clone, Debug)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub state: String,
}

// ---------------------------------------------------------------------------
// Process table (FR-2)
// ---------------------------------------------------------------------------

/// The process table. Functional at M0: it allocates PIDs, holds capability
/// sets, and drives the state machine. M1 attaches real WASM instances.
pub struct ProcTable {
    procs: Vec<Process>,
    next_pid: u32,
}

impl Default for ProcTable {
    fn default() -> Self {
        Self::new()
    }
}

impl ProcTable {
    pub fn new() -> Self {
        // PID 0 is reserved (idle/kernel sentinel); real entries start at 1.
        Self { procs: Vec::new(), next_pid: 1 }
    }

    /// Create a process entry in the `New` state and return its unique PID.
    pub fn spawn(&mut self, name: &str, priority: u8, caps: CapabilitySet) -> u32 {
        let pid = self.next_pid;
        self.next_pid += 1;
        self.procs.push(Process {
            pid,
            name: name.to_string(),
            state: ProcState::New,
            priority,
            caps,
        });
        pid
    }

    pub fn get(&self, pid: u32) -> Option<&Process> {
        self.procs.iter().find(|p| p.pid == pid)
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

    pub fn count(&self) -> usize {
        self.procs.len()
    }

    pub fn list(&self) -> Vec<ProcInfo> {
        self.procs
            .iter()
            .map(|p| ProcInfo { pid: p.pid, name: p.name.clone(), state: p.state.as_str().to_string() })
            .collect()
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
}

//! Shared memory (M4) — an explicit, capability-gated region shared between
//! processes (the only inter-process memory path, FR-6).
//!
//! A wasm guest cannot map an external buffer into its own linear memory, so a
//! shm region is a kernel-arbitrated byte buffer accessed via `shm_read`/
//! `shm_write` syscalls (copy in/out) rather than a literal `(ptr,len)` mapping.
//! Access is default-deny: the creator is granted access; it may `grant` other
//! processes. This preserves isolation (a process can only touch a region it was
//! explicitly granted) while delivering real shared memory.

use std::collections::{BTreeMap, BTreeSet};

/// Largest shm region (fits one SAB ring payload, so a read/write is one syscall).
pub const MAX_SHM_SIZE: usize = 60 * 1024;

#[derive(Default)]
pub struct ShmTable {
    regions: BTreeMap<u32, Vec<u8>>,
    owners: BTreeMap<u32, u32>,
    /// `shm_id -> pids granted access` (the explicit shared-memory capability, FR-6).
    granted: BTreeMap<u32, BTreeSet<u32>>,
    next_id: u32,
}

impl ShmTable {
    pub fn new() -> Self {
        Self { regions: BTreeMap::new(), owners: BTreeMap::new(), granted: BTreeMap::new(), next_id: 1 }
    }

    /// Create a zeroed region of `size` bytes owned by (and accessible to) `pid`.
    pub fn create(&mut self, pid: u32, size: usize) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.regions.insert(id, vec![0u8; size.min(MAX_SHM_SIZE)]);
        self.owners.insert(id, pid);
        self.granted.entry(id).or_default().insert(pid);
        id
    }

    pub fn exists(&self, id: u32) -> bool {
        self.regions.contains_key(&id)
    }

    pub fn size(&self, id: u32) -> usize {
        self.regions.get(&id).map(|r| r.len()).unwrap_or(0)
    }

    /// Does `pid` hold access to region `id` (the FR-6 shm capability)?
    pub fn has_access(&self, id: u32, pid: u32) -> bool {
        self.granted.get(&id).is_some_and(|s| s.contains(&pid))
    }

    /// The owner grants `target` access. Returns false if `owner` is not the owner.
    pub fn grant(&mut self, id: u32, owner: u32, target: u32) -> bool {
        if self.owners.get(&id) == Some(&owner) {
            self.granted.entry(id).or_default().insert(target);
            true
        } else {
            false
        }
    }

    /// Copy up to `len` bytes from `off` in region `id`.
    pub fn read(&self, id: u32, off: usize, len: usize) -> Vec<u8> {
        match self.regions.get(&id) {
            Some(r) if off < r.len() => r[off..(off + len).min(r.len())].to_vec(),
            _ => Vec::new(),
        }
    }

    /// Write `data` at `off` in region `id` (clipped to the region). Returns false
    /// if the region does not exist.
    pub fn write(&mut self, id: u32, off: usize, data: &[u8]) -> bool {
        match self.regions.get_mut(&id) {
            Some(r) if off < r.len() => {
                let end = (off + data.len()).min(r.len());
                r[off..end].copy_from_slice(&data[..end - off]);
                true
            }
            _ => false,
        }
    }

    /// Release every region owned by a dying process and drop it from all grants.
    pub fn free_owned(&mut self, pid: u32) {
        let owned: Vec<u32> = self.owners.iter().filter(|(_, &p)| p == pid).map(|(&id, _)| id).collect();
        for id in &owned {
            self.regions.remove(id);
            self.owners.remove(id);
            self.granted.remove(id);
        }
        for set in self.granted.values_mut() {
            set.remove(&pid);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_grants_owner_access_others_denied() {
        let mut t = ShmTable::new();
        let id = t.create(7, 64);
        assert!(t.has_access(id, 7)); // owner
        assert!(!t.has_access(id, 8)); // default-deny
        assert_eq!(t.size(id), 64);
    }

    #[test]
    fn grant_shares_access_and_data_round_trips() {
        let mut t = ShmTable::new();
        let id = t.create(7, 32);
        // Owner grants pid 8.
        assert!(t.grant(id, 7, 8));
        assert!(t.has_access(id, 8));
        // A non-owner cannot grant.
        assert!(!t.grant(id, 8, 9));
        // Writes by one are visible to the other (same region).
        assert!(t.write(id, 4, b"SHARED"));
        assert_eq!(t.read(id, 4, 6), b"SHARED");
    }

    #[test]
    fn size_is_capped_and_writes_clip_to_region() {
        let mut t = ShmTable::new();
        let id = t.create(1, MAX_SHM_SIZE * 2);
        assert_eq!(t.size(id), MAX_SHM_SIZE); // capped
        let small = t.create(1, 4);
        assert!(t.write(small, 2, b"ABCD")); // off 2 + 4 > 4 → clipped to 2 bytes
        assert_eq!(t.read(small, 0, 4), vec![0, 0, b'A', b'B']);
    }

    #[test]
    fn free_owned_releases_regions_and_grants() {
        let mut t = ShmTable::new();
        let id = t.create(7, 16);
        t.grant(id, 7, 8);
        t.free_owned(7); // owner exits
        assert!(!t.exists(id));
        assert!(!t.has_access(id, 8));
    }
}

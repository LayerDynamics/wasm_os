//! Virtual filesystem: one POSIX-like tree over multiple backends.
//! tmpfs lives in kernel memory; opfs/idb mounts delegate to a Blockstore
//! the host implements (see wit/blockstore.wit).

use crate::types::Backend;
use std::collections::BTreeMap;

/// Host-implemented persistence, abstracted so the kernel core is testable
/// in plain `cargo test` with an in-memory fake.
pub trait Blockstore {
    fn get(&self, key: &str) -> Option<Vec<u8>>;
    fn put(&mut self, key: &str, value: Vec<u8>) -> bool;
    fn list(&self, prefix: &str) -> Vec<String>;
    /// Part of the home-store/mnt-store WIT contract and implemented end-to-end
    /// (host `delete`). Its kernel-side caller (control `fs-delete` / unlink) is
    /// scheduled for M1; the M0 control surface is intentionally write/read/list,
    /// so this is contract-complete but not yet invoked at M0.
    #[allow(dead_code)]
    fn delete(&mut self, key: &str) -> bool;
}

#[derive(Debug, PartialEq)]
pub enum FsError {
    NotFound,
    IoFailure(String),
    BadPath(String),
}

struct Mount {
    backend: Backend,
}

pub struct Vfs {
    tmpfs: BTreeMap<String, Vec<u8>>,
    mounts: Vec<(String, Mount)>, // (prefix, mount), longest-prefix wins
    home: Box<dyn Blockstore>,    // bound to /home (opfs)
    mnt: Box<dyn Blockstore>,     // bound to /mnt  (idb)
}

impl Vfs {
    pub fn new(home: Box<dyn Blockstore>, mnt: Box<dyn Blockstore>) -> Self {
        let mut v = Self { tmpfs: BTreeMap::new(), mounts: Vec::new(), home, mnt };
        v.mounts.push(("/".into(), Mount { backend: Backend::Tmpfs }));
        v
    }

    pub fn mount(&mut self, path: &str, on: Backend) -> Result<(), FsError> {
        if !path.starts_with('/') {
            return Err(FsError::BadPath(path.into()));
        }
        // Replace existing mount at this prefix if present.
        self.mounts.retain(|(p, _)| p != path);
        self.mounts.push((path.to_string(), Mount { backend: on }));
        Ok(())
    }

    fn resolve(&self, path: &str) -> Result<Backend, FsError> {
        if !path.starts_with('/') {
            return Err(FsError::BadPath(path.into()));
        }
        let mut best: Option<(&str, Backend)> = None;
        for (prefix, m) in &self.mounts {
            let matches = path == prefix
                || prefix == "/"
                || path.starts_with(&format!("{}/", prefix.trim_end_matches('/')));
            if matches {
                let take = match best {
                    Some((bp, _)) => prefix.len() > bp.len(),
                    None => true,
                };
                if take {
                    best = Some((prefix, m.backend));
                }
            }
        }
        best.map(|(_, b)| b).ok_or(FsError::NotFound)
    }

    fn store_mut(&mut self, b: Backend) -> Option<&mut dyn Blockstore> {
        match b {
            Backend::Opfs => Some(self.home.as_mut()),
            Backend::Idb => Some(self.mnt.as_mut()),
            Backend::Tmpfs => None,
        }
    }
    fn store(&self, b: Backend) -> Option<&dyn Blockstore> {
        match b {
            Backend::Opfs => Some(self.home.as_ref()),
            Backend::Idb => Some(self.mnt.as_ref()),
            Backend::Tmpfs => None,
        }
    }

    pub fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), FsError> {
        match self.resolve(path)? {
            Backend::Tmpfs => {
                self.tmpfs.insert(path.to_string(), bytes);
                Ok(())
            }
            b => {
                let store = self.store_mut(b).unwrap();
                if store.put(path, bytes) { Ok(()) } else { Err(FsError::IoFailure(path.into())) }
            }
        }
    }

    pub fn read(&self, path: &str) -> Result<Vec<u8>, FsError> {
        match self.resolve(path)? {
            Backend::Tmpfs => self.tmpfs.get(path).cloned().ok_or(FsError::NotFound),
            b => self.store(b).unwrap().get(path).ok_or(FsError::NotFound),
        }
    }

    pub fn list(&self, path: &str) -> Result<Vec<String>, FsError> {
        let prefix = if path.ends_with('/') { path.to_string() } else { format!("{path}/") };
        match self.resolve(path)? {
            Backend::Tmpfs => Ok(self
                .tmpfs
                .keys()
                .filter(|k| k.starts_with(&prefix))
                .cloned()
                .collect()),
            b => Ok(self.store(b).unwrap().list(&prefix)),
        }
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

    fn vfs() -> Vfs {
        let mut v = Vfs::new(Box::new(MemStore::default()), Box::new(MemStore::default()));
        v.mount("/home", Backend::Opfs).unwrap();
        v.mount("/mnt", Backend::Idb).unwrap();
        v
    }

    #[test]
    fn writes_route_to_the_correct_backend_and_read_back() {
        let mut v = vfs();
        v.write("/scratch.txt", b"tmp".to_vec()).unwrap();      // tmpfs
        v.write("/home/a.txt", b"home".to_vec()).unwrap();      // opfs
        v.write("/mnt/b.txt", b"mnt".to_vec()).unwrap();        // idb
        assert_eq!(v.read("/scratch.txt").unwrap(), b"tmp");
        assert_eq!(v.read("/home/a.txt").unwrap(), b"home");
        assert_eq!(v.read("/mnt/b.txt").unwrap(), b"mnt");
    }

    #[test]
    fn list_returns_entries_under_prefix() {
        let mut v = vfs();
        v.write("/home/x.txt", b"1".to_vec()).unwrap();
        v.write("/home/y.txt", b"2".to_vec()).unwrap();
        let mut got = v.list("/home").unwrap();
        got.sort();
        assert_eq!(got, vec!["/home/x.txt".to_string(), "/home/y.txt".to_string()]);
    }

    #[test]
    fn missing_file_is_not_found() {
        let v = vfs();
        assert_eq!(v.read("/home/nope.txt"), Err(FsError::NotFound));
    }

    #[test]
    fn bad_path_rejected() {
        let mut v = vfs();
        assert_eq!(v.write("relative.txt", vec![]), Err(FsError::BadPath("relative.txt".into())));
    }
}

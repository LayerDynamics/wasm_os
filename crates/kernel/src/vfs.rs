//! Virtual filesystem: one POSIX-like tree over multiple backends (M2 —
//! hierarchical directories).
//!
//! ## Storage model
//! Each backend (tmpfs / opfs / idb) is a flat `key -> bytes` store. The
//! directory tree is layered on top:
//!
//! - A **file** at `/a/b.txt` is stored under the key `/a/b.txt` — **identical
//!   to M1**, so existing OPFS/IndexedDB data needs no transformation (the M1
//!   persistence E2E keeps passing). Ancestor directories are *implied* by any
//!   key beneath them.
//! - An **empty / explicitly-created directory** is recorded with a reserved
//!   marker key `\x01d:/a` (reserved keys start with `\x01`, which a real path
//!   never does, so files and markers never collide and markers are invisible
//!   to file listings).
//! - A per-backend version stamp `\x01vfs_version` records the on-disk layout
//!   version (Appendix C). Absent stamp + existing keys = M1 data → stamped to
//!   v2 in place (files already valid; nothing to rewrite).

use crate::types::Backend;
use std::collections::BTreeMap;

/// Host-implemented persistence, abstracted so the kernel core is testable
/// in plain `cargo test` with an in-memory fake.
pub trait Blockstore {
    fn get(&self, key: &str) -> Option<Vec<u8>>;
    fn put(&mut self, key: &str, value: Vec<u8>) -> bool;
    fn list(&self, prefix: &str) -> Vec<String>;
    /// Remove a key, returning whether it existed.
    fn delete(&mut self, key: &str) -> bool;
}

#[derive(Debug, PartialEq)]
pub enum FsError {
    NotFound,
    IoFailure(String),
    BadPath(String),
    /// The path is a directory where a file was expected (or vice-versa).
    IsDir,
    /// `rmdir` on a non-empty directory.
    NotEmpty,
    /// Target already exists (e.g. `mkdir` of an existing path).
    Exists,
}

/// One entry returned by [`Vfs::readdir`].
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: String,
    pub is_dir: bool,
}

/// Reserved key prefixes (a real path always starts with `/`, never `\x01`).
const VERSION_KEY: &str = "\u{1}vfs_version";
const DIR_PREFIX: &str = "\u{1}d:";
const VFS_VERSION: &[u8] = b"2";

fn dir_marker(path: &str) -> String {
    format!("{DIR_PREFIX}{path}")
}
fn is_reserved(key: &str) -> bool {
    key.starts_with('\u{1}')
}

struct Mount {
    backend: Backend,
}

pub struct Vfs {
    tmpfs: BTreeMap<String, Vec<u8>>,
    mounts: Vec<(String, Mount)>, // (prefix, mount), longest-prefix wins
    home: Box<dyn Blockstore>,    // bound to /home (opfs)
    mnt: Box<dyn Blockstore>,     // bound to /mnt  (idb)
    sys: Box<dyn Blockstore>,     // bound to /etc, /var, … (opfs, separate store)
}

impl Vfs {
    pub fn new(home: Box<dyn Blockstore>, mnt: Box<dyn Blockstore>, sys: Box<dyn Blockstore>) -> Self {
        let mut v = Self { tmpfs: BTreeMap::new(), mounts: Vec::new(), home, mnt, sys };
        v.mounts.push(("/".into(), Mount { backend: Backend::Tmpfs }));
        v
    }

    pub fn mount(&mut self, path: &str, on: Backend) -> Result<(), FsError> {
        if !path.starts_with('/') {
            return Err(FsError::BadPath(path.into()));
        }
        self.mounts.retain(|(p, _)| p != path);
        self.mounts.push((path.to_string(), Mount { backend: on }));
        // Stamp the on-disk version for persistent backends (Appendix C). The
        // v2 layout is a strict superset of M1's flat file keys, so an unstamped
        // store full of M1 file keys is simply stamped — no data is rewritten.
        if matches!(on, Backend::Opfs | Backend::Idb | Backend::Sys) && self.kv_get(on, VERSION_KEY).is_none() {
            self.kv_put(on, VERSION_KEY, VFS_VERSION.to_vec());
        }
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

    // --- uniform key/value access across tmpfs + blockstores ---

    fn kv_get(&self, b: Backend, key: &str) -> Option<Vec<u8>> {
        match b {
            Backend::Tmpfs => self.tmpfs.get(key).cloned(),
            Backend::Opfs => self.home.get(key),
            Backend::Idb => self.mnt.get(key),
            Backend::Sys => self.sys.get(key),
        }
    }
    fn kv_put(&mut self, b: Backend, key: &str, value: Vec<u8>) -> bool {
        match b {
            Backend::Tmpfs => {
                self.tmpfs.insert(key.to_string(), value);
                true
            }
            Backend::Opfs => self.home.put(key, value),
            Backend::Idb => self.mnt.put(key, value),
            Backend::Sys => self.sys.put(key, value),
        }
    }
    fn kv_delete(&mut self, b: Backend, key: &str) -> bool {
        match b {
            Backend::Tmpfs => self.tmpfs.remove(key).is_some(),
            Backend::Opfs => self.home.delete(key),
            Backend::Idb => self.mnt.delete(key),
            Backend::Sys => self.sys.delete(key),
        }
    }
    fn kv_keys(&self, b: Backend, prefix: &str) -> Vec<String> {
        match b {
            Backend::Tmpfs => self.tmpfs.keys().filter(|k| k.starts_with(prefix)).cloned().collect(),
            Backend::Opfs => self.home.list(prefix),
            Backend::Idb => self.mnt.list(prefix),
            Backend::Sys => self.sys.list(prefix),
        }
    }

    // --- directory predicates ---

    /// True if `path` names a directory (the root, an explicit marker, or any
    /// path that has at least one descendant key).
    pub fn is_dir(&self, path: &str) -> bool {
        if path == "/" {
            return true;
        }
        // A mount point is always a directory, even when empty.
        let trimmed = path.trim_end_matches('/');
        if self.mounts.iter().any(|(p, _)| p.trim_end_matches('/') == trimmed) {
            return true;
        }
        let b = match self.resolve(path) {
            Ok(b) => b,
            Err(_) => return false,
        };
        if self.kv_get(b, &dir_marker(path)).is_some() {
            return true;
        }
        let child_prefix = format!("{path}/");
        // Any descendant file, or any descendant directory marker.
        !self.kv_keys(b, &child_prefix).is_empty()
            || !self.kv_keys(b, &dir_marker(&child_prefix)).is_empty()
    }

    pub fn is_file(&self, path: &str) -> bool {
        self.resolve(path).map(|b| self.kv_get(b, path).is_some()).unwrap_or(false)
    }

    pub fn exists(&self, path: &str) -> bool {
        path == "/" || self.is_file(path) || self.is_dir(path)
    }

    // --- file ops ---

    pub fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), FsError> {
        let b = self.resolve(path)?;
        if self.is_dir(path) {
            return Err(FsError::IsDir);
        }
        if self.kv_put(b, path, bytes) {
            Ok(())
        } else {
            Err(FsError::IoFailure(path.into()))
        }
    }

    pub fn read(&self, path: &str) -> Result<Vec<u8>, FsError> {
        let b = self.resolve(path)?;
        match self.kv_get(b, path) {
            Some(v) => Ok(v),
            None if self.is_dir(path) => Err(FsError::IsDir),
            None => Err(FsError::NotFound),
        }
    }

    /// Unlink a file (used by the control `fs-delete` verb). Directories are
    /// rejected with `IsDir`; use [`Vfs::rmdir`].
    pub fn delete(&mut self, path: &str) -> Result<(), FsError> {
        let b = self.resolve(path)?;
        if self.kv_get(b, path).is_none() {
            return if self.is_dir(path) { Err(FsError::IsDir) } else { Err(FsError::NotFound) };
        }
        if self.kv_delete(b, path) {
            Ok(())
        } else {
            Err(FsError::NotFound)
        }
    }

    // --- directory ops ---

    /// Create a directory. Errors if the path already exists.
    pub fn mkdir(&mut self, path: &str) -> Result<(), FsError> {
        let b = self.resolve(path)?;
        if self.exists(path) {
            return Err(FsError::Exists);
        }
        self.kv_put(b, &dir_marker(path), Vec::new());
        Ok(())
    }

    /// Create a directory and all missing parents (`mkdir -p`); idempotent. Each
    /// segment's marker is placed in the backend that segment resolves to, so a path
    /// crossing a mount boundary (e.g. `/usr/local` with `/usr` on tmpfs and
    /// `/usr/local` on the sys store) records each level on the correct backend.
    pub fn mkdir_p(&mut self, path: &str) -> Result<(), FsError> {
        self.resolve(path)?; // validate the path
        let mut acc = String::new();
        for seg in path.split('/').filter(|s| !s.is_empty()) {
            acc.push('/');
            acc.push_str(seg);
            if self.is_file(&acc) {
                return Err(FsError::IsDir);
            }
            if !self.is_dir(&acc) {
                let b = self.resolve(&acc)?;
                self.kv_put(b, &dir_marker(&acc), Vec::new());
            }
        }
        Ok(())
    }

    /// Remove an empty directory.
    pub fn rmdir(&mut self, path: &str) -> Result<(), FsError> {
        let b = self.resolve(path)?;
        if !self.is_dir(path) {
            return Err(FsError::NotFound);
        }
        if !self.readdir(path)?.is_empty() {
            return Err(FsError::NotEmpty);
        }
        self.kv_delete(b, &dir_marker(path));
        Ok(())
    }

    /// List the immediate children of a directory.
    pub fn readdir(&self, path: &str) -> Result<Vec<DirEntry>, FsError> {
        let b = self.resolve(path)?;
        if !self.is_dir(path) {
            return Err(if self.is_file(path) { FsError::IsDir } else { FsError::NotFound });
        }
        let prefix = if path == "/" { "/".to_string() } else { format!("{path}/") };
        let mut dirs: BTreeMap<String, bool> = BTreeMap::new(); // name -> is_dir

        // Files (and implied intermediate dirs) from real keys.
        for key in self.kv_keys(b, &prefix) {
            if is_reserved(&key) {
                continue;
            }
            let Some(rest) = key.strip_prefix(&prefix) else { continue };
            match rest.split_once('/') {
                Some((name, _)) => {
                    dirs.insert(name.to_string(), true); // intermediate dir
                }
                None => {
                    dirs.entry(rest.to_string()).or_insert(false); // file (unless dir wins)
                }
            }
        }
        // Explicit/empty directory markers.
        for key in self.kv_keys(b, &dir_marker(&prefix)) {
            let marked = &key[DIR_PREFIX.len()..]; // the real dir path
            if let Some(rest) = marked.strip_prefix(&prefix) {
                let name = rest.split('/').next().unwrap_or(rest);
                if !name.is_empty() {
                    dirs.insert(name.to_string(), true);
                }
            }
        }

        // Immediate child mount points (e.g. /home, /etc, /var) are directories even
        // though their contents live in a different backend than `path`'s.
        let base = path.trim_end_matches('/'); // "" for root
        for (mount_prefix, _) in &self.mounts {
            let mp = mount_prefix.trim_end_matches('/');
            if let Some((parent, name)) = mp.rsplit_once('/') {
                if parent == base && !name.is_empty() {
                    dirs.insert(name.to_string(), true);
                }
            }
        }

        Ok(dirs.into_iter().map(|(name, is_dir)| DirEntry { name, is_dir }).collect())
    }

    /// Immediate children as full paths (backs the control `fs-list` verb).
    pub fn list(&self, path: &str) -> Result<Vec<String>, FsError> {
        let base = path.trim_end_matches('/');
        Ok(self.readdir(path)?.into_iter().map(|e| format!("{base}/{}", e.name)).collect())
    }

    /// Rename a file or directory within the same backend.
    pub fn rename(&mut self, from: &str, to: &str) -> Result<(), FsError> {
        let bf = self.resolve(from)?;
        let bt = self.resolve(to)?;
        if bf != bt {
            // Cross-backend move is copy+unlink at a higher layer; not atomic.
            return Err(FsError::IoFailure("cross-backend rename".into()));
        }
        if self.is_file(from) {
            let content = self.kv_get(bf, from).ok_or(FsError::NotFound)?;
            if self.exists(to) {
                return Err(FsError::Exists);
            }
            self.kv_put(bt, to, content);
            self.kv_delete(bf, from);
            Ok(())
        } else if self.is_dir(from) {
            if self.exists(to) {
                return Err(FsError::Exists);
            }
            // Re-key the marker + every descendant (files and sub-markers).
            let from_slash = format!("{from}/");
            let to_slash = format!("{to}/");
            // Files.
            for key in self.kv_keys(bf, &from_slash) {
                if is_reserved(&key) {
                    continue;
                }
                if let Some(rest) = key.strip_prefix(&from_slash) {
                    let content = self.kv_get(bf, &key).unwrap_or_default();
                    self.kv_put(bt, &format!("{to_slash}{rest}"), content);
                    self.kv_delete(bf, &key);
                }
            }
            // Sub-directory markers.
            for key in self.kv_keys(bf, &dir_marker(&from_slash)) {
                let marked = key[DIR_PREFIX.len()..].to_string();
                if let Some(rest) = marked.strip_prefix(&from_slash) {
                    self.kv_put(bt, &dir_marker(&format!("{to_slash}{rest}")), Vec::new());
                    self.kv_delete(bf, &key);
                }
            }
            // The directory's own marker (if any) → new marker.
            self.kv_delete(bf, &dir_marker(from));
            self.kv_put(bt, &dir_marker(to), Vec::new());
            Ok(())
        } else {
            Err(FsError::NotFound)
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
        let mut v = Vfs::new(
            Box::new(MemStore::default()),
            Box::new(MemStore::default()),
            Box::new(MemStore::default()),
        );
        v.mount("/home", Backend::Opfs).unwrap();
        v.mount("/mnt", Backend::Idb).unwrap();
        v.mount("/etc", Backend::Sys).unwrap();
        v
    }

    #[test]
    fn sys_backend_routes_etc_writes_and_is_a_distinct_store() {
        let mut v = vfs();
        v.write("/etc/hostname", b"wasmos".to_vec()).unwrap();
        assert_eq!(v.read("/etc/hostname").unwrap(), b"wasmos");
        // /etc routes to Sys, not the /home (Opfs) store — a /home read of the same
        // basename is independent.
        v.write("/home/hostname", b"user".to_vec()).unwrap();
        assert_eq!(v.read("/home/hostname").unwrap(), b"user");
        assert_eq!(v.read("/etc/hostname").unwrap(), b"wasmos");
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

    #[test]
    fn delete_removes_across_all_backends_and_reports_not_found() {
        let mut v = vfs();
        v.write("/scratch.txt", b"tmp".to_vec()).unwrap();
        v.write("/home/a.txt", b"home".to_vec()).unwrap();
        v.write("/mnt/b.txt", b"mnt".to_vec()).unwrap();
        assert_eq!(v.delete("/scratch.txt"), Ok(()));
        assert_eq!(v.delete("/home/a.txt"), Ok(()));
        assert_eq!(v.delete("/mnt/b.txt"), Ok(()));
        assert_eq!(v.read("/scratch.txt"), Err(FsError::NotFound));
        assert_eq!(v.read("/home/a.txt"), Err(FsError::NotFound));
        assert_eq!(v.read("/mnt/b.txt"), Err(FsError::NotFound));
        assert_eq!(v.delete("/scratch.txt"), Err(FsError::NotFound));
        assert_eq!(v.delete("/home/gone.txt"), Err(FsError::NotFound));
        assert_eq!(v.delete("/mnt/gone.txt"), Err(FsError::NotFound));
    }

    #[test]
    fn delete_rejects_bad_path() {
        let mut v = vfs();
        assert_eq!(v.delete("relative"), Err(FsError::BadPath("relative".into())));
    }

    // --- M2: hierarchical directories ---

    #[test]
    fn mkdir_readdir_nested_and_files() {
        let mut v = vfs();
        v.mkdir("/home/proj").unwrap();
        v.write("/home/proj/main.rs", b"fn main(){}".to_vec()).unwrap();
        v.mkdir("/home/proj/src").unwrap();
        // readdir of /home shows proj (dir).
        let home = v.readdir("/home").unwrap();
        assert!(home.iter().any(|e| e.name == "proj" && e.is_dir));
        // readdir of /home/proj shows the file and the sub-dir.
        let proj = v.readdir("/home/proj").unwrap();
        assert!(proj.iter().any(|e| e.name == "main.rs" && !e.is_dir));
        assert!(proj.iter().any(|e| e.name == "src" && e.is_dir));
        assert!(v.is_dir("/home/proj"));
        assert!(v.is_dir("/home/proj/src")); // empty dir still exists
    }

    #[test]
    fn mkdir_existing_is_exists_and_intermediate_dirs_implied() {
        let mut v = vfs();
        v.write("/home/a/b/c.txt", b"x".to_vec()).unwrap(); // implies /home/a and /home/a/b
        assert!(v.is_dir("/home/a"));
        assert!(v.is_dir("/home/a/b"));
        assert_eq!(v.mkdir("/home/a"), Err(FsError::Exists));
        assert!(v.readdir("/home/a").unwrap().iter().any(|e| e.name == "b" && e.is_dir));
    }

    #[test]
    fn readdir_lists_child_mounts_and_mkdir_p_crosses_boundaries() {
        let mut v = vfs(); // mounts /home (opfs), /mnt (idb), /etc (sys)
        // `/` lists its child mount points even when they hold no files yet.
        let root = v.readdir("/").unwrap();
        for m in ["home", "mnt", "etc"] {
            assert!(root.iter().any(|e| e.name == m && e.is_dir), "/ should list {m}");
        }
        // mkdir_p across a mount boundary records each level on its own backend.
        v.mount("/usr/local", Backend::Sys).unwrap();
        v.mkdir_p("/usr/local/share").unwrap();
        assert!(v.is_dir("/usr")); // tmpfs marker
        assert!(v.is_dir("/usr/local")); // mount point on sys
        assert!(v.is_dir("/usr/local/share")); // sys marker
        assert!(v.readdir("/").unwrap().iter().any(|e| e.name == "usr" && e.is_dir));
        assert!(v.readdir("/usr").unwrap().iter().any(|e| e.name == "local" && e.is_dir));
    }

    #[test]
    fn mkdir_p_creates_parents_and_is_idempotent() {
        let mut v = vfs();
        v.mkdir_p("/home/a/b/c").unwrap();
        assert!(v.is_dir("/home/a"));
        assert!(v.is_dir("/home/a/b"));
        assert!(v.is_dir("/home/a/b/c"));
        // Idempotent: a second mkdir_p of an existing tree is Ok (not Exists).
        v.mkdir_p("/home/a/b/c").unwrap();
        // A segment that is a file makes mkdir_p fail with IsDir.
        v.write("/home/a/file", b"x".to_vec()).unwrap();
        assert_eq!(v.mkdir_p("/home/a/file/sub"), Err(FsError::IsDir));
    }

    #[test]
    fn rmdir_requires_empty() {
        let mut v = vfs();
        v.mkdir("/home/d").unwrap();
        v.write("/home/d/f", b"1".to_vec()).unwrap();
        assert_eq!(v.rmdir("/home/d"), Err(FsError::NotEmpty));
        v.delete("/home/d/f").unwrap();
        v.rmdir("/home/d").unwrap();
        assert!(!v.is_dir("/home/d"));
    }

    #[test]
    fn rename_file_and_dir() {
        let mut v = vfs();
        v.write("/home/old.txt", b"data".to_vec()).unwrap();
        v.rename("/home/old.txt", "/home/new.txt").unwrap();
        assert_eq!(v.read("/home/new.txt").unwrap(), b"data");
        assert_eq!(v.read("/home/old.txt"), Err(FsError::NotFound));

        v.mkdir("/home/dir").unwrap();
        v.write("/home/dir/inner.txt", b"i".to_vec()).unwrap();
        v.rename("/home/dir", "/home/moved").unwrap();
        assert_eq!(v.read("/home/moved/inner.txt").unwrap(), b"i");
        assert!(v.is_dir("/home/moved"));
        assert!(!v.is_dir("/home/dir"));
    }

    #[test]
    fn write_over_directory_is_rejected() {
        let mut v = vfs();
        v.mkdir("/home/d").unwrap();
        assert_eq!(v.write("/home/d", b"x".to_vec()), Err(FsError::IsDir));
    }

    #[test]
    fn m1_flat_keys_migrate_in_place_and_are_readable_as_a_tree() {
        // Simulate an existing M1 OPFS store: flat file keys, NO version stamp.
        let mut home = MemStore::default();
        home.0.insert("/home/user/notes.txt".into(), b"hello".to_vec());
        home.0.insert("/home/user/sub/deep.txt".into(), b"deep".to_vec());
        let mut v = Vfs::new(Box::new(home), Box::new(MemStore::default()), Box::new(MemStore::default()));
        // Mounting stamps the version without touching the M1 file data.
        v.mount("/home", Backend::Opfs).unwrap();
        // Files read back unchanged; directories are derived from the keys.
        assert_eq!(v.read("/home/user/notes.txt").unwrap(), b"hello");
        assert!(v.is_dir("/home/user"));
        assert!(v.is_dir("/home/user/sub"));
        let entries = v.readdir("/home/user").unwrap();
        assert!(entries.iter().any(|e| e.name == "notes.txt" && !e.is_dir));
        assert!(entries.iter().any(|e| e.name == "sub" && e.is_dir));
        // Reserved keys never leak into a listing.
        assert!(!entries.iter().any(|e| e.name.starts_with('\u{1}')));
    }
}

//! procfs — a synthetic, read-only filesystem generated **live** from the kernel's
//! real process table and mount list (like Linux `/proc`). Nothing here is stored:
//! every `read`/`readdir` reflects the true current state of the running system. The
//! kernel owns the process table, so generation lives here (not in `vfs`), and the
//! syscall + control layers route `/proc` paths through these functions.

use crate::types::ProcTable;
use crate::vfs::DirEntry;

/// True for `/proc` itself or anything beneath it.
pub fn is_proc(path: &str) -> bool {
    path == "/proc" || path.starts_with("/proc/")
}

/// A static, real description of the kernel build (no fabricated values).
const VERSION: &str = "WASM_OS microkernel (Rust, wasm32 component; WASI p1)\n";

/// `readdir` of a `/proc` directory. Returns `None` if `path` is not a proc dir.
/// `/proc` lists every live PID plus the global files; `/proc/<pid>` lists the
/// per-process files (only for a PID that actually exists).
pub fn readdir(procs: &ProcTable, path: &str) -> Option<Vec<DirEntry>> {
    let rest = path.strip_prefix("/proc")?.trim_start_matches('/');
    if rest.is_empty() {
        let mut out: Vec<DirEntry> =
            procs.list().iter().map(|p| DirEntry { name: p.pid.to_string(), is_dir: true }).collect();
        for f in ["self", "mounts", "version"] {
            out.push(DirEntry { name: f.to_string(), is_dir: false });
        }
        return Some(out);
    }
    if let Ok(pid) = rest.parse::<u32>() {
        if procs.get(pid).is_some() {
            return Some(
                ["status", "stat", "cmdline"]
                    .iter()
                    .map(|f| DirEntry { name: (*f).to_string(), is_dir: false })
                    .collect(),
            );
        }
    }
    None
}

/// `read` a `/proc` file, generated from live state. `caller` is the PID performing
/// the read (so `/proc/self` resolves to it). `mounts` is the real mount table as
/// `(mount_point, backend_name)`. Returns `None` if the path is not a readable proc
/// file (a directory or a non-existent PID).
pub fn read(procs: &ProcTable, mounts: &[(String, &'static str)], caller: u32, path: &str) -> Option<Vec<u8>> {
    let rest = path.strip_prefix("/proc/")?;
    match rest {
        "version" => return Some(VERSION.as_bytes().to_vec()),
        "self" => return Some(format!("{caller}\n").into_bytes()),
        "mounts" => {
            // device  mountpoint  fstype  options  dump  pass — real mount table.
            let mut s = String::new();
            for (point, backend) in mounts {
                s.push_str(&format!("{backend} {point} {backend} rw 0 0\n"));
            }
            return Some(s.into_bytes());
        }
        _ => {}
    }
    let (pid_str, file) = rest.split_once('/')?;
    let pid = pid_str.parse::<u32>().ok()?;
    let p = procs.get(pid)?;
    let state = p.state.as_str();
    let content = match file {
        "status" => format!(
            "Name:\t{}\nState:\t{}\nPid:\t{}\nPriority:\t{}\n",
            p.name, state, p.pid, p.priority,
        ),
        "stat" => format!(
            "{} ({}) {} {}\n",
            p.pid,
            p.name,
            state.chars().next().unwrap_or('?').to_ascii_uppercase(),
            p.priority,
        ),
        "cmdline" => format!("{}\0", p.name),
        _ => return None,
    };
    Some(content.into_bytes())
}

/// Whether `path` names an existing proc file or directory (for `path_open` /
/// `filestat` existence checks).
pub fn exists(procs: &ProcTable, path: &str) -> bool {
    if path == "/proc" {
        return true;
    }
    let Some(rest) = path.strip_prefix("/proc/") else { return false };
    match rest {
        "self" | "mounts" | "version" => true,
        _ => match rest.split_once('/') {
            // /proc/<pid>/<file>
            Some((pid, file)) => {
                pid.parse::<u32>().ok().and_then(|p| procs.get(p)).is_some()
                    && matches!(file, "status" | "stat" | "cmdline")
            }
            // /proc/<pid> directory
            None => rest.parse::<u32>().ok().and_then(|p| procs.get(p)).is_some(),
        },
    }
}

/// Whether `path` is a `/proc` directory (the root, or an existing `/proc/<pid>`).
pub fn is_dir(procs: &ProcTable, path: &str) -> bool {
    if path == "/proc" {
        return true;
    }
    path.strip_prefix("/proc/")
        .and_then(|rest| if rest.contains('/') { None } else { rest.parse::<u32>().ok() })
        .and_then(|p| procs.get(p))
        .is_some()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{CapabilitySet, ProcState, ProcTable};

    fn table() -> ProcTable {
        let mut t = ProcTable::new();
        let pid = t.spawn("sh", 10, CapabilitySet::default());
        t.set_state(pid, ProcState::Running);
        t
    }

    #[test]
    fn readdir_lists_live_pids_and_globals() {
        let t = table();
        let entries = readdir(&t, "/proc").unwrap();
        assert!(entries.iter().any(|e| e.name == "1" && e.is_dir)); // the spawned pid
        assert!(entries.iter().any(|e| e.name == "mounts" && !e.is_dir));
        assert!(entries.iter().any(|e| e.name == "version" && !e.is_dir));
    }

    #[test]
    fn read_status_reflects_the_real_process() {
        let t = table();
        let status = String::from_utf8(read(&t, &[], 1, "/proc/1/status").unwrap()).unwrap();
        assert!(status.contains("Name:\tsh"));
        assert!(status.contains("State:\trunning"));
        assert!(status.contains("Pid:\t1"));
        // A non-existent pid has no status.
        assert!(read(&t, &[], 1, "/proc/999/status").is_none());
    }

    #[test]
    fn self_and_mounts_and_version() {
        let t = table();
        assert_eq!(read(&t, &[], 7, "/proc/self").unwrap(), b"7\n");
        let mounts = String::from_utf8(read(&t, &[("/home".into(), "opfs")], 1, "/proc/mounts").unwrap()).unwrap();
        assert!(mounts.contains("opfs /home opfs rw 0 0"));
        assert!(exists(&t, "/proc/1"));
        assert!(is_dir(&t, "/proc/1"));
        assert!(!exists(&t, "/proc/1/bogus"));
    }
}

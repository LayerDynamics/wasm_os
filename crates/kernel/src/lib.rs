//! M0 kernel component. Exports `wasmos:abi/control`; imports two blockstores
//! (`home`->OPFS, `mnt`->IndexedDB) provided by the host.

// These modules are the kernel's public library API (the crate is built as an
// rlib as well as the wasm cdylib component). Exposing them publicly is correct
// design — the process table, scheduler, capability system, and VFS are the
// kernel's surface — and it means items reached only by the wasm-gated
// `component` or by M1 callers are not miscounted as dead on the host build.
pub mod kcore;
pub mod pipe;
pub mod sched;
pub mod syscall;
pub mod types;
pub mod vfs;

// Everything below depends on the `bindings` module that `cargo component`
// injects ONLY for the wasm32 target. Gate the whole component layer behind
// `cfg(target_arch = "wasm32")` so plain `cargo test` (host target) compiles
// just `types` + `vfs` (the unit-tested logic) and is green.
// `cargo component` generates `bindings` at the crate root (src/bindings.rs).
// It must be declared here, not inside `mod component`.
#[cfg(target_arch = "wasm32")]
#[allow(warnings)]
mod bindings;

#[cfg(target_arch = "wasm32")]
mod component {
    use super::bindings;
    use super::kcore::KernelCore;
    use super::types::{Backend, Rights};
    use super::vfs::{Blockstore, FsError};
    use std::cell::RefCell;

    use bindings::exports::wasmos::abi::control::{
        Backend as WBackend, BootStatus, FeatureReport, FsError as WFsError, Guest,
        ProcInfo as WProcInfo, SpawnSpec, SyscallOutcome as WSyscallOutcome,
    };
    use bindings::wasmos::abi::{home_store, mnt_store};

    /// Adapter: route the kernel's Blockstore trait to a host import module.
    enum HostStore {
        Home,
        Mnt,
    }
    impl Blockstore for HostStore {
        fn get(&self, key: &str) -> Option<Vec<u8>> {
            match self {
                HostStore::Home => home_store::get(key),
                HostStore::Mnt => mnt_store::get(key),
            }
        }
        fn put(&mut self, key: &str, value: Vec<u8>) -> bool {
            match self {
                HostStore::Home => home_store::put(key, &value),
                HostStore::Mnt => mnt_store::put(key, &value),
            }
        }
        fn list(&self, prefix: &str) -> Vec<String> {
            match self {
                HostStore::Home => home_store::list_keys(prefix),
                HostStore::Mnt => mnt_store::list_keys(prefix),
            }
        }
        fn delete(&mut self, key: &str) -> bool {
            match self {
                HostStore::Home => home_store::delete(key),
                HostStore::Mnt => mnt_store::delete(key),
            }
        }
    }

    thread_local! {
        static KERNEL: RefCell<KernelCore> =
            RefCell::new(KernelCore::new(Box::new(HostStore::Home), Box::new(HostStore::Mnt)));
    }

    fn map_backend(b: WBackend) -> Backend {
        match b {
            WBackend::Tmpfs => Backend::Tmpfs,
            WBackend::Opfs => Backend::Opfs,
            WBackend::Idb => Backend::Idb,
        }
    }
    fn map_err(e: FsError) -> WFsError {
        match e {
            FsError::NotFound => WFsError::NotFound,
            FsError::IoFailure(s) => WFsError::IoFailure(s),
            FsError::BadPath(s) => WFsError::BadPath(s),
            // The control fs-error variant is coarse (M0/M1); map the M2
            // directory errors onto io-failure with a descriptive message.
            FsError::IsDir => WFsError::IoFailure("is a directory".into()),
            FsError::NotEmpty => WFsError::IoFailure("directory not empty".into()),
            FsError::Exists => WFsError::IoFailure("already exists".into()),
        }
    }

    struct Component;

    impl Guest for Component {
        fn boot(features: FeatureReport) -> BootStatus {
            KERNEL.with(|k| k.borrow_mut().boot());
            BootStatus { ready: true, boot_millis: 0, features }
        }

        fn mount(path: String, on: WBackend) -> Result<(), WFsError> {
            KERNEL.with(|k| k.borrow_mut().mount(&path, map_backend(on)).map_err(map_err))
        }

        fn fs_write(path: String, bytes: Vec<u8>) -> Result<(), WFsError> {
            KERNEL.with(|k| k.borrow_mut().write(&path, bytes).map_err(map_err))
        }

        fn fs_read(path: String) -> Result<Vec<u8>, WFsError> {
            KERNEL.with(|k| k.borrow().read(&path).map_err(map_err))
        }

        fn fs_list(path: String) -> Result<Vec<String>, WFsError> {
            KERNEL.with(|k| k.borrow().list(&path).map_err(map_err))
        }

        fn fs_delete(path: String) -> Result<(), WFsError> {
            KERNEL.with(|k| k.borrow_mut().delete(&path).map_err(map_err))
        }

        fn list_procs() -> Vec<WProcInfo> {
            KERNEL.with(|k| {
                k.borrow()
                    .list_procs()
                    .into_iter()
                    .map(|p| WProcInfo { pid: p.pid, name: p.name, state: p.state })
                    .collect()
            })
        }

        // --- Process lifecycle (M1, FR-5) ---

        fn spawn(spec: SpawnSpec) -> u32 {
            // An empty subtree means "no FS grant"; otherwise grant read+write.
            let grant_fs = if spec.grant_fs_subtree.is_empty() {
                None
            } else {
                Some((spec.grant_fs_subtree.as_str(), Rights::RW))
            };
            KERNEL.with(|k| k.borrow_mut().spawn(&spec.name, grant_fs, spec.grant_spawn))
        }

        fn service_syscall(pid: u32, request: Vec<u8>) -> WSyscallOutcome {
            let out = KERNEL.with(|k| k.borrow_mut().service_syscall(pid, &request));
            WSyscallOutcome { reply: out.reply, wakeups: out.wakeups, term_output: out.term_output }
        }

        fn deliver_stdin(pid: u32, bytes: Vec<u8>) -> Vec<u32> {
            KERNEL.with(|k| k.borrow_mut().deliver_stdin(pid, &bytes))
        }

        fn bind_terminal(pid: u32) {
            KERNEL.with(|k| k.borrow_mut().bind_terminal(pid));
        }

        fn exit_code(pid: u32) -> Option<i32> {
            KERNEL.with(|k| k.borrow().exit_code(pid))
        }

        fn take_capture(pid: u32) -> (Vec<u8>, Vec<u8>) {
            KERNEL.with(|k| k.borrow_mut().take_capture(pid))
        }
    }

    // cargo-component generates ONE `export!` macro on the bindings module.
    bindings::export!(Component with_types_in bindings);
}

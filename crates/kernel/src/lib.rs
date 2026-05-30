//! M0 kernel component. Exports `wasmos:abi/control`; imports two blockstores
//! (`home`->OPFS, `mnt`->IndexedDB) provided by the host.

mod types;
mod vfs;

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
    use super::types::{Backend, ProcTable};
    use super::vfs::{Blockstore, FsError, Vfs};
    use std::cell::RefCell;

    use bindings::exports::wasmos::abi::control::{
        Backend as WBackend, BootStatus, FeatureReport, FsError as WFsError, Guest,
        ProcInfo as WProcInfo,
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

    struct KernelState {
        vfs: Vfs,
        procs: ProcTable,
        booted: bool,
    }

    thread_local! {
        static STATE: RefCell<KernelState> = RefCell::new(KernelState {
            vfs: Vfs::new(Box::new(HostStore::Home), Box::new(HostStore::Mnt)),
            procs: ProcTable::default(),
            booted: false,
        });
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
        }
    }

    struct Component;

    impl Guest for Component {
        fn boot(features: FeatureReport) -> BootStatus {
            STATE.with(|s| {
                let mut st = s.borrow_mut();
                if !st.booted {
                    // Standard M0 mount layout.
                    let _ = st.vfs.mount("/home", Backend::Opfs);
                    let _ = st.vfs.mount("/mnt", Backend::Idb);
                    st.booted = true;
                }
                BootStatus { ready: true, boot_millis: 0, features }
            })
        }

        fn mount(path: String, on: WBackend) -> Result<(), WFsError> {
            STATE.with(|s| s.borrow_mut().vfs.mount(&path, map_backend(on)).map_err(map_err))
        }

        fn fs_write(path: String, bytes: Vec<u8>) -> Result<(), WFsError> {
            STATE.with(|s| s.borrow_mut().vfs.write(&path, bytes).map_err(map_err))
        }

        fn fs_read(path: String) -> Result<Vec<u8>, WFsError> {
            STATE.with(|s| s.borrow().vfs.read(&path).map_err(map_err))
        }

        fn fs_list(path: String) -> Result<Vec<String>, WFsError> {
            STATE.with(|s| s.borrow().vfs.list(&path).map_err(map_err))
        }

        fn list_procs() -> Vec<WProcInfo> {
            STATE.with(|s| {
                s.borrow()
                    .procs
                    .list()
                    .into_iter()
                    .map(|p| WProcInfo { pid: p.pid, name: p.name, state: p.state })
                    .collect()
            })
        }
    }

    // cargo-component generates ONE `export!` macro on the bindings module.
    bindings::export!(Component with_types_in bindings);
}

//! pwd — print the working directory (FR-18).
//!
//! wasm32-wasip1 has no `getcwd`, and `std::env::current_dir()` reads wasi-libc's
//! own notion of cwd (always "/"), NOT this process's actual working directory.
//! In WASM_OS the working directory IS the process's preopened directory: the
//! kernel sets fd 3 to `Dir{cwd}` at spawn (see `k_spawn`). So we read fd 3's
//! preopen name directly via the WASI prestat calls.

#[link(wasm_import_module = "wasi_snapshot_preview1")]
extern "C" {
    fn fd_prestat_get(fd: u32, buf: *mut u8) -> u16;
    fn fd_prestat_dir_name(fd: u32, path: *mut u8, path_len: usize) -> u16;
}

/// The process's working-directory preopen (kernel convention; see PREOPEN_FD).
const PREOPEN_FD: u32 = 3;

fn main() {
    // `prestat` is 8 bytes on wasm32: tag (u8) at offset 0, pr_name_len (u32 LE)
    // at offset 4. Tag 0 == a preopened directory.
    let mut prestat = [0u8; 8];
    if unsafe { fd_prestat_get(PREOPEN_FD, prestat.as_mut_ptr()) } != 0 {
        // No preopen advertised → the working directory is root.
        println!("/");
        return;
    }
    let name_len = u32::from_le_bytes([prestat[4], prestat[5], prestat[6], prestat[7]]) as usize;
    let mut buf = vec![0u8; name_len];
    if unsafe { fd_prestat_dir_name(PREOPEN_FD, buf.as_mut_ptr(), name_len) } != 0 {
        eprintln!("pwd: cannot read working directory");
        std::process::exit(1);
    }
    println!("{}", String::from_utf8_lossy(&buf));
}

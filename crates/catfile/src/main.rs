//! WASI process runtime FS guest: open a fixed path, read it through `fd_read`, and write the
//! bytes to stdout. Exercises `path_open` → `fd_read` → `fd_close` against the
//! kernel-backed VFS (WASI process runtime exit criterion 4). Uses an explicit read loop so it
//! does not depend on `fd_filestat_get` for sizing.

use std::fs::File;
use std::io::{Read, Write};

fn main() {
    let mut file = File::open("/mnt/in.txt").expect("open /mnt/in.txt");
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        let n = file.read(&mut chunk).expect("read");
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&chunk[..n]);
    }
    std::io::stdout().write_all(&buf).expect("write stdout");
}

//! mount — print the mounted filesystems, read live from /proc/mounts (FHS). With no
//! arguments it lists the real mount table the kernel maintains.

use std::fs;

fn main() {
    match fs::read_to_string("/proc/mounts") {
        Ok(content) => {
            for line in content.lines() {
                let f: Vec<&str> = line.split_whitespace().collect();
                if f.len() >= 3 {
                    // device on mountpoint type fstype (options)
                    let opts = f.get(3).copied().unwrap_or("rw");
                    println!("{} on {} type {} ({})", f[0], f[1], f[2], opts);
                }
            }
        }
        Err(e) => {
            eprintln!("mount: cannot read /proc/mounts: {e}");
            std::process::exit(1);
        }
    }
}

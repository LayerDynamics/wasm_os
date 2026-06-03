//! touch — create each FILE if it does not already exist (the ensure-exists core of
//! touch). An existing file is left untouched. Errors are reported per file.

use std::fs::OpenOptions;

fn main() {
    let files: Vec<String> = std::env::args().skip(1).filter(|a| !a.starts_with('-')).collect();
    if files.is_empty() {
        eprintln!("touch: missing file operand");
        std::process::exit(1);
    }
    let mut code = 0;
    for path in files {
        // create(true) makes the file if absent; truncate(false) means an existing
        // file keeps its contents (touch must never clobber data).
        if let Err(e) = OpenOptions::new().create(true).write(true).truncate(false).open(&path) {
            eprintln!("touch: cannot touch '{path}': {e}");
            code = 1;
        }
    }
    std::process::exit(code);
}

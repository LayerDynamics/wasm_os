//! rm — remove files (FR-18). Directories require they be empty (rmdir-style).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: rm FILE...");
        std::process::exit(2);
    }
    let mut status = 0;
    for path in &args {
        let r = std::fs::remove_file(path).or_else(|_| std::fs::remove_dir(path));
        if r.is_err() {
            eprintln!("rm: {path}: No such file or directory");
            status = 1;
        }
    }
    std::process::exit(status);
}

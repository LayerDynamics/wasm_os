//! mkdir — create directories (FR-18).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        eprintln!("usage: mkdir DIR...");
        std::process::exit(2);
    }
    let mut status = 0;
    for path in &args {
        if std::fs::create_dir(path).is_err() {
            eprintln!("mkdir: cannot create directory '{path}'");
            status = 1;
        }
    }
    std::process::exit(status);
}

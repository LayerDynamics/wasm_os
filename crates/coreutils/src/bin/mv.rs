//! mv — rename/move SRC to DST (FR-18).

fn main() {
    wasmos_sys::chdir_to_pwd(); // relative paths resolve against $PWD, not the preopen root
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 2 {
        eprintln!("usage: mv SRC DST");
        std::process::exit(2);
    }
    if std::fs::rename(&args[0], &args[1]).is_err() {
        eprintln!("mv: cannot move {} to {}", args[0], args[1]);
        std::process::exit(1);
    }
}

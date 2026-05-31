//! ls — list directory contents (FR-18).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let dir = args.first().map(String::as_str).unwrap_or(".");
    match std::fs::read_dir(dir) {
        Ok(entries) => {
            let mut names: Vec<String> = entries
                .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
                .collect();
            names.sort();
            for n in names {
                println!("{n}");
            }
        }
        Err(_) => {
            eprintln!("ls: {dir}: No such file or directory");
            std::process::exit(1);
        }
    }
}

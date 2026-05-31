//! echo — write arguments to stdout, space-separated, newline-terminated (FR-18).

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    println!("{}", args.join(" "));
}

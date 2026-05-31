//! pwd — print the working directory (FR-18).

fn main() {
    match std::env::current_dir() {
        Ok(p) => println!("{}", p.display()),
        Err(_) => println!("/"),
    }
}

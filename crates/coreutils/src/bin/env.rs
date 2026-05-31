//! env — print the environment (FR-18). The M2 environment is empty.

fn main() {
    for (k, v) in std::env::vars() {
        println!("{k}={v}");
    }
}

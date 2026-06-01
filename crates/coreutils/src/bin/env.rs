//! env — print the environment (FR-18). Each process carries a real baseline
//! environment (PATH/HOME/TERM/PWD), inherited from its parent on spawn.

fn main() {
    for (k, v) in std::env::vars() {
        println!("{k}={v}");
    }
}

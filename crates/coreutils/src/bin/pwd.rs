//! pwd — print the working directory (FR-18).
//!
//! The kernel roots every process's preopen (fd 3) at "/" so the whole filesystem
//! is reachable, and carries the process's actual working directory in `$PWD`
//! (set from the shell's cwd at spawn). On wasm32-wasip1 `std::env::current_dir()`
//! reads wasi-libc's own cwd, which is "/" until a process `chdir`s; `$PWD` is the
//! canonical source the shell maintains (the same one bash's `pwd` builtin reads).

fn main() {
    match std::env::var("PWD") {
        Ok(dir) if !dir.is_empty() => println!("{dir}"),
        _ => println!("/"),
    }
}

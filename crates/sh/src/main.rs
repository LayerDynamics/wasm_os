//! WASM_OS shell (L2). A real `wasm32-wasip1` process bound to the terminal:
//! it reads a command line from stdin, resolves the program via `$PATH` (`/bin`)
//! in the VFS, spawns it through the `wasmos_kernel` extension with the terminal
//! as stdio, waits for it, and reports a non-zero exit (FR-15/16). Pipelines and
//! redirection (FR-17) are layered on in M2-T8.

use std::io::{Read, Write};
use wasmos_sys::{spawn, wait, Stdio};

const PROMPT: &str = "wasmos$ ";

fn main() {
    let mut stdin = std::io::stdin();
    loop {
        prompt();
        let line = match read_line(&mut stdin) {
            Some(l) => l,
            None => break, // stdin EOF
        };
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line == "exit" {
            break;
        }
        run_command(line);
    }
}

fn prompt() {
    print!("{PROMPT}");
    let _ = std::io::stdout().flush();
}

/// Run a single command with the terminal as stdio.
fn run_command(line: &str) {
    let argv: Vec<&str> = line.split_whitespace().collect();
    let Some(&cmd) = argv.first() else { return };
    let path = resolve(cmd);
    match spawn(&path, &argv, &[Stdio::Terminal, Stdio::Terminal, Stdio::Terminal]) {
        Ok(pid) => match wait(pid) {
            Ok(0) => {}
            Ok(code) => println!("[{cmd}: exit {code}]"),
            Err(e) => println!("{cmd}: wait failed (errno {e})"),
        },
        Err(_) => println!("{cmd}: command not found"),
    }
}

/// Resolve a command name against `$PATH` (`/bin`). Absolute/relative paths are
/// used as given.
fn resolve(cmd: &str) -> String {
    if cmd.contains('/') {
        cmd.to_string()
    } else {
        format!("/bin/{cmd}")
    }
}

/// Read one line from stdin (until CR/LF). Returns `None` at EOF. Blocks (parks)
/// until the terminal delivers input.
fn read_line(stdin: &mut std::io::Stdin) -> Option<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stdin.read(&mut byte) {
            Ok(0) => {
                if buf.is_empty() {
                    return None; // EOF with nothing read
                }
                break;
            }
            Ok(_) => {
                if byte[0] == b'\n' || byte[0] == b'\r' {
                    break;
                }
                buf.push(byte[0]);
            }
            Err(_) => break,
        }
    }
    Some(String::from_utf8_lossy(&buf).into_owned())
}

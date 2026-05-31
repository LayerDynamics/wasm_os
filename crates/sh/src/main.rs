//! WASM_OS shell (L2) — FR-15/16/17. A real `wasm32-wasip1` process bound to
//! the terminal. It reads a command line, parses a pipeline of stages with I/O
//! redirection, resolves each program via `$PATH` (`/bin`) in the VFS, wires the
//! stages together with kernel pipes, runs them via the `wasmos_kernel`
//! extension, and reports the pipeline's exit status. Built-ins: `cd`, `pwd`,
//! `exit`, and `$?` expansion.

use std::io::{Read, Write};
use wasmos_sys::{close, pipe, spawn, wait, Stdio, FILE_APPEND, FILE_READ, FILE_TRUNC};

fn main() {
    let mut stdin = std::io::stdin();
    let mut cwd = String::from("/");
    let mut last_status: i32 = 0;

    loop {
        prompt(&cwd);
        let line = match read_line(&mut stdin) {
            Some(l) => l,
            None => break, // stdin EOF
        };
        // Expand `$?` (last exit status) before parsing.
        let line = line.replace("$?", &last_status.to_string());
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        let stage_strs: Vec<&str> = line.split('|').map(str::trim).collect();

        // Built-ins run in the shell itself (only as a standalone command).
        if stage_strs.len() == 1 {
            if let Some(code) = try_builtin(stage_strs[0], &mut cwd) {
                last_status = code;
                continue;
            }
        }

        let stages: Vec<Stage> = stage_strs.iter().map(|s| parse_stage(s)).collect();
        if stages.iter().any(|s| s.argv.is_empty()) {
            eprintln!("sh: syntax error near `|`");
            last_status = 2;
            continue;
        }
        last_status = run_pipeline(&stages, &cwd);
    }
}

struct Stage<'a> {
    argv: Vec<&'a str>,
    stdin_file: Option<&'a str>,
    /// (path, append?)
    stdout_file: Option<(&'a str, bool)>,
}

/// Parse one pipeline stage: `prog args... [< in] [> out] [>> out]`.
fn parse_stage(s: &str) -> Stage<'_> {
    let mut argv = Vec::new();
    let mut stdin_file = None;
    let mut stdout_file = None;
    let toks: Vec<&str> = s.split_whitespace().collect();
    let mut i = 0;
    while i < toks.len() {
        let t = toks[i];
        if t == "<" {
            i += 1;
            stdin_file = toks.get(i).copied();
        } else if t == ">>" {
            i += 1;
            stdout_file = toks.get(i).copied().map(|f| (f, true));
        } else if t == ">" {
            i += 1;
            stdout_file = toks.get(i).copied().map(|f| (f, false));
        } else if let Some(f) = t.strip_prefix(">>") {
            stdout_file = Some((f, true));
        } else if let Some(f) = t.strip_prefix('>') {
            stdout_file = Some((f, false));
        } else if let Some(f) = t.strip_prefix('<') {
            stdin_file = Some(f);
        } else {
            argv.push(t);
        }
        i += 1;
    }
    Stage { argv, stdin_file, stdout_file }
}

/// Run a single command that is a shell built-in. Returns its status, or `None`
/// if the command is not a built-in.
fn try_builtin(s: &str, cwd: &mut String) -> Option<i32> {
    let toks: Vec<&str> = s.split_whitespace().collect();
    match toks.first().copied()? {
        "exit" => std::process::exit(toks.get(1).and_then(|c| c.parse().ok()).unwrap_or(0)),
        "pwd" => {
            println!("{cwd}");
            Some(0)
        }
        "cd" => {
            let target = toks.get(1).copied().unwrap_or("/");
            *cwd = resolve_path(cwd, target);
            Some(0)
        }
        _ => None,
    }
}

fn run_pipeline(stages: &[Stage], cwd: &str) -> i32 {
    let n = stages.len();
    // One pipe between each adjacent pair of stages.
    let mut pipes: Vec<(u32, u32, u32)> = Vec::new(); // (read_fd, write_fd, id)
    for _ in 0..n.saturating_sub(1) {
        match pipe() {
            Ok(p) => pipes.push(p),
            Err(e) => {
                eprintln!("sh: pipe failed (errno {e})");
                return 1;
            }
        }
    }

    let mut pids: Vec<Option<u32>> = Vec::new();
    for (i, stage) in stages.iter().enumerate() {
        let prog = stage.argv[0];
        let path = resolve_cmd(cwd, prog);

        let stdin = if let Some(f) = stage.stdin_file {
            Stdio::File { path: resolve_path(cwd, f), mode: FILE_READ }
        } else if i > 0 {
            Stdio::PipeRead(pipes[i - 1].2)
        } else {
            Stdio::Terminal
        };
        let stdout = if let Some((f, append)) = stage.stdout_file {
            Stdio::File {
                path: resolve_path(cwd, f),
                mode: if append { FILE_APPEND } else { FILE_TRUNC },
            }
        } else if i < n - 1 {
            Stdio::PipeWrite(pipes[i].2)
        } else {
            Stdio::Terminal
        };

        // Coreutils don't draw: no Gpu/Input delegation.
        match spawn(&path, &stage.argv, &[stdin, stdout, Stdio::Terminal], cwd, false, false) {
            Ok(pid) => pids.push(Some(pid)),
            Err(_) => {
                eprintln!("{prog}: command not found");
                pids.push(None);
            }
        }
    }

    // Release the shell's pipe ends so EOF/EPIPE propagate between stages.
    for (r, w, _) in &pipes {
        close(*r);
        close(*w);
    }

    // Wait for every stage; the pipeline's status is the last stage's.
    let mut status = 0;
    for (i, pid) in pids.iter().enumerate() {
        let code = match pid {
            Some(p) => wait(*p).unwrap_or(-1),
            None => 127, // failed to spawn
        };
        // A stage killed by a trap (wasm `unreachable`/panic) surfaces as an exit
        // code >= 128 (128 + signal). Report it like a real shell does for a
        // crashed child — naming the offending stage — so a crash anywhere in the
        // pipeline is visible. The prompt still returns: this is just a message,
        // and the kernel has already released the dead stage's pipe ends (FR-34).
        if code >= 128 {
            eprintln!("sh: {}: terminated abnormally (exit {code})", stages[i].argv[0]);
        }
        if i == pids.len() - 1 {
            status = code;
        }
    }
    status
}

/// Resolve a program name: a path (containing `/`) is resolved against `cwd`,
/// a bare name against `$PATH` (`/bin`).
fn resolve_cmd(cwd: &str, prog: &str) -> String {
    if prog.contains('/') {
        resolve_path(cwd, prog)
    } else {
        format!("/bin/{prog}")
    }
}

/// Normalize `target` against `cwd` into an absolute path (handles `.`/`..`).
fn resolve_path(cwd: &str, target: &str) -> String {
    let base = if target.starts_with('/') { "/" } else { cwd };
    let mut parts: Vec<&str> = base.split('/').filter(|s| !s.is_empty()).collect();
    for seg in target.split('/').filter(|s| !s.is_empty()) {
        match seg {
            "." => {}
            ".." => {
                parts.pop();
            }
            s => parts.push(s),
        }
    }
    if parts.is_empty() {
        "/".to_string()
    } else {
        format!("/{}", parts.join("/"))
    }
}

fn prompt(cwd: &str) {
    print!("wasmos:{cwd}$ ");
    let _ = std::io::stdout().flush();
}

/// Read one line from stdin (until CR/LF). `None` at EOF. Blocks (parks) until
/// the terminal delivers input.
fn read_line(stdin: &mut std::io::Stdin) -> Option<String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut byte = [0u8; 1];
    loop {
        match stdin.read(&mut byte) {
            Ok(0) => {
                if buf.is_empty() {
                    return None;
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

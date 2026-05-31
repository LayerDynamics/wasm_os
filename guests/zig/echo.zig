//! echo (Zig) — FR-14 polyglot proof. Observably identical to the Rust `echo`:
//! join argv[1..] with single spaces, terminate with one newline, write to stdout.
//!
//! Built with `zig build-exe -target wasm32-wasi` (see build:guests:zig). It speaks
//! the same WASI Preview 1 ABI as the Rust coreutils — args_sizes_get/args_get to
//! read argv, fd_write to emit stdout — so the kernel runs it through the exact same
//! process path. Deliberately uses only long-stable std APIs (raw WASI syscalls +
//! page_allocator, no ArrayList/File/Io churn) so it builds across Zig releases.
const std = @import("std");
const wasi = std.os.wasi;

pub fn main() !void {
    const alloc = std.heap.page_allocator;

    var count: usize = undefined;
    var buf_size: usize = undefined;
    if (wasi.args_sizes_get(&count, &buf_size) != .SUCCESS) return error.Args;

    const argv = try alloc.alloc([*:0]u8, count);
    const argv_buf = try alloc.alloc(u8, buf_size);
    if (wasi.args_get(argv.ptr, argv_buf.ptr) != .SUCCESS) return error.Args;

    // buf_size counts every arg's bytes plus a NUL per arg (incl. argv[0], which we
    // drop). We add at most (count-2) spaces and one newline; reusing the dropped
    // NUL/argv[0] headroom, buf_size + 1 is always enough.
    const out = try alloc.alloc(u8, buf_size + 1);
    var n: usize = 0;
    var i: usize = 1;
    while (i < count) : (i += 1) {
        if (i > 1) {
            out[n] = ' ';
            n += 1;
        }
        const arg = std.mem.span(argv[i]);
        @memcpy(out[n .. n + arg.len], arg);
        n += arg.len;
    }
    out[n] = '\n';
    n += 1;

    var written: usize = 0;
    while (written < n) {
        var w: usize = undefined;
        const iov = [_]wasi.ciovec_t{.{ .base = out.ptr + written, .len = n - written }};
        if (wasi.fd_write(1, &iov, 1, &w) != .SUCCESS) return error.Write;
        if (w == 0) break;
        written += w;
    }
}

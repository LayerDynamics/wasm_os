//! Mandelbrot explorer (Zig) — the desktop compositor polyglot graphical app (FR-14 on the
//! compositor path). It speaks the SAME `wasmos_kernel` syscall ABI as the Rust
//! canvas apps (win_surface/win_present/win_read_input over the single `syscall`
//! import), computes the Mandelbrot set into a framebuffer, and pans (drag) +
//! zooms (+/- keys) on brokered input — proving the OS's graphics + input stack
//! is language-agnostic. Built with `zig build-exe -target wasm32-wasi`.

const WIDTH: u32 = 300;
const HEIGHT: u32 = 240;
const MAX_ITER: u32 = 120;

// Opcodes — must match crates/kernel + crates/wasmos-sys.
const OP_WIN_SURFACE: u8 = 0x23;
const OP_WIN_PRESENT: u8 = 0x24;
const OP_WIN_READ_INPUT: u8 = 0x25;

// Input event kinds / key codes — must match the compositor encoder.
const EV_POINTER_MOVE: u8 = 1;
const EV_POINTER_DOWN: u8 = 2;
const EV_POINTER_UP: u8 = 3;
const EV_KEY_DOWN: u8 = 4;

extern "wasmos_kernel" fn syscall(req_ptr: [*]const u8, req_len: usize, resp_ptr: [*]u8, resp_cap: usize) usize;
extern "wasi_snapshot_preview1" fn random_get(buf: [*]u8, buf_len: usize) u16;

var framebuffer: [WIDTH * HEIGHT * 4]u8 = undefined;
var respbuf: [512]u8 = undefined;

fn putU32(buf: []u8, v: u32) void {
    buf[0] = @truncate(v);
    buf[1] = @truncate(v >> 8);
    buf[2] = @truncate(v >> 16);
    buf[3] = @truncate(v >> 24);
}
fn getU16(buf: []const u8) u16 {
    return @as(u16, buf[0]) | (@as(u16, buf[1]) << 8);
}
fn getU32(buf: []const u8) u32 {
    return @as(u32, buf[0]) | (@as(u32, buf[1]) << 8) | (@as(u32, buf[2]) << 16) | (@as(u32, buf[3]) << 24);
}

fn winSurface(w: u32, h: u32) u32 {
    var req: [9]u8 = undefined;
    req[0] = OP_WIN_SURFACE;
    putU32(req[1..5], w);
    putU32(req[5..9], h);
    _ = syscall(&req, req.len, &respbuf, respbuf.len);
    // resp: [errno u16][surface_id u32]
    return getU32(respbuf[2..6]);
}

fn winPresent(surface_id: u32) void {
    var req: [13]u8 = undefined;
    req[0] = OP_WIN_PRESENT;
    putU32(req[1..5], surface_id);
    putU32(req[5..9], @intCast(@intFromPtr(&framebuffer)));
    putU32(req[9..13], @intCast(framebuffer.len));
    _ = syscall(&req, req.len, &respbuf, respbuf.len);
}

const Event = struct { kind: u8, x: u16, y: u16, key: u32 };

/// Blocks until at least one event; writes them into `out`, returns the count.
/// Returns 0 with `ok=false` if the process lacks the Input capability.
fn winReadInput(out: []Event, ok: *bool) usize {
    var req: [5]u8 = undefined;
    req[0] = OP_WIN_READ_INPUT;
    putU32(req[1..5], 20 * 12);
    const n = syscall(&req, req.len, &respbuf, respbuf.len);
    ok.* = true;
    if (n < 6 or getU16(respbuf[0..2]) != 0) {
        ok.* = false;
        return 0;
    }
    const len = getU32(respbuf[2..6]);
    var count: usize = 0;
    var off: usize = 6;
    while (off + 12 <= 6 + len and off + 12 <= n and count < out.len) : (off += 12) {
        out[count] = .{
            .kind = respbuf[off],
            .x = getU16(respbuf[off + 2 .. off + 4]),
            .y = getU16(respbuf[off + 4 .. off + 6]),
            .key = getU32(respbuf[off + 6 .. off + 10]),
        };
        count += 1;
    }
    return count;
}

fn render(cx: f64, cy: f64, scale: f64) void {
    var py: u32 = 0;
    while (py < HEIGHT) : (py += 1) {
        var px: u32 = 0;
        while (px < WIDTH) : (px += 1) {
            const c_re = cx + (@as(f64, @floatFromInt(px)) - @as(f64, WIDTH) / 2.0) * scale;
            const c_im = cy + (@as(f64, @floatFromInt(py)) - @as(f64, HEIGHT) / 2.0) * scale;
            var zr: f64 = 0;
            var zi: f64 = 0;
            var it: u32 = 0;
            while (it < MAX_ITER and zr * zr + zi * zi <= 4.0) : (it += 1) {
                const nzr = zr * zr - zi * zi + c_re;
                zi = 2.0 * zr * zi + c_im;
                zr = nzr;
            }
            const i = (py * WIDTH + px) * 4;
            if (it >= MAX_ITER) {
                framebuffer[i] = 0;
                framebuffer[i + 1] = 0;
                framebuffer[i + 2] = 0;
            } else {
                const t = @as(f64, @floatFromInt(it)) / @as(f64, MAX_ITER);
                framebuffer[i] = @intFromFloat(9.0 * (1.0 - t) * t * t * t * 255.0);
                framebuffer[i + 1] = @intFromFloat(15.0 * (1.0 - t) * (1.0 - t) * t * t * 255.0);
                framebuffer[i + 2] = @intFromFloat(8.5 * (1.0 - t) * (1.0 - t) * (1.0 - t) * t * 255.0);
            }
            framebuffer[i + 3] = 255;
        }
    }
}

const View = struct { cx: f64, cy: f64, scale: f64 };

const VIEW_PRESETS = [_]View{
    .{ .cx = -0.743643887, .cy = 0.131825904, .scale = 0.0042 }, // seahorse valley
    .{ .cx = -0.101096, .cy = 0.956286, .scale = 0.0028 }, // double spiral
    .{ .cx = 0.285, .cy = 0.01, .scale = 0.0065 }, // elephant valley
    .{ .cx = -1.25066, .cy = 0.02012, .scale = 0.0038 }, // mini Mandelbrot
    .{ .cx = -0.16, .cy = 1.0405, .scale = 0.0055 }, // dendrite
    .{ .cx = -0.6, .cy = 0.0, .scale = 3.0 / @as(f64, WIDTH) }, // full set
};

fn mix(value: u64) u64 {
    var x = value;
    x ^= x >> 30;
    x *%= 0xbf58476d1ce4e5b9;
    x ^= x >> 27;
    x *%= 0x94d049bb133111eb;
    return x ^ (x >> 31);
}

fn unit(value: u64) f64 {
    return @as(f64, @floatFromInt(value & 0xffff)) / 65535.0;
}

fn randomSeed() u64 {
    var bytes: [8]u8 = undefined;
    if (random_get(&bytes, bytes.len) != 0) return 0x6a09e667f3bcc909;
    var seed: u64 = 0;
    var i: usize = 0;
    while (i < bytes.len) : (i += 1) seed |= @as(u64, bytes[i]) << @as(u6, @intCast(i * 8));
    return if (seed == 0) 0x6a09e667f3bcc909 else seed;
}

fn nextView(seed: u64, generation: u32) View {
    const r = mix(seed +% (@as(u64, generation) *% 0x9e3779b97f4a7c15));
    var view = VIEW_PRESETS[@as(usize, @intCast(r % @as(u64, VIEW_PRESETS.len)))];
    const x_jitter = (unit(r >> 16) - 0.5) * 2.0;
    const y_jitter = (unit(r >> 32) - 0.5) * 2.0;
    view.cx += x_jitter * view.scale * 12.0;
    view.cy += y_jitter * view.scale * 12.0;
    view.scale *= 0.72 + unit(r >> 48) * 0.48;
    return view;
}

pub fn main() void {
    const surface = winSurface(WIDTH, HEIGHT);

    var seed = randomSeed();
    var generation: u32 = 0;
    var view = nextView(seed, generation);
    var cx = view.cx;
    var cy = view.cy;
    var scale = view.scale;

    render(cx, cy, scale);
    winPresent(surface);

    var events: [20]Event = undefined;
    var dragging = false;
    var last_x: f64 = 0;
    var last_y: f64 = 0;
    while (true) {
        var ok: bool = false;
        const n = winReadInput(&events, &ok);
        if (!ok) return; // no Input capability — the current fractal remains visible
        var changed = false;
        var received_key = false;
        var k: usize = 0;
        while (k < n) : (k += 1) {
            const ev = events[k];
            switch (ev.kind) {
                EV_POINTER_DOWN => {
                    dragging = true;
                    last_x = @floatFromInt(ev.x);
                    last_y = @floatFromInt(ev.y);
                },
                EV_POINTER_UP => dragging = false,
                EV_POINTER_MOVE => {
                    if (dragging) {
                        const nx: f64 = @floatFromInt(ev.x);
                        const ny: f64 = @floatFromInt(ev.y);
                        cx -= (nx - last_x) * scale;
                        cy -= (ny - last_y) * scale;
                        last_x = nx;
                        last_y = ny;
                        changed = true;
                    }
                },
                EV_KEY_DOWN => {
                    received_key = true;
                    if (ev.key == 'n' or ev.key == 'N' or ev.key == ' ') {
                        generation +%= 1;
                        view = nextView(seed, generation);
                        cx = view.cx;
                        cy = view.cy;
                        scale = view.scale;
                        changed = true;
                    } else if (ev.key == 'r' or ev.key == 'R') {
                        seed = randomSeed();
                        generation = 0;
                        view = nextView(seed, generation);
                        cx = view.cx;
                        cy = view.cy;
                        scale = view.scale;
                        changed = true;
                    } else if (ev.key == '+' or ev.key == '=') {
                        scale *= 0.7;
                        changed = true;
                    } else if (ev.key == '-' or ev.key == '_') {
                        scale *= 1.4;
                        changed = true;
                    }
                },
                else => {},
            }
        }
        if (changed or received_key) {
            render(cx, cy, scale);
            winPresent(surface);
        }
    }
}

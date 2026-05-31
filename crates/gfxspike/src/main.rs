//! gfxspike — the M3 compositor-surface spine fixture (FR-23).
//!
//! Requests a canvas surface (needs the `Gpu` capability), draws a recognizable,
//! clearly non-blank pattern into an RGBA framebuffer, and presents it. Then it
//! parks on stdin so the process — and its window — stays alive without burning
//! CPU. M3-T3 extends this to redraw in response to brokered input.

use std::io::Read;
use wasmos_sys::{win_present, win_surface};

const W: u32 = 192;
const H: u32 = 128;

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1), // no Gpu capability → cannot draw
    };

    let mut fb = vec![0u8; (W * H * 4) as usize];
    for y in 0..H {
        for x in 0..W {
            let i = ((y * W + x) * 4) as usize;
            fb[i] = (x * 255 / W) as u8; // R: left→right gradient
            fb[i + 1] = (y * 255 / H) as u8; // G: top→bottom gradient
            fb[i + 2] = 160; // B: constant
            fb[i + 3] = 255; // opaque
        }
    }
    // A white square in the centre makes "non-blank + structured" unmistakable.
    for y in (H / 2 - 16)..(H / 2 + 16) {
        for x in (W / 2 - 16)..(W / 2 + 16) {
            let i = ((y * W + x) * 4) as usize;
            fb[i] = 255;
            fb[i + 1] = 255;
            fb[i + 2] = 255;
            fb[i + 3] = 255;
        }
    }
    win_present(surface, &fb);

    // Park on stdin: keep the process + its window alive without spinning.
    let mut byte = [0u8; 1];
    let _ = std::io::stdin().read(&mut byte);
}

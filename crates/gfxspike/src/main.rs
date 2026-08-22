//! gfxspike — the desktop compositor surface + input fixture (FR-23, FR-25).
//!
//! Requests a canvas surface (Gpu cap), draws a recognizable pattern, and presents
//! it. Then, if it holds the Input capability, it loops on brokered input and
//! redraws — a white marker follows the pointer, and a click/key shifts the
//! background — so the canvas visibly CHANGES in response to real input. Without
//! Input it parks on stdin (stays alive, no CPU spin) so the surface-only path is
//! still exercised.

use std::io::Read;
use wasmos_sys::{
    win_present, win_read_input, win_surface, EV_KEY_DOWN, EV_POINTER_DOWN, EV_POINTER_MOVE,
    KEY_ESCAPE,
};

const W: u32 = 192;
const H: u32 = 128;

/// Redraw the gradient background plus a white marker centred on `cursor`.
fn draw(fb: &mut [u8], cursor: (u16, u16), bg: u8) {
    for y in 0..H {
        for x in 0..W {
            let i = ((y * W + x) * 4) as usize;
            fb[i] = (x * 255 / W) as u8;
            fb[i + 1] = (y * 255 / H) as u8;
            fb[i + 2] = bg;
            fb[i + 3] = 255;
        }
    }
    let (cx, cy) = (cursor.0 as i32, cursor.1 as i32);
    for dy in -12..12 {
        for dx in -12..12 {
            let (x, y) = (cx + dx, cy + dy);
            if x >= 0 && x < W as i32 && y >= 0 && y < H as i32 {
                let i = ((y as u32 * W + x as u32) * 4) as usize;
                fb[i] = 255;
                fb[i + 1] = 255;
                fb[i + 2] = 255;
                fb[i + 3] = 255;
            }
        }
    }
}

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1), // no Gpu capability → cannot draw
    };

    let mut fb = vec![0u8; (W * H * 4) as usize];
    let mut cursor = (W as u16 / 2, H as u16 / 2);
    let mut bg: u8 = 160;
    draw(&mut fb, cursor, bg);
    win_present(surface, &fb);

    loop {
        match win_read_input() {
            Ok(events) => {
                for ev in &events {
                    match ev.kind {
                        EV_POINTER_MOVE => cursor = (ev.x, ev.y),
                        EV_POINTER_DOWN => {
                            cursor = (ev.x, ev.y);
                            bg = bg.wrapping_add(40);
                        }
                        // Escape triggers a deliberate trap — the crash-containment
                        // fixture (FR-34): the window closes, the desktop survives.
                        EV_KEY_DOWN if ev.key == KEY_ESCAPE => std::process::abort(),
                        EV_KEY_DOWN => bg = bg.wrapping_add(40),
                        _ => {}
                    }
                }
                draw(&mut fb, cursor, bg);
                win_present(surface, &fb);
            }
            Err(_) => {
                // No Input capability: keep the window alive without spinning.
                let mut byte = [0u8; 1];
                let _ = std::io::stdin().read(&mut byte);
                return;
            }
        }
    }
}

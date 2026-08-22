//! Paint (L3 / desktop compositor) — a real `wasm32-wasip1` canvas app.
//!
//! Draws brush strokes into a wasmgfx framebuffer from brokered pointer input,
//! with a colour palette, a clear button, and save/load to the VFS
//! (`/home/paint.img`). Strokes accumulate in the framebuffer; only the toolbar
//! is repainted each frame. This is a genuinely interactive, stateful, persistent
//! app — not a passive animation.

use wasmgfx::{rgb, Color, Framebuffer, BLACK, WHITE};
use wasmos_sys::{
    win_present, win_read_input, win_surface, EV_POINTER_DOWN, EV_POINTER_MOVE, EV_POINTER_UP,
};

const W: u32 = 400;
const H: u32 = 320;
const TOOLBAR_H: i32 = 24;
const SAVE_PATH: &str = "/home/paint.img";
const MAGIC: &[u8; 4] = b"WPN1";

const PALETTE: [Color; 8] = [
    BLACK,
    rgb(220, 50, 50),   // red
    rgb(60, 200, 70),   // green
    rgb(60, 110, 230),  // blue
    rgb(235, 200, 60),  // yellow
    rgb(70, 200, 220),  // cyan
    rgb(210, 80, 200),  // magenta
    WHITE,              // (eraser-ish)
];

// Toolbar geometry.
const SW: i32 = 18; // swatch size
const GAP: i32 = 22;
const SW_X0: i32 = 4;
const CLR_X: i32 = 4 + 8 * GAP + 8; // after the 8 swatches
const CLR_W: i32 = 40;
const SAVE_X: i32 = CLR_X + CLR_W + 8;
const SAVE_W: i32 = 56;

struct App {
    fb: Framebuffer,
    color: Color,
    drawing: bool,
}

impl App {
    fn clear_canvas(&mut self) {
        self.fb.fill_rect(0, TOOLBAR_H, W as i32, H as i32 - TOOLBAR_H, WHITE);
    }

    fn paint_at(&mut self, x: i32, y: i32) {
        if y < TOOLBAR_H {
            return;
        }
        self.fb.fill_rect(x - 2, y - 2, 5, 5, self.color);
    }

    fn toolbar(&mut self) {
        self.fb.fill_rect(0, 0, W as i32, TOOLBAR_H, rgb(40, 44, 54));
        for (i, c) in PALETTE.iter().enumerate() {
            let x = SW_X0 + i as i32 * GAP;
            self.fb.fill_rect(x, 3, SW, SW, *c);
            if *c == self.color {
                self.fb.rect(x - 1, 2, SW + 2, SW + 2, WHITE); // selection ring
            }
        }
        self.fb.fill_rect(CLR_X, 3, CLR_W, SW, rgb(70, 74, 84));
        self.fb.text(CLR_X + 8, 7, "CLR", WHITE);
        self.fb.fill_rect(SAVE_X, 3, SAVE_W, SW, rgb(50, 110, 70));
        self.fb.text(SAVE_X + 6, 7, "SAVE", WHITE);
    }

    fn toolbar_click(&mut self, x: i32) {
        for (i, c) in PALETTE.iter().enumerate() {
            let sx = SW_X0 + i as i32 * GAP;
            if (sx..sx + SW).contains(&x) {
                self.color = *c;
                return;
            }
        }
        if (CLR_X..CLR_X + CLR_W).contains(&x) {
            self.clear_canvas();
        } else if (SAVE_X..SAVE_X + SAVE_W).contains(&x) {
            self.save();
        }
    }

    fn save(&self) {
        let mut out = Vec::with_capacity(12 + self.fb.buf.len());
        out.extend_from_slice(MAGIC);
        out.extend_from_slice(&W.to_le_bytes());
        out.extend_from_slice(&H.to_le_bytes());
        out.extend_from_slice(&self.fb.buf);
        let _ = std::fs::write(SAVE_PATH, out);
    }

    fn load(&mut self) {
        if let Ok(data) = std::fs::read(SAVE_PATH) {
            if data.len() >= 12 && &data[0..4] == MAGIC {
                let w = u32::from_le_bytes([data[4], data[5], data[6], data[7]]);
                let h = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
                if w == W && h == H && data.len() == 12 + self.fb.buf.len() {
                    self.fb.buf.copy_from_slice(&data[12..]);
                }
            }
        }
    }
}

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1),
    };
    let mut app = App { fb: Framebuffer::new(W, H), color: PALETTE[1], drawing: false };
    app.clear_canvas();
    app.load(); // restore a prior drawing if present
    app.toolbar();
    win_present(surface, app.fb.bytes());

    loop {
        let events = match win_read_input() {
            Ok(ev) => ev,
            Err(_) => return,
        };
        for ev in &events {
            let (x, y) = (ev.x as i32, ev.y as i32);
            match ev.kind {
                EV_POINTER_DOWN => {
                    if y < TOOLBAR_H {
                        app.toolbar_click(x);
                    } else {
                        app.drawing = true;
                        app.paint_at(x, y);
                    }
                }
                EV_POINTER_MOVE if app.drawing => app.paint_at(x, y),
                EV_POINTER_UP => app.drawing = false,
                _ => {}
            }
        }
        app.toolbar();
        win_present(surface, app.fb.bytes());
    }
}

//! wasmgfx — a tiny software-rendering SDK for WASM_OS canvas apps (M3).
//!
//! A [`Framebuffer`] is `width*height` RGBA pixels (the byte order the host blits
//! straight into a `<canvas>` `ImageData`). It offers clipped primitives
//! (`clear`/`put_pixel`/`fill_rect`/`hline`/`vline`/`rect`/`blit`) and an 8x8
//! bitmap-font `text` for the file manager, editor, and HUDs. No I/O — it builds
//! and unit-tests on the host as well as `wasm32-wasip1`.

mod font;

/// An RGBA colour (the framebuffer's native pixel).
pub type Color = [u8; 4];

/// Opaque RGB.
pub const fn rgb(r: u8, g: u8, b: u8) -> Color {
    [r, g, b, 255]
}

pub const BLACK: Color = rgb(0, 0, 0);
pub const WHITE: Color = rgb(255, 255, 255);

/// Width of one character cell when drawn with [`Framebuffer::text`].
pub const GLYPH_W: u32 = 8;
/// Height of one character cell.
pub const GLYPH_H: u32 = 8;

pub struct Framebuffer {
    pub w: u32,
    pub h: u32,
    pub buf: Vec<u8>,
}

impl Framebuffer {
    pub fn new(w: u32, h: u32) -> Self {
        Self { w, h, buf: vec![0u8; (w * h * 4) as usize] }
    }

    /// The raw RGBA bytes to hand to `win_present`.
    pub fn bytes(&self) -> &[u8] {
        &self.buf
    }

    pub fn clear(&mut self, c: Color) {
        for px in self.buf.chunks_exact_mut(4) {
            px.copy_from_slice(&c);
        }
    }

    #[inline]
    pub fn put_pixel(&mut self, x: i32, y: i32, c: Color) {
        if x < 0 || y < 0 || x >= self.w as i32 || y >= self.h as i32 {
            return;
        }
        let i = ((y as u32 * self.w + x as u32) * 4) as usize;
        self.buf[i..i + 4].copy_from_slice(&c);
    }

    pub fn fill_rect(&mut self, x: i32, y: i32, w: i32, h: i32, c: Color) {
        for yy in y..y + h {
            for xx in x..x + w {
                self.put_pixel(xx, yy, c);
            }
        }
    }

    pub fn hline(&mut self, x: i32, y: i32, len: i32, c: Color) {
        for xx in x..x + len {
            self.put_pixel(xx, y, c);
        }
    }

    pub fn vline(&mut self, x: i32, y: i32, len: i32, c: Color) {
        for yy in y..y + len {
            self.put_pixel(x, yy, c);
        }
    }

    /// A 1px rectangle outline.
    pub fn rect(&mut self, x: i32, y: i32, w: i32, h: i32, c: Color) {
        self.hline(x, y, w, c);
        self.hline(x, y + h - 1, w, c);
        self.vline(x, y, h, c);
        self.vline(x + w - 1, y, h, c);
    }

    /// Copy a `sw*sh` RGBA sub-image to `(dx, dy)` (clipped).
    pub fn blit(&mut self, src: &[u8], sw: u32, sh: u32, dx: i32, dy: i32) {
        for sy in 0..sh {
            for sx in 0..sw {
                let i = ((sy * sw + sx) * 4) as usize;
                if i + 4 <= src.len() {
                    let c = [src[i], src[i + 1], src[i + 2], src[i + 3]];
                    self.put_pixel(dx + sx as i32, dy + sy as i32, c);
                }
            }
        }
    }

    /// Draw one 8x8 glyph at `(x, y)`. Non-printable chars render blank.
    pub fn glyph(&mut self, x: i32, y: i32, ch: char, c: Color) {
        let rows = font::glyph(ch);
        for (row, bits) in rows.iter().enumerate() {
            for col in 0..8 {
                if (bits >> col) & 1 != 0 {
                    self.put_pixel(x + col, y + row as i32, c);
                }
            }
        }
    }

    /// Draw a string left-to-right at `(x, y)` (no wrapping; `\n` advances a line).
    pub fn text(&mut self, x: i32, y: i32, s: &str, c: Color) {
        let (mut cx, mut cy) = (x, y);
        for ch in s.chars() {
            if ch == '\n' {
                cx = x;
                cy += GLYPH_H as i32;
                continue;
            }
            self.glyph(cx, cy, ch, c);
            cx += GLYPH_W as i32;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Byte offset of pixel (x, y) in a `w`-wide framebuffer.
    fn off(x: usize, y: usize, w: usize) -> usize {
        (y * w + x) * 4
    }

    #[test]
    fn clear_and_put_pixel_are_clipped() {
        let mut fb = Framebuffer::new(4, 3);
        fb.clear(rgb(10, 20, 30));
        assert_eq!(&fb.buf[0..4], &[10, 20, 30, 255]);
        fb.put_pixel(1, 1, WHITE);
        let o = off(1, 1, 4);
        assert_eq!(&fb.buf[o..o + 4], &[255, 255, 255, 255]);
        // Out-of-bounds writes are ignored (no panic, no corruption).
        fb.put_pixel(-1, 0, WHITE);
        fb.put_pixel(99, 99, WHITE);
    }

    #[test]
    fn fill_rect_and_outline() {
        let mut fb = Framebuffer::new(8, 8);
        fb.fill_rect(2, 2, 3, 3, rgb(1, 2, 3));
        let inside = off(2, 2, 8);
        assert_eq!(&fb.buf[inside..inside + 4], &[1, 2, 3, 255]);
        // A pixel just outside the rect is still zero.
        let outside = off(5, 2, 8);
        assert_eq!(&fb.buf[outside..outside + 4], &[0, 0, 0, 0]);
    }

    #[test]
    fn text_renders_known_glyphs() {
        // 'A' has set pixels; a space renders nothing. Proves the font path works.
        let mut fb = Framebuffer::new(16, 8);
        fb.text(0, 0, "A ", WHITE);
        let lit = fb.buf.chunks_exact(4).filter(|p| p[0] == 255).count();
        assert!(lit > 4, "expected 'A' to set several pixels, got {lit}");
        // The space cell (x in 8..16) is blank.
        let space_lit = (0..8u32)
            .flat_map(|row| (8..16u32).map(move |col| (row, col)))
            .filter(|&(row, col)| fb.buf[((row * 16 + col) * 4) as usize] == 255)
            .count();
        assert_eq!(space_lit, 0);
    }
}

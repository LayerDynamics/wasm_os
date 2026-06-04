//! Text editor (L3 / M3) — a real `wasm32-wasip1` canvas app.
//!
//! Opens the file named in `argv[1]` (or `/home/untitled.txt` when launched
//! directly), renders it with the wasmgfx font, edits via brokered keyboard
//! input (printable chars, Enter, Backspace, arrows), and saves with Ctrl+S. This
//! is the file manager's `.txt` association target.

use wasmgfx::{rgb, Color, Framebuffer};
use wasmos_sys::{
    win_present, win_read_input, win_surface, EV_KEY_DOWN, KEY_BACKSPACE, KEY_DELETE, KEY_DOWN,
    KEY_ENTER, KEY_LEFT, KEY_RIGHT, KEY_UP,
};

const W: u32 = 540;
const H: u32 = 360;
const HEADER_H: i32 = 16;
const LINE_H: i32 = 10;
const CHAR_W: i32 = 8;
const LEFT: i32 = 4;
const MOD_CTRL: u8 = 2;

const BG: Color = rgb(22, 25, 31);
const HEADER_BG: Color = rgb(40, 48, 65);
const FG: Color = rgb(222, 224, 228);
const CARET: Color = rgb(120, 200, 255);

struct Editor {
    path: String,
    lines: Vec<String>,
    row: usize,
    col: usize,
    scroll: usize,
    modified: bool,
    obj: Option<Vec<u8>>, // Some(bytes) when the file is a wasm object (FR-12)
}

impl Editor {
    fn load(path: String) -> Editor {
        // Decide if this is a byteblockstorage document. Guard against clobbering an
        // existing non-document .wasm (e.g. an executable guest): only a .wasm path
        // that DOES NOT EXIST yet becomes a new mintable document. An existing .wasm
        // that does not verify is treated as a plain file (obj=None → no mint on save).
        let read = std::fs::read(&path);
        let (text, obj) = if path.ends_with(".wasm") {
            match &read {
                Ok(bytes) if byteblockstorage::verify(bytes).is_ok() => {
                    let content = byteblockstorage::read(bytes).unwrap_or_default();
                    (String::from_utf8_lossy(&content).into_owned(), Some(bytes.clone()))
                }
                Ok(bytes) => (String::from_utf8_lossy(bytes).into_owned(), None),
                Err(_) => (String::new(), Some(Vec::new())), // new doc → save mints
            }
        } else {
            let bytes = read.unwrap_or_default();
            (String::from_utf8_lossy(&bytes).into_owned(), None)
        };
        let mut lines: Vec<String> = text
            .split('\n')
            .map(|s| s.chars().filter(|c| (' '..='~').contains(c)).collect())
            .collect();
        if lines.is_empty() {
            lines.push(String::new());
        }
        Editor { path, lines, row: 0, col: 0, scroll: 0, modified: false, obj }
    }

    fn save(&mut self) {
        let text = self.lines.join("\n");
        let ok = match &mut self.obj {
            Some(obj) => {
                // Ensure we have a live object to write into; mint one sized to content.
                if byteblockstorage::verify(obj).is_err() {
                    let tier = byteblockstorage::Tier::for_len(text.len() as u32 + 4)
                        .unwrap_or(byteblockstorage::Tier::K64);
                    *obj = byteblockstorage::mint(tier, 0);
                }
                byteblockstorage::save(obj, text.as_bytes()).is_ok()
                    && std::fs::write(&self.path, &obj[..]).is_ok()
            }
            None => std::fs::write(&self.path, text.as_bytes()).is_ok(),
        };
        if ok {
            self.modified = false;
        }
    }

    fn insert(&mut self, c: char) {
        // ASCII printable only (the font + byte/char indexing assume it).
        if !(' '..='~').contains(&c) {
            return;
        }
        let line = &mut self.lines[self.row];
        let at = self.col.min(line.len());
        line.insert(at, c);
        self.col = at + 1;
        self.modified = true;
    }

    fn newline(&mut self) {
        let line = &mut self.lines[self.row];
        let rest = line.split_off(self.col.min(line.len()));
        self.lines.insert(self.row + 1, rest);
        self.row += 1;
        self.col = 0;
        self.modified = true;
    }

    fn backspace(&mut self) {
        if self.col > 0 {
            self.lines[self.row].remove(self.col - 1);
            self.col -= 1;
        } else if self.row > 0 {
            let cur = self.lines.remove(self.row);
            self.row -= 1;
            self.col = self.lines[self.row].len();
            self.lines[self.row].push_str(&cur);
        }
        self.modified = true;
    }

    fn delete_forward(&mut self) {
        let len = self.lines[self.row].len();
        if self.col < len {
            self.lines[self.row].remove(self.col); // erase the char under the cursor
        } else if self.row + 1 < self.lines.len() {
            let next = self.lines.remove(self.row + 1); // at line end: pull up the next line
            self.lines[self.row].push_str(&next);
        } else {
            return; // end of buffer: nothing to delete
        }
        self.modified = true;
    }

    fn move_cursor(&mut self, key: u32) {
        match key {
            KEY_LEFT => {
                if self.col > 0 {
                    self.col -= 1;
                } else if self.row > 0 {
                    self.row -= 1;
                    self.col = self.lines[self.row].len();
                }
            }
            KEY_RIGHT => {
                if self.col < self.lines[self.row].len() {
                    self.col += 1;
                } else if self.row + 1 < self.lines.len() {
                    self.row += 1;
                    self.col = 0;
                }
            }
            KEY_UP if self.row > 0 => {
                self.row -= 1;
                self.col = self.col.min(self.lines[self.row].len());
            }
            KEY_DOWN if self.row + 1 < self.lines.len() => {
                self.row += 1;
                self.col = self.col.min(self.lines[self.row].len());
            }
            _ => {}
        }
    }

    fn visible(&self) -> usize {
        ((H as i32 - HEADER_H) / LINE_H) as usize
    }

    fn keep_cursor_visible(&mut self) {
        if self.row < self.scroll {
            self.scroll = self.row;
        } else if self.row >= self.scroll + self.visible() {
            self.scroll = self.row + 1 - self.visible();
        }
    }

    fn draw(&self, fb: &mut Framebuffer) {
        fb.clear(BG);
        fb.fill_rect(0, 0, W as i32, HEADER_H, HEADER_BG);
        let title = format!("{}{}", self.path, if self.modified { " *" } else { "" });
        fb.text(LEFT, 4, &title, FG);

        for screen in 0..self.visible() {
            let li = self.scroll + screen;
            if li >= self.lines.len() {
                break;
            }
            let y = HEADER_H + screen as i32 * LINE_H;
            fb.text(LEFT, y + 1, &self.lines[li], FG);
            if li == self.row {
                let cx = LEFT + self.col as i32 * CHAR_W;
                fb.fill_rect(cx, y, 1, wasmgfx::GLYPH_H as i32, CARET);
            }
        }
    }
}

fn main() {
    let path = std::env::args().nth(1).unwrap_or_else(|| "/home/untitled.txt".to_string());
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1),
    };
    let mut ed = Editor::load(path);
    let mut fb = Framebuffer::new(W, H);
    ed.draw(&mut fb);
    win_present(surface, fb.bytes());

    loop {
        let events = match win_read_input() {
            Ok(ev) => ev,
            Err(_) => return,
        };
        for ev in &events {
            if ev.kind != EV_KEY_DOWN {
                continue;
            }
            // Ctrl+S saves.
            if ev.key == 's' as u32 && ev.mods & MOD_CTRL != 0 {
                ed.save();
                continue;
            }
            match ev.key {
                KEY_ENTER => ed.newline(),
                KEY_BACKSPACE => ed.backspace(),
                KEY_DELETE => ed.delete_forward(),
                KEY_LEFT | KEY_RIGHT | KEY_UP | KEY_DOWN => ed.move_cursor(ev.key),
                k if k < 0x100 => {
                    if let Some(c) = char::from_u32(k) {
                        ed.insert(c);
                    }
                }
                _ => {}
            }
        }
        ed.keep_cursor_visible();
        ed.draw(&mut fb);
        win_present(surface, fb.bytes());
    }
}

//! Lisp — a code-runtime app: an interactive REPL for a complete
//! Scheme-like interpreter (`interp.rs`), running as a real `wasm32-wasip1` canvas
//! process. You type expressions at the `λ` prompt; the interpreter evaluates them
//! in a persistent environment (so `define`s accumulate across a session) and the
//! result + any `display` output print to a scrolling console. Keyboard is brokered
//! by the compositor (Input capability); pixels go through a canvas surface (Gpu).
//! This is "a runtime accessible in the browser" — write code, run it, see results.

mod interp;

use interp::{global_env, run, Env};
use wasmgfx::{rgb, Color, Framebuffer, GLYPH_H, GLYPH_W};
use wasmos_sys::{
    win_present, win_read_input, win_surface, EV_KEY_DOWN, KEY_BACKSPACE, KEY_DELETE, KEY_DOWN,
    KEY_END, KEY_ENTER, KEY_HOME, KEY_LEFT, KEY_RIGHT, KEY_UP,
};

const W: u32 = 640;
const H: u32 = 440;
const TITLE_H: i32 = 16;
const ROW_H: i32 = 10;
const COLS: usize = (W as usize / GLYPH_W as usize) - 1; // text columns (1-char margin)

const BG: Color = rgb(16, 18, 24);
const TITLE_BG: Color = rgb(46, 34, 66);
const FG: Color = rgb(214, 217, 223);
const PROMPT: Color = rgb(126, 214, 142);
const ECHO: Color = rgb(150, 156, 168);
const ERR: Color = rgb(232, 120, 120);
const CURSOR: Color = rgb(126, 214, 142);

/// A console line + the colour it renders in.
struct Line {
    text: String,
    color: Color,
}

struct Repl {
    env: Env,
    lines: Vec<Line>,
    input: String,
    cursor: usize,
    history: Vec<String>,
    /// Position while browsing history with Up/Down (None = editing fresh input).
    hist_pos: Option<usize>,
}

impl Repl {
    fn new() -> Self {
        let mut r = Repl {
            env: global_env(),
            lines: Vec::new(),
            input: String::new(),
            cursor: 0,
            history: Vec::new(),
            hist_pos: None,
        };
        r.push(FG, "Lisp — a Scheme runtime in your browser.");
        r.push(ECHO, "Try: (define (fib n) (if (< n 2) n (+ (fib (- n 1)) (fib (- n 2)))))");
        r.push(ECHO, "then: (fib 20)");
        r.push(FG, "");
        r
    }

    /// Push a (word-wrapped) console line.
    fn push(&mut self, color: Color, text: &str) {
        if text.is_empty() {
            self.lines.push(Line { text: String::new(), color });
            return;
        }
        let chars: Vec<char> = text.chars().collect();
        for chunk in chars.chunks(COLS) {
            self.lines.push(Line { text: chunk.iter().collect(), color });
        }
    }

    /// Evaluate the current input line, appending the echo + result/output.
    fn submit(&mut self) {
        let src = std::mem::take(&mut self.input);
        self.cursor = 0;
        self.hist_pos = None;
        self.push(ECHO, &format!("\u{3bb} {src}"));
        if src.trim().is_empty() {
            return;
        }
        self.history.push(src.clone());
        match run(&src, &self.env) {
            Ok((value, output)) => {
                if !output.is_empty() {
                    for l in output.split('\n') {
                        self.push(FG, l);
                    }
                }
                let rendered = format!("{value}");
                if !rendered.is_empty() {
                    self.push(FG, &format!("=> {rendered}"));
                }
            }
            Err(e) => self.push(ERR, &format!("error: {e}")),
        }
        self.persist();
    }

    /// Save the session transcript to the VFS so a session is durable + inspectable
    /// (FR-30). Best-effort: silently skipped if the app lacks an FS grant.
    fn persist(&self) {
        let transcript: String = self.lines.iter().map(|l| l.text.as_str()).collect::<Vec<_>>().join("\n");
        let _ = std::fs::write("/home/.lisp-session.txt", transcript);
    }

    fn recall_history(&mut self, back: bool) {
        if self.history.is_empty() {
            return;
        }
        let pos = match (self.hist_pos, back) {
            (None, true) => self.history.len() - 1,
            (None, false) => return,
            (Some(p), true) => p.saturating_sub(1),
            (Some(p), false) => {
                if p + 1 >= self.history.len() {
                    self.hist_pos = None;
                    self.input.clear();
                    self.cursor = 0;
                    return;
                }
                p + 1
            }
        };
        self.hist_pos = Some(pos);
        self.input = self.history[pos].clone();
        self.cursor = self.input.chars().count();
    }

    fn key(&mut self, code: u32) {
        match code {
            KEY_ENTER => self.submit(),
            KEY_BACKSPACE if self.cursor > 0 => {
                let idx = self.byte_at(self.cursor - 1);
                self.input.remove(idx);
                self.cursor -= 1;
            }
            KEY_DELETE => {
                let len = self.input.chars().count();
                if self.cursor < len {
                    let idx = self.byte_at(self.cursor);
                    self.input.remove(idx);
                }
            }
            KEY_LEFT => self.cursor = self.cursor.saturating_sub(1),
            KEY_RIGHT => self.cursor = (self.cursor + 1).min(self.input.chars().count()),
            KEY_HOME => self.cursor = 0,
            KEY_END => self.cursor = self.input.chars().count(),
            KEY_UP => self.recall_history(true),
            KEY_DOWN => self.recall_history(false),
            c if (0x20..0x100).contains(&c) => {
                if let Some(ch) = char::from_u32(c) {
                    let idx = self.byte_at(self.cursor);
                    self.input.insert(idx, ch);
                    self.cursor += 1;
                    self.hist_pos = None;
                }
            }
            _ => {}
        }
    }

    /// Byte offset of the `n`th character in the input (for insert/remove).
    fn byte_at(&self, n: usize) -> usize {
        self.input.char_indices().nth(n).map(|(i, _)| i).unwrap_or(self.input.len())
    }

    fn draw(&self, fb: &mut Framebuffer) {
        fb.clear(BG);
        fb.fill_rect(0, 0, W as i32, TITLE_H, TITLE_BG);
        fb.text(5, 4, "Lisp REPL", FG);

        // The input line sits at the bottom; the console fills the space above it.
        let input_y = H as i32 - ROW_H - 2;
        let top = TITLE_H + 2;
        let visible = ((input_y - top) / ROW_H) as usize;
        let start = self.lines.len().saturating_sub(visible);
        for (row, line) in self.lines[start..].iter().enumerate() {
            fb.text(5, top + row as i32 * ROW_H, &line.text, line.color);
        }

        // Prompt + current input + a block cursor.
        fb.text(5, input_y, "\u{3bb}", PROMPT);
        let base_x = 5 + (GLYPH_W as i32) + 2;
        fb.text(base_x, input_y, &self.input, FG);
        let cur_x = base_x + self.cursor as i32 * GLYPH_W as i32;
        fb.fill_rect(cur_x, input_y, GLYPH_W as i32, GLYPH_H as i32, CURSOR);
        // Redraw the character under the cursor (if any) so it stays legible.
        if let Some(ch) = self.input.chars().nth(self.cursor) {
            fb.text(cur_x, input_y, &ch.to_string(), BG);
        }
    }
}

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1),
    };
    let mut fb = Framebuffer::new(W, H);
    let mut repl = Repl::new();
    repl.draw(&mut fb);
    win_present(surface, fb.bytes());

    loop {
        let events = match win_read_input() {
            Ok(ev) => ev,
            Err(_) => return, // no Input capability
        };
        let mut changed = false;
        for ev in &events {
            if ev.kind == EV_KEY_DOWN {
                repl.key(ev.key);
                changed = true;
            }
        }
        if changed {
            repl.draw(&mut fb);
            win_present(surface, fb.bytes());
        }
    }
}

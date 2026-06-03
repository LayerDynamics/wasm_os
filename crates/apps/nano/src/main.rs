//! nano — a real in-terminal text editor for WASM_OS (L3).
//!
//! A `wasm32-wasip1` process that edits a text file inside the terminal, the way
//! GNU nano does. On launch it switches the terminal to RAW line discipline via
//! [`tty_set_raw`] (the host then forwards every keystroke — printable, control,
//! and ESC sequences for the arrow keys — straight to our stdin with no echo and
//! no line buffering). It reads those keys one at a time, edits an in-memory line
//! buffer, repaints the screen with ANSI escape sequences written to stdout, and
//! writes the buffer back to the filesystem on Ctrl-O.
//!
//! Keys: arrows/Home/End/PageUp/PageDown move; printable text inserts; Enter
//! splits a line; Backspace/Delete remove; Ctrl-K cuts the current line; Ctrl-O
//! writes the file; Ctrl-X exits (prompting to save if the buffer is modified).
//!
//! On exit it restores cooked mode and the shell's screen. Even if it were to die
//! unexpectedly, the host (kworker) restores the terminal's cooked discipline for
//! the shell when this process exits, so the terminal can never be left unusable.

use std::fs;
use std::io::{self, Read, Write};
use wasmos_sys::tty_set_raw;

const CTRL_X: u8 = 0x18;
const CTRL_O: u8 = 0x0f;
const CTRL_K: u8 = 0x0b;
const CTRL_C: u8 = 0x03;
const ESC: u8 = 0x1b;
const BS_DEL: u8 = 0x7f;
const BS_H: u8 = 0x08;
const CR: u8 = 0x0d;
const LF: u8 = 0x0a;

/// A decoded keypress.
enum Key {
    Char(char),
    Enter,
    Backspace,
    Delete,
    Left,
    Right,
    Up,
    Down,
    Home,
    End,
    PageUp,
    PageDown,
    Ctrl(u8),
    Esc,
}

/// Read one byte from stdin, `None` on EOF/error (the host closed our input).
fn read_byte(input: &mut impl Read) -> Option<u8> {
    let mut b = [0u8; 1];
    match input.read(&mut b) {
        Ok(0) => None,
        Ok(_) => Some(b[0]),
        Err(_) => None,
    }
}

/// Decode the next keypress, parsing ANSI escape sequences for the special keys.
/// The terminal delivers an arrow key's whole `ESC [ A` sequence at once, so the
/// follow-on bytes are already buffered when we read them.
fn read_key(input: &mut impl Read) -> Option<Key> {
    let b = read_byte(input)?;
    match b {
        ESC => {
            // Could be a lone Esc or a CSI/SS3 sequence (ESC [ … / ESC O …).
            let Some(b1) = read_byte(input) else { return Some(Key::Esc) };
            if b1 != b'[' && b1 != b'O' {
                return Some(Key::Esc);
            }
            let Some(b2) = read_byte(input) else { return Some(Key::Esc) };
            match b2 {
                b'A' => Some(Key::Up),
                b'B' => Some(Key::Down),
                b'C' => Some(Key::Right),
                b'D' => Some(Key::Left),
                b'H' => Some(Key::Home),
                b'F' => Some(Key::End),
                b'0'..=b'9' => {
                    // Numeric CSI: ESC [ <n> ~  (e.g. 3~ Delete, 1~/7~ Home, …).
                    let mut n = (b2 - b'0') as u32;
                    loop {
                        match read_byte(input) {
                            Some(d @ b'0'..=b'9') => n = n * 10 + (d - b'0') as u32,
                            Some(b'~') => break,
                            _ => break,
                        }
                    }
                    match n {
                        1 | 7 => Some(Key::Home),
                        4 | 8 => Some(Key::End),
                        3 => Some(Key::Delete),
                        5 => Some(Key::PageUp),
                        6 => Some(Key::PageDown),
                        _ => Some(Key::Esc),
                    }
                }
                _ => Some(Key::Esc),
            }
        }
        CR | LF => Some(Key::Enter),
        BS_DEL | BS_H => Some(Key::Backspace),
        // Control bytes we act on; the rest are reported as Ctrl for the dispatcher.
        0x00..=0x1f => Some(Key::Ctrl(b)),
        // Printable ASCII. (Bytes >= 0x80 are treated as Latin-1 chars; good enough
        // for editing, and avoids choking on stray high bytes.)
        _ => Some(Key::Char(b as char)),
    }
}

/// The editor state: the file as a vector of lines (each a vector of chars so
/// cursor math and insert/delete are exact), the cursor, scroll offsets, and the
/// view dimensions.
struct Editor {
    lines: Vec<Vec<char>>,
    cx: usize,
    cy: usize,
    row_off: usize,
    col_off: usize,
    filename: String,
    modified: bool,
    status: String,
    rows: usize,
    cols: usize,
    quit: bool,
}

impl Editor {
    fn new(filename: String, rows: usize, cols: usize) -> Self {
        let (lines, status) = match fs::read_to_string(&filename) {
            Ok(text) => {
                let mut parts: Vec<&str> = text.split('\n').collect();
                // A trailing newline yields a spurious empty final element — drop it
                // so the file's real last line is the buffer's last line.
                if parts.len() > 1 && parts.last() == Some(&"") {
                    parts.pop();
                }
                let lines: Vec<Vec<char>> = parts.iter().map(|s| s.chars().collect()).collect();
                let lines = if lines.is_empty() { vec![Vec::new()] } else { lines };
                let n = lines.len();
                (lines, format!("Read {n} line{}", if n == 1 { "" } else { "s" }))
            }
            Err(_) => (vec![Vec::new()], "New File".to_string()),
        };
        Editor {
            lines,
            cx: 0,
            cy: 0,
            row_off: 0,
            col_off: 0,
            filename,
            modified: false,
            status,
            rows: rows.max(5),
            cols: cols.max(20),
            quit: false,
        }
    }

    /// Rows available for text: total minus title (1), status (1), help (1).
    fn text_rows(&self) -> usize {
        self.rows.saturating_sub(3).max(1)
    }

    fn cur_len(&self) -> usize {
        self.lines[self.cy].len()
    }

    /// Keep the cursor visible by adjusting the scroll offsets.
    fn scroll(&mut self) {
        let th = self.text_rows();
        if self.cy < self.row_off {
            self.row_off = self.cy;
        }
        if self.cy >= self.row_off + th {
            self.row_off = self.cy + 1 - th;
        }
        if self.cx < self.col_off {
            self.col_off = self.cx;
        }
        if self.cx >= self.col_off + self.cols {
            self.col_off = self.cx + 1 - self.cols;
        }
    }

    /// Render the whole screen in one write: title bar, text, status, key hints,
    /// and the cursor at its buffer position.
    fn render(&mut self, out: &mut impl Write) {
        self.scroll();
        let mut s = String::with_capacity(self.cols * self.rows + 64);
        s.push_str("\x1b[?25l"); // hide cursor while repainting

        // Title bar (reverse video): app + filename + modified flag.
        let modflag = if self.modified { "  Modified" } else { "" };
        let name = if self.filename.is_empty() { "New Buffer" } else { &self.filename };
        let title = format!("  WASM_OS nano    {name}{modflag}");
        s.push_str("\x1b[1;1H\x1b[7m");
        s.push_str(&fit(&title, self.cols));
        s.push_str("\x1b[0m");

        // Text area.
        let th = self.text_rows();
        for i in 0..th {
            let screen_row = 2 + i;
            s.push_str(&format!("\x1b[{screen_row};1H\x1b[K"));
            let li = self.row_off + i;
            if li < self.lines.len() {
                let line = &self.lines[li];
                let from = self.col_off.min(line.len());
                let to = (self.col_off + self.cols).min(line.len());
                let slice: String = line[from..to].iter().collect();
                s.push_str(&slice);
            }
        }

        // Status line (reverse video) — messages like "[ Wrote 5 lines ]".
        let status_row = self.rows - 1;
        s.push_str(&format!("\x1b[{status_row};1H\x1b[K\x1b[7m"));
        s.push_str(&fit(&format!(" {}", self.status), self.cols));
        s.push_str("\x1b[0m");

        // Help line: the most useful shortcuts.
        let help_row = self.rows;
        s.push_str(&format!("\x1b[{help_row};1H\x1b[K"));
        s.push_str(&fit("^O Write Out   ^X Exit   ^K Cut Line", self.cols));

        // Place the cursor at its buffer position and show it again.
        let scr_row = 2 + (self.cy - self.row_off);
        let scr_col = 1 + (self.cx - self.col_off);
        s.push_str(&format!("\x1b[{scr_row};{scr_col}H\x1b[?25h"));

        let _ = out.write_all(s.as_bytes());
        let _ = out.flush();
    }

    fn move_left(&mut self) {
        if self.cx > 0 {
            self.cx -= 1;
        } else if self.cy > 0 {
            self.cy -= 1;
            self.cx = self.cur_len();
        }
    }
    fn move_right(&mut self) {
        if self.cx < self.cur_len() {
            self.cx += 1;
        } else if self.cy + 1 < self.lines.len() {
            self.cy += 1;
            self.cx = 0;
        }
    }
    fn move_up(&mut self) {
        if self.cy > 0 {
            self.cy -= 1;
            self.cx = self.cx.min(self.cur_len());
        }
    }
    fn move_down(&mut self) {
        if self.cy + 1 < self.lines.len() {
            self.cy += 1;
            self.cx = self.cx.min(self.cur_len());
        }
    }
    fn page_up(&mut self) {
        for _ in 0..self.text_rows() {
            self.move_up();
        }
    }
    fn page_down(&mut self) {
        for _ in 0..self.text_rows() {
            self.move_down();
        }
    }

    fn insert_char(&mut self, c: char) {
        let cx = self.cx;
        self.lines[self.cy].insert(cx, c);
        self.cx += 1;
        self.modified = true;
    }

    fn insert_newline(&mut self) {
        let tail = self.lines[self.cy].split_off(self.cx);
        self.lines.insert(self.cy + 1, tail);
        self.cy += 1;
        self.cx = 0;
        self.modified = true;
    }

    fn backspace(&mut self) {
        if self.cx > 0 {
            self.lines[self.cy].remove(self.cx - 1);
            self.cx -= 1;
            self.modified = true;
        } else if self.cy > 0 {
            // Join this line onto the end of the previous one.
            let cur = self.lines.remove(self.cy);
            self.cy -= 1;
            self.cx = self.cur_len();
            self.lines[self.cy].extend(cur);
            self.modified = true;
        }
    }

    fn delete(&mut self) {
        if self.cx < self.cur_len() {
            self.lines[self.cy].remove(self.cx);
            self.modified = true;
        } else if self.cy + 1 < self.lines.len() {
            // Pull the next line up onto this one.
            let next = self.lines.remove(self.cy + 1);
            self.lines[self.cy].extend(next);
            self.modified = true;
        }
    }

    fn cut_line(&mut self) {
        if self.lines.len() > 1 {
            self.lines.remove(self.cy);
            if self.cy >= self.lines.len() {
                self.cy = self.lines.len() - 1;
            }
        } else {
            self.lines[0].clear();
        }
        self.cx = 0;
        self.modified = true;
    }

    /// Serialize the buffer back to text (one trailing newline, like nano).
    fn to_text(&self) -> String {
        let mut text: String = self
            .lines
            .iter()
            .map(|l| l.iter().collect::<String>())
            .collect::<Vec<_>>()
            .join("\n");
        text.push('\n');
        text
    }

    /// Ctrl-O: write the buffer to its file.
    fn save(&mut self) {
        if self.filename.is_empty() {
            self.filename = "untitled.txt".to_string();
        }
        match fs::write(&self.filename, self.to_text()) {
            Ok(()) => {
                let n = self.lines.len();
                self.status = format!("[ Wrote {n} line{} ]", if n == 1 { "" } else { "s" });
                self.modified = false;
            }
            Err(e) => {
                self.status = format!("[ Error writing {}: {e} ]", self.filename);
            }
        }
    }
}

/// Truncate or space-pad `s` to exactly `cols` columns (char-based).
fn fit(s: &str, cols: usize) -> String {
    let chars: Vec<char> = s.chars().collect();
    if chars.len() >= cols {
        chars[..cols].iter().collect()
    } else {
        let mut out: String = chars.iter().collect();
        out.push_str(&" ".repeat(cols - chars.len()));
        out
    }
}

/// Read the terminal size from the environment (the host seeds `LINES`/`COLUMNS`
/// when it binds the terminal), defaulting to the classic 80x24.
fn term_size() -> (usize, usize) {
    let rows = std::env::var("LINES").ok().and_then(|v| v.parse().ok()).unwrap_or(24usize);
    let cols = std::env::var("COLUMNS").ok().and_then(|v| v.parse().ok()).unwrap_or(80usize);
    (rows.clamp(5, 200), cols.clamp(20, 400))
}

fn main() {
    // Open a relative filename against the shell's cwd, not the preopen root.
    wasmos_sys::chdir_to_pwd();
    let filename = std::env::args().nth(1).unwrap_or_default();
    let (rows, cols) = term_size();
    let mut ed = Editor::new(filename, rows, cols);

    // Take over the terminal: raw input + the alternate screen buffer so the
    // shell's scrollback is left untouched when we exit.
    tty_set_raw(true);
    let stdout = io::stdout();
    let mut out = stdout.lock();
    let _ = out.write_all(b"\x1b[?1049h");
    let _ = out.flush();

    let stdin = io::stdin();
    let mut input = stdin.lock();

    loop {
        ed.render(&mut out);
        let Some(key) = read_key(&mut input) else { break };
        match key {
            Key::Left => ed.move_left(),
            Key::Right => ed.move_right(),
            Key::Up => ed.move_up(),
            Key::Down => ed.move_down(),
            Key::Home => ed.cx = 0,
            Key::End => ed.cx = ed.cur_len(),
            Key::PageUp => ed.page_up(),
            Key::PageDown => ed.page_down(),
            Key::Enter => ed.insert_newline(),
            Key::Backspace => ed.backspace(),
            Key::Delete => ed.delete(),
            Key::Char(c) => ed.insert_char(c),
            Key::Ctrl(CTRL_O) => ed.save(),
            Key::Ctrl(CTRL_K) => ed.cut_line(),
            Key::Ctrl(CTRL_X) => {
                if ed.modified && !exit_confirmed(&mut ed, &mut out, &mut input) {
                    ed.status = "Cancelled".to_string();
                } else {
                    ed.quit = true;
                }
            }
            // Unmapped control bytes and a lone Esc are no-ops.
            Key::Esc | Key::Ctrl(_) => {}
        }
        if ed.quit {
            break;
        }
    }

    // Restore the terminal for the shell: leave the alternate screen and return
    // to cooked input. (The kernel also forces cooked mode on exit as a backstop.)
    let _ = out.write_all(b"\x1b[?25h\x1b[?1049l");
    let _ = out.flush();
    tty_set_raw(false);
}

/// Ctrl-X with unsaved changes: ask "Save modified buffer?". Returns true when it
/// is safe to exit (saved, or the user chose not to save); false to cancel.
fn exit_confirmed(ed: &mut Editor, out: &mut impl Write, input: &mut impl Read) -> bool {
    // ^C cancels reliably (a single byte); a lone Esc would only register once the
    // next key arrives, so it is accepted but not advertised.
    ed.status = "Save modified buffer?  Y = save   N = discard   ^C = cancel".to_string();
    ed.render(out);
    loop {
        match read_key(input) {
            Some(Key::Char('y')) | Some(Key::Char('Y')) => {
                ed.save();
                return true;
            }
            Some(Key::Char('n')) | Some(Key::Char('N')) => return true,
            Some(Key::Esc) | Some(Key::Ctrl(CTRL_C)) => return false,
            None => return true, // input closed — let the exit proceed
            _ => {}
        }
    }
}

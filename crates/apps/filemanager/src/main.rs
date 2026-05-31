//! File manager (L3 / M3, FR-24) — a real `wasm32-wasip1` process.
//!
//! Draws a canvas surface, lists the current VFS directory (`std::fs::read_dir`),
//! and navigates on brokered pointer/keyboard input: click or Enter on a folder
//! descends, on `..` ascends, on a file LAUNCHES it as a process (delegating
//! Gpu+Input so graphical apps can draw). Launching is the FR-24 "open files with
//! associated apps" path; `.txt` files open in the editor when it is present.

use wasmgfx::{rgb, Color, Framebuffer, GLYPH_H, GLYPH_W};
use wasmos_sys::{
    spawn, win_present, win_read_input, win_surface, Stdio, EV_KEY_DOWN, EV_POINTER_DOWN,
    EV_POINTER_MOVE, KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_UP,
};

const W: u32 = 460;
const H: u32 = 340;
const HEADER_H: i32 = 22;
const ROW_H: i32 = 14;

const BG: Color = rgb(24, 27, 34);
const HEADER_BG: Color = rgb(40, 48, 65);
const FG: Color = rgb(214, 217, 223);
const SEL_BG: Color = rgb(43, 108, 176);
const DIR_ICON: Color = rgb(232, 196, 80);
const FILE_ICON: Color = rgb(120, 200, 210);

struct Entry {
    name: String,
    is_dir: bool,
}

struct State {
    cwd: String,
    entries: Vec<Entry>,
    selected: usize,
    scroll: usize,
}

fn parent_of(path: &str) -> String {
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) | None => "/".to_string(),
        Some(i) => trimmed[..i].to_string(),
    }
}

fn join(cwd: &str, name: &str) -> String {
    if cwd == "/" {
        format!("/{name}")
    } else {
        format!("{cwd}/{name}")
    }
}

impl State {
    fn rows(&self) -> usize {
        // The synthetic ".." row exists everywhere except the root.
        self.entries.len() + if self.cwd == "/" { 0 } else { 1 }
    }

    fn relist(&mut self) {
        self.entries.clear();
        if let Ok(rd) = std::fs::read_dir(&self.cwd) {
            for e in rd.flatten() {
                let name = e.file_name().to_string_lossy().into_owned();
                let is_dir = std::fs::metadata(join(&self.cwd, &name)).map(|m| m.is_dir()).unwrap_or(false);
                self.entries.push(Entry { name, is_dir });
            }
        }
        // Directories first, then files; each alphabetical.
        self.entries.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
        self.selected = 0;
        self.scroll = 0;
    }

    /// Activate the row at `idx`: ascend, descend, or launch.
    fn activate(&mut self, idx: usize) {
        let has_dotdot = self.cwd != "/";
        if has_dotdot && idx == 0 {
            self.cwd = parent_of(&self.cwd);
            self.relist();
            return;
        }
        let ei = idx - if has_dotdot { 1 } else { 0 };
        let Some(entry) = self.entries.get(ei) else { return };
        if entry.is_dir {
            self.cwd = join(&self.cwd, &entry.name);
            self.relist();
        } else {
            launch(&join(&self.cwd, &entry.name));
        }
    }
}

/// Launch a file as a process. Graphical apps need Gpu+Input, which the file
/// manager holds and delegates; a `.txt` opens in the editor (when installed).
fn launch(path: &str) {
    let stdio = [Stdio::Terminal, Stdio::Terminal, Stdio::Terminal];
    if path.ends_with(".txt") {
        // Open with the associated app (the editor): `editor <path>`.
        let _ = spawn("/bin/editor", &["editor", path], &stdio, "/", true, true);
    } else {
        let _ = spawn(path, &[path], &stdio, "/", true, true);
    }
}

fn draw(fb: &mut Framebuffer, st: &State) {
    fb.clear(BG);
    fb.fill_rect(0, 0, W as i32, HEADER_H, HEADER_BG);
    fb.text(4, 7, &format!("Files: {}", st.cwd), FG);

    let visible = ((H as i32 - HEADER_H) / ROW_H) as usize;
    let has_dotdot = st.cwd != "/";
    for screen in 0..visible {
        let idx = st.scroll + screen;
        if idx >= st.rows() {
            break;
        }
        let y = HEADER_H + screen as i32 * ROW_H;
        if idx == st.selected {
            fb.fill_rect(0, y, W as i32, ROW_H, SEL_BG);
        }
        let (icon, label, is_dir) = if has_dotdot && idx == 0 {
            (DIR_ICON, "..".to_string(), true)
        } else {
            let e = &st.entries[idx - if has_dotdot { 1 } else { 0 }];
            (if e.is_dir { DIR_ICON } else { FILE_ICON }, e.name.clone(), e.is_dir)
        };
        fb.fill_rect(5, y + 3, GLYPH_W as i32, GLYPH_H as i32, icon);
        let suffix = if is_dir { "/" } else { "" };
        fb.text(5 + GLYPH_W as i32 + 4, y + 3, &format!("{label}{suffix}"), FG);
    }
}

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1),
    };
    let mut fb = Framebuffer::new(W, H);
    let mut st = State { cwd: "/".to_string(), entries: Vec::new(), selected: 0, scroll: 0 };
    st.relist();
    draw(&mut fb, &st);
    win_present(surface, fb.bytes());

    let visible = ((H as i32 - HEADER_H) / ROW_H) as usize;
    loop {
        let events = match win_read_input() {
            Ok(ev) => ev,
            Err(_) => return, // no Input capability (should not happen for the FM)
        };
        for ev in &events {
            match ev.kind {
                EV_POINTER_MOVE | EV_POINTER_DOWN => {
                    let y = ev.y as i32;
                    if y >= HEADER_H {
                        let row = st.scroll + ((y - HEADER_H) / ROW_H) as usize;
                        if row < st.rows() {
                            st.selected = row;
                            if ev.kind == EV_POINTER_DOWN {
                                st.activate(row);
                            }
                        }
                    }
                }
                EV_KEY_DOWN => match ev.key {
                    KEY_DOWN if st.selected + 1 < st.rows() => st.selected += 1,
                    KEY_UP => st.selected = st.selected.saturating_sub(1),
                    KEY_ENTER => st.activate(st.selected),
                    KEY_BACKSPACE if st.cwd != "/" => {
                        st.cwd = parent_of(&st.cwd);
                        st.relist();
                    }
                    _ => {}
                },
                _ => {}
            }
        }
        // Keep the selection visible.
        if st.selected < st.scroll {
            st.scroll = st.selected;
        } else if st.selected >= st.scroll + visible {
            st.scroll = st.selected + 1 - visible;
        }
        draw(&mut fb, &st);
        win_present(surface, fb.bytes());
    }
}

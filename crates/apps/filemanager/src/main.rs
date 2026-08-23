//! File manager (L3 / desktop compositor, FR-24) — a real `wasm32-wasip1` process.
//!
//! Draws a canvas surface, lists the current VFS directory (`std::fs::read_dir`),
//! and navigates on brokered pointer/keyboard input: click or Enter on a folder
//! descends, on `..` ascends, on a file LAUNCHES it as a process (delegating
//! Gpu+Input so graphical apps can draw). Launching is the FR-24 "open files with
//! associated apps" path; `.txt` files open in the editor when it is present.

use std::time::{Duration, Instant};
use wasmgfx::{rgb, Color, Framebuffer, GLYPH_H, GLYPH_W};
use wasmobj::wasi::load_object;
use wasmos_sys::{
    spawn, win_present, win_read_input, win_surface, Stdio, EV_KEY_DOWN, EV_POINTER_DOWN,
    EV_POINTER_MOVE, KEY_BACKSPACE, KEY_DOWN, KEY_ENTER, KEY_UP,
};

const W: u32 = 460;
const H: u32 = 340;
const HEADER_H: i32 = 22;
const ROW_H: i32 = 14;
const DUPLICATE_ACTIVATION_GUARD: Duration = Duration::from_millis(350);

const BG: Color = rgb(24, 27, 34);
const HEADER_BG: Color = rgb(40, 48, 65);
const FG: Color = rgb(214, 217, 223);
const SEL_BG: Color = rgb(43, 108, 176);
const DIR_ICON: Color = rgb(232, 196, 80);
const FILE_ICON: Color = rgb(120, 200, 210);

// Header navigation affordances (FR-24 usability): an explicit "↑ Up" button and a
// clickable breadcrumb path, so ascending out of a folder is obvious — not just the
// "../" row or the (undiscoverable) Backspace key.
const UP_X0: i32 = 4;
const UP_X1: i32 = 44; // "↑ Up" button hit region [UP_X0, UP_X1)
const CRUMB_X0: i32 = 50; // breadcrumb starts here
const SEP_FG: Color = rgb(120, 126, 138);
const CRUMB_FG: Color = rgb(150, 200, 235); // ancestor crumbs look link-like (clickable)

struct Entry {
    name: String,
    is_dir: bool,
}

struct State {
    cwd: String,
    entries: Vec<Entry>,
    selected: usize,
    scroll: usize,
    last_launch: Option<(String, Instant)>,
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

/// One clickable breadcrumb segment: its pixel x-range in the header and the cwd it
/// navigates to when clicked.
struct Crumb {
    x0: i32,
    x1: i32,
    label: String,
    path: String,
}

/// Lay out the breadcrumb for `cwd` into clickable segments. The layout is fully
/// determined by `cwd` and the fixed glyph width, so `draw` (rendering) and the click
/// handler (hit-testing) agree on every segment's pixel range. For example,
/// `/home/docs` renders as `/ > home > docs`, where `/`, `home`, and `docs` are
/// clickable and navigate to `/`, `/home`, and `/home/docs` respectively.
fn crumbs_for(cwd: &str) -> Vec<Crumb> {
    let gw = GLYPH_W as i32;
    let sep_w = 3 * gw; // " > " between crumbs
    let mut out = vec![Crumb {
        x0: CRUMB_X0,
        x1: CRUMB_X0 + gw, // "/" is one glyph
        label: "/".to_string(),
        path: "/".to_string(),
    }];
    let mut x = CRUMB_X0 + gw;
    let mut cum = String::new();
    for comp in cwd.split('/').filter(|s| !s.is_empty()) {
        x += sep_w;
        cum.push('/');
        cum.push_str(comp);
        let w = gw * comp.chars().count() as i32;
        out.push(Crumb {
            x0: x,
            x1: x + w,
            label: comp.to_string(),
            path: cum.clone(),
        });
        x += w;
    }
    out
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
                let is_dir = e.file_type().map(|t| t.is_dir()).unwrap_or(false);
                self.entries.push(Entry { name, is_dir });
            }
        }
        // Directories first, then files; each alphabetical (case-insensitive, so
        // e.g. /Volumes sorts with the lowercase dirs rather than ahead of them).
        self.entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
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
        let Some(entry) = self.entries.get(ei) else {
            return;
        };
        if entry.is_dir {
            self.cwd = join(&self.cwd, &entry.name);
            self.relist();
        } else {
            self.launch_file(&join(&self.cwd, &entry.name));
        }
    }

    fn launch_file(&mut self, path: &str) {
        let now = Instant::now();
        if let Some((last_path, last_at)) = &self.last_launch {
            if last_path == path && last_at.elapsed() < DUPLICATE_ACTIVATION_GUARD {
                return;
            }
        }
        self.last_launch = Some((path.to_string(), now));
        launch(path);
    }

    /// Handle a click in the header bar at pixel `x`: the "↑ Up" button ascends one
    /// level; a breadcrumb segment jumps straight to that ancestor.
    fn activate_header(&mut self, x: i32) {
        if self.cwd != "/" && (UP_X0..UP_X1).contains(&x) {
            self.cwd = parent_of(&self.cwd);
            self.relist();
            return;
        }
        for c in crumbs_for(&self.cwd) {
            if (c.x0..c.x1).contains(&x) {
                if c.path != self.cwd {
                    self.cwd = c.path;
                    self.relist();
                }
                return;
            }
        }
    }
}

/// What "opening" a file should do.
#[derive(Debug, PartialEq, Eq)]
enum OpenAs {
    /// Execute it as a process (a real `wasm32-wasi` executable module).
    Run,
    /// Execute a command guest through the terminal without creating a desktop surface.
    RunTerminal,
    /// Open it in the editor (documents and data — never executed).
    Edit,
}

/// Decide how to open a file from its bytes. Only a genuine executable wasm module
/// is run; everything else — wasmobj documents, text, and arbitrary data — opens in
/// the editor. This is the guard against the old behaviour of `spawn`-ing any
/// non-`.txt` file, which tried to execute non-wasm bytes as a process.
fn open_action(path: &str, bytes: &[u8]) -> OpenAs {
    let is_wasm_module = bytes.starts_with(b"\0asm");
    // A wasmobj document is also a valid wasm module, but it is a *document* — open
    // it for editing, not execution. (It can still be run from the terminal.)
    let app_name = path.rsplit('/').next().unwrap_or(path);
    let is_graphical_app = matches!(
        app_name,
        "editor" | "filemanager" | "gfxspike" | "lisp" | "paint" | "sysmon" | "welcome"
    );
    if is_wasm_module && wasmobj::verify(bytes).is_err() {
        if is_graphical_app {
            OpenAs::Run
        } else {
            OpenAs::RunTerminal
        }
    } else {
        OpenAs::Edit
    }
}

/// Launch a file: run a real executable module, or open everything else in the
/// editor. Graphical apps need Gpu+Input, which the file manager holds and delegates.
fn launch(path: &str) {
    let stdio = [Stdio::Terminal, Stdio::Terminal, Stdio::Terminal];
    // Read the file to classify it; an unreadable file falls back to the editor
    // (an empty buffer) rather than being executed.
    let bytes = load_object(path).unwrap_or_default();
    match open_action(path, &bytes) {
        OpenAs::Run => {
            let _ = spawn(path, &[path], &stdio, "/", true, true, false, false);
        }
        OpenAs::RunTerminal => {
            let _ = spawn(path, &[path], &stdio, "/", false, false, false, false);
        }
        OpenAs::Edit => {
            let _ = spawn(
                "/bin/editor",
                &["editor", path],
                &stdio,
                "/",
                true,
                true,
                false,
                false,
            );
        }
    }
}

fn draw(fb: &mut Framebuffer, st: &State) {
    fb.clear(BG);
    fb.fill_rect(0, 0, W as i32, HEADER_H, HEADER_BG);

    // "↑ Up" button — dimmed and inert at the root, where there is nowhere to go up to.
    let at_root = st.cwd == "/";
    let up_bg = if at_root {
        rgb(34, 40, 54)
    } else {
        rgb(60, 72, 96)
    };
    fb.fill_rect(UP_X0, 2, UP_X1 - UP_X0, HEADER_H - 4, up_bg);
    let up_fg = if at_root { rgb(96, 102, 116) } else { FG };
    fb.text(UP_X0 + 4, 7, "\u{2191} Up", up_fg);

    // Clickable breadcrumb path. The current (last) crumb is plain; ancestors are
    // tinted to read as links.
    let crumbs = crumbs_for(&st.cwd);
    for (i, c) in crumbs.iter().enumerate() {
        if i > 0 {
            fb.text(c.x0 - 3 * GLYPH_W as i32, 7, " > ", SEP_FG);
        }
        let fg = if i + 1 == crumbs.len() { FG } else { CRUMB_FG };
        fb.text(c.x0, 7, &c.label, fg);
    }

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
        // The synthetic up-dir row is spelled out so it reads as a control, not two
        // mysterious dots; real entries keep a trailing "/" on directories.
        let (icon, text) = if has_dotdot && idx == 0 {
            (DIR_ICON, ".. (up one level)".to_string())
        } else {
            let e = &st.entries[idx - if has_dotdot { 1 } else { 0 }];
            let suffix = if e.is_dir { "/" } else { "" };
            (
                if e.is_dir { DIR_ICON } else { FILE_ICON },
                format!("{}{}", e.name, suffix),
            )
        };
        fb.fill_rect(5, y + 3, GLYPH_W as i32, GLYPH_H as i32, icon);
        fb.text(5 + GLYPH_W as i32 + 4, y + 3, &text, FG);
    }
}

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1),
    };
    let mut fb = Framebuffer::new(W, H);
    let mut st = State {
        cwd: "/".to_string(),
        entries: Vec::new(),
        selected: 0,
        scroll: 0,
        last_launch: None,
    };
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
                    let x = ev.x as i32;
                    let y = ev.y as i32;
                    if y < HEADER_H {
                        // Header bar: the "↑ Up" button and breadcrumb act on click only.
                        if ev.kind == EV_POINTER_DOWN {
                            st.activate_header(x);
                        }
                    } else {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn text_and_data_open_in_editor_not_executed() {
        assert_eq!(
            open_action("/home/readme", b"# readme\nhello world"),
            OpenAs::Edit
        );
        assert_eq!(open_action("/home/data", b"{\"json\":true}"), OpenAs::Edit);
        assert_eq!(
            open_action("/home/photo.jpg", &[0xff, 0xd8, 0xff, 0xe0]),
            OpenAs::Edit
        ); // JPEG header
        assert_eq!(open_action("/home/empty", b""), OpenAs::Edit); // empty / unreadable
    }

    #[test]
    fn wasmobj_document_opens_in_editor() {
        let mut obj = wasmobj::mint(wasmobj::Tier::K4, 0);
        wasmobj::save(&mut obj, b"a saved document").unwrap();
        assert_eq!(open_action("/home/document.wasm", &obj), OpenAs::Edit);
    }

    #[test]
    fn executable_wasm_module_runs() {
        // A wasm module that is NOT a wasmobj document (no wob0 header) -> executable.
        let exe = b"\0asm\x01\x00\x00\x00";
        assert_eq!(open_action("/usr/bin/paint", exe), OpenAs::Run);
        assert_eq!(open_action("/usr/bin/ls", exe), OpenAs::RunTerminal);
    }
}

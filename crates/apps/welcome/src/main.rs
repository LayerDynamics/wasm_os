//! Welcome — a guided intro to WASM_OS. A real `wasm32-wasip1` canvas process
//! that walks a new user through a few slides: what WASM_OS is, how it works, and how
//! to actually do things. Keyboard is brokered by the compositor (Input capability);
//! pixels go through a canvas surface (Gpu) — i.e. this help screen is itself a normal
//! OS app, the same kind it describes.
//!
//! Navigation: ← / → (or Space / Enter) step slides; Home / End jump to first / last;
//! clicking the left or right half of the window goes back / forward.

use wasmgfx::{rgb, Color, Framebuffer, GLYPH_H, GLYPH_W};
use wasmos_sys::{
    win_present, win_read_input, win_surface, EV_KEY_DOWN, EV_POINTER_DOWN, KEY_END, KEY_ENTER,
    KEY_HOME, KEY_LEFT, KEY_RIGHT,
};

const W: u32 = 600;
const H: u32 = 440;
const TITLE_H: i32 = 22;
const FOOTER_H: i32 = 26;
const MARGIN: i32 = 18;
const LINE_H: i32 = 13;

const BG: Color = rgb(18, 20, 28);
const TITLE_BG: Color = rgb(46, 34, 66);
const TITLE_FG: Color = rgb(224, 214, 246);
const HEADING: Color = rgb(150, 200, 255);
const BODY: Color = rgb(214, 217, 223);
const ACCENT: Color = rgb(126, 214, 142);
const DIM: Color = rgb(140, 146, 158);
const DOT_ON: Color = rgb(150, 200, 255);
const DOT_OFF: Color = rgb(70, 76, 90);
const FOOTER_BG: Color = rgb(24, 27, 36);

/// One slide: a heading and its body lines (already sized to fit the window width).
struct Slide {
    heading: &'static str,
    body: &'static [&'static str],
}

const SLIDES: &[Slide] = &[
    Slide {
        heading: "Welcome to WASM_OS",
        body: &[
            "WASM_OS is an operating-system experiment that runs inside",
            "a browser tab.",
            "",
            "A Rust microkernel schedules wasm32-wasi programs, routes",
            "their blocking syscalls over a SharedArrayBuffer ring, and",
            "exposes a Unix-like userland. A TypeScript host connects the",
            "kernel to browser workers, storage, a terminal, and a",
            "windowed desktop.",
            "",
            "The desktop includes a shell, core utilities, a file manager,",
            "Paint, an editor, a Lisp REPL, a system monitor, a Welcome",
            "window, and a Zig Mandelbrot viewer.",
            "Mandelbrot pans with a drag, zooms with +/-, and generates",
            "a new seeded view with N or Space (R reseeds it).",
            "",
            "At startup, Welcome is the only open window. Terminal — sh",
            "is running behind its taskbar button.",
            "",
            "Use the \u{2190} and \u{2192} arrow keys (or Space) to read on.",
        ],
    },
    Slide {
        heading: "How it works",
        body: &[
            "The kernel runs in a Web Worker and speaks WASI, the same",
            "system interface Unix-like programs expect.",
            "",
            "Every app is its own WebAssembly program \u{2014} a real process",
            "with a PID, isolated in its own worker, talking to the kernel",
            "over a shared-memory ring buffer (no copying, no network).",
            "",
            "A compositor draws the windows; an in-memory filesystem keeps",
            "your files and persists them to your browser's storage.",
        ],
    },
    Slide {
        heading: "The desktop",
        body: &[
            "Click  \u{2630} Apps  at the bottom-left to launch a program.",
            "",
            "At startup, this guide is the only open window. Click the",
            "Terminal — sh button in the taskbar when you want the shell.",
            "",
            "Each app opens in its own window:",
            "  \u{2022} drag the title bar to move it",
            "  \u{2022} drag an edge or corner to resize it",
            "  \u{2022} the corner buttons minimize, maximize, and close it",
            "",
            "The taskbar lists every open window \u{2014} click one to bring it",
            "to the front. New windows tile into free space automatically.",
        ],
    },
    Slide {
        heading: "The terminal",
        body: &[
            "The Terminal runs a real shell (sh) as a normal process.",
            "",
            "Try typing:",
            "  ls        pwd        echo hello        env        ps",
            "  cat file        grep word file        wc        top",
            "",
            "Pipes and redirection work too:",
            "  echo hi | wc        echo hi > note.txt        cat note.txt",
            "",
            "If the shell ever exits, the terminal restarts it for you.",
        ],
    },
    Slide {
        heading: "The apps",
        body: &[
            "  Shell    \u{2014} run commands and combine core utilities",
            "  Editor   \u{2014} write and save text files (Ctrl+S)",
            "  Paint    \u{2014} draw with the mouse and save your canvas",
            "  Files    \u{2014} browse and open the filesystem",
            "  Mandelbrot \u{2014} drag, zoom, and generate seeded views",
            "  Monitor  \u{2014} watch running processes and kill them",
            "  Lisp     \u{2014} a live Scheme REPL: define, run, see results",
            "  Welcome  \u{2014} return to this guided tour",
            "  Linux    \u{2014} boots a real RISC-V Linux in a virtual machine",
            "",
            "Everything you create is saved in your browser and survives a",
            "reload. That's it \u{2014} open  \u{2630} Apps  and start exploring.",
        ],
    },
    Slide {
        heading: "The filesystem",
        body: &[
            "WASM_OS has a real Unix filesystem hierarchy you can explore:",
            "  /bin  /usr/bin   programs        /etc   system config",
            "  /home            your files      /tmp   scratch (cleared on reload)",
            "  /var/log         logs            /mnt  /media   mount points",
            "",
            "/proc and /dev are live \u{2014} generated by the kernel, not stored:",
            "  cat /proc/mounts   ·   cat /proc/<pid>/status   ·   mount",
            "  /dev/null  /dev/zero  /dev/urandom   are real device nodes",
            "",
            "Most of it persists in your browser across reloads.",
        ],
    },
];

struct Deck {
    slide: usize,
}

impl Deck {
    fn next(&mut self) {
        if self.slide + 1 < SLIDES.len() {
            self.slide += 1;
        }
    }
    fn prev(&mut self) {
        self.slide = self.slide.saturating_sub(1);
    }

    /// Returns true if the view changed (so the caller re-presents).
    fn key(&mut self, code: u32) -> bool {
        let before = self.slide;
        match code {
            KEY_LEFT => self.prev(),
            KEY_RIGHT | KEY_ENTER | 0x20 => self.next(), // 0x20 = Space
            KEY_HOME => self.slide = 0,
            KEY_END => self.slide = SLIDES.len() - 1,
            _ => {}
        }
        self.slide != before
    }

    /// Click the left half to go back, the right half to go forward.
    fn click(&mut self, x: i32) -> bool {
        let before = self.slide;
        if x < W as i32 / 2 {
            self.prev();
        } else {
            self.next();
        }
        self.slide != before
    }

    fn draw(&self, fb: &mut Framebuffer) {
        fb.clear(BG);

        // Title bar — a fixed brand (the per-slide heading carries the topic, so this
        // does not repeat the slide-1 "Welcome to WASM_OS" heading).
        fb.fill_rect(0, 0, W as i32, TITLE_H, TITLE_BG);
        fb.text(MARGIN, 7, "WASM_OS  \u{2014}  a guided tour", TITLE_FG);
        let counter = format!("{} / {}", self.slide + 1, SLIDES.len());
        let cx = W as i32 - MARGIN - counter.chars().count() as i32 * GLYPH_W as i32;
        fb.text(cx, 7, &counter, TITLE_FG);

        // Slide heading + an accent underline.
        let s = &SLIDES[self.slide];
        let top = TITLE_H + 16;
        fb.text(MARGIN, top, s.heading, HEADING);
        let underline_w = s.heading.chars().count() as i32 * GLYPH_W as i32;
        fb.fill_rect(MARGIN, top + GLYPH_H as i32 + 3, underline_w, 2, ACCENT);

        // Body lines.
        let body_top = top + GLYPH_H as i32 + 16;
        for (i, line) in s.body.iter().enumerate() {
            fb.text(MARGIN, body_top + i as i32 * LINE_H, line, BODY);
        }

        // Footer: progress dots (centered) + navigation hint.
        let footer_y = H as i32 - FOOTER_H;
        fb.fill_rect(0, footer_y, W as i32, FOOTER_H, FOOTER_BG);
        let dot_gap = 16;
        let dots_w = (SLIDES.len() as i32 - 1) * dot_gap;
        let dots_x = (W as i32 - dots_w) / 2;
        let dot_y = footer_y + FOOTER_H / 2 - 3;
        for i in 0..SLIDES.len() {
            let color = if i == self.slide { DOT_ON } else { DOT_OFF };
            fb.fill_rect(dots_x + i as i32 * dot_gap, dot_y, 6, 6, color);
        }
        let hint = if self.slide + 1 == SLIDES.len() {
            "\u{2190} Back        Home: start"
        } else {
            "\u{2190} \u{2192}  or Space to continue"
        };
        fb.text(MARGIN, footer_y + 9, hint, DIM);
    }
}

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1),
    };
    let mut fb = Framebuffer::new(W, H);
    let mut deck = Deck { slide: 0 };
    deck.draw(&mut fb);
    win_present(surface, fb.bytes());

    loop {
        let events = match win_read_input() {
            Ok(ev) => ev,
            Err(_) => return, // no Input capability
        };
        let mut changed = false;
        let mut received_key = false;
        for ev in &events {
            if ev.kind == EV_KEY_DOWN {
                received_key = true;
                changed |= deck.key(ev.key);
            } else if ev.kind == EV_POINTER_DOWN {
                changed |= deck.click(ev.x as i32);
            }
        }
        if changed || received_key {
            deck.draw(&mut fb);
            win_present(surface, fb.bytes());
        }
    }
}

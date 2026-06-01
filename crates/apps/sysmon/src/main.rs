//! System Monitor (L3 / M4-T8, FR-33 + FR-8) — a real `wasm32-wasip1` process.
//!
//! Draws the live process table to a canvas surface (read from the `proc_list`
//! syscall) and acts on the selected process from brokered keyboard input:
//!   k → SIGKILL (forceful)   t → SIGTERM (graceful)   r → renice (+1 priority)
//! Process control uses the Signal capability, which the launcher delegates (the
//! graphical sibling of the `kill`/`renice` coreutils). It refreshes the table on
//! every input event, so interacting shows current state. init (pid 1) is
//! protected — the monitor refuses to signal it.

use wasmgfx::{rgb, Color, Framebuffer, GLYPH_H, GLYPH_W};
use wasmos_sys::{
    kill, proc_list, set_priority, win_present, win_read_input, win_surface, ProcInfo, ProcState,
    EV_KEY_DOWN, EV_POINTER_DOWN, EV_POINTER_MOVE, KEY_DOWN, KEY_UP, SIGKILL, SIGTERM,
};

const W: u32 = 520;
const H: u32 = 360;
const HEADER_H: i32 = 34;
const ROW_H: i32 = 14;

const BG: Color = rgb(18, 20, 26);
const HEADER_BG: Color = rgb(34, 40, 56);
const COLHDR_BG: Color = rgb(28, 32, 44);
const FG: Color = rgb(214, 217, 223);
const DIM: Color = rgb(140, 146, 158);
const SEL_BG: Color = rgb(43, 108, 176);
const RUN_FG: Color = rgb(120, 210, 140); // running/ready
const ZOMBIE_FG: Color = rgb(210, 120, 120);

const KEY_K: u32 = 'k' as u32;
const KEY_T: u32 = 't' as u32;
const KEY_R: u32 = 'r' as u32;

struct State {
    procs: Vec<ProcInfo>,
    selected: usize,
}

impl State {
    fn refresh(&mut self) {
        let prev_pid = self.procs.get(self.selected).map(|p| p.pid);
        self.procs = proc_list();
        self.procs.sort_by_key(|p| p.pid);
        // Keep the selection pinned to the same pid across refreshes when possible.
        if let Some(pid) = prev_pid {
            if let Some(i) = self.procs.iter().position(|p| p.pid == pid) {
                self.selected = i;
            }
        }
        if self.selected >= self.procs.len() {
            self.selected = self.procs.len().saturating_sub(1);
        }
    }

    fn selected_pid(&self) -> Option<u32> {
        self.procs.get(self.selected).map(|p| p.pid)
    }
}

fn state_color(s: ProcState) -> Color {
    match s {
        ProcState::Running | ProcState::Ready => RUN_FG,
        ProcState::Zombie => ZOMBIE_FG,
        _ => DIM,
    }
}

fn draw(fb: &mut Framebuffer, st: &State) {
    fb.clear(BG);
    fb.fill_rect(0, 0, W as i32, HEADER_H, HEADER_BG);
    fb.text(6, 5, &format!("System Monitor — {} processes", st.procs.len()), FG);
    fb.text(6, 19, "[k] kill  [t] term  [r] renice+   up/dn select", DIM);

    // Column header.
    let cy = HEADER_H;
    fb.fill_rect(0, cy, W as i32, ROW_H, COLHDR_BG);
    fb.text(6, cy + 3, "  PID  PRI STAT      CPU   MEM(KB)  NAME", DIM);

    let top = cy + ROW_H;
    let visible = ((H as i32 - top) / ROW_H) as usize;
    for screen in 0..visible {
        let Some(p) = st.procs.get(screen) else { break };
        let y = top + screen as i32 * ROW_H;
        if screen == st.selected {
            fb.fill_rect(0, y, W as i32, ROW_H, SEL_BG);
        }
        let row = format!(
            "{:>5} {:>4} {:<6} {:>6} {:>8}  {}",
            p.pid,
            p.priority,
            p.state.label(),
            p.cpu_ticks,
            p.mem_bytes / 1024,
            p.name,
        );
        // State-tinted dot, then the row text.
        fb.fill_rect(2, y + 3, GLYPH_W as i32, GLYPH_H as i32, state_color(p.state));
        fb.text(2 + GLYPH_W as i32 + 2, y + 3, &row, FG);
    }
}

/// Act on the selected process. init (pid 1) is protected.
fn act(st: &mut State, sig_or_renice: Action) {
    let Some(pid) = st.selected_pid() else { return };
    if pid == 1 {
        return; // never signal init
    }
    match sig_or_renice {
        Action::Kill => {
            let _ = kill(pid, SIGKILL);
        }
        Action::Term => {
            let _ = kill(pid, SIGTERM);
        }
        Action::Renice => {
            let cur = st.procs.get(st.selected).map(|p| p.priority).unwrap_or(5);
            let _ = set_priority(pid, cur.saturating_add(1));
        }
    }
}

enum Action {
    Kill,
    Term,
    Renice,
}

fn main() {
    let surface = match win_surface(W, H) {
        Ok(id) => id,
        Err(_) => std::process::exit(1),
    };
    let mut fb = Framebuffer::new(W, H);
    let mut st = State { procs: Vec::new(), selected: 0 };
    st.refresh();
    draw(&mut fb, &st);
    win_present(surface, fb.bytes());

    let top = HEADER_H + ROW_H;
    loop {
        let events = match win_read_input() {
            Ok(ev) => ev,
            Err(_) => return, // no Input capability
        };
        // Refresh the table on each input batch so the view is live.
        st.refresh();
        for ev in &events {
            match ev.kind {
                EV_POINTER_MOVE | EV_POINTER_DOWN => {
                    let y = ev.y as i32;
                    if y >= top {
                        let row = ((y - top) / ROW_H) as usize;
                        if row < st.procs.len() {
                            st.selected = row;
                        }
                    }
                }
                EV_KEY_DOWN => match ev.key {
                    KEY_DOWN if st.selected + 1 < st.procs.len() => st.selected += 1,
                    KEY_UP => st.selected = st.selected.saturating_sub(1),
                    KEY_K => act(&mut st, Action::Kill),
                    KEY_T => act(&mut st, Action::Term),
                    KEY_R => act(&mut st, Action::Renice),
                    _ => {}
                },
                _ => {}
            }
        }
        // Reflect any process-control side effects immediately.
        st.refresh();
        draw(&mut fb, &st);
        win_present(surface, fb.bytes());
    }
}

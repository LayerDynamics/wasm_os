//! System Monitor (L3 / system monitor, FR-33 + FR-8) — a real `wasm32-wasip1` process.
//!
//! Draws the live process table to a canvas surface (read from the `proc_list`
//! syscall) and acts on the selected process from brokered keyboard input or the
//! visible KILL, TERM, and RENICE controls:
//!   k/KILL → SIGKILL   t/TERM → SIGTERM   r/RENICE → renice (+1 priority)
//! Process control uses the Signal capability, which the launcher delegates (the
//! graphical sibling of the `kill`/`renice` coreutils). It refreshes the table on
//! every input event, so interacting shows current state. Action results are shown
//! in the header, and init (pid 1) is protected — the monitor refuses to signal it.

use wasmgfx::{rgb, Color, Framebuffer, GLYPH_H, GLYPH_W};
use wasmos_sys::{
    kill, proc_list, set_priority, win_present, win_read_input, win_surface, ProcInfo, ProcState,
    EV_KEY_DOWN, EV_POINTER_DOWN, EV_POINTER_MOVE, KEY_DOWN, KEY_UP, SIGKILL, SIGTERM,
};

const W: u32 = 520;
const H: u32 = 360;
const HEADER_H: i32 = 34;
const ROW_H: i32 = 14;
const ACTION_Y: i32 = 17;
const ACTION_H: i32 = 13;
const KILL_X: i32 = 6;
const TERM_X: i32 = 72;
const RENICE_X: i32 = 138;
const ACTION_W: i32 = 58;

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
    status: String,
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

    /// Index of the first process that can actually be signalled (i.e. not init,
    /// pid 1, which is protected). Used to seed the selection so k/t/r act on a real
    /// target out of the box instead of silently no-op'ing on init.
    fn first_killable(&self) -> usize {
        self.procs.iter().position(|p| p.pid != 1).unwrap_or(0)
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
    fb.text(
        6,
        5,
        &format!("System Monitor — {} processes", st.procs.len()),
        FG,
    );
    for (x, label, color) in [
        (KILL_X, "KILL", rgb(120, 55, 62)),
        (TERM_X, "TERM", rgb(105, 82, 48)),
        (RENICE_X, "RENICE", rgb(48, 86, 112)),
    ] {
        fb.fill_rect(x, ACTION_Y, ACTION_W, ACTION_H, color);
        fb.text(x + 5, ACTION_Y + 3, label, FG);
    }
    fb.text(205, ACTION_Y + 3, &st.status, DIM);

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
        fb.fill_rect(
            2,
            y + 3,
            GLYPH_W as i32,
            GLYPH_H as i32,
            state_color(p.state),
        );
        fb.text(2 + GLYPH_W as i32 + 2, y + 3, &row, FG);
    }
}

/// Act on the selected process. init (pid 1) is protected.
fn act(st: &mut State, sig_or_renice: Action) {
    let Some(pid) = st.selected_pid() else {
        st.status = "No process selected".to_string();
        return;
    };
    if pid == 1 {
        st.status = "PID 1 is protected".to_string();
        return; // never signal init
    }
    match sig_or_renice {
        Action::Kill => {
            st.status = action_status("killed", pid, kill(pid, SIGKILL));
        }
        Action::Term => {
            st.status = action_status("terminated", pid, kill(pid, SIGTERM));
        }
        Action::Renice => {
            let cur = st.procs.get(st.selected).map(|p| p.priority).unwrap_or(5);
            st.status = action_status("reniced", pid, set_priority(pid, cur.saturating_add(1)));
        }
    }
}

fn action_status(action: &str, pid: u32, errno: u16) -> String {
    if errno == 0 {
        format!("{action} {pid}")
    } else {
        format!("{action} {pid} failed (errno {errno})")
    }
}

fn action_at(x: i32, y: i32) -> Option<Action> {
    if !(ACTION_Y..ACTION_Y + ACTION_H).contains(&y) {
        return None;
    }
    if (KILL_X..KILL_X + ACTION_W).contains(&x) {
        Some(Action::Kill)
    } else if (TERM_X..TERM_X + ACTION_W).contains(&x) {
        Some(Action::Term)
    } else if (RENICE_X..RENICE_X + ACTION_W).contains(&x) {
        Some(Action::Renice)
    } else {
        None
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
    let mut st = State {
        procs: Vec::new(),
        selected: 0,
        status: "Press K to kill selected process".to_string(),
    };
    st.refresh();
    // Seed the cursor on a killable process (not the protected init) so the first
    // k/t/r keypress acts on a real target.
    st.selected = st.first_killable();
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
                    if ev.kind == EV_POINTER_DOWN {
                        if let Some(action) = action_at(ev.x as i32, ev.y as i32) {
                            act(&mut st, action);
                            continue;
                        }
                    }
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

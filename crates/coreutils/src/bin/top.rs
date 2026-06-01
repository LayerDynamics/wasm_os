//! top — the busiest processes first (M4-T7, FR-33). Like `ps` it snapshots the
//! live table via the `wasmos_kernel` proc_list syscall, but it sorts by CPU
//! activity (scheduler ticks) descending and prints a summary header — the
//! distinguishing `top` view. One-shot (equivalent to `top -n 1`) so it does not
//! block the shell.

use wasmos_sys::{proc_list, ProcState};

fn main() {
    let mut procs = proc_list();
    let total = procs.len();
    let running = procs.iter().filter(|p| matches!(p.state, ProcState::Running | ProcState::Ready)).count();
    let total_cpu: u64 = procs.iter().map(|p| p.cpu_ticks).sum();

    // Busiest first; ties broken by PID for a stable order.
    procs.sort_by(|a, b| b.cpu_ticks.cmp(&a.cpu_ticks).then(a.pid.cmp(&b.pid)));

    println!("top - {total} processes, {running} runnable, {total_cpu} total CPU ticks");
    println!("  PID  PRI  STAT      CPU     MEM(KB)  NAME");
    for p in &procs {
        println!(
            "{:>5} {:>4}  {:<7} {:>5} {:>10}  {}",
            p.pid,
            p.priority,
            p.state.label(),
            p.cpu_ticks,
            p.mem_bytes / 1024,
            p.name,
        );
    }
}

//! ps — snapshot the process table (process-table tools, FR-33). Reads the live table via the
//! `wasmos_kernel` proc_list syscall (no capability required — it is a read-only
//! view) and prints one row per process, ordered by PID.

use wasmos_sys::proc_list;

fn main() {
    let mut procs = proc_list();
    procs.sort_by_key(|p| p.pid);
    println!("  PID  PPID  PRI  STAT      CPU     MEM(KB)  NAME");
    for p in &procs {
        println!(
            "{:>5} {:>5} {:>4}  {:<7} {:>5} {:>10}  {}",
            p.pid,
            p.parent,
            p.priority,
            p.state.label(),
            p.cpu_ticks,
            p.mem_bytes / 1024,
            p.name,
        );
    }
}

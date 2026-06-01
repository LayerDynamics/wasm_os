//! Kernel core: the host-independent kernel logic (VFS + process table +
//! scheduler + capabilities) wired together. The WASM `component` layer in
//! `lib.rs` is a thin WIT adapter over this; `cargo test` exercises it directly
//! on the host with an in-memory blockstore.

use crate::pipe::PipeTable;
use crate::sched::Scheduler;
use crate::syscall;
use crate::types::{
    Backend, Capability, CapabilitySet, DescKind, ProcInfo, ProcKind, ProcState, ProcTable, Rights,
    WaitReason,
};
use crate::vfs::{Blockstore, FsError, Vfs};

/// Default scheduling priority for user processes spawned at M1 (init is 10).
const USER_PRIORITY: u8 = 5;

/// Signals (M4-T5). SIGTERM is catchable (cooperative graceful shutdown); SIGKILL
/// is uncatchable + forceful (the kernel reaps the process). Values match POSIX.
const SIGKILL: u8 = 9;
const SIGTERM: u8 = 15;

pub struct KernelCore {
    vfs: Vfs,
    procs: ProcTable,
    sched: Scheduler,
    pipes: PipeTable,
    chans: crate::chan::ChannelTable,
    shm: crate::shm::ShmTable,
    /// The privileged emulator process (M5), if one is running — special-cased by
    /// the scheduler (run-to-budget, FR-28).
    emulator_pid: Option<u32>,
    booted: bool,
}

impl KernelCore {
    pub fn new(home: Box<dyn Blockstore>, mnt: Box<dyn Blockstore>) -> Self {
        Self {
            vfs: Vfs::new(home, mnt),
            procs: ProcTable::new(),
            sched: Scheduler::new(),
            pipes: PipeTable::new(),
            chans: crate::chan::ChannelTable::new(),
            shm: crate::shm::ShmTable::new(),
            emulator_pid: None,
            booted: false,
        }
    }

    /// Idempotent boot: mount the standard layout and register the kernel
    /// `init` process, driving it New -> Ready -> Running through the scheduler.
    /// This exercises the capability system, process table, and scheduler live.
    pub fn boot(&mut self) {
        if self.booted {
            return;
        }
        let _ = self.vfs.mount("/home", Backend::Opfs);
        let _ = self.vfs.mount("/mnt", Backend::Idb);

        // init holds full FS rights and the right to spawn (it launches the
        // userland in M1). Registering it drives the full M0 process path.
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
        caps.grant(Capability::Spawn);

        let init = self.procs.spawn("init", 10, caps);
        self.procs.set_state(init, ProcState::Ready);
        self.sched.enqueue(init, 10);
        if let Some(pid) = self.sched.pick_next() {
            self.procs.set_state(pid, ProcState::Running);
            self.sched.account(pid, 1);
        }
        self.booted = true;
    }

    pub fn is_booted(&self) -> bool {
        self.booted
    }

    // --- VFS surface (delegates) ---
    pub fn mount(&mut self, path: &str, on: Backend) -> Result<(), FsError> {
        self.vfs.mount(path, on)
    }
    pub fn write(&mut self, path: &str, bytes: Vec<u8>) -> Result<(), FsError> {
        self.vfs.write(path, bytes)
    }
    pub fn read(&self, path: &str) -> Result<Vec<u8>, FsError> {
        self.vfs.read(path)
    }
    pub fn list(&self, path: &str) -> Result<Vec<String>, FsError> {
        self.vfs.list(path)
    }
    pub fn delete(&mut self, path: &str) -> Result<(), FsError> {
        self.vfs.delete(path)
    }

    // --- Process/scheduler/capability surface ---
    pub fn list_procs(&self) -> Vec<ProcInfo> {
        // Enrich the process table projection with scheduler CPU accounting (M4).
        let mut infos = self.procs.list();
        for i in infos.iter_mut() {
            i.cpu_ticks = self.sched.time_of(i.pid);
        }
        infos
    }

    /// Record a process's reported guest memory size (M4 `top`).
    pub fn set_proc_mem(&mut self, pid: u32, bytes: u32) {
        self.procs.set_mem(pid, bytes);
    }

    /// Change a process's scheduling priority at runtime (FR-8). Re-buckets it in
    /// the scheduler if it is currently ready.
    pub fn set_priority(&mut self, pid: u32, priority: u8) {
        if self.procs.set_priority(pid, priority).is_some() {
            self.sched.reprioritize(pid, priority);
        }
    }
    pub fn proc_count(&self) -> usize {
        self.procs.count()
    }

    /// Confer the Signal (process-control) capability on a process after spawn
    /// (M4-T5). The host grants it to the shell so its `kill` builtin can signal
    /// other processes, and the shell may delegate it to a spawned `kill`.
    pub fn grant_signal(&mut self, pid: u32) {
        self.procs.grant_cap(pid, Capability::Signal);
    }
    pub fn ready_count(&self) -> usize {
        self.sched.ready_len()
    }
    /// Authorization check for a process against a capability (FR-31).
    pub fn check_cap(&self, pid: u32, cap: &Capability) -> bool {
        self.procs.has_cap(pid, cap)
    }

    // --- Process lifecycle (M1, FR-5) ---

    /// Allocate a process with a minimal capability set and make it `Ready`
    /// (enqueued on the scheduler). `grant_fs` is an optional `(subtree, rights)`
    /// FS grant; `grant_spawn` confers the right to spawn children. The kernel
    /// **never** grants `Shm` here — there is no inter-process memory path at M1
    /// (the structural half of the isolation guarantee, FR-6).
    pub fn spawn(
        &mut self,
        name: &str,
        grant_fs: Option<(&str, Rights)>,
        grant_spawn: bool,
        grant_gpu: bool,
        grant_input: bool,
    ) -> u32 {
        let mut caps = CapabilitySet::default();
        if let Some((subtree, rights)) = grant_fs {
            caps.grant(Capability::FsPath { subtree: subtree.to_string(), rights });
        }
        if grant_spawn {
            caps.grant(Capability::Spawn);
        }
        // Gpu gates win_surface (M3); Input gates brokered keyboard/mouse (M3-T3).
        if grant_gpu {
            caps.grant(Capability::Gpu);
        }
        if grant_input {
            caps.grant(Capability::Input);
        }
        let pid = self.procs.spawn(name, USER_PRIORITY, caps);
        self.procs.set_state(pid, ProcState::Ready);
        self.sched.enqueue(pid, USER_PRIORITY);
        pid
    }

    /// Register the **privileged emulator process** (M5, FR-27/FR-28): a `Native`
    /// process that runs its own CPU loop in a dedicated host worker rather than
    /// making WASI syscalls over the ring. It is a first-class PID — it appears in
    /// `proc_list`/`top`, holds a capability set (Gpu+Input+Net+FS for the
    /// framebuffer, brokered input, image fetch, and the 9p shared folder), and is
    /// killable via the normal signal/reap path — but is **never** enqueued on the
    /// ring scheduler. It is marked `Running` (it runs continuously in its worker)
    /// and special-cased for run-to-budget accounting (T5). Isolation (FR-6) holds:
    /// it is a separate worker with no access to other processes' memory.
    pub fn spawn_emulator(&mut self, name: &str) -> u32 {
        let mut caps = CapabilitySet::default();
        caps.grant(Capability::FsPath { subtree: "/".into(), rights: Rights::RWX });
        caps.grant(Capability::Gpu);
        caps.grant(Capability::Input);
        caps.grant(Capability::Net);
        let pid = self.procs.spawn(name, USER_PRIORITY, caps);
        self.procs.set_kind(pid, ProcKind::Native);
        self.procs.set_state(pid, ProcState::Running);
        self.emulator_pid = Some(pid);
        pid
    }

    /// The running emulator process's pid, if any (M5 scheduling/lifecycle).
    pub fn emulator_pid(&self) -> Option<u32> {
        self.emulator_pid
    }

    /// The execution kind of a process (M5 — `Native` for the emulator).
    pub fn proc_kind(&self, pid: u32) -> ProcKind {
        self.procs.kind_of(pid)
    }

    /// Account a run-to-budget quantum for the emulator (M5-T5, FR-28). The emulator
    /// makes no syscalls, so its CPU activity surfaced in `top`/`proc_list` comes
    /// from periodic wall-budget heartbeats its worker reports. Ignored for any pid
    /// that is not the registered emulator (it cannot inflate another process).
    pub fn account_emulator(&mut self, pid: u32, ticks: u64) {
        if self.emulator_pid == Some(pid) {
            self.sched.account(pid, ticks);
        }
    }

    /// Route one syscall for `pid` (FR-4). Returns a [`syscall::SyscallOutcome`]
    /// — a ready reply, or a park (M2) the kworker defers until a wakeup.
    pub fn service_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        // Account one scheduler tick per serviced syscall — a deterministic
        // kernel-activity metric powering `ps`/`top` (FR-3 time accounting, FR-33).
        self.sched.account(pid, 1);
        // proc_list / set_priority need the scheduler (cpu accounting, re-bucketing)
        // so they are serviced here rather than in the (scheduler-free) router.
        match req.first().copied() {
            Some(0x30) => syscall::SyscallOutcome::ready(self.encode_proc_list()),
            Some(0x31) => self.set_priority_syscall(pid, req),
            Some(0x32) => self.chan_open_syscall(pid, req),
            Some(0x33) => self.chan_send_syscall(pid, req),
            Some(0x34) => self.chan_recv_syscall(pid, req),
            Some(0x35) => self.shm_create_syscall(pid, req),
            Some(0x36) => self.shm_map_syscall(pid, req),
            Some(0x37) => self.shm_read_syscall(pid, req),
            Some(0x38) => self.shm_write_syscall(pid, req),
            Some(0x39) => self.shm_grant_syscall(pid, req),
            Some(0x3A) => self.kill_syscall(pid, req),
            Some(0x3B) => self.sig_wait_syscall(pid),
            _ => {
                let mut out =
                    syscall::dispatch(&mut self.vfs, &mut self.procs, &mut self.pipes, pid, req);
                // proc_exit (0x10): also release this process's channel endpoints and
                // shm regions so parked peers observe EOF / freed memory (sibling of
                // the pipe/surface cleanup).
                if req.first() == Some(&0x10) {
                    out.wakeups.extend(self.close_proc_channels(pid));
                    self.shm.free_owned(pid);
                }
                out
            }
        }
    }

    /// `proc_list()` (M4 `ps`/`top`, FR-33). Reply: `[errno u16][count u32]` then,
    /// per process: `pid u32, name(len-prefixed), state u8, priority u8,
    /// cpu_ticks u64, mem_bytes u32, parent u32`.
    fn encode_proc_list(&self) -> Vec<u8> {
        let infos = self.list_procs();
        let mut b = Vec::new();
        b.extend_from_slice(&syscall::errno::SUCCESS.to_le_bytes());
        b.extend_from_slice(&(infos.len() as u32).to_le_bytes());
        for i in &infos {
            b.extend_from_slice(&i.pid.to_le_bytes());
            let name = i.name.as_bytes();
            b.extend_from_slice(&(name.len() as u32).to_le_bytes());
            b.extend_from_slice(name);
            b.push(match i.state.as_str() {
                "new" => 0,
                "ready" => 1,
                "running" => 2,
                "blocked" => 3,
                _ => 4, // zombie
            });
            b.push(i.priority);
            b.extend_from_slice(&i.cpu_ticks.to_le_bytes());
            b.extend_from_slice(&i.mem_bytes.to_le_bytes());
            b.extend_from_slice(&i.parent.to_le_bytes());
        }
        b
    }

    /// `set_priority(target, prio)` (FR-8). A process may renice itself freely;
    /// renicing another requires the Signal (process-control) capability.
    fn set_priority_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        let err = |e: u16| syscall::SyscallOutcome::ready(e.to_le_bytes().to_vec());
        if req.len() < 6 {
            return err(syscall::errno::INVAL);
        }
        let target = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        let prio = req[5];
        if self.procs.get(target).is_none() {
            return err(syscall::errno::SRCH);
        }
        if target != pid && !self.procs.has_cap(pid, &Capability::Signal) {
            return err(syscall::errno::NOTCAPABLE);
        }
        self.set_priority(target, prio);
        err(syscall::errno::SUCCESS)
    }

    // --- M4-T3: message channels (opaque handles, not WASI fds) ---

    /// `chan_open(name)` — rendezvous by name. Reply: `[errno u16][chan_id u32][end u8]`.
    fn chan_open_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        let name = String::from_utf8_lossy(&req[1..]).into_owned();
        let (id, end) = self.chans.open(&name);
        self.procs.add_channel(pid, id, end);
        let mut b = Vec::with_capacity(7);
        b.extend_from_slice(&syscall::errno::SUCCESS.to_le_bytes());
        b.extend_from_slice(&id.to_le_bytes());
        b.push(end);
        syscall::SyscallOutcome::ready(b)
    }

    /// `chan_send(chan_id, msg)` — `[0x33][chan_id u32][msg...]`. Reply: `[errno u16]`.
    /// The whole request payload after the id IS the message (boundaries preserved).
    fn chan_send_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        let err = |e: u16| syscall::SyscallOutcome::ready(e.to_le_bytes().to_vec());
        if req.len() < 5 {
            return err(syscall::errno::INVAL);
        }
        let id = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        let Some(end) = self.procs.channel_end(pid, id) else {
            return err(syscall::errno::BADF); // caller does not hold this channel
        };
        if !self.chans.send(id, end, req[5..].to_vec()) {
            return err(syscall::errno::PIPE); // peer permanently gone
        }
        // Wake a receiver parked on the PEER endpoint.
        let wakeups = self.procs.take_blocked_on(&WaitReason::ChanRecv(id, 1 - end));
        syscall::SyscallOutcome {
            reply: Some(syscall::errno::SUCCESS.to_le_bytes().to_vec()),
            wakeups,
            term_output: Vec::new(),
            spawn: None,
            reap: Vec::new(),
        }
    }

    /// `chan_recv(chan_id)` — `[0x34][chan_id u32]`. Parks on an empty inbox whose
    /// peer is still open; a closed-peer empty inbox is EOF (a zero-length reply).
    /// Reply: `[errno u16][len u32][msg]`.
    fn chan_recv_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        if req.len() < 5 {
            return syscall::SyscallOutcome::ready(syscall::errno::INVAL.to_le_bytes().to_vec());
        }
        let id = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        let Some(end) = self.procs.channel_end(pid, id) else {
            return syscall::SyscallOutcome::ready(syscall::errno::BADF.to_le_bytes().to_vec());
        };
        if self.chans.inbox_len(id, end) > 0 {
            let msg = self.chans.recv(id, end).unwrap_or_default();
            let mut b = Vec::with_capacity(6 + msg.len());
            b.extend_from_slice(&syscall::errno::SUCCESS.to_le_bytes());
            b.extend_from_slice(&(msg.len() as u32).to_le_bytes());
            b.extend_from_slice(&msg);
            syscall::SyscallOutcome::ready(b)
        } else if !self.chans.peer_open(id, end) {
            // EOF: peer gone, inbox drained → empty message.
            let mut b = Vec::with_capacity(6);
            b.extend_from_slice(&syscall::errno::SUCCESS.to_le_bytes());
            b.extend_from_slice(&0u32.to_le_bytes());
            syscall::SyscallOutcome::ready(b)
        } else {
            self.procs.set_blocked(pid, WaitReason::ChanRecv(id, end));
            syscall::SyscallOutcome::parked()
        }
    }

    /// Release every channel endpoint a dying process holds; returns the pids whose
    /// parked receives are now runnable (they will observe EOF).
    fn close_proc_channels(&mut self, pid: u32) -> Vec<u32> {
        let mut wakeups = Vec::new();
        for (id, end) in self.procs.channels_of(pid) {
            self.chans.close(id, end);
            wakeups.extend(self.procs.take_blocked_on(&WaitReason::ChanRecv(id, 1 - end)));
        }
        wakeups
    }

    // --- M4-T4: shared memory (kernel-arbitrated, capability-gated region, FR-6) ---

    /// `shm_create(size)` — `[0x35][size u32]`. Reply: `[errno u16][shm_id u32]`.
    /// Any process may create a region (it owns + may grant it); size is capped.
    fn shm_create_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        if req.len() < 5 {
            return syscall::SyscallOutcome::ready(syscall::errno::INVAL.to_le_bytes().to_vec());
        }
        let size = u32::from_le_bytes([req[1], req[2], req[3], req[4]]) as usize;
        let id = self.shm.create(pid, size);
        let mut b = syscall::errno::SUCCESS.to_le_bytes().to_vec();
        b.extend_from_slice(&id.to_le_bytes());
        syscall::SyscallOutcome::ready(b)
    }

    /// `shm_map(shm_id)` — `[0x36][shm_id u32]`. Confirms this process holds access
    /// (granted by the owner). Reply: `[errno u16]` (NOTCAPABLE if not granted).
    fn shm_map_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        let err = |e: u16| syscall::SyscallOutcome::ready(e.to_le_bytes().to_vec());
        if req.len() < 5 {
            return err(syscall::errno::INVAL);
        }
        let id = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        if !self.shm.exists(id) {
            return err(syscall::errno::INVAL);
        }
        if !self.shm.has_access(id, pid) {
            return err(syscall::errno::NOTCAPABLE);
        }
        err(syscall::errno::SUCCESS)
    }

    /// `shm_read(shm_id, off, len)` — `[0x37][shm_id u32][off u32][len u32]`.
    /// Reply: `[errno u16][len u32][bytes]` (NOTCAPABLE if access not granted).
    fn shm_read_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        if req.len() < 13 {
            return syscall::SyscallOutcome::ready(syscall::errno::INVAL.to_le_bytes().to_vec());
        }
        let id = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        let off = u32::from_le_bytes([req[5], req[6], req[7], req[8]]) as usize;
        let len = u32::from_le_bytes([req[9], req[10], req[11], req[12]]) as usize;
        if !self.shm.has_access(id, pid) {
            return syscall::SyscallOutcome::ready(syscall::errno::NOTCAPABLE.to_le_bytes().to_vec());
        }
        let data = self.shm.read(id, off, len);
        let mut b = syscall::errno::SUCCESS.to_le_bytes().to_vec();
        b.extend_from_slice(&(data.len() as u32).to_le_bytes());
        b.extend_from_slice(&data);
        syscall::SyscallOutcome::ready(b)
    }

    /// `shm_write(shm_id, off, data)` — `[0x38][shm_id u32][off u32][data...]`.
    /// Reply: `[errno u16]` (NOTCAPABLE if access not granted).
    fn shm_write_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        let err = |e: u16| syscall::SyscallOutcome::ready(e.to_le_bytes().to_vec());
        if req.len() < 9 {
            return err(syscall::errno::INVAL);
        }
        let id = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        let off = u32::from_le_bytes([req[5], req[6], req[7], req[8]]) as usize;
        if !self.shm.has_access(id, pid) {
            return err(syscall::errno::NOTCAPABLE);
        }
        if !self.shm.write(id, off, &req[9..]) {
            return err(syscall::errno::INVAL);
        }
        err(syscall::errno::SUCCESS)
    }

    /// `shm_grant(shm_id, target_pid)` — `[0x39][shm_id u32][target_pid u32]`.
    /// The owner shares access with another process. Reply: `[errno u16]`
    /// (NOTCAPABLE if the caller is not the region's owner).
    fn shm_grant_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        let err = |e: u16| syscall::SyscallOutcome::ready(e.to_le_bytes().to_vec());
        if req.len() < 9 {
            return err(syscall::errno::INVAL);
        }
        let id = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        let target = u32::from_le_bytes([req[5], req[6], req[7], req[8]]);
        if self.shm.grant(id, pid, target) {
            err(syscall::errno::SUCCESS)
        } else {
            err(syscall::errno::NOTCAPABLE)
        }
    }

    // --- M4-T5: signals (SIGTERM cooperative + SIGKILL forceful, Signal cap) ---

    /// `kill(target, sig)` — `[0x3A][target u32][sig u8]`. Reply: `[errno u16]`.
    /// Signalling another process requires the Signal capability (self always
    /// allowed). SIGKILL (9) is uncatchable + forceful: the kernel runs the
    /// target's full exit teardown (pipes/channels/shm released, waiters woken) and
    /// asks the host to terminate its worker (`reap`). SIGTERM (15) is catchable +
    /// cooperative: it queues a pending signal and wakes the target if it is parked
    /// in `sig_wait()`, so the guest can observe it and exit gracefully.
    fn kill_syscall(&mut self, pid: u32, req: &[u8]) -> syscall::SyscallOutcome {
        let err = |e: u16| syscall::SyscallOutcome::ready(e.to_le_bytes().to_vec());
        if req.len() < 6 {
            return err(syscall::errno::INVAL);
        }
        let target = u32::from_le_bytes([req[1], req[2], req[3], req[4]]);
        let sig = req[5];
        if target == 1 {
            return err(syscall::errno::NOTCAPABLE);
        }
        if self.procs.get(target).is_none() {
            return err(syscall::errno::SRCH);
        }
        if target != pid && !self.procs.has_cap(pid, &Capability::Signal) {
            return err(syscall::errno::NOTCAPABLE);
        }
        match sig {
            SIGKILL => {
                // Forge the target's own proc_exit (exit code 128+SIGKILL) so it
                // releases pipes/surfaces and wakes its waiters exactly as a clean
                // exit would, then release its channels + shm (the kcore-level
                // siblings of that teardown) and ask the host to reap its worker.
                let mut exit_req = vec![0x10u8];
                exit_req.extend_from_slice(&(128u32 + SIGKILL as u32).to_le_bytes());
                let mut out =
                    syscall::dispatch(&mut self.vfs, &mut self.procs, &mut self.pipes, target, &exit_req);
                out.wakeups.extend(self.close_proc_channels(target));
                self.shm.free_owned(target);
                out.reap.push(target);
                // The forged exit's SUCCESS reply belongs to `target`'s (now dead)
                // ring; replace it with this caller's kill reply.
                out.reply = Some(syscall::errno::SUCCESS.to_le_bytes().to_vec());
                out
            }
            SIGTERM => {
                self.procs.push_signal(target, SIGTERM);
                // Zero-CPU delivery: wake the target only if it is parked in
                // sig_wait (its re-driven wait then drains the pending signal).
                let mut wakeups = Vec::new();
                if self.procs.blocked_on(target) == Some(WaitReason::SigWait) {
                    self.procs.clear_blocked(target);
                    wakeups.push(target);
                }
                syscall::SyscallOutcome {
                    reply: Some(syscall::errno::SUCCESS.to_le_bytes().to_vec()),
                    wakeups,
                    term_output: Vec::new(),
                    spawn: None,
                    reap: Vec::new(),
                }
            }
            _ => err(syscall::errno::INVAL), // unsupported signal
        }
    }

    /// `sig_wait()` — `[0x3B]`. Blocks until at least one signal is pending, then
    /// drains + returns them. Reply: `[errno u16][count u32][sig u8 ...]`. Parks on
    /// an empty signal queue (woken by a SIGTERM delivery) — no busy-poll.
    fn sig_wait_syscall(&mut self, pid: u32) -> syscall::SyscallOutcome {
        let sigs = self.procs.take_signals(pid);
        if sigs.is_empty() {
            self.procs.set_blocked(pid, WaitReason::SigWait);
            return syscall::SyscallOutcome::parked();
        }
        let mut b = syscall::errno::SUCCESS.to_le_bytes().to_vec();
        b.extend_from_slice(&(sigs.len() as u32).to_le_bytes());
        b.extend_from_slice(&sigs);
        syscall::SyscallOutcome::ready(b)
    }

    /// Bind a process's stdout + stderr (fd 1/2) to the interactive terminal so
    /// its writes stream to xterm (M2). fd 0 stays stdin, fed by `deliver_stdin`.
    pub fn bind_terminal(&mut self, pid: u32) {
        if let Some(d) = self.procs.fd_mut(pid, 1) {
            d.kind = DescKind::Terminal;
        }
        if let Some(d) = self.procs.fd_mut(pid, 2) {
            d.kind = DescKind::Terminal;
        }
    }

    /// Deliver input bytes to a process's stdin (terminal keystrokes, M2).
    /// Returns the pids whose parked stdin reads are now runnable.
    pub fn deliver_stdin(&mut self, pid: u32, bytes: &[u8]) -> Vec<u32> {
        self.procs.push_stdin(pid, bytes);
        if self.procs.blocked_on(pid) == Some(crate::types::WaitReason::Stdin) {
            self.procs.clear_blocked(pid);
            vec![pid]
        } else {
            vec![]
        }
    }

    /// Deliver brokered input events to a process's focused window (M3-T3, FR-25).
    /// Default-deny: only a process holding the Input capability receives events.
    /// Returns the pids whose parked `win_read_input` calls are now runnable.
    pub fn deliver_input(&mut self, pid: u32, bytes: &[u8]) -> Vec<u32> {
        if !self.procs.has_cap(pid, &Capability::Input) {
            return vec![];
        }
        self.procs.push_input(pid, bytes);
        if self.procs.blocked_on(pid) == Some(crate::types::WaitReason::Input) {
            self.procs.clear_blocked(pid);
            vec![pid]
        } else {
            vec![]
        }
    }

    /// The process's exit code, if it has exited (FR-5 `wait`).
    pub fn exit_code(&self, pid: u32) -> Option<i32> {
        self.procs.exit_code(pid)
    }

    /// Drain and return a process's captured `(stdout, stderr)`.
    pub fn take_capture(&mut self, pid: u32) -> (Vec<u8>, Vec<u8>) {
        self.procs.take_capture(pid)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    #[derive(Default)]
    struct MemStore(BTreeMap<String, Vec<u8>>);
    impl Blockstore for MemStore {
        fn get(&self, k: &str) -> Option<Vec<u8>> { self.0.get(k).cloned() }
        fn put(&mut self, k: &str, v: Vec<u8>) -> bool { self.0.insert(k.into(), v); true }
        fn list(&self, p: &str) -> Vec<String> {
            self.0.keys().filter(|k| k.starts_with(p)).cloned().collect()
        }
        fn delete(&mut self, k: &str) -> bool { self.0.remove(k).is_some() }
    }

    fn core() -> KernelCore {
        KernelCore::new(Box::new(MemStore::default()), Box::new(MemStore::default()))
    }

    #[test]
    fn boot_registers_init_running_with_capabilities() {
        let mut k = core();
        assert!(!k.is_booted());
        k.boot();
        assert!(k.is_booted());

        let procs = k.list_procs();
        assert_eq!(procs.len(), 1);
        assert_eq!(procs[0].name, "init");
        assert_eq!(procs[0].state, "running"); // scheduler picked it
        assert_eq!(procs[0].pid, 1);

        // init's capabilities are real and enforced (default-deny otherwise).
        assert!(k.check_cap(1, &Capability::Spawn));
        assert!(k.check_cap(1, &Capability::FsPath { subtree: "/home/x".into(), rights: Rights::RW }));
        assert!(!k.check_cap(1, &Capability::Net)); // not granted
    }

    #[test]
    fn boot_is_idempotent() {
        let mut k = core();
        k.boot();
        k.boot();
        assert_eq!(k.proc_count(), 1); // not re-registered
    }

    #[test]
    fn boot_mounts_all_three_backends_and_routes_writes() {
        let mut k = core();
        k.boot();
        k.write("/scratch", b"t".to_vec()).unwrap(); // tmpfs
        k.write("/home/a", b"h".to_vec()).unwrap();   // opfs
        k.write("/mnt/b", b"m".to_vec()).unwrap();    // idb
        assert_eq!(k.read("/scratch").unwrap(), b"t");
        assert_eq!(k.read("/home/a").unwrap(), b"h");
        assert_eq!(k.read("/mnt/b").unwrap(), b"m");
    }

    // --- M1: process lifecycle (FR-5) ---

    /// Encode a syscall request the way the host JS shim does (op byte + LE fields).
    fn fd_write_req(fd: u32, data: &[u8]) -> Vec<u8> {
        let mut v = vec![0x01u8]; // Op::FdWrite
        v.extend_from_slice(&fd.to_le_bytes());
        v.extend_from_slice(&(data.len() as u32).to_le_bytes());
        v.extend_from_slice(data);
        v
    }
    fn proc_exit_req(code: u32) -> Vec<u8> {
        let mut v = vec![0x10u8]; // Op::ProcExit
        v.extend_from_slice(&code.to_le_bytes());
        v
    }
    fn fd_read_req(fd: u32, len: u32) -> Vec<u8> {
        let mut v = vec![0x02u8]; // Op::FdRead
        v.extend_from_slice(&fd.to_le_bytes());
        v.extend_from_slice(&len.to_le_bytes());
        v
    }

    #[test]
    fn spawn_then_service_fd_write_then_exit() {
        let mut k = core();
        k.boot();
        let pid = k.spawn("hello", Some(("/", Rights::RW)), false, false, false);
        assert!(pid > 1); // init is pid 1
        // Process is Ready and enqueued.
        assert!(k.ready_count() >= 1);
        // Route an fd_write to stdout, then proc_exit(0).
        let resp = k.service_syscall(pid, &fd_write_req(1, b"hi")).reply.expect("ready");
        assert_eq!(u16::from_le_bytes([resp[0], resp[1]]), 0); // SUCCESS
        k.service_syscall(pid, &proc_exit_req(0));
        let (out, _err) = k.take_capture(pid);
        assert_eq!(out, b"hi");
        assert_eq!(k.exit_code(pid), Some(0));
    }

    #[test]
    fn stdin_read_parks_then_deliver_wakes_and_redrives() {
        let mut k = core();
        k.boot();
        let pid = k.spawn("reader", Some(("/", Rights::RW)), false, false, false);
        let req = fd_read_req(0, 16); // read stdin (fd 0)

        // No input yet → the syscall PARKS (no reply).
        assert!(k.service_syscall(pid, &req).reply.is_none());

        // Deliver input → the parked reader is woken.
        assert_eq!(k.deliver_stdin(pid, b"hi\n"), vec![pid]);

        // Re-driving the SAME request now returns the delivered bytes.
        let resp = k.service_syscall(pid, &req).reply.expect("ready after deliver");
        assert_eq!(u16::from_le_bytes([resp[0], resp[1]]), 0); // SUCCESS
        let n = u32::from_le_bytes([resp[2], resp[3], resp[4], resp[5]]) as usize;
        assert_eq!(&resp[6..6 + n], b"hi\n");

        // Delivering to a process that is NOT parked yields no wakeups.
        assert!(k.deliver_stdin(pid, b"more").is_empty());
    }

    #[test]
    fn bind_terminal_streams_writes_as_term_output() {
        let mut k = core();
        k.boot();
        let pid = k.spawn("shell", Some(("/", Rights::RW)), false, false, false);
        k.bind_terminal(pid);
        // A write to fd 1 (now Terminal) streams out as term_output (→ xterm),
        // and is NOT accumulated in the at-exit capture buffer.
        let out = k.service_syscall(pid, &fd_write_req(1, b"prompt$ "));
        assert_eq!(out.term_output, b"prompt$ ");
        assert_eq!(read_u16(&out.reply.expect("ready")), 0); // SUCCESS
        let (cap, _) = k.take_capture(pid);
        assert!(cap.is_empty());
    }

    fn read_u16(b: &[u8]) -> u16 {
        u16::from_le_bytes([b[0], b[1]])
    }

    #[test]
    fn two_spawns_have_isolated_fd_tables_and_no_shm_cap() {
        let mut k = core();
        k.boot();
        let a = k.spawn("a", Some(("/home", Rights::RW)), false, false, false);
        let b = k.spawn("b", Some(("/home", Rights::RW)), false, false, false);
        assert_ne!(a, b);
        // Neither holds Shm — there is no inter-process memory path (FR-6).
        assert!(!k.check_cap(a, &Capability::Shm));
        assert!(!k.check_cap(b, &Capability::Shm));
        // Each has exactly the FS grant it asked for, nothing more.
        assert!(k.check_cap(a, &Capability::FsPath { subtree: "/home/x".into(), rights: Rights::R }));
        assert!(!k.check_cap(a, &Capability::FsPath { subtree: "/mnt".into(), rights: Rights::R }));
    }

    #[test]
    fn spawn_grants_only_requested_caps() {
        let mut k = core();
        k.boot();
        // No FS grant, no spawn grant → default-deny everything.
        let pid = k.spawn("bare", None, false, false, false);
        assert!(!k.check_cap(pid, &Capability::Spawn));
        assert!(!k.check_cap(pid, &Capability::Shm));
        assert!(!k.check_cap(pid, &Capability::FsPath { subtree: "/".into(), rights: Rights::R }));
        // With spawn grant.
        let p2 = k.spawn("launcher", None, true, false, false);
        assert!(k.check_cap(p2, &Capability::Spawn));
    }

    #[test]
    fn spawn_grants_gpu_and_input_when_requested() {
        let mut k = core();
        k.boot();
        let plain = k.spawn("plain", None, false, false, false);
        assert!(!k.check_cap(plain, &Capability::Gpu));
        assert!(!k.check_cap(plain, &Capability::Input));
        let gfx = k.spawn("gfx", None, false, true, true);
        assert!(k.check_cap(gfx, &Capability::Gpu));
        assert!(k.check_cap(gfx, &Capability::Input));
    }

    #[test]
    fn deliver_input_is_capability_gated_and_wakes_a_parked_reader() {
        let mut k = core();
        k.boot();
        let with = k.spawn("g", None, false, false, true); // Input granted
        let without = k.spawn("n", None, false, false, false); // no Input
        // Default-deny: a process without Input receives nothing (no wakeups).
        assert!(k.deliver_input(without, &[0u8; 12]).is_empty());
        // Park `with` on win_read_input (opcode 0x25, cap=120) with an empty queue,
        // then a delivery wakes exactly that pid.
        let req = vec![0x25u8, 120, 0, 0, 0];
        assert!(k.service_syscall(with, &req).reply.is_none());
        assert_eq!(k.deliver_input(with, &[0u8; 12]), vec![with]);
    }

    // --- M4: process metrics + proc_list + runtime priority ---

    #[test]
    fn proc_list_carries_metrics_and_priority_is_capability_gated() {
        let mut k = core();
        k.boot();
        let pid = k.spawn("worker", Some(("/", Rights::RW)), false, false, false);
        k.set_proc_mem(pid, 1_114_112); // a worker reports its memory size

        // A serviced syscall accounts a CPU tick; list_procs surfaces the metrics.
        k.service_syscall(pid, &fd_write_req(1, b"x"));
        let infos = k.list_procs();
        let me = infos.iter().find(|i| i.pid == pid).unwrap();
        assert!(me.cpu_ticks >= 1);
        assert_eq!(me.priority, USER_PRIORITY);
        assert_eq!(me.mem_bytes, 1_114_112);

        // proc_list() syscall returns [errno][count] + the encoded table.
        let resp = k.service_syscall(pid, &[0x30]).reply.unwrap();
        assert_eq!(read_u16(&resp), 0); // SUCCESS
        let count = u32::from_le_bytes([resp[2], resp[3], resp[4], resp[5]]);
        assert!(count >= 2); // init + worker

        // set_priority on SELF is allowed and re-buckets.
        let mut self_req = vec![0x31u8];
        self_req.extend_from_slice(&pid.to_le_bytes());
        self_req.push(9);
        assert_eq!(read_u16(&k.service_syscall(pid, &self_req).reply.unwrap()), 0);
        assert_eq!(k.list_procs().iter().find(|i| i.pid == pid).unwrap().priority, 9);

        // Renicing ANOTHER process without the Signal capability is denied.
        let mut other_req = vec![0x31u8];
        other_req.extend_from_slice(&1u32.to_le_bytes()); // init
        other_req.push(3);
        assert_eq!(read_u16(&k.service_syscall(pid, &other_req).reply.unwrap()), 76); // NOTCAPABLE
    }

    // --- M4-T3: message channels through the kernel core ---

    fn chan_open_req(name: &str) -> Vec<u8> {
        let mut v = vec![0x32u8];
        v.extend_from_slice(name.as_bytes());
        v
    }
    fn chan_send_req(id: u32, msg: &[u8]) -> Vec<u8> {
        let mut v = vec![0x33u8];
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(msg);
        v
    }
    fn chan_recv_req(id: u32) -> Vec<u8> {
        let mut v = vec![0x34u8];
        v.extend_from_slice(&id.to_le_bytes());
        v
    }

    #[test]
    fn channel_open_send_recv_park_resume_and_exit_eof() {
        let mut k = core();
        k.boot();
        let a = k.spawn("a", None, false, false, false);
        let b = k.spawn("b", None, false, false, false);

        // a opens "demo" (creator, end 0); b connects (end 1) to the same channel.
        let ra = k.service_syscall(a, &chan_open_req("demo")).reply.unwrap();
        assert_eq!(read_u16(&ra), 0);
        let id = u32::from_le_bytes([ra[2], ra[3], ra[4], ra[5]]);
        assert_eq!(ra[6], 0);
        let rb = k.service_syscall(b, &chan_open_req("demo")).reply.unwrap();
        assert_eq!(u32::from_le_bytes([rb[2], rb[3], rb[4], rb[5]]), id);
        assert_eq!(rb[6], 1);

        // b receives on an empty inbox (peer open) → parks.
        assert!(k.service_syscall(b, &chan_recv_req(id)).reply.is_none());
        // a sends → wakes b.
        let send = k.service_syscall(a, &chan_send_req(id, b"HELLO"));
        assert_eq!(read_u16(&send.reply.unwrap()), 0);
        assert_eq!(send.wakeups, vec![b]);
        // Re-driving b's receive returns the message.
        let r = k.service_syscall(b, &chan_recv_req(id)).reply.unwrap();
        assert_eq!(read_u16(&r), 0);
        let len = u32::from_le_bytes([r[2], r[3], r[4], r[5]]) as usize;
        assert_eq!(&r[6..6 + len], b"HELLO");

        // a exits → b's next receive is EOF (zero-length).
        k.service_syscall(a, &proc_exit_req(0));
        let eof = k.service_syscall(b, &chan_recv_req(id)).reply.unwrap();
        assert_eq!(read_u16(&eof), 0);
        assert_eq!(u32::from_le_bytes([eof[2], eof[3], eof[4], eof[5]]), 0);

        // A process cannot receive on a channel it never opened.
        let c = k.spawn("c", None, false, false, false);
        assert_eq!(read_u16(&k.service_syscall(c, &chan_recv_req(id)).reply.unwrap()), 8); // BADF
    }

    // --- M4-T4: shared memory through the kernel core ---

    fn shm_create_req(size: u32) -> Vec<u8> {
        let mut v = vec![0x35u8];
        v.extend_from_slice(&size.to_le_bytes());
        v
    }
    fn shm_read_req(id: u32, off: u32, len: u32) -> Vec<u8> {
        let mut v = vec![0x37u8];
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(&off.to_le_bytes());
        v.extend_from_slice(&len.to_le_bytes());
        v
    }
    fn shm_write_req(id: u32, off: u32, data: &[u8]) -> Vec<u8> {
        let mut v = vec![0x38u8];
        v.extend_from_slice(&id.to_le_bytes());
        v.extend_from_slice(&off.to_le_bytes());
        v.extend_from_slice(data);
        v
    }

    #[test]
    fn shm_create_grant_share_and_isolation_then_exit_frees() {
        let mut k = core();
        k.boot();
        let owner = k.spawn("owner", None, false, false, false);
        let peer = k.spawn("peer", None, false, false, false);

        // owner creates a region (reply [errno][shm_id]) and writes into it.
        let rc = k.service_syscall(owner, &shm_create_req(64)).reply.unwrap();
        assert_eq!(read_u16(&rc), 0);
        let id = u32::from_le_bytes([rc[2], rc[3], rc[4], rc[5]]);
        assert_eq!(read_u16(&k.service_syscall(owner, &shm_write_req(id, 8, b"SHARED-MEM")).reply.unwrap()), 0);

        // Default-deny: peer cannot map/read/write before being granted.
        let mut map_req = vec![0x36u8];
        map_req.extend_from_slice(&id.to_le_bytes());
        assert_eq!(read_u16(&k.service_syscall(peer, &map_req).reply.unwrap()), 76); // NOTCAPABLE
        assert_eq!(read_u16(&k.service_syscall(peer, &shm_read_req(id, 8, 10)).reply.unwrap()), 76);

        // A non-owner cannot grant; the owner can.
        let mut steal = vec![0x39u8];
        steal.extend_from_slice(&id.to_le_bytes());
        steal.extend_from_slice(&peer.to_le_bytes());
        assert_eq!(read_u16(&k.service_syscall(peer, &steal).reply.unwrap()), 76); // peer isn't owner
        let mut grant = vec![0x39u8];
        grant.extend_from_slice(&id.to_le_bytes());
        grant.extend_from_slice(&peer.to_le_bytes());
        assert_eq!(read_u16(&k.service_syscall(owner, &grant).reply.unwrap()), 0);

        // Now peer maps + reads exactly what the owner wrote (shared region).
        assert_eq!(read_u16(&k.service_syscall(peer, &map_req).reply.unwrap()), 0);
        let rr = k.service_syscall(peer, &shm_read_req(id, 8, 10)).reply.unwrap();
        assert_eq!(read_u16(&rr), 0);
        let n = u32::from_le_bytes([rr[2], rr[3], rr[4], rr[5]]) as usize;
        assert_eq!(&rr[6..6 + n], b"SHARED-MEM");

        // owner exits → region is freed; peer's access is revoked.
        k.service_syscall(owner, &proc_exit_req(0));
        assert_eq!(read_u16(&k.service_syscall(peer, &shm_read_req(id, 8, 10)).reply.unwrap()), 76);
    }

    // --- M4-T5: signals (SIGTERM cooperative + SIGKILL forceful) ---

    fn kill_req(target: u32, sig: u8) -> Vec<u8> {
        let mut v = vec![0x3Au8];
        v.extend_from_slice(&target.to_le_bytes());
        v.push(sig);
        v
    }

    #[test]
    fn signals_are_capability_gated_sigterm_wakes_sig_wait_sigkill_reaps() {
        let mut k = core();
        k.boot();
        let signaler = k.spawn("signaler", None, false, false, false);
        k.grant_signal(signaler); // process-control authority
        let victim = k.spawn("victim", None, false, false, false);
        let bystander = k.spawn("bystander", None, false, false, false);

        // Default-deny: a process without Signal cannot signal another.
        assert_eq!(read_u16(&k.service_syscall(bystander, &kill_req(victim, 15)).reply.unwrap()), 76); // NOTCAPABLE
        // Unknown pid → SRCH.
        assert_eq!(read_u16(&k.service_syscall(signaler, &kill_req(9999, 15)).reply.unwrap()), 71); // SRCH
        // Self-signalling is always allowed (no Signal cap required).
        assert_eq!(read_u16(&k.service_syscall(victim, &kill_req(victim, 15)).reply.unwrap()), 0);
        // (drain the self-delivered signal so the park test below starts clean)
        let drained = k.service_syscall(victim, &[0x3Bu8]).reply.unwrap();
        assert_eq!(read_u16(&drained), 0);

        // SIGTERM delivery wakes a process parked in sig_wait (zero-CPU path).
        assert!(k.service_syscall(victim, &[0x3Bu8]).reply.is_none()); // parks (no pending)
        let term = k.service_syscall(signaler, &kill_req(victim, 15));
        assert_eq!(read_u16(&term.reply.unwrap()), 0);
        assert_eq!(term.wakeups, vec![victim]); // the parked sig_wait is runnable
        let got = k.service_syscall(victim, &[0x3Bu8]).reply.unwrap(); // re-driven
        assert_eq!(read_u16(&got), 0);
        let count = u32::from_le_bytes([got[2], got[3], got[4], got[5]]) as usize;
        assert_eq!(&got[6..6 + count], &[15u8]); // SIGTERM observed

        // SIGKILL is forceful: the kernel zombifies the target and asks the host
        // to reap its worker.
        let killed = k.service_syscall(signaler, &kill_req(victim, 9));
        assert_eq!(read_u16(&killed.reply.unwrap()), 0);
        assert_eq!(killed.reap, vec![victim]);
        assert_eq!(
            k.list_procs().iter().find(|i| i.pid == victim).unwrap().state.as_str(),
            "zombie"
        );
    }

    // --- M5-T2: the emulator as a privileged (Native, non-ring) process ---

    #[test]
    fn emulator_is_a_killable_native_process_in_proc_list_and_isolated() {
        let mut k = core();
        k.boot();
        // A normal wasi process running alongside the emulator.
        let peer = k.spawn("peer", Some(("/", Rights::RW)), false, false, false);

        // Register the privileged emulator process.
        let emu = k.spawn_emulator("linux");
        assert_eq!(k.emulator_pid(), Some(emu));
        assert_eq!(k.proc_kind(emu), crate::types::ProcKind::Native);

        // It is a first-class PID in proc_list, shown running.
        let me = k.list_procs().into_iter().find(|i| i.pid == emu).unwrap();
        assert_eq!(me.state.as_str(), "running");
        assert_eq!(me.name, "linux");

        // The System Monitor (Signal-capable) reaps it from `top`.
        let mon = k.spawn("sysmon", None, false, false, false);
        k.grant_signal(mon);
        let killed = k.service_syscall(mon, &kill_req(emu, 9));
        assert_eq!(read_u16(&killed.reply.unwrap()), 0);
        assert_eq!(killed.reap, vec![emu]); // host tears down the emulator worker

        // The emulator is reaped; the unrelated peer is untouched (FR-6 isolation).
        let infos = k.list_procs();
        assert_eq!(infos.iter().find(|i| i.pid == emu).unwrap().state.as_str(), "zombie");
        assert_ne!(infos.iter().find(|i| i.pid == peer).unwrap().state.as_str(), "zombie");
    }
}

//! Scheduler scaffold (FR-3).
//!
//! Policy: **priority round-robin with per-process time accounting**, fully
//! deterministic. Higher `priority` value wins; within a priority level,
//! processes run in FIFO/round-robin order (the run loop re-enqueues a process
//! after its quantum, sending it to the back of its level's queue).
//!
//! At M0 there is no preemption timer and no WASM execution (that is the M1
//! runtime); this is the scheduling *decision* machinery — ready queues, the
//! pick policy, blocking, and time accounting — exercised live by `boot()` and
//! by unit tests with synthetic PIDs.

use std::collections::{BTreeMap, HashMap, VecDeque};

#[derive(Default)]
pub struct Scheduler {
    /// Ready queues keyed by priority. BTreeMap keeps levels ordered so the
    /// highest priority is found deterministically.
    ready: BTreeMap<u8, VecDeque<u32>>,
    /// Accumulated CPU ticks per process (time accounting).
    time: HashMap<u32, u64>,
}

impl Scheduler {
    pub fn new() -> Self {
        Self { ready: BTreeMap::new(), time: HashMap::new() }
    }

    /// Add a process to the ready set at the given priority (FIFO at its level).
    pub fn enqueue(&mut self, pid: u32, priority: u8) {
        self.ready.entry(priority).or_default().push_back(pid);
    }

    /// Pick the next process to run: highest non-empty priority level, FIFO
    /// within it. Returns `None` when nothing is ready.
    pub fn next(&mut self) -> Option<u32> {
        // Highest priority first (BTreeMap iterates ascending; reverse it).
        let prio = *self
            .ready
            .iter()
            .rev()
            .find(|(_, q)| !q.is_empty())
            .map(|(p, _)| p)?;
        let pid = self.ready.get_mut(&prio).and_then(|q| q.pop_front());
        // Drop now-empty levels to keep iteration cheap.
        if self.ready.get(&prio).is_some_and(|q| q.is_empty()) {
            self.ready.remove(&prio);
        }
        pid
    }

    /// Remove a process from the ready set (e.g. it blocked on I/O).
    pub fn block(&mut self, pid: u32) {
        for q in self.ready.values_mut() {
            q.retain(|&p| p != pid);
        }
        self.ready.retain(|_, q| !q.is_empty());
    }

    /// Charge `ticks` of CPU time to a process.
    pub fn account(&mut self, pid: u32, ticks: u64) {
        *self.time.entry(pid).or_insert(0) += ticks;
    }

    pub fn time_of(&self, pid: u32) -> u64 {
        *self.time.get(&pid).unwrap_or(&0)
    }

    /// Total number of processes currently ready to run.
    pub fn ready_len(&self) -> usize {
        self.ready.values().map(|q| q.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_robin_within_a_priority_level_is_fifo() {
        let mut s = Scheduler::new();
        s.enqueue(1, 5);
        s.enqueue(2, 5);
        s.enqueue(3, 5);
        assert_eq!(s.next(), Some(1));
        assert_eq!(s.next(), Some(2));
        // Re-enqueue 1 (ran its quantum) — it goes to the back: round-robin.
        s.enqueue(1, 5);
        assert_eq!(s.next(), Some(3));
        assert_eq!(s.next(), Some(1));
        assert_eq!(s.next(), None);
    }

    #[test]
    fn higher_priority_is_preferred() {
        let mut s = Scheduler::new();
        s.enqueue(10, 1); // low priority
        s.enqueue(20, 9); // high priority
        s.enqueue(11, 1);
        assert_eq!(s.next(), Some(20)); // high first
        assert_eq!(s.next(), Some(10)); // then low, FIFO
        assert_eq!(s.next(), Some(11));
    }

    #[test]
    fn blocking_removes_from_ready() {
        let mut s = Scheduler::new();
        s.enqueue(1, 5);
        s.enqueue(2, 5);
        s.block(1);
        assert_eq!(s.ready_len(), 1);
        assert_eq!(s.next(), Some(2));
        assert_eq!(s.next(), None);
    }

    #[test]
    fn time_accounting_accumulates_per_process() {
        let mut s = Scheduler::new();
        s.account(7, 3);
        s.account(7, 4);
        s.account(8, 1);
        assert_eq!(s.time_of(7), 7);
        assert_eq!(s.time_of(8), 1);
        assert_eq!(s.time_of(999), 0); // never-run pid
    }

    #[test]
    fn schedules_at_least_32_concurrent_processes() {
        let mut s = Scheduler::new();
        for pid in 1..=40 {
            s.enqueue(pid, 5);
        }
        assert_eq!(s.ready_len(), 40);
        let mut drained = Vec::new();
        while let Some(pid) = s.next() {
            drained.push(pid);
        }
        assert_eq!(drained.len(), 40);
        assert_eq!(drained, (1..=40).collect::<Vec<_>>()); // deterministic FIFO order
    }
}

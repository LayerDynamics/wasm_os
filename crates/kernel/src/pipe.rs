//! Kernel pipes (shell and userland) — bounded byte buffers connecting one process's output to
//! another's input. Blocking semantics (empty read, full write) are realized
//! through the park/resume machinery (see `WaitReason::PipeRead/PipeWrite`): the
//! syscall router parks the guest and a later read/write/close returns the
//! parked pids in its wakeup list.

use std::collections::{BTreeMap, VecDeque};

/// Default pipe capacity (bytes). A full pipe parks the writer (backpressure).
pub const PIPE_CAPACITY: usize = 64 * 1024;

struct Pipe {
    buf: VecDeque<u8>,
    capacity: usize,
    readers: u32,
    writers: u32,
}

#[derive(Default)]
pub struct PipeTable {
    pipes: BTreeMap<u32, Pipe>,
    next_id: u32,
}

impl PipeTable {
    pub fn new() -> Self {
        Self { pipes: BTreeMap::new(), next_id: 1 }
    }

    /// Create a pipe with one reader and one writer; returns its id.
    pub fn create(&mut self) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.pipes.insert(
            id,
            Pipe { buf: VecDeque::new(), capacity: PIPE_CAPACITY, readers: 1, writers: 1 },
        );
        id
    }

    pub fn exists(&self, id: u32) -> bool {
        self.pipes.contains_key(&id)
    }

    pub fn buf_len(&self, id: u32) -> usize {
        self.pipes.get(&id).map(|p| p.buf.len()).unwrap_or(0)
    }

    pub fn space(&self, id: u32) -> usize {
        self.pipes.get(&id).map(|p| p.capacity - p.buf.len()).unwrap_or(0)
    }

    pub fn write_open(&self, id: u32) -> bool {
        self.pipes.get(&id).map(|p| p.writers > 0).unwrap_or(false)
    }

    pub fn read_open(&self, id: u32) -> bool {
        self.pipes.get(&id).map(|p| p.readers > 0).unwrap_or(false)
    }

    /// Drain up to `max` bytes from the front of the pipe.
    pub fn read(&mut self, id: u32, max: usize) -> Vec<u8> {
        match self.pipes.get_mut(&id) {
            Some(p) => {
                let n = max.min(p.buf.len());
                p.buf.drain(..n).collect()
            }
            None => Vec::new(),
        }
    }

    /// Append up to the remaining capacity; returns the number of bytes written.
    pub fn write(&mut self, id: u32, data: &[u8]) -> usize {
        match self.pipes.get_mut(&id) {
            Some(p) => {
                let space = p.capacity - p.buf.len();
                let n = space.min(data.len());
                p.buf.extend(data[..n].iter().copied());
                n
            }
            None => 0,
        }
    }

    pub fn add_reader(&mut self, id: u32) {
        if let Some(p) = self.pipes.get_mut(&id) {
            p.readers += 1;
        }
    }
    pub fn add_writer(&mut self, id: u32) {
        if let Some(p) = self.pipes.get_mut(&id) {
            p.writers += 1;
        }
    }

    /// Close one read end. Returns true if the last reader closed.
    pub fn close_reader(&mut self, id: u32) -> bool {
        if let Some(p) = self.pipes.get_mut(&id) {
            p.readers = p.readers.saturating_sub(1);
            let last = p.readers == 0;
            self.gc(id);
            last
        } else {
            false
        }
    }

    /// Close one write end. Returns true if the last writer closed (readers see EOF).
    pub fn close_writer(&mut self, id: u32) -> bool {
        if let Some(p) = self.pipes.get_mut(&id) {
            p.writers = p.writers.saturating_sub(1);
            let last = p.writers == 0;
            self.gc(id);
            last
        } else {
            false
        }
    }

    /// Drop a fully-closed, drained pipe.
    fn gc(&mut self, id: u32) {
        if let Some(p) = self.pipes.get(&id) {
            if p.readers == 0 && p.writers == 0 {
                self.pipes.remove(&id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_write_read_roundtrip() {
        let mut t = PipeTable::new();
        let id = t.create();
        assert_eq!(t.write(id, b"hello"), 5);
        assert_eq!(t.buf_len(id), 5);
        assert_eq!(t.read(id, 3), b"hel");
        assert_eq!(t.read(id, 10), b"lo");
        assert_eq!(t.buf_len(id), 0);
    }

    #[test]
    fn capacity_bounds_writes_for_backpressure() {
        let mut t = PipeTable::new();
        let id = t.create();
        let big = vec![0u8; PIPE_CAPACITY + 100];
        assert_eq!(t.write(id, &big), PIPE_CAPACITY); // partial write up to capacity
        assert_eq!(t.space(id), 0);
        assert_eq!(t.write(id, b"x"), 0); // full → nothing written (writer would park)
    }

    #[test]
    fn last_writer_close_is_eof_signal() {
        let mut t = PipeTable::new();
        let id = t.create();
        assert!(t.close_writer(id)); // the only writer closed → readers get EOF
        assert!(!t.write_open(id));
        assert!(t.read_open(id)); // reader still open; pipe not gc'd (reader present)
    }

    #[test]
    fn fully_closed_drained_pipe_is_removed() {
        let mut t = PipeTable::new();
        let id = t.create();
        t.close_writer(id);
        t.close_reader(id);
        assert!(!t.exists(id));
    }
}

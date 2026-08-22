//! Message channels (process control and IPC) — named, bidirectional message queues between two
//! processes. Unlike a pipe (a byte stream), a channel preserves message
//! boundaries and both endpoints can send + receive. Rendezvous is by name: the
//! first `chan_open(name)` creates the channel (endpoint 0); the second connects
//! (endpoint 1). Blocking `recv` is realized through the shell and userland park/resume machinery
//! (`WaitReason::ChanRecv`); a closed peer with a drained inbox is EOF.

use std::collections::{BTreeMap, VecDeque};

#[derive(Default)]
struct Endpoint {
    inbox: VecDeque<Vec<u8>>,
    open: bool,
}

struct Channel {
    ends: [Endpoint; 2],
    /// True until the second endpoint connects (a peer may still appear).
    pending: bool,
}

#[derive(Default)]
pub struct ChannelTable {
    chans: BTreeMap<u32, Channel>,
    by_name: BTreeMap<String, u32>,
    next_id: u32,
}

impl ChannelTable {
    pub fn new() -> Self {
        Self { chans: BTreeMap::new(), by_name: BTreeMap::new(), next_id: 1 }
    }

    /// Open a channel by name. The first opener creates it and gets endpoint 0;
    /// the second connects and gets endpoint 1. Returns `(chan_id, end)`.
    pub fn open(&mut self, name: &str) -> (u32, u8) {
        if let Some(&id) = self.by_name.get(name) {
            self.by_name.remove(name); // fully connected — no longer a rendezvous
            if let Some(c) = self.chans.get_mut(&id) {
                c.ends[1].open = true;
                c.pending = false;
            }
            (id, 1)
        } else {
            let id = self.next_id;
            self.next_id += 1;
            let mut ends: [Endpoint; 2] = Default::default();
            ends[0].open = true;
            self.chans.insert(id, Channel { ends, pending: true });
            self.by_name.insert(name.to_string(), id);
            (id, 0)
        }
    }

    pub fn exists(&self, id: u32) -> bool {
        self.chans.contains_key(&id)
    }

    /// Send a message from `end` to the PEER endpoint's inbox. Returns false if
    /// the peer is permanently gone (closed and not pending) — an EPIPE.
    pub fn send(&mut self, id: u32, end: u8, msg: Vec<u8>) -> bool {
        let peer = 1 - end as usize;
        match self.chans.get_mut(&id) {
            Some(c) => {
                if !c.ends[peer].open && !c.pending {
                    return false; // peer will never read — EPIPE
                }
                c.ends[peer].inbox.push_back(msg);
                true
            }
            None => false,
        }
    }

    /// Pop one message from `end`'s own inbox, or `None` if empty.
    pub fn recv(&mut self, id: u32, end: u8) -> Option<Vec<u8>> {
        self.chans.get_mut(&id).and_then(|c| c.ends[end as usize].inbox.pop_front())
    }

    pub fn inbox_len(&self, id: u32, end: u8) -> usize {
        self.chans.get(&id).map(|c| c.ends[end as usize].inbox.len()).unwrap_or(0)
    }

    /// Whether the peer of `end` is still around (open, or pending a connection).
    /// When false and the inbox is empty, a receive is EOF.
    pub fn peer_open(&self, id: u32, end: u8) -> bool {
        self.chans
            .get(&id)
            .map(|c| {
                let peer = 1 - end as usize;
                c.ends[peer].open || c.pending
            })
            .unwrap_or(false)
    }

    /// Close one endpoint. Drops a fully-closed, drained channel.
    pub fn close(&mut self, id: u32, end: u8) {
        if let Some(c) = self.chans.get_mut(&id) {
            c.ends[end as usize].open = false;
            // A still-pending channel never found its peer. If its creator (endpoint
            // 0) gives up, drop the channel and release its name — otherwise gc keeps
            // it forever (gc only collects non-pending channels) and a later opener
            // of the same name would connect to the dead endpoint instead of starting
            // fresh.
            if c.pending && end == 0 && c.ends[1].inbox.is_empty() {
                self.chans.remove(&id);
                self.by_name.retain(|_, v| *v != id);
                return;
            }
        }
        self.gc(id);
    }

    fn gc(&mut self, id: u32) {
        let drop = self.chans.get(&id).is_some_and(|c| {
            !c.pending
                && !c.ends[0].open
                && !c.ends[1].open
                && c.ends[0].inbox.is_empty()
                && c.ends[1].inbox.is_empty()
        });
        if drop {
            self.chans.remove(&id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rendezvous_connects_two_endpoints() {
        let mut t = ChannelTable::new();
        let (id_a, end_a) = t.open("demo");
        assert_eq!(end_a, 0);
        let (id_b, end_b) = t.open("demo");
        assert_eq!(id_b, id_a);
        assert_eq!(end_b, 1);
        // A third opener of the same name starts a NEW channel (rendezvous consumed).
        let (id_c, end_c) = t.open("demo");
        assert_ne!(id_c, id_a);
        assert_eq!(end_c, 0);
    }

    #[test]
    fn send_goes_to_peer_inbox_both_directions() {
        let mut t = ChannelTable::new();
        let (id, _) = t.open("c");
        t.open("c");
        // end 0 → end 1
        assert!(t.send(id, 0, b"a->b".to_vec()));
        assert_eq!(t.inbox_len(id, 1), 1);
        assert_eq!(t.recv(id, 1).unwrap(), b"a->b");
        // end 1 → end 0
        assert!(t.send(id, 1, b"b->a".to_vec()));
        assert_eq!(t.recv(id, 0).unwrap(), b"b->a");
    }

    #[test]
    fn buffered_message_survives_sender_close_then_eof() {
        let mut t = ChannelTable::new();
        let (id, _) = t.open("c");
        t.send(id, 0, b"buffered".to_vec()); // sent before peer connects (pending)
        t.open("c"); // peer connects
        t.close(id, 0); // sender closes
        // The buffered message is still delivered...
        assert_eq!(t.recv(id, 1).unwrap(), b"buffered");
        // ...and then the receiver sees EOF (peer gone, inbox drained).
        assert!(!t.peer_open(id, 1));
        assert!(t.recv(id, 1).is_none());
    }

    #[test]
    fn buffered_message_survives_sender_exit_before_peer_connects() {
        let mut t = ChannelTable::new();
        let (id, end) = t.open("late-peer");
        assert_eq!(end, 0);
        assert!(t.send(id, end, b"buffered-before-connect".to_vec()));

        // The creator can exit before the peer has finished starting. Keep the
        // rendezvous alive because its peer inbox already contains a message.
        t.close(id, end);
        let (peer_id, peer_end) = t.open("late-peer");
        assert_eq!(peer_id, id);
        assert_eq!(peer_end, 1);
        assert_eq!(t.recv(peer_id, peer_end).unwrap(), b"buffered-before-connect");
    }

    #[test]
    fn abandoned_pending_rendezvous_is_dropped_on_creator_close() {
        let mut t = ChannelTable::new();
        let (id, end) = t.open("solo");
        assert_eq!(end, 0);
        t.close(id, 0); // creator gives up before any peer connects
        assert!(!t.exists(id), "abandoned pending channel must be dropped");
        // The name is freed: a later opener starts a brand-new channel as endpoint 0.
        let (id2, end2) = t.open("solo");
        assert_ne!(id2, id);
        assert_eq!(end2, 0);
    }

    #[test]
    fn send_to_a_fully_closed_peer_is_epipe() {
        let mut t = ChannelTable::new();
        let (id, _) = t.open("c");
        t.open("c");
        t.close(id, 1); // peer end closed
        assert!(!t.send(id, 0, b"x".to_vec())); // EPIPE
    }
}

//! chandemo — M4-T3 message-channel fixture.
//!
//! Two instances rendezvous on the channel named "demo". The first opener (the
//! creator, endpoint 0) sends a message; the second (endpoint 1) receives it and
//! writes it to `/home/chan-out.txt` so an E2E can verify cross-process delivery.
//! Works in any spawn order — whoever opens first is the sender.

use wasmos_sys::{chan_open, chan_recv, chan_send};

const MESSAGE: &[u8] = b"HELLO-OVER-CHANNEL";

fn main() {
    let (id, end) = match chan_open("demo") {
        Ok(v) => v,
        Err(_) => std::process::exit(1),
    };
    if end == 0 {
        // Creator → sender.
        let _ = chan_send(id, MESSAGE);
    } else {
        // Connector → receiver: persist what arrived for the test to read.
        if let Ok(msg) = chan_recv(id) {
            let _ = std::fs::write("/home/chan-out.txt", &msg);
        }
    }
}

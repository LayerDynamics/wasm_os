//! Deterministic emitter for wasm objects. The non-data sections are fixed bytes;
//! only the memory page count, data segment length/bytes, and wob0 vary by tier.

use crate::format::{leb_u32, section, Header, Tier};

/// Emit a fresh wasm object at `tier`, window pre-filled with 0x20 and content_len 0.
pub fn mint(tier: Tier, content_type: u8) -> Vec<u8> {
    let capacity = tier.bytes();
    // Window lives in linear memory at offset 256; ensure enough pages for it
    // (>= 1 always, since 256 + capacity > 0).
    let pages = (256 + capacity).div_ceil(0x10000);

    let mut out = Vec::new();
    out.extend_from_slice(b"\0asm");
    out.extend_from_slice(&1u32.to_le_bytes());

    // --- type section (id 1): type0 = (i32 i32 i32 i32)->i32 ; type1 = ()->()
    let type_payload = [
        0x02, // 2 types
        0x60, 0x04, 0x7f, 0x7f, 0x7f, 0x7f, 0x01, 0x7f, // fd_write
        0x60, 0x00, 0x00, // _start
    ];
    section(1, &type_payload, &mut out);

    // --- import section (id 2): wasi_snapshot_preview1.fd_write : func type0
    let mut imp = Vec::new();
    imp.push(0x01); // 1 import
    let module = b"wasi_snapshot_preview1";
    leb_u32(module.len() as u32, &mut imp);
    imp.extend_from_slice(module);
    let field = b"fd_write";
    leb_u32(field.len() as u32, &mut imp);
    imp.extend_from_slice(field);
    imp.push(0x00); // import kind: func
    leb_u32(0, &mut imp); // type index 0
    section(2, &imp, &mut out);

    // --- function section (id 3): one local func, type1
    section(3, &[0x01, 0x01], &mut out);

    // --- memory section (id 5): 1 memory, min = pages
    let mut mem = Vec::new();
    mem.push(0x01); // 1 memory
    mem.push(0x00); // limits: min only
    leb_u32(pages, &mut mem);
    section(5, &mem, &mut out);

    // --- export section (id 7): "memory" mem0 ; "_start" func1
    let mut exp = Vec::new();
    exp.push(0x02);
    leb_u32(6, &mut exp);
    exp.extend_from_slice(b"memory");
    exp.push(0x02);
    leb_u32(0, &mut exp);
    leb_u32(6, &mut exp);
    exp.extend_from_slice(b"_start");
    exp.push(0x00);
    leb_u32(1, &mut exp);
    section(7, &exp, &mut out);

    // --- code section (id 10): _start body (FIXED, content-independent)
    // (i32.store 16 260)            ; iov.buf = window_data_start (256+4)
    // (i32.store 20 (i32.load 256)) ; iov.len = content_len (in-band)
    // (call fd_write 1 16 1 8) drop ; write iovec[16] to fd 1, nwritten @ 8
    let body: &[u8] = &[
        0x00, // 0 locals
        0x41, 0x10, 0x41, 0x84, 0x02, 0x36, 0x02, 0x00, // store buf=260 @16
        0x41, 0x14, 0x41, 0x80, 0x02, 0x28, 0x02, 0x00, 0x36, 0x02, 0x00, // store len=*256 @20
        0x41, 0x01, 0x41, 0x10, 0x41, 0x01, 0x41, 0x08, 0x10, 0x00, 0x1a, // call fd_write; drop
        0x0b, // end
    ];
    let mut code = Vec::new();
    code.push(0x01); // 1 function body
    leb_u32(body.len() as u32, &mut code);
    code.extend_from_slice(body);
    section(10, &code, &mut out);

    // --- data section (id 11): 1 active segment @ i32.const 256
    let mut data = Vec::new();
    data.push(0x01); // 1 segment
    data.push(0x00); // active, memidx 0
    data.extend_from_slice(&[0x41, 0x80, 0x02, 0x0b]); // i32.const 256; end
    leb_u32(capacity, &mut data); // segment byte length
    // Offset of the window bytes WITHIN the data payload (after the 6-byte preamble
    // + the LEB capacity), captured right before appending the window:
    let window_start_in_data = data.len();
    let mut window = vec![0x20u8; capacity as usize];
    window[0..4].copy_from_slice(&0u32.to_le_bytes()); // content_len = 0
    data.extend_from_slice(&window);
    // section() prepends: 1 id byte + LEB(payload len). The window's FILE offset is
    // therefore: current out.len() + 1 (id) + LEB(data.len()).len() + window_start_in_data.
    let mut leb_len = Vec::new();
    leb_u32(data.len() as u32, &mut leb_len);
    let window_offset = (out.len() + 1 + leb_len.len() + window_start_in_data) as u32;
    section(11, &data, &mut out);

    // --- custom section (id 0): "wob0" header
    let header = Header {
        version: 1,
        window_offset,
        capacity,
        content_len: 0,
        content_type,
    };
    let mut custom = Vec::new();
    leb_u32(4, &mut custom);
    custom.extend_from_slice(b"wob0");
    custom.extend_from_slice(&header.encode());
    section(0, &custom, &mut out);

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::format::{locate, Tier};

    #[test]
    fn mint_is_locatable_blank_and_well_formed() {
        let obj = mint(Tier::K4, 0);
        let loc = locate(&obj).expect("locatable");
        assert_eq!(loc.header.capacity, 4096);
        assert_eq!(loc.header.content_len, 0);
        assert_eq!(loc.header.content_type, 0);
        // window starts at window_offset; first 4 bytes are the in-band len (0), rest 0x20.
        let w = loc.header.window_offset as usize;
        assert_eq!(&obj[w..w + 4], &0u32.to_le_bytes());
        assert!(obj[w + 4..w + 4096].iter().all(|&b| b == 0x20));
    }

    #[test]
    fn mint_validates_with_wasmparser() {
        for t in Tier::ALL {
            let obj = mint(t, 0);
            wasmparser::Validator::new_with_features(wasmparser::WasmFeatures::default())
                .validate_all(&obj)
                .unwrap_or_else(|e| panic!("tier {:?} invalid: {e}", t));
        }
    }
}

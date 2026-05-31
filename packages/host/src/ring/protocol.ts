/**
 * JS side of the syscall wire format — the exact mirror of
 * `crates/kernel/src/syscall.rs`. The process worker's WASI shim encodes
 * requests with {@link Writer} and decodes responses with {@link Reader}; the
 * kernel router (Rust) speaks the same little-endian, length-prefixed bytes.
 *
 * Keeping this in one module means the two ends of the ABI never drift by hand.
 */

/** Syscall opcodes (request byte 0) — must match `syscall::Op`. */
export const OP = {
  FD_WRITE: 0x01,
  FD_READ: 0x02,
  FD_SEEK: 0x03,
  FD_CLOSE: 0x04,
  PATH_OPEN: 0x05,
  FD_READDIR: 0x06,
  FD_PRESTAT_GET: 0x07,
  FD_PRESTAT_DIR_NAME: 0x08,
  FD_FDSTAT_GET: 0x09,
  ENVIRON_SIZES_GET: 0x0a,
  ENVIRON_GET: 0x0b,
  ARGS_SIZES_GET: 0x0c,
  ARGS_GET: 0x0d,
  RANDOM_GET: 0x0e,
  CLOCK_TIME_GET: 0x0f,
  PROC_EXIT: 0x10,
  PATH_CREATE_DIRECTORY: 0x11,
  PATH_UNLINK_FILE: 0x12,
  PATH_REMOVE_DIRECTORY: 0x13,
  PATH_RENAME: 0x14,
  PATH_FILESTAT_GET: 0x15,
} as const;

/** WASI Preview 1 errno values (subset) — must match `syscall::errno`. */
export const ERRNO = {
  SUCCESS: 0,
  ACCES: 2,
  BADF: 8,
  INVAL: 28,
  NOENT: 44,
  NOSYS: 52,
  NOTDIR: 54,
  NOTCAPABLE: 76,
} as const;

/** Builds a little-endian request buffer (mirrors the Rust `Writer`). */
export class Writer {
  private buf: number[] = [];

  u8(v: number): this {
    this.buf.push(v & 0xff);
    return this;
  }
  u16(v: number): this {
    return this.u8(v).u8(v >>> 8);
  }
  u32(v: number): this {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  u64(v: bigint): this {
    let x = BigInt.asUintN(64, v);
    for (let i = 0; i < 8; i++) {
      this.u8(Number(x & 0xffn));
      x >>= 8n;
    }
    return this;
  }
  i64(v: bigint): this {
    return this.u64(v);
  }
  bytes(b: Uint8Array): this {
    this.u32(b.length);
    for (let i = 0; i < b.length; i++) this.buf.push(b[i] as number);
    return this;
  }
  build(): Uint8Array {
    return Uint8Array.from(this.buf);
  }
}

/** Parses a little-endian response buffer (mirrors the Rust `Reader`). */
export class Reader {
  private dv: DataView;
  private pos = 0;

  constructor(private b: Uint8Array) {
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  u8(): number {
    const v = this.dv.getUint8(this.pos);
    this.pos += 1;
    return v;
  }
  u16(): number {
    const v = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return v;
  }
  u32(): number {
    const v = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  u64(): bigint {
    const v = this.dv.getBigUint64(this.pos, true);
    this.pos += 8;
    return v;
  }
  bytes(): Uint8Array {
    const n = this.u32();
    const s = this.b.subarray(this.pos, this.pos + n);
    this.pos += n;
    return s;
  }
}

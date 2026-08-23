/**
 * Hand-written `wasi_snapshot_preview1` shim for guest processes (WASI process runtime).
 *
 * This is the ONLY place guest linear memory is touched. Each WASI call reads
 * its pointer/length arguments out of the guest's memory, marshals the resolved
 * values through the SAB syscall ring to the kernel, and scatters any result
 * back into guest memory. The kernel never sees a guest pointer (see
 * `crates/kernel/src/syscall.rs`).
 *
 * The guest is a stock Rust `wasm32-wasip1` binary importing standard WASI —
 * no generated stubs, no Component Model on the guest path.
 */
import type { RingClient } from "../ring/guest.js";
import { OP, ERRNO, Reader, Writer } from "../ring/protocol.js";
import { REQ_CAP, RESP_CAP } from "../ring/layout.js";

/**
 * Max bytes moved through the SAB ring in one fd_read/fd_write. The ring request
 * and response buffers are bounded (REQ_CAP/RESP_CAP), so a single syscall caps
 * its payload and reports a SHORT read/write; libc's `read`/`write_all` then loop
 * for the remainder. Without this, a large write (e.g. saving a framebuffer)
 * overflows the ring and silently writes nothing.
 */
const MAX_IO_BYTES = Math.min(REQ_CAP, RESP_CAP) - 64;

/** Thrown to unwind the guest when it calls `proc_exit`. */
export class ProcExit extends Error {
  constructor(public readonly code: number) {
    super(`proc_exit(${code})`);
    this.name = "ProcExit";
  }
}

type Wasi = Record<string, (...args: never[]) => unknown>;

/**
 * Build the `wasi_snapshot_preview1` import object. `getMemory` is called lazily
 * (the guest's exported memory only exists after instantiation, but no WASI
 * function runs until `_start`).
 */
export function makeWasiImports(getMemory: () => WebAssembly.Memory, ring: RingClient): Wasi {
  const td = new TextDecoder();
  const te = new TextEncoder();

  const dv = (): DataView => new DataView(getMemory().buffer);
  const u8 = (): Uint8Array => new Uint8Array(getMemory().buffer);

  /** Read an array of `(buf, len)` iovecs from guest memory. */
  function readIovs(ptr: number, len: number): Array<{ buf: number; len: number }> {
    const view = dv();
    const out: Array<{ buf: number; len: number }> = [];
    for (let i = 0; i < len; i++) {
      const o = ptr + i * 8;
      out.push({ buf: view.getUint32(o, true), len: view.getUint32(o + 4, true) });
    }
    return out;
  }

  // --- poll_oneoff support (real, host-side) ---------------------------------
  // A private SAB used to block this dedicated worker thread for a relative
  // duration via Atomics.wait (the same primitive the syscall ring uses). It is
  // never notified, so the wait always times out after the requested ms.
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  const sleepMs = (ms: number): void => {
    if (ms > 0) Atomics.wait(sleepCell, 0, 0, ms);
  };
  // Ask the kernel whether an fd would read/write without blocking right now.
  const fdReady = (fd: number, writable: boolean): { errno: number; ready: boolean; nbytes: bigint } => {
    const resp = new Reader(ring.call(new Writer().u8(OP.FD_READY).u32(fd).u8(writable ? 1 : 0).build()));
    return { errno: resp.u16(), ready: resp.u8() !== 0, nbytes: resp.u64() };
  };
  // Current value of a WASI clock in nanoseconds (REALTIME = epoch; else monotonic).
  // The scaling is done in BigInt: `ms * 1e6` (~1.8e18 for an epoch timestamp) is
  // ~200x Number.MAX_SAFE_INTEGER, so computing it in float64 would quantize the
  // result to ~256 ns and add rounding noise. Splitting into whole/fractional
  // milliseconds preserves the sub-microsecond resolution performance.now() offers.
  const clockNowNs = (clockId: number): bigint => {
    const ms = clockId === 0 ? performance.timeOrigin + performance.now() : performance.now();
    const whole = Math.trunc(ms);
    return BigInt(whole) * 1_000_000n + BigInt(Math.round((ms - whole) * 1e6));
  };

  /** Resolve WASI filestat timestamp flags while the runtime still has a real clock. */
  const resolveFileTimes = (atim: bigint, mtim: bigint, flags: number): [bigint, bigint, number] | undefined => {
    const ATIM = 1;
    const MTIM = 2;
    const ATIM_NOW = 4;
    const MTIM_NOW = 8;
    if ((flags & ATIM) !== 0 && (flags & ATIM_NOW) !== 0) return undefined;
    if ((flags & MTIM) !== 0 && (flags & MTIM_NOW) !== 0) return undefined;
    const now = clockNowNs(1);
    const a = flags & ATIM_NOW ? now : atim;
    const m = flags & MTIM_NOW ? now : mtim;
    return [a, m, (flags & ATIM_NOW ? ATIM : 0) | (flags & MTIM_NOW ? MTIM : 0) | (flags & (ATIM | MTIM))];
  };

  const handlers: Wasi = {
    clock_res_get(clockId: number, resolutionPtr: number): number {
      // Browser clocks are monotonic at the host boundary. Report nanosecond
      // resolution, which is the unit WASI requires; clock_time_get still
      // returns the actual value from the browser clock.
      if (clockId > 3) return ERRNO.INVAL;
      dv().setBigUint64(resolutionPtr, 1n, true);
      return ERRNO.SUCCESS;
    },

    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const iovs = readIovs(iovsPtr, iovsLen);
      const mem = u8();
      const total = iovs.reduce((n, v) => n + v.len, 0);
      // Send at most one ring-payload worth; report a short write so libc loops.
      const cap = Math.min(total, MAX_IO_BYTES);
      const data = new Uint8Array(cap);
      let off = 0;
      for (const v of iovs) {
        if (off >= cap) break;
        const take = Math.min(v.len, cap - off);
        data.set(mem.subarray(v.buf, v.buf + take), off);
        off += take;
      }
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_WRITE).u32(fd).bytes(data).build()));
      const errno = resp.u16();
      const nwritten = resp.u32();
      dv().setUint32(nwrittenPtr, nwritten, true);
      return errno;
    },

    fd_pread(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nreadPtr: number): number {
      const iovs = readIovs(iovsPtr, iovsLen);
      const want = Math.min(iovs.reduce((n, v) => n + v.len, 0), MAX_IO_BYTES);
      const resp = new Reader(
        ring.call(new Writer().u8(OP.FD_PREAD).u32(fd).u64(offset).u32(want).build()),
      );
      const errno = resp.u16();
      const data = resp.bytes();
      const mem = u8();
      let off = 0;
      for (const iov of iovs) {
        const n = Math.min(iov.len, data.length - off);
        if (n <= 0) break;
        mem.set(data.subarray(off, off + n), iov.buf);
        off += n;
      }
      dv().setUint32(nreadPtr, off, true);
      return errno;
    },

    fd_pwrite(fd: number, iovsPtr: number, iovsLen: number, offset: bigint, nwrittenPtr: number): number {
      const iovs = readIovs(iovsPtr, iovsLen);
      const cap = Math.min(iovs.reduce((n, v) => n + v.len, 0), MAX_IO_BYTES);
      const data = new Uint8Array(cap);
      const mem = u8();
      let off = 0;
      for (const iov of iovs) {
        if (off >= cap) break;
        const n = Math.min(iov.len, cap - off);
        data.set(mem.subarray(iov.buf, iov.buf + n), off);
        off += n;
      }
      const resp = new Reader(
        ring.call(new Writer().u8(OP.FD_PWRITE).u32(fd).u64(offset).bytes(data).build()),
      );
      const errno = resp.u16();
      dv().setUint32(nwrittenPtr, resp.u32(), true);
      return errno;
    },

    fd_advise(fd: number, _offset: bigint, _len: bigint, _advice: number): number {
      // The browser-backed VFS has no page cache hint to tune. Validate the fd
      // through the kernel so callers still get EBADF/other descriptor errors.
      return new Reader(ring.call(new Writer().u8(OP.FD_FDSTAT_GET).u32(fd).build())).u16();
    },

    fd_allocate(fd: number, offset: bigint, len: bigint): number {
      // Allocation is meaningful here as guaranteeing the requested file range
      // exists. The kernel's bounded resize path supplies the same sparse-file
      // semantics without pretending the browser exposes block allocation.
      const stat = new Reader(ring.call(new Writer().u8(OP.FD_FILESTAT_GET).u32(fd).build()));
      const statErrno = stat.u16();
      if (statErrno !== ERRNO.SUCCESS) return statErrno;
      stat.u8();
      const size = stat.u64();
      const end = offset + len;
      if (end <= size) return ERRNO.SUCCESS;
      return new Reader(
        ring.call(new Writer().u8(OP.FD_FILESTAT_SET_SIZE).u32(fd).u64(end).build()),
      ).u16();
    },

    fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const iovs = readIovs(iovsPtr, iovsLen);
      const total = iovs.reduce((n, v) => n + v.len, 0);
      // Request at most one ring-payload worth; a short read makes libc loop for a
      // large file rather than overflow the response ring.
      const want = Math.min(total, MAX_IO_BYTES);
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_READ).u32(fd).u32(want).build()));
      const errno = resp.u16();
      const data = resp.bytes();
      const mem = u8();
      let off = 0;
      for (const v of iovs) {
        const n = Math.min(v.len, data.length - off);
        if (n <= 0) break;
        mem.set(data.subarray(off, off + n), v.buf);
        off += n;
      }
      dv().setUint32(nreadPtr, off, true);
      return errno;
    },

    fd_seek(fd: number, offset: bigint, whence: number, newoffsetPtr: number): number {
      const resp = new Reader(
        ring.call(new Writer().u8(OP.FD_SEEK).u32(fd).i64(offset).u8(whence).build()),
      );
      const errno = resp.u16();
      const newoff = resp.u64();
      dv().setBigUint64(newoffsetPtr, newoff, true);
      return errno;
    },

    fd_close(fd: number): number {
      return new Reader(ring.call(new Writer().u8(OP.FD_CLOSE).u32(fd).build())).u16();
    },

    fd_fdstat_set_flags(fd: number, flags: number): number {
      // Persist the fd-flags (e.g. O_APPEND) in the kernel so fd_fdstat_get reads
      // them back and fd_write honors them. Returns EBADF for an unknown fd.
      return new Reader(
        ring.call(new Writer().u8(OP.FD_FDSTAT_SET_FLAGS).u32(fd).u16(flags).build()),
      ).u16();
    },

    fd_filestat_get(fd: number, bufPtr: number): number {
      // Real type + size for the open fd from the kernel/VFS (regular files report
      // their true byte length). Scatter into the 64-byte WASI filestat.
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_FILESTAT_GET).u32(fd).build()));
      const errno = resp.u16();
      const filetype = resp.u8();
      const size = resp.u64();
      const atim = resp.u64();
      const mtim = resp.u64();
      const ctim = resp.u64();
      const view = dv();
      for (let i = 0; i < 64; i++) view.setUint8(bufPtr + i, 0);
      view.setUint8(bufPtr + 16, filetype); // fs_filetype
      view.setBigUint64(bufPtr + 24, 1n, true); // fs_nlink
      view.setBigUint64(bufPtr + 32, size, true); // fs_size
      view.setBigUint64(bufPtr + 40, atim, true);
      view.setBigUint64(bufPtr + 48, mtim, true);
      view.setBigUint64(bufPtr + 56, ctim, true);
      return errno;
    },

    fd_fdstat_get(fd: number, statPtr: number): number {
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_FDSTAT_GET).u32(fd).build()));
      const errno = resp.u16();
      const filetype = resp.u8();
      const flags = resp.u16();
      const rightsBase = resp.u64();
      const rightsInh = resp.u64();
      const view = dv();
      view.setUint8(statPtr + 0, filetype);
      view.setUint16(statPtr + 2, flags, true);
      view.setBigUint64(statPtr + 8, rightsBase, true);
      view.setBigUint64(statPtr + 16, rightsInh, true);
      return errno;
    },

    fd_tell(fd: number, offsetPtr: number): number {
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_TELL).u32(fd).build()));
      const errno = resp.u16();
      dv().setBigUint64(offsetPtr, resp.u64(), true);
      return errno;
    },

    fd_filestat_set_size(fd: number, size: bigint): number {
      return new Reader(ring.call(new Writer().u8(OP.FD_FILESTAT_SET_SIZE).u32(fd).u64(size).build())).u16();
    },

    fd_filestat_set_times(fd: number, atim: bigint, mtim: bigint, flags: number): number {
      const resolved = resolveFileTimes(atim, mtim, flags);
      if (resolved === undefined) return ERRNO.INVAL;
      const [a, m, f] = resolved;
      return new Reader(
        ring.call(new Writer().u8(OP.FD_FILESTAT_SET_TIMES).u32(fd).u64(a).u64(m).u16(f).build()),
      ).u16();
    },

    fd_sync(fd: number): number {
      return new Reader(ring.call(new Writer().u8(OP.FD_SYNC).u32(fd).build())).u16();
    },

    fd_datasync(fd: number): number {
      // The backing stores commit each kernel mutation synchronously. Reuse the
      // same descriptor validation and completion boundary as fd_sync.
      return new Reader(ring.call(new Writer().u8(OP.FD_SYNC).u32(fd).build())).u16();
    },

    fd_fdstat_set_rights(fd: number, rightsBase: bigint, rightsInheriting: bigint): number {
      return new Reader(
        ring.call(
          new Writer().u8(OP.FD_FDSTAT_SET_RIGHTS).u32(fd).u64(rightsBase).u64(rightsInheriting).build(),
        ),
      ).u16();
    },

    fd_renumber(from: number, to: number): number {
      return new Reader(ring.call(new Writer().u8(OP.FD_RENUMBER).u32(from).u32(to).build())).u16();
    },

    fd_prestat_get(fd: number, prestatPtr: number): number {
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_PRESTAT_GET).u32(fd).build()));
      const errno = resp.u16();
      const nameLen = resp.u32();
      if (errno === ERRNO.SUCCESS) {
        const view = dv();
        view.setUint8(prestatPtr, 0); // tag: dir
        view.setUint32(prestatPtr + 4, nameLen, true);
      }
      return errno;
    },

    fd_prestat_dir_name(fd: number, pathPtr: number, pathLen: number): number {
      const resp = new Reader(
        ring.call(new Writer().u8(OP.FD_PRESTAT_DIR_NAME).u32(fd).u32(pathLen).build()),
      );
      const errno = resp.u16();
      const name = resp.bytes();
      if (errno === ERRNO.SUCCESS) u8().set(name.subarray(0, pathLen), pathPtr);
      return errno;
    },

    path_open(
      dirfd: number,
      dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      rightsBase: bigint,
      rightsInh: bigint,
      fdflags: number,
      openedFdPtr: number,
    ): number {
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const resp = new Reader(
        ring.call(
          new Writer()
            .u8(OP.PATH_OPEN)
            .u32(dirfd)
            .u32(dirflags)
            .bytes(te.encode(path))
            .u16(oflags)
            .u64(rightsBase)
            .u64(rightsInh)
            .u16(fdflags)
            .build(),
        ),
      );
      const errno = resp.u16();
      const fd = resp.u32();
      if (errno === ERRNO.SUCCESS) dv().setUint32(openedFdPtr, fd, true);
      return errno;
    },

    path_filestat_get(
      dirfd: number,
      _flags: number,
      pathPtr: number,
      pathLen: number,
      bufPtr: number,
    ): number {
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const resp = new Reader(
        ring.call(new Writer().u8(OP.PATH_FILESTAT_GET).u32(dirfd).bytes(te.encode(path)).build()),
      );
      const errno = resp.u16();
      const filetype = resp.u8();
      const size = resp.u64();
      const atim = resp.u64();
      const mtim = resp.u64();
      const ctim = resp.u64();
      if (errno === ERRNO.SUCCESS) {
        const view = dv();
        for (let i = 0; i < 64; i++) view.setUint8(bufPtr + i, 0); // filestat is 64 bytes
        view.setUint8(bufPtr + 16, filetype); // fs_filetype
        view.setBigUint64(bufPtr + 24, 1n, true); // fs_nlink
        view.setBigUint64(bufPtr + 32, size, true); // fs_size
        view.setBigUint64(bufPtr + 40, atim, true);
        view.setBigUint64(bufPtr + 48, mtim, true);
        view.setBigUint64(bufPtr + 56, ctim, true);
      }
      return errno;
    },

    path_create_directory(dirfd: number, pathPtr: number, pathLen: number): number {
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const req = new Writer().u8(OP.PATH_CREATE_DIRECTORY).u32(dirfd).bytes(te.encode(path)).build();
      return new Reader(ring.call(req)).u16();
    },

    path_unlink_file(dirfd: number, pathPtr: number, pathLen: number): number {
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const req = new Writer().u8(OP.PATH_UNLINK_FILE).u32(dirfd).bytes(te.encode(path)).build();
      return new Reader(ring.call(req)).u16();
    },

    path_remove_directory(dirfd: number, pathPtr: number, pathLen: number): number {
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const req = new Writer().u8(OP.PATH_REMOVE_DIRECTORY).u32(dirfd).bytes(te.encode(path)).build();
      return new Reader(ring.call(req)).u16();
    },

    path_rename(
      oldDirfd: number,
      oldPtr: number,
      oldLen: number,
      newDirfd: number,
      newPtr: number,
      newLen: number,
    ): number {
      const mem = u8();
      const oldPath = td.decode(mem.subarray(oldPtr, oldPtr + oldLen));
      const newPath = td.decode(mem.subarray(newPtr, newPtr + newLen));
      const req = new Writer()
        .u8(OP.PATH_RENAME)
        .u32(oldDirfd)
        .bytes(te.encode(oldPath))
        .u32(newDirfd)
        .bytes(te.encode(newPath))
        .build();
      return new Reader(ring.call(req)).u16();
    },

    path_link(
      oldDirfd: number,
      _oldFlags: number,
      oldPathPtr: number,
      oldPathLen: number,
      newDirfd: number,
      newPathPtr: number,
      newPathLen: number,
    ): number {
      const mem = u8();
      const oldPath = td.decode(mem.subarray(oldPathPtr, oldPathPtr + oldPathLen));
      const newPath = td.decode(mem.subarray(newPathPtr, newPathPtr + newPathLen));
      return new Reader(
        ring.call(new Writer().u8(OP.PATH_LINK).u32(oldDirfd).bytes(te.encode(oldPath)).u32(newDirfd).bytes(te.encode(newPath)).build()),
      ).u16();
    },

    path_readlink(dirfd: number, pathPtr: number, pathLen: number, bufPtr: number, bufLen: number, bufusedPtr: number): number {
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const resp = new Reader(
        ring.call(new Writer().u8(OP.PATH_READLINK).u32(dirfd).bytes(te.encode(path)).u32(bufLen).build()),
      );
      const errno = resp.u16();
      const target = resp.bytes();
      const n = Math.min(target.length, bufLen);
      u8().set(target.subarray(0, n), bufPtr);
      dv().setUint32(bufusedPtr, n, true);
      return errno;
    },

    path_symlink(oldPathPtr: number, oldPathLen: number, dirfd: number, newPathPtr: number, newPathLen: number): number {
      const mem = u8();
      const target = td.decode(mem.subarray(oldPathPtr, oldPathPtr + oldPathLen));
      const link = td.decode(mem.subarray(newPathPtr, newPathPtr + newPathLen));
      return new Reader(
        ring.call(new Writer().u8(OP.PATH_SYMLINK).bytes(te.encode(target)).u32(dirfd).bytes(te.encode(link)).build()),
      ).u16();
    },

    path_filestat_set_times(
      dirfd: number,
      _flags: number,
      pathPtr: number,
      pathLen: number,
      atim: bigint,
      mtim: bigint,
      fstFlags: number,
    ): number {
      const resolved = resolveFileTimes(atim, mtim, fstFlags);
      if (resolved === undefined) return ERRNO.INVAL;
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const [a, m, f] = resolved;
      return new Reader(
        ring.call(new Writer().u8(OP.PATH_FILESTAT_SET_TIMES).u32(dirfd).bytes(te.encode(path)).u64(a).u64(m).u16(f).build()),
      ).u16();
    },

    proc_raise(signal: number): number {
      return new Reader(ring.call(new Writer().u8(OP.PROC_RAISE).u8(signal).build())).u16();
    },

    fd_readdir(fd: number, buf: number, bufLen: number, cookie: bigint, bufusedPtr: number): number {
      const resp = new Reader(
        ring.call(new Writer().u8(OP.FD_READDIR).u32(fd).u64(cookie).u32(bufLen).build()),
      );
      const errno = resp.u16();
      const entries = resp.bytes();
      const n = Math.min(entries.length, bufLen);
      u8().set(entries.subarray(0, n), buf);
      dv().setUint32(bufusedPtr, n, true);
      return errno;
    },

    environ_sizes_get(countPtr: number, bufsizePtr: number): number {
      const resp = new Reader(ring.call(new Writer().u8(OP.ENVIRON_SIZES_GET).build()));
      const errno = resp.u16();
      const count = resp.u32();
      const bufsize = resp.u32();
      const view = dv();
      view.setUint32(countPtr, count, true);
      view.setUint32(bufsizePtr, bufsize, true);
      return errno;
    },

    environ_get(environPtr: number, bufPtr: number): number {
      // The kernel returns the environment as a NUL-terminated, NUL-joined blob;
      // lay out the bytes at `bufPtr` and a pointer to each `KEY=VALUE` entry at
      // `environPtr[i]` (mirrors args_get).
      const resp = new Reader(ring.call(new Writer().u8(OP.ENVIRON_GET).build()));
      const errno = resp.u16();
      const blob = resp.bytes();
      u8().set(blob, bufPtr);
      const view = dv();
      let ai = 0;
      let start = 0;
      for (let i = 0; i < blob.length; i++) {
        if (blob[i] === 0) {
          view.setUint32(environPtr + ai * 4, bufPtr + start, true);
          ai += 1;
          start = i + 1;
        }
      }
      return errno;
    },

    args_sizes_get(argcPtr: number, bufsizePtr: number): number {
      const resp = new Reader(ring.call(new Writer().u8(OP.ARGS_SIZES_GET).build()));
      const errno = resp.u16();
      const count = resp.u32();
      const bufsize = resp.u32();
      const view = dv();
      view.setUint32(argcPtr, count, true);
      view.setUint32(bufsizePtr, bufsize, true);
      return errno;
    },

    args_get(argvPtr: number, bufPtr: number): number {
      // The kernel returns argv as a NUL-terminated, NUL-joined blob; lay out the
      // bytes at `bufPtr` and a pointer to each arg at `argvPtr[i]` (shell and userland).
      const resp = new Reader(ring.call(new Writer().u8(OP.ARGS_GET).build()));
      const errno = resp.u16();
      const blob = resp.bytes();
      u8().set(blob, bufPtr);
      const view = dv();
      let ai = 0;
      let start = 0;
      for (let i = 0; i < blob.length; i++) {
        if (blob[i] === 0) {
          view.setUint32(argvPtr + ai * 4, bufPtr + start, true);
          ai += 1;
          start = i + 1;
        }
      }
      return errno;
    },

    random_get(buf: number, bufLen: number): number {
      // Real CSPRNG entropy, host-sourced. The kernel is a deterministic
      // `wasm32-unknown-unknown` component with no host RNG import, so entropy is
      // provided here (the only layer with `crypto`). `getRandomValues` caps at
      // 65536 bytes per call, so larger requests are filled in chunks.
      const out = new Uint8Array(bufLen);
      for (let off = 0; off < bufLen; off += 65536) {
        crypto.getRandomValues(out.subarray(off, Math.min(off + 65536, bufLen)));
      }
      u8().set(out, buf);
      return ERRNO.SUCCESS;
    },

    clock_time_get(clockId: number, _precision: bigint, timePtr: number): number {
      // Real wall-clock / monotonic time, host-sourced (the deterministic kernel
      // cannot read a clock). REALTIME (0) = nanoseconds since the Unix epoch;
      // MONOTONIC (1) and the CPU clocks (2/3) = nanoseconds since the worker's
      // time origin. clockNowNs does the ns scaling in BigInt to avoid float64
      // quantization (see its definition).
      dv().setBigUint64(timePtr, clockNowNs(clockId), true);
      return ERRNO.SUCCESS;
    },

    proc_exit(code: number): never {
      ring.call(new Writer().u8(OP.PROC_EXIT).u32(code).build());
      throw new ProcExit(code);
    },

    // sched_yield is advisory — there is nothing to yield to within a single
    // cooperatively-scheduled guest worker, so the correct WASI answer is success.
    sched_yield(): number {
      return ERRNO.SUCCESS;
    },

    poll_oneoff(inPtr: number, outPtr: number, nsubs: number, neventsPtr: number): number {
      // Real `poll_oneoff`: block until at least one subscription is ready. Clock
      // subscriptions sleep host-side (real time); fd subscriptions ask the kernel
      // for readiness. Subscription = 48 bytes, event = 32 bytes (WASI p1 layout).
      const CLOCK = 0;
      const FD_READ = 1;
      const FD_WRITE = 2;
      const ABSTIME = 1; // subclockflags bit: timeout is absolute, not relative

      type Sub = { userdata: bigint; type: number; fd: number; clockId: number; deadlineNs: bigint };
      const subs: Sub[] = [];
      {
        const view = dv();
        for (let i = 0; i < nsubs; i++) {
          const b = inPtr + i * 48;
          const userdata = view.getBigUint64(b, true);
          const type = view.getUint8(b + 8);
          if (type === CLOCK) {
            const clockId = view.getUint32(b + 16, true);
            const timeout = view.getBigUint64(b + 24, true);
            const flags = view.getUint16(b + 40, true);
            const deadlineNs = flags & ABSTIME ? timeout : clockNowNs(clockId) + timeout;
            subs.push({ userdata, type, fd: 0, clockId, deadlineNs });
          } else {
            subs.push({ userdata, type, fd: view.getUint32(b + 16, true), clockId: 0, deadlineNs: 0n });
          }
        }
      }
      const fdSubs = subs.filter((s) => s.type === FD_READ || s.type === FD_WRITE);
      const clockSubs = subs.filter((s) => s.type === CLOCK);

      type Ev = { userdata: bigint; error: number; type: number; nbytes: bigint };
      let events: Ev[] = [];
      for (;;) {
        events = [];
        for (const s of fdSubs) {
          const { errno, ready, nbytes } = fdReady(s.fd, s.type === FD_WRITE);
          if (errno !== ERRNO.SUCCESS) events.push({ userdata: s.userdata, error: errno, type: s.type, nbytes: 0n });
          else if (ready) events.push({ userdata: s.userdata, error: ERRNO.SUCCESS, type: s.type, nbytes });
        }
        let earliestWaitMs = Infinity;
        for (const s of clockSubs) {
          const now = clockNowNs(s.clockId);
          if (s.deadlineNs <= now) {
            events.push({ userdata: s.userdata, error: ERRNO.SUCCESS, type: CLOCK, nbytes: 0n });
          } else {
            earliestWaitMs = Math.min(earliestWaitMs, Number(s.deadlineNs - now) / 1e6);
          }
        }
        if (events.length > 0) break;
        if (clockSubs.length === 0 && fdSubs.length === 0) break; // empty poll → 0 events
        // Nothing ready: sleep until the next clock deadline, but cap the slice to
        // 5ms whenever fds are watched so a newly-ready fd isn't missed mid-wait.
        const slice = fdSubs.length > 0 ? Math.min(earliestWaitMs, 5) : earliestWaitMs;
        sleepMs(Number.isFinite(slice) ? slice : 5);
      }

      const view = dv();
      let i = 0;
      for (const ev of events) {
        const o = outPtr + i * 32;
        for (let j = 0; j < 32; j++) view.setUint8(o + j, 0);
        view.setBigUint64(o + 0, ev.userdata, true);
        view.setUint16(o + 8, ev.error, true);
        view.setUint8(o + 10, ev.type);
        view.setBigUint64(o + 16, ev.nbytes, true);
        i += 1;
      }
      view.setUint32(neventsPtr, events.length, true);
      return ERRNO.SUCCESS;
    },

    // WASI Preview 1 exposes socket-shaped imports even when a host chooses not
    // to provide sockets. Keep these names explicit so module linking is stable
    // and unsupported networking is observable as the standard NOSYS errno,
    // rather than being hidden by a catch-all import proxy.
    sock_accept(_fd: number, _flags: number, _roFd: number): number {
      return ERRNO.NOSYS;
    },
    sock_recv(
      _fd: number,
      _riData: number,
      _riDataLen: number,
      _riFlags: number,
      _roDataLen: number,
      _roFlags: number,
    ): number {
      return ERRNO.NOSYS;
    },
    sock_send(_fd: number, _siData: number, _siDataLen: number, _siFlags: number, _soDataLen: number): number {
      return ERRNO.NOSYS;
    },
    sock_shutdown(_fd: number, _how: number): number {
      return ERRNO.NOSYS;
    },
  };
  return handlers;
}

const OP_WIN_SURFACE = 0x23;
const OP_WIN_PRESENT = 0x24;

/**
 * Host hooks for the desktop compositor surface path. Implemented by the process
 * worker: it allocates the per-surface framebuffer SAB and relays surface/present
 * notifications up to the compositor (pixels never traverse the kernel ring).
 */
export interface SurfaceHost {
  /** The kernel allocated `surfaceId`; allocate a `width*height*4` framebuffer. */
  onSurface(surfaceId: number, width: number, height: number): void;
  /** Copy the guest framebuffer `src` into the surface's SAB and signal a frame. */
  onPresent(surfaceId: number, src: Uint8Array): void;
}

/**
 * Build the `wasmos_kernel` import object — the process-control + compositor
 * extension. Most calls (KSPAWN/KPIPE/KWAIT, win_surface) are forwarded through
 * the ring (the kernel router dispatches by opcode); `win_surface` success is
 * post-processed to allocate the host framebuffer, and `win_present` is handled
 * entirely here (the guest framebuffer is copied straight into the surface SAB,
 * so per-frame pixels never enter the ring).
 */
export function makeKernelImports(
  getMemory: () => WebAssembly.Memory,
  ring: RingClient,
  surfaces: SurfaceHost,
): Wasi {
  return {
    syscall(reqPtr: number, reqLen: number, respPtr: number, respCap: number): number {
      const req = new Uint8Array(getMemory().buffer).slice(reqPtr, reqPtr + reqLen);
      const op = req[0];
      const reqView = new DataView(req.buffer, req.byteOffset, req.byteLength);

      // win_present: copy the guest framebuffer into the surface SAB + notify the
      // compositor. Never touches the kernel ring. Request: [0x24][id][ptr][len].
      if (op === OP_WIN_PRESENT) {
        const surfaceId = reqView.getUint32(1, true);
        const ptr = reqView.getUint32(5, true);
        const len = reqView.getUint32(9, true);
        const src = new Uint8Array(getMemory().buffer, ptr, len);
        surfaces.onPresent(surfaceId, src);
        const ok = new Uint8Array([ERRNO.SUCCESS & 0xff, (ERRNO.SUCCESS >> 8) & 0xff]);
        new Uint8Array(getMemory().buffer).set(ok.subarray(0, Math.min(ok.length, respCap)), respPtr);
        return ok.length;
      }

      const resp = ring.call(req);

      // win_surface success → the kernel allocated the id; allocate the host
      // framebuffer for it. Request: [0x23][w][h]. Reply: [errno u16][id u32].
      if (op === OP_WIN_SURFACE && resp.length >= 6) {
        const respView = new DataView(resp.buffer, resp.byteOffset, resp.byteLength);
        if (respView.getUint16(0, true) === ERRNO.SUCCESS) {
          const surfaceId = respView.getUint32(2, true);
          surfaces.onSurface(surfaceId, reqView.getUint32(1, true), reqView.getUint32(5, true));
        }
      }

      const n = Math.min(resp.length, respCap);
      new Uint8Array(getMemory().buffer).set(resp.subarray(0, n), respPtr);
      return resp.length; // actual length (so the guest can detect truncation)
    },
  };
}

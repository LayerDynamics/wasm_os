/**
 * Hand-written `wasi_snapshot_preview1` shim for guest processes (M1).
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

  const handlers: Wasi = {
    fd_write(fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number {
      const iovs = readIovs(iovsPtr, iovsLen);
      const mem = u8();
      const total = iovs.reduce((n, v) => n + v.len, 0);
      const data = new Uint8Array(total);
      let off = 0;
      for (const v of iovs) {
        data.set(mem.subarray(v.buf, v.buf + v.len), off);
        off += v.len;
      }
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_WRITE).u32(fd).bytes(data).build()));
      const errno = resp.u16();
      const nwritten = resp.u32();
      dv().setUint32(nwrittenPtr, nwritten, true);
      return errno;
    },

    fd_read(fd: number, iovsPtr: number, iovsLen: number, nreadPtr: number): number {
      const iovs = readIovs(iovsPtr, iovsLen);
      const total = iovs.reduce((n, v) => n + v.len, 0);
      const resp = new Reader(ring.call(new Writer().u8(OP.FD_READ).u32(fd).u32(total).build()));
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
      _dirflags: number,
      pathPtr: number,
      pathLen: number,
      oflags: number,
      rightsBase: bigint,
      _rightsInh: bigint,
      _fdflags: number,
      openedFdPtr: number,
    ): number {
      const path = td.decode(u8().subarray(pathPtr, pathPtr + pathLen));
      const resp = new Reader(
        ring.call(
          new Writer()
            .u8(OP.PATH_OPEN)
            .u32(dirfd)
            .bytes(te.encode(path))
            .u16(oflags)
            .u64(rightsBase)
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
      if (errno === ERRNO.SUCCESS) {
        const view = dv();
        for (let i = 0; i < 64; i++) view.setUint8(bufPtr + i, 0); // filestat is 64 bytes
        view.setUint8(bufPtr + 16, filetype); // fs_filetype
        view.setBigUint64(bufPtr + 24, 1n, true); // fs_nlink
        view.setBigUint64(bufPtr + 32, size, true); // fs_size
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

    environ_get(_environPtr: number, _bufPtr: number): number {
      // M1 guests have an empty environment; nothing to lay out.
      return new Reader(ring.call(new Writer().u8(OP.ENVIRON_GET).build())).u16();
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
      // bytes at `bufPtr` and a pointer to each arg at `argvPtr[i]` (M2).
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
      const resp = new Reader(ring.call(new Writer().u8(OP.RANDOM_GET).u32(bufLen).build()));
      const errno = resp.u16();
      const bytes = resp.bytes();
      u8().set(bytes.subarray(0, bufLen), buf);
      return errno;
    },

    clock_time_get(clockId: number, precision: bigint, timePtr: number): number {
      const resp = new Reader(
        ring.call(new Writer().u8(OP.CLOCK_TIME_GET).u32(clockId).u64(precision).build()),
      );
      const errno = resp.u16();
      const time = resp.u64();
      dv().setBigUint64(timePtr, time, true);
      return errno;
    },

    proc_exit(code: number): never {
      ring.call(new Writer().u8(OP.PROC_EXIT).u32(code).build());
      throw new ProcExit(code);
    },

    // --- locally-handled WASI calls not routed to the kernel at M1 ---
    // These keep instantiation from LinkError-ing and behave sensibly for the
    // M1 guest surface (stdout + a single file read). Routed FS lands in M2.
    sched_yield(): number {
      return ERRNO.SUCCESS;
    },
    fd_fdstat_set_flags(_fd: number, _flags: number): number {
      return ERRNO.SUCCESS;
    },
    fd_filestat_get(_fd: number, bufPtr: number): number {
      // Zeroed filestat (64 bytes), filetype = regular_file @ offset 16.
      const view = dv();
      for (let i = 0; i < 64; i++) view.setUint8(bufPtr + i, 0);
      view.setUint8(bufPtr + 16, 4);
      return ERRNO.SUCCESS;
    },
    poll_oneoff(_in: number, _out: number, _nsub: number, neventsPtr: number): number {
      dv().setUint32(neventsPtr, 0, true);
      return ERRNO.SUCCESS;
    },
  };

  // Safety net: any WASI import we did not explicitly model resolves to a stub
  // that returns ENOSYS rather than failing instantiation with a LinkError.
  return new Proxy(handlers, {
    get(target, prop: string) {
      if (prop in target) return target[prop];
      return (..._args: never[]): number => ERRNO.NOSYS;
    },
  }) as Wasi;
}

const OP_WIN_SURFACE = 0x23;
const OP_WIN_PRESENT = 0x24;

/**
 * Host hooks for the M3 compositor surface path. Implemented by the process
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

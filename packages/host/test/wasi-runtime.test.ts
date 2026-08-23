import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { OP, Writer } from "../src/ring/protocol.js";
import { ProcExit } from "../src/worker/wasi-shim.js";
import { WasiRuntime } from "../src/worker/wasi-runtime.js";
import type { RingClient } from "../src/ring/guest.js";

const helloPath = fileURLToPath(new URL("../guests/hello.wasm", import.meta.url));
const watinfoPath = fileURLToPath(new URL("../guests/watinfo.wasm", import.meta.url));

function response(errno: number, body: Uint8Array = new Uint8Array()): Uint8Array {
  return new Writer().u16(errno).bytes(body).build();
}

function fakeKernelRing(output: Uint8Array[]): RingClient {
  return {
    call(request: Uint8Array): Uint8Array {
      const op = request[0] ?? -1;
      if (op === OP.FD_WRITE) {
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        const fd = view.getUint32(1, true);
        const len = view.getUint32(5, true);
        expect(fd).toBe(1);
        output.push(request.slice(9, 9 + len));
        return new Writer().u16(0).u32(len).build();
      }
      if (op === OP.ENVIRON_SIZES_GET) {
        return new Writer().u16(0).u32(0).u32(0).build();
      }
      if (op === OP.ENVIRON_GET) {
        return response(0);
      }
      if (op === OP.PROC_EXIT) {
        return response(0);
      }
      throw new Error(`unexpected syscall opcode 0x${op.toString(16)}`);
    },
  } as RingClient;
}

function fakeWatKernelRing(output: Uint8Array[]): RingClient {
  const uptime = new TextEncoder().encode("123.45 67.89\n");
  return {
    call(request: Uint8Array): Uint8Array {
      const op = request[0] ?? -1;
      if (op === OP.PATH_OPEN) {
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        const pathLen = view.getUint32(9, true);
        const path = new TextDecoder().decode(request.slice(13, 13 + pathLen));
        expect(path).toBe("/proc/uptime");
        return new Writer().u16(0).u32(7).build();
      }
      if (op === OP.FD_READ) {
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        expect(view.getUint32(1, true)).toBe(7);
        return new Writer().u16(0).bytes(uptime).build();
      }
      if (op === OP.FD_CLOSE) {
        expect(new DataView(request.buffer, request.byteOffset, request.byteLength).getUint32(1, true)).toBe(7);
        return response(0);
      }
      if (op === OP.FD_WRITE) {
        const view = new DataView(request.buffer, request.byteOffset, request.byteLength);
        const len = view.getUint32(5, true);
        expect(view.getUint32(1, true)).toBe(1);
        output.push(request.slice(9, 9 + len));
        return new Writer().u16(0).u32(len).build();
      }
      if (op === OP.PROC_EXIT) return response(0);
      throw new Error("unexpected WAT syscall opcode 0x" + op.toString(16));
    },
  } as RingClient;
}

describe("WASI runtime", () => {
  it("instantiates and runs the real Rust guest through the host import boundary", async () => {
    const bytes = readFileSync(helloPath);
    const wasmBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const output: Uint8Array[] = [];
    const runtime = new WasiRuntime({
      wasmBytes,
      ring: fakeKernelRing(output),
      surfaces: { onSurface() {}, onPresent() {} },
    });

    const inspection = await WasiRuntime.inspect(wasmBytes);
    expect(inspection.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: "wasi_snapshot_preview1", name: "fd_write" }),
        expect.objectContaining({ module: "wasi_snapshot_preview1", name: "proc_exit" }),
      ]),
    );

    try {
      await runtime.run();
    } catch (error) {
      expect(error).toBeInstanceOf(ProcExit);
      expect((error as ProcExit).code).toBe(0);
    }
    expect(new TextDecoder().decode(Uint8Array.from(output.flatMap((chunk) => Array.from(chunk))))).toBe(
      "hello from wasm_os\n",
    );
    expect(runtime.state().sharedMemory).toBe(false);
  });

  it("runs the hand-authored WAT OS utility through WASI file I/O", async () => {
    const bytes = readFileSync(watinfoPath);
    const wasmBytes = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const output: Uint8Array[] = [];
    const runtime = new WasiRuntime({
      wasmBytes,
      ring: fakeWatKernelRing(output),
      surfaces: { onSurface() {}, onPresent() {} },
    });

    const inspection = await WasiRuntime.inspect(wasmBytes);
    expect(inspection.imports).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ module: "wasi_snapshot_preview1", name: "path_open" }),
        expect.objectContaining({ module: "wasi_snapshot_preview1", name: "fd_read" }),
      ]),
    );

    try {
      await runtime.run();
    } catch (error) {
      expect(error).toBeInstanceOf(ProcExit);
      expect((error as ProcExit).code).toBe(0);
    }
    expect(new TextDecoder().decode(Uint8Array.from(output.flatMap((chunk) => Array.from(chunk))))).toBe(
      "WAT uptime: 123.45 67.89\n",
    );
  });
});

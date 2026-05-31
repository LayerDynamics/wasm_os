/**
 * SAB syscall-ring memory layout (Tier A).
 *
 * The ring carries one syscall request/response at a time between a process
 * worker (the guest's WASI shim) and the kernel worker. Synchronization uses
 * **two monotonic doorbell counters** rather than a single shared state word:
 * each side waits on the *other's* counter expecting its last-seen value, so a
 * too-fast peer makes `Atomics.wait` return `not-equal` immediately (no lost
 * wakeup) and there is no reset-vs-arm ambiguity.
 *
 * Header is 4 × Int32 lanes, followed by the request region then the response
 * region. Region capacities are fixed module constants shared by both ends, so
 * neither side needs to encode sizes in the buffer.
 */

/** Header lane indices (into the Int32 view). */
export const REQ_SEQ = 0; // request doorbell — kernel waits on this; guest bumps
export const RESP_SEQ = 1; // response doorbell — guest waits on this; kernel bumps
export const OPLEN = 2; // request byte length
export const RESPLEN = 3; // response byte length

export const HEADER_LANES = 4;
export const HEADER_BYTES = HEADER_LANES * 4; // Int32 = 4 bytes

/** Region capacities (bytes). 64 KiB each comfortably holds an M1 syscall. */
export const REQ_CAP = 64 * 1024;
export const RESP_CAP = 64 * 1024;

export const REQ_OFFSET = HEADER_BYTES;
export const RESP_OFFSET = HEADER_BYTES + REQ_CAP;
export const RING_BYTES = HEADER_BYTES + REQ_CAP + RESP_CAP;

/** Allocate a fresh ring. Both doorbell counters start at 0. */
export function createRing(): SharedArrayBuffer {
  return new SharedArrayBuffer(RING_BYTES);
}

/** Int32 view over the header lanes (the Atomics target). */
export function header(sab: SharedArrayBuffer): Int32Array {
  return new Int32Array(sab, 0, HEADER_LANES);
}

/** Byte view over the request region. */
export function reqRegion(sab: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(sab, REQ_OFFSET, REQ_CAP);
}

/** Byte view over the response region. */
export function respRegion(sab: SharedArrayBuffer): Uint8Array {
  return new Uint8Array(sab, RESP_OFFSET, RESP_CAP);
}

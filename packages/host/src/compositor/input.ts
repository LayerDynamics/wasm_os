/**
 * Input broker (L3 / M3, FR-25). Captures keyboard/mouse for the FOCUSED canvas
 * window and delivers fixed-size event records to that window's owning process
 * (capability-checked kernel-side: events for a process without `Input` are
 * dropped). Pointer coordinates are mapped to the surface's backing-store pixels.
 *
 * Record layout (12 bytes, little-endian) — must match `wasmos_sys::InputEvent`
 * and `crates/kernel` `INPUT_EVENT_SIZE`:
 *   [0]=kind u8 [1]=button u8 [2..4]=x u16 [4..6]=y u16 [6..10]=key u32 [10]=mods u8 [11]=pad
 */

export const EV_POINTER_MOVE = 1;
export const EV_POINTER_DOWN = 2;
export const EV_POINTER_UP = 3;
export const EV_KEY_DOWN = 4;
export const EV_KEY_UP = 5;
const INPUT_EVENT_SIZE = 12;

function encode(kind: number, x: number, y: number, button: number, key: number, mods: number): Uint8Array {
  const b = new Uint8Array(INPUT_EVENT_SIZE);
  const dv = new DataView(b.buffer);
  dv.setUint8(0, kind);
  dv.setUint8(1, button & 0xff);
  dv.setUint16(2, Math.max(0, Math.min(65535, x | 0)), true);
  dv.setUint16(4, Math.max(0, Math.min(65535, y | 0)), true);
  dv.setUint32(6, key >>> 0, true);
  dv.setUint8(10, mods & 0xff);
  return b;
}

function modBits(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): number {
  return (e.shiftKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.altKey ? 4 : 0) | (e.metaKey ? 8 : 0);
}

export class InputRouter {
  constructor(
    private deliver: (pid: number, bytes: Uint8Array) => void,
    /** Owning pid of the currently focused canvas window, or undefined. */
    private activeCanvasOwner: () => number | undefined,
  ) {
    window.addEventListener("keydown", (e) => this.onKey(EV_KEY_DOWN, e));
    window.addEventListener("keyup", (e) => this.onKey(EV_KEY_UP, e));
  }

  private onKey(kind: number, e: KeyboardEvent): void {
    const pid = this.activeCanvasOwner();
    if (pid === undefined) return; // focus is on a DOM window (e.g. the terminal)
    this.deliver(pid, encode(kind, 0, 0, 0, e.keyCode, modBits(e)));
  }

  /** Route pointer events on `canvas` to `ownerPid` (surface-local coordinates). */
  bindCanvas(canvas: HTMLCanvasElement, ownerPid: number): void {
    const local = (e: PointerEvent): { x: number; y: number } => {
      const r = canvas.getBoundingClientRect();
      return {
        x: r.width ? ((e.clientX - r.left) / r.width) * canvas.width : 0,
        y: r.height ? ((e.clientY - r.top) / r.height) * canvas.height : 0,
      };
    };
    canvas.addEventListener("pointermove", (e) => {
      const { x, y } = local(e);
      this.deliver(ownerPid, encode(EV_POINTER_MOVE, x, y, e.button, 0, modBits(e)));
    });
    canvas.addEventListener("pointerdown", (e) => {
      const { x, y } = local(e);
      this.deliver(ownerPid, encode(EV_POINTER_DOWN, x, y, e.button, 0, modBits(e)));
    });
    canvas.addEventListener("pointerup", (e) => {
      const { x, y } = local(e);
      this.deliver(ownerPid, encode(EV_POINTER_UP, x, y, e.button, 0, modBits(e)));
    });
  }
}

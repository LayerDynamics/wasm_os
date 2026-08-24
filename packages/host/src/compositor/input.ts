/**
 * Input broker (L3 / desktop compositor, FR-25). Captures keyboard/mouse for the FOCUSED canvas
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

/**
 * Key encoding for the `key` field: a printable key carries its actual character
 * code (browser-resolved layout + shift, e.g. 'A'=65, '!'=33); named keys carry a
 * code at or above 0x100. Guests share these via `wasmos_sys::KEY_*`.
 */
const NAMED_KEYS: Record<string, number> = {
  Enter: 0x100,
  Backspace: 0x101,
  ArrowLeft: 0x102,
  ArrowRight: 0x103,
  ArrowUp: 0x104,
  ArrowDown: 0x105,
  Tab: 0x106,
  Escape: 0x107,
  Delete: 0x108,
  Home: 0x109,
  End: 0x10a,
  Insert: 0x10b,
  PageUp: 0x10c,
  PageDown: 0x10d,
  F1: 0x10e,
  F2: 0x10f,
  F3: 0x110,
  F4: 0x111,
  F5: 0x112,
  F6: 0x113,
  F7: 0x114,
  F8: 0x115,
  F9: 0x116,
  F10: 0x117,
  F11: 0x118,
  F12: 0x119,
  CapsLock: 0x11a,
  NumLock: 0x11b,
  ScrollLock: 0x11c,
  Pause: 0x11d,
  PrintScreen: 0x11e,
  ContextMenu: 0x11f,
};

export const NAMED_KEY_CODES = Object.freeze(
  Object.entries(NAMED_KEYS).map(([name, code]) => ({ name, code })),
);

type InputSource = "canvas" | "terminal";

interface PendingInput {
  source: InputSource;
  pid?: number;
  key: string;
  startedAt: number;
  delivered: boolean;
  rendered: boolean;
}

export interface InputKeyMetric {
  generated: number;
  delivered: number;
  rendered: number;
  dropped: number;
  missed: number;
}

export interface InputMetricsSnapshot {
  generated: number;
  delivered: number;
  rendered: number;
  dropped: number;
  missed: number;
  pending: number;
  p50Millis: number | null;
  p95Millis: number | null;
  maxMillis: number | null;
  deliveryRate: number;
  dropRate: number;
  missedRate: number;
  byKey: Record<string, InputKeyMetric>;
}

const INPUT_COMPLETION_TIMEOUT_MS = 5_000;

function percentile(samples: number[], p: number): number | null {
  if (samples.length === 0) return null;
  const index = Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1);
  return Math.round(samples[index]! * 100) / 100;
}

/** Runtime evidence for browser input delivery and guest rendering.
 *
 * A sample starts at the browser event, is accepted or rejected by the kernel
 * delivery result, and completes when the target guest presents a frame. Inputs
 * that remain unresolved past the timeout are counted as missed instead of being
 * silently omitted from the report.
 */
export class InputMetrics {
  private nextId = 1;
  private pending = new Map<number, PendingInput>();
  private samples: number[] = [];
  private generated = 0;
  private delivered = 0;
  private rendered = 0;
  private dropped = 0;
  private missed = 0;
  private keyMetrics = new Map<string, InputKeyMetric>();

  private keyMetric(key: string): InputKeyMetric {
    let metric = this.keyMetrics.get(key);
    if (!metric) {
      metric = { generated: 0, delivered: 0, rendered: 0, dropped: 0, missed: 0 };
      this.keyMetrics.set(key, metric);
    }
    return metric;
  }

  private begin(source: InputSource, key: string, pid?: number): number {
    const id = this.nextId++;
    this.generated++;
    this.keyMetric(key).generated++;
    this.pending.set(id, { source, pid, key, startedAt: performance.now(), delivered: false, rendered: false });
    return id;
  }

  beginCanvas(pid: number, key: string): number {
    return this.begin("canvas", key, pid);
  }

  beginTerminal(key: string): number {
    return this.begin("terminal", key);
  }

  drop(id: number): void {
    const sample = this.pending.get(id);
    if (!sample) return;
    this.pending.delete(id);
    this.dropped++;
    this.keyMetric(sample.key).dropped++;
  }

  deliveredByKernel(id: number, accepted: boolean): void {
    const sample = this.pending.get(id);
    if (!sample) return;
    if (!accepted) {
      this.drop(id);
      return;
    }
    if (!sample.delivered) {
      sample.delivered = true;
      this.delivered++;
      this.keyMetric(sample.key).delivered++;
    }
    if (sample.rendered) this.pending.delete(id);
  }

  markCanvasRendered(pid: number): void {
    const now = performance.now();
    for (const [id, sample] of this.pending) {
      if (sample.source !== "canvas" || sample.pid !== pid) continue;
      sample.rendered = true;
      // A visible frame is an independent acceptance proof. The kernel RPC can
      // resolve after the guest has already been woken and rendered the batch.
      if (!sample.delivered) {
        sample.delivered = true;
        this.delivered++;
        this.keyMetric(sample.key).delivered++;
      }
      this.rendered++;
      this.keyMetric(sample.key).rendered++;
      this.samples.push(now - sample.startedAt);
      if (sample.delivered) this.pending.delete(id);
    }
  }

  markTerminalEcho(): void {
    const first = [...this.pending.entries()].find(([, sample]) => sample.source === "terminal");
    if (!first) return;
    const [id, sample] = first;
    if (!sample.delivered) {
      sample.delivered = true;
      this.delivered++;
      this.keyMetric(sample.key).delivered++;
    }
    this.pending.delete(id);
    this.rendered++;
    this.keyMetric(sample.key).rendered++;
    this.samples.push(performance.now() - sample.startedAt);
  }

  reset(): void {
    this.nextId = 1;
    this.pending.clear();
    this.samples = [];
    this.generated = 0;
    this.delivered = 0;
    this.rendered = 0;
    this.dropped = 0;
    this.missed = 0;
    this.keyMetrics.clear();
  }

  snapshot(): InputMetricsSnapshot {
    const now = performance.now();
    for (const [id, sample] of this.pending) {
      if (now - sample.startedAt < INPUT_COMPLETION_TIMEOUT_MS) continue;
      this.pending.delete(id);
      this.missed++;
      this.keyMetric(sample.key).missed++;
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const byKey: Record<string, InputKeyMetric> = {};
    for (const [key, metric] of this.keyMetrics) byKey[key] = { ...metric };
    return {
      generated: this.generated,
      delivered: this.delivered,
      rendered: this.rendered,
      dropped: this.dropped,
      missed: this.missed,
      pending: this.pending.size,
      p50Millis: percentile(sorted, 0.5),
      p95Millis: percentile(sorted, 0.95),
      maxMillis: sorted.length ? Math.round(sorted[sorted.length - 1]! * 100) / 100 : null,
      deliveryRate: this.generated ? this.delivered / this.generated : 1,
      dropRate: this.generated ? this.dropped / this.generated : 0,
      missedRate: this.generated ? this.missed / this.generated : 0,
      byKey,
    };
  }
}

function keyName(key: number, browserName: string): string {
  if (key < 0x100) return `U+${key.toString(16).toUpperCase().padStart(4, "0")}`;
  return Object.entries(NAMED_KEYS).find(([, code]) => code === key)?.[0] ?? browserName;
}

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
    private deliver: (pid: number, bytes: Uint8Array) => boolean | void | Promise<boolean | void>,
    /** Owning pid of the currently focused canvas window, or undefined. */
    private activeCanvasOwner: () => number | undefined,
    private metrics: InputMetrics = new InputMetrics(),
  ) {
    window.addEventListener("keydown", (e) => this.onKey(EV_KEY_DOWN, e));
    window.addEventListener("keyup", (e) => this.onKey(EV_KEY_UP, e));
  }

  private onKey(kind: number, e: KeyboardEvent): void {
    const pid = this.activeCanvasOwner();
    let key: number;
    if (Array.from(e.key).length === 1) {
      key = e.key.codePointAt(0)!; // the actual character (layout + shift applied)
    } else {
      // Some browser/keyboard combinations expose the physical key reliably in
      // `code` while leaving `key` empty or layout-dependent. Named controls must
      // still reach the guest in that case; printable input continues to use the
      // layout-resolved `key` above.
      key = NAMED_KEYS[e.key] ?? NAMED_KEYS[e.code] ?? 0;
      if (key === 0) return; // ignore pure modifiers (Shift/Control/…) and unmapped keys
    }
    if (kind !== EV_KEY_DOWN) {
      if (pid === undefined) return; // keyup is irrelevant to the latency sample
      this.deliver(pid, encode(kind, 0, 0, 0, key, modBits(e)));
      return;
    }
    if (pid === undefined) {
      return; // focus is on a DOM window (e.g. the terminal)
    }
    const sample = this.metrics.beginCanvas(pid, keyName(key, e.key));
    // A focused canvas window consuming the key shouldn't also scroll/navigate the page.
    if (e.key.length === 1 || key >= 0x100) e.preventDefault();
    Promise.resolve(this.deliver(pid, encode(kind, 0, 0, 0, key, modBits(e))))
      .then((accepted) => this.metrics.deliveredByKernel(sample, accepted !== false))
      .catch(() => this.metrics.drop(sample));
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

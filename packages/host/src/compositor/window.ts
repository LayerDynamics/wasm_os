/**
 * Window (L3 / desktop compositor) — one framed surface with chrome.
 *
 * Owns its DOM: a titlebar (drag to move, double-click to maximize, min/max/close
 * buttons) and a content host, plus 8 resize handles. Move/resize use Pointer
 * Events with pointer capture so a drag that leaves the element still tracks.
 * The window never decides z-order/focus itself — it asks the compositor via the
 * {@link WindowDelegate} so there is a single focus authority (FR-22).
 */
import type { SurfaceKind, WinState, WindowDelegate, WindowOptions } from "./types.js";

const MIN_W = 160;
const MIN_H = 96;
const TITLEBAR_H = 28;

type ResizeDir = "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

export class Win {
  readonly id: number;
  readonly ownerPid?: number;
  readonly surface: SurfaceKind;
  readonly root: HTMLDivElement;
  readonly content: HTMLDivElement;

  private titleEl: HTMLSpanElement;
  private titleText: string;
  private state: WinState = "normal";
  private geom = { x: 0, y: 0, w: 0, h: 0 };
  private prevGeom = { x: 0, y: 0, w: 0, h: 0 };

  constructor(id: number, opts: WindowOptions, private delegate: WindowDelegate) {
    this.id = id;
    this.ownerPid = opts.ownerPid;
    this.surface = opts.surface ?? "dom";
    this.titleText = opts.title;
    this.geom = {
      x: opts.x ?? 0,
      y: opts.y ?? 0,
      w: Math.max(MIN_W, opts.width),
      h: Math.max(MIN_H, opts.height),
    };

    const root = document.createElement("div");
    root.className = "wasmos-window";
    root.dataset.winId = String(id);
    root.tabIndex = -1;

    const titlebar = document.createElement("div");
    titlebar.className = "wasmos-titlebar";

    this.titleEl = document.createElement("span");
    this.titleEl.className = "wasmos-title";
    this.titleEl.textContent = this.titleText;
    titlebar.appendChild(this.titleEl);

    const btns = document.createElement("div");
    btns.className = "wasmos-winbtns";
    for (const act of ["min", "max", "close"] as const) {
      const b = document.createElement("button");
      b.className = `wasmos-winbtn wasmos-winbtn-${act}`;
      b.dataset.act = act;
      b.type = "button";
      b.textContent = act === "min" ? "–" : act === "max" ? "▢" : "✕";
      b.addEventListener("pointerdown", (e) => e.stopPropagation());
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        if (act === "min") this.minimize();
        else if (act === "max") this.toggleMaximize();
        else this.delegate.requestClose(this.id);
      });
      btns.appendChild(b);
    }
    titlebar.appendChild(btns);

    const content = document.createElement("div");
    content.className = "wasmos-content";

    root.appendChild(titlebar);
    root.appendChild(content);
    for (const dir of ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as ResizeDir[]) {
      const h = document.createElement("div");
      h.className = `wasmos-resize wasmos-resize-${dir}`;
      h.dataset.dir = dir;
      h.addEventListener("pointerdown", (e) => this.beginResize(e, dir));
      root.appendChild(h);
    }

    this.root = root;
    this.content = content;
    this.applyGeom();

    // Focus on any press; move on titlebar drag; maximize on titlebar dbl-click.
    root.addEventListener("pointerdown", () => this.delegate.requestFocus(this.id));
    titlebar.addEventListener("pointerdown", (e) => this.beginMove(e));
    titlebar.addEventListener("dblclick", () => this.toggleMaximize());
  }

  get title(): string {
    return this.titleText;
  }
  setTitle(t: string): void {
    this.titleText = t;
    this.titleEl.textContent = t;
    this.delegate.onChanged(this.id);
  }

  getState(): WinState {
    return this.state;
  }

  /**
   * Invoked when this window becomes the active (focused) window. A DOM window
   * uses it to restore keyboard focus to its content — e.g. the terminal's xterm
   * textarea — which is otherwise lost when focus moves to another window and is
   * NOT recovered by a click (the titlebar's `beginMove` calls `preventDefault`,
   * suppressing the browser's native focus). The compositor is the single focus
   * authority (FR-22), so DOM focus must be driven from here to stay in lockstep
   * with z-order/active state.
   */
  onActivate?: () => void;

  setActive(active: boolean): void {
    this.root.classList.toggle("wasmos-window-active", active);
    if (active) this.onActivate?.();
  }

  setZ(z: number): void {
    this.root.style.zIndex = String(z);
  }

  /** Content box size in CSS pixels (used by canvas surfaces in canvas surfaces). */
  contentSize(): { w: number; h: number } {
    return { w: this.geom.w, h: this.geom.h - TITLEBAR_H };
  }

  /** Current window geometry in CSS pixels (session restore session persistence). */
  geometry(): { x: number; y: number; w: number; h: number } {
    return { ...this.geom };
  }

  /** Restore a saved geometry (session restore). Clamped to the minimum window size. */
  setGeometry(g: { x: number; y: number; w: number; h: number }): void {
    this.geom = { x: g.x, y: g.y, w: Math.max(MIN_W, g.w), h: Math.max(MIN_H, g.h) };
    this.applyGeom();
    this.delegate.onChanged(this.id);
  }

  // --- state transitions ---

  minimize(): void {
    this.state = "minimized";
    this.root.style.display = "none";
    this.delegate.onChanged(this.id);
  }

  restore(): void {
    if (this.state === "minimized") {
      this.state = "normal";
      this.root.style.display = "";
    }
    this.delegate.onChanged(this.id);
  }

  toggleMaximize(): void {
    if (this.state === "maximized") {
      this.geom = { ...this.prevGeom };
      this.state = "normal";
      this.root.classList.remove("wasmos-window-max");
    } else {
      this.prevGeom = { ...this.geom };
      this.state = "maximized";
      this.root.classList.add("wasmos-window-max");
      const parent = this.root.parentElement;
      if (parent) {
        this.geom = { x: 0, y: 0, w: parent.clientWidth, h: parent.clientHeight };
      }
    }
    this.applyGeom();
    this.delegate.onChanged(this.id);
  }

  isVisible(): boolean {
    return this.state !== "minimized";
  }

  private applyGeom(): void {
    const { x, y, w, h } = this.geom;
    this.root.style.left = `${x}px`;
    this.root.style.top = `${y}px`;
    this.root.style.width = `${w}px`;
    this.root.style.height = `${h}px`;
  }

  private workspace(): { w: number; h: number } {
    const p = this.root.parentElement;
    return { w: p?.clientWidth ?? window.innerWidth, h: p?.clientHeight ?? window.innerHeight };
  }

  private beginMove(e: PointerEvent): void {
    if (this.state === "maximized") return; // maximized windows don't drag
    e.preventDefault();
    this.delegate.requestFocus(this.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const origX = this.geom.x;
    const origY = this.geom.y;
    const ws = this.workspace();
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const nx = origX + (ev.clientX - startX);
      const ny = origY + (ev.clientY - startY);
      // Keep the titlebar reachable: clamp within the workspace.
      this.geom.x = Math.max(-this.geom.w + 64, Math.min(nx, ws.w - 64));
      this.geom.y = Math.max(0, Math.min(ny, ws.h - TITLEBAR_H));
      this.applyGeom();
    };
    // `lostpointercapture` is the universal end-of-drag signal: the browser
    // implicitly releases capture after pointerup/pointercancel AND when the
    // captured element is removed (e.g. the owning process exits and the window is
    // torn down mid-drag). Keying teardown off it — rather than only pointerup —
    // guarantees the move listener and its closure are always removed.
    const finish = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("lostpointercapture", finish);
      this.delegate.onChanged(this.id);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("lostpointercapture", finish);
  }

  private beginResize(e: PointerEvent, dir: ResizeDir): void {
    if (this.state === "maximized") return;
    e.preventDefault();
    e.stopPropagation();
    this.delegate.requestFocus(this.id);
    const startX = e.clientX;
    const startY = e.clientY;
    const o = { ...this.geom };
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);

    const onMove = (ev: PointerEvent) => {
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      let { x, y, w, h } = o;
      if (dir.includes("e")) w = Math.max(MIN_W, o.w + dx);
      if (dir.includes("s")) h = Math.max(MIN_H, o.h + dy);
      if (dir.includes("w")) {
        w = Math.max(MIN_W, o.w - dx);
        x = o.x + (o.w - w);
      }
      if (dir.includes("n")) {
        h = Math.max(MIN_H, o.h - dy);
        y = o.y + (o.h - h);
        // Keep the window's top edge within the workspace: clamp y >= 0 and
        // absorb the overflow into the height.
        if (y < 0) {
          h += y;
          y = 0;
        }
      }
      this.geom = { x, y, w, h };
      this.applyGeom();
    };
    // See beginMove: lostpointercapture fires on pointerup/pointercancel and on
    // element removal, so the resize listeners never leak even if the drag is
    // interrupted by the window being torn down.
    const finish = () => {
      target.removeEventListener("pointermove", onMove);
      target.removeEventListener("lostpointercapture", finish);
      this.delegate.onChanged(this.id);
    };
    target.addEventListener("pointermove", onMove);
    target.addEventListener("lostpointercapture", finish);
  }
}

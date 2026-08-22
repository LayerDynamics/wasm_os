/**
 * Compositor (L3 / desktop compositor) — the window manager (FR-21, FR-22).
 *
 * Single authority for window lifecycle, z-order, and focus. Windows ask it to
 * focus/close via the WindowDelegate; it keeps a z-ordered stack (raise on
 * focus), tracks the active window, and drives the taskbar. The terminal mounts
 * as the first window (a DOM surface); process-owned canvas windows (canvas surfaces) plug
 * in through the same API.
 */
import "./compositor.css";
import { Win } from "./window.js";
import { Taskbar } from "./taskbar.js";
import type { WindowDelegate, WindowOptions } from "./types.js";

export class Compositor {
  private desktop: HTMLElement;
  private taskbar: Taskbar;
  private wins = new Map<number, Win>();
  /** Bottom→top stacking order of window ids. */
  private zorder: number[] = [];
  private activeId: number | null = null;
  private nextId = 1;
  private baseZ = 10;
  /** Step (px) of the placement grid scanned by {@link place}. */
  private static readonly PLACE_STEP = 32;

  /** Notified when a window closes (so owners can reap a backing process). */
  onWindowClosed: (id: number, ownerPid?: number) => void = () => {};
  /** Notified when a window opens (session restore session: associate it with an app). */
  onWindowOpened: (win: Win) => void = () => {};
  /** Notified on any window lifecycle/geometry change (session restore session save). */
  onWindowsChanged: () => void = () => {};

  constructor(desktopEl: HTMLElement, taskbarEl: HTMLElement) {
    this.desktop = desktopEl;
    this.taskbar = new Taskbar(taskbarEl, {
      focus: (id) => this.focus(id),
      isActive: (id) => this.activeId === id,
    });
  }

  private delegate: WindowDelegate = {
    requestFocus: (id) => this.focus(id),
    requestClose: (id) => this.close(id),
    onChanged: () => {
      this.taskbar.render(this.windowList());
      this.onWindowsChanged();
    },
  };

  /** Open a window; returns it so the caller can mount content into `.content`. */
  open(opts: WindowOptions): Win {
    const id = this.nextId++;
    // Place a new window in the emptiest spot (least overlap with existing visible
    // windows) when the caller didn't pin a position — so launched apps tile into
    // free desktop space instead of cascading on top of the terminal. A restored
    // window (session geometry) pins both coords and keeps them.
    const spot =
      opts.x !== undefined && opts.y !== undefined
        ? { x: opts.x, y: opts.y }
        : opts.centered
          ? this.center(opts.width, opts.height)
          : this.place(opts.width, opts.height);
    const placed: WindowOptions = { ...opts, x: spot.x, y: spot.y };
    const win = new Win(id, placed, this.delegate);
    this.wins.set(id, win);
    this.zorder.push(id);
    this.desktop.appendChild(win.root);
    this.focus(id);
    this.onWindowOpened(win);
    this.onWindowsChanged();
    return win;
  }

  /** Top-left that centers a `w`×`h` window in the workspace (above the taskbar). */
  private center(w: number, h: number): { x: number; y: number } {
    const taskbarH = 36;
    const wsW = this.desktop.clientWidth || window.innerWidth;
    const wsH = (this.desktop.clientHeight || window.innerHeight) - taskbarH;
    return { x: Math.max(8, Math.round((wsW - w) / 2)), y: Math.max(8, Math.round((wsH - h) / 2)) };
  }

  /** Choose a top-left for a new `w`×`h` window that overlaps existing visible
   * windows the least (a light tiling). Scans a coarse grid of the workspace and
   * keeps the lowest-overlap slot, preferring the top-left; returns immediately on
   * a fully free slot. Falls back to the top-left margin when the desktop is full. */
  private place(w: number, h: number): { x: number; y: number } {
    const margin = 8;
    const taskbarH = 36; // keep windows clear of the bottom taskbar
    const wsW = this.desktop.clientWidth || window.innerWidth;
    const wsH = (this.desktop.clientHeight || window.innerHeight) - taskbarH;
    const maxX = Math.max(margin, wsW - w - margin);
    const maxY = Math.max(margin, wsH - h - margin);
    const rects = [...this.wins.values()]
      .filter((win) => win.isVisible())
      .map((win) => win.geometry());
    const step = Compositor.PLACE_STEP;
    let best = { x: margin, y: margin };
    let bestScore = Infinity;
    for (let y = margin; y <= maxY; y += step) {
      for (let x = margin; x <= maxX; x += step) {
        let overlap = 0;
        for (const g of rects) {
          const ox = Math.max(0, Math.min(x + w, g.x + g.w) - Math.max(x, g.x));
          const oy = Math.max(0, Math.min(y + h, g.y + g.h) - Math.max(y, g.y));
          overlap += ox * oy;
        }
        const score = overlap * 1_000_000 + x + y; // least overlap, then most top-left
        if (score < bestScore) {
          bestScore = score;
          best = { x, y };
          if (overlap === 0) return best; // a fully free slot — take it
        }
      }
    }
    return best;
  }

  close(id: number): void {
    const win = this.wins.get(id);
    if (!win) return;
    win.root.remove();
    this.wins.delete(id);
    this.zorder = this.zorder.filter((z) => z !== id);
    if (this.activeId === id) {
      this.activeId = null;
      // Focus the next-highest visible window.
      for (let i = this.zorder.length - 1; i >= 0; i--) {
        const wid = this.zorder[i];
        if (wid === undefined) continue;
        const w = this.wins.get(wid);
        if (w && w.isVisible()) {
          this.focus(wid);
          break;
        }
      }
    }
    this.taskbar.render(this.windowList());
    this.onWindowClosed(id, win.ownerPid);
    this.onWindowsChanged();
  }

  focus(id: number): void {
    const win = this.wins.get(id);
    if (!win) return;
    win.restore(); // un-minimize if needed
    // Raise to top of the z-stack.
    this.zorder = this.zorder.filter((z) => z !== id);
    this.zorder.push(id);
    this.zorder.forEach((wid, i) => this.wins.get(wid)?.setZ(this.baseZ + i));
    // Mark active.
    if (this.activeId !== null && this.activeId !== id) {
      this.wins.get(this.activeId)?.setActive(false);
    }
    this.activeId = id;
    win.setActive(true);
    // DOM-focus coordination: a focused CANVAS window receives keyboard through
    // the input broker (window-level listener), so the terminal's xterm must not
    // also capture keystrokes — blur it. A DOM window keeps its content focusable.
    if (win.surface === "canvas") {
      (document.activeElement as HTMLElement | null)?.blur?.();
    }
    this.taskbar.render(this.windowList());
  }

  get(id: number): Win | undefined {
    return this.wins.get(id);
  }

  /** Close every window owned by `ownerPid` (used when a process exits/traps). */
  closeByOwner(ownerPid: number): void {
    const ids = [...this.wins.values()].filter((w) => w.ownerPid === ownerPid).map((w) => w.id);
    for (const id of ids) this.close(id);
  }

  /** Wire the taskbar launcher menu to a fixed app list (launcher and window lifecycle). */
  setLauncherApps(apps: Array<{ label: string; launch: () => void }>): void {
    this.taskbar.setApps(apps);
  }

  activeWindow(): Win | undefined {
    return this.activeId !== null ? this.wins.get(this.activeId) : undefined;
  }

  private windowList(): Array<{ id: number; title: string; minimized: boolean; active: boolean }> {
    return this.zorder.map((id) => {
      const w = this.wins.get(id)!;
      return { id, title: w.title, minimized: w.getState() === "minimized", active: this.activeId === id };
    });
  }
}

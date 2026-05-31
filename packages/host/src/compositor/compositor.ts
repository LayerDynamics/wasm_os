/**
 * Compositor (L3 / M3) — the window manager (FR-21, FR-22).
 *
 * Single authority for window lifecycle, z-order, and focus. Windows ask it to
 * focus/close via the WindowDelegate; it keeps a z-ordered stack (raise on
 * focus), tracks the active window, and drives the taskbar. The terminal mounts
 * as the first window (a DOM surface); process-owned canvas windows (M3-T2) plug
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
  private cascade = 0;

  /** Notified when a window closes (so owners can reap a backing process). */
  onWindowClosed: (id: number, ownerPid?: number) => void = () => {};

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
    onChanged: () => this.taskbar.render(this.windowList()),
  };

  /** Open a window; returns it so the caller can mount content into `.content`. */
  open(opts: WindowOptions): Win {
    const id = this.nextId++;
    // Cascade initial placement when the caller didn't pin a position.
    const placed: WindowOptions = {
      ...opts,
      x: opts.x ?? 24 + (this.cascade % 6) * 28,
      y: opts.y ?? 24 + (this.cascade % 6) * 28,
    };
    this.cascade++;
    const win = new Win(id, placed, this.delegate);
    this.wins.set(id, win);
    this.zorder.push(id);
    this.desktop.appendChild(win.root);
    this.focus(id);
    return win;
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
    this.taskbar.render(this.windowList());
  }

  get(id: number): Win | undefined {
    return this.wins.get(id);
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

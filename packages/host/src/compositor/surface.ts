/**
 * Surface manager (L3 / M3) — presents process-owned framebuffers.
 *
 * A process requests a surface (`win_surface`); the host process worker allocates
 * a `width*height*4` RGBA `SharedArrayBuffer` and the kworker relays it here. We
 * open a canvas window and, on each present signal, blit the shared framebuffer
 * to the `<canvas>` on the next animation frame (coalesced, so a flood of presents
 * costs at most one blit per frame). Pixels never traverse the kernel ring.
 */
import type { Compositor } from "./compositor.js";
import type { Win } from "./window.js";
import type { SurfaceInfo } from "../boot.js";

interface ManagedSurface {
  win: Win;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  view: Uint8Array;
  dirty: boolean;
}

export class SurfaceManager {
  private surfaces = new Map<number, ManagedSurface>();
  /** surface_id -> the window id, so a window close can drop the surface. */
  private byWindow = new Map<number, number>();
  private rafScheduled = false;

  constructor(
    private compositor: Compositor,
    /** Title for a process-owned window, by owning pid (overridden in M3-T9). */
    private titleFor: (pid: number) => string = (pid) => `App (pid ${pid})`,
  ) {}

  /** A process created a surface: open its canvas window and bind the framebuffer. */
  onSurface(info: SurfaceInfo): void {
    const win = this.compositor.open({
      title: this.titleFor(info.pid),
      width: info.width + 2,
      height: info.height + 30, // + titlebar
      ownerPid: info.pid,
      surface: "canvas",
    });
    const canvas = document.createElement("canvas");
    canvas.width = info.width;
    canvas.height = info.height;
    win.content.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d canvas context unavailable");
    const image = ctx.createImageData(info.width, info.height);
    this.surfaces.set(info.surfaceId, {
      win,
      canvas,
      ctx,
      image,
      view: new Uint8Array(info.sab),
      dirty: false,
    });
    this.byWindow.set(win.id, info.surfaceId);
  }

  /** A process published a frame: schedule a blit. */
  onPresent(surfaceId: number): void {
    const s = this.surfaces.get(surfaceId);
    if (!s) return;
    s.dirty = true;
    this.scheduleBlit();
  }

  /** Drop the surface backing a closed window (M3-T9 owner reaping). */
  closeByWindow(windowId: number): number | undefined {
    const surfaceId = this.byWindow.get(windowId);
    if (surfaceId === undefined) return undefined;
    this.byWindow.delete(windowId);
    this.surfaces.delete(surfaceId);
    return surfaceId;
  }

  /** The owning pid of a surface's window (M3-T3 routes input to it). */
  ownerOfWindow(windowId: number): number | undefined {
    const surfaceId = this.byWindow.get(windowId);
    if (surfaceId === undefined) return undefined;
    return this.surfaces.get(surfaceId)?.win.ownerPid;
  }

  private scheduleBlit(): void {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      for (const s of this.surfaces.values()) {
        if (!s.dirty) continue;
        s.dirty = false;
        // RGBA bytes from the shared framebuffer → the canvas backing store.
        s.image.data.set(s.view);
        s.ctx.putImageData(s.image, 0, 0);
      }
    });
  }
}

/**
 * Compositor shared types (L3 / desktop compositor).
 *
 * A `Window` frames a content surface. In desktop compositor the only surface is a DOM node
 * (the terminal); the canvas/WebGL framebuffer surface for process-owned windows
 * arrives in canvas surfaces (`win_surface`). The kind is modeled now so the window chrome,
 * z-order, focus, and taskbar code is surface-agnostic from the start.
 */

export type SurfaceKind = "dom" | "canvas";

export type WinState = "normal" | "minimized" | "maximized";

export interface WindowOptions {
  title: string;
  width: number;
  height: number;
  /** Initial top-left; auto-cascaded by the compositor when omitted. */
  x?: number;
  y?: number;
  /** Owning process PID for a process-backed window (undefined = host app). */
  ownerPid?: number;
  surface?: SurfaceKind;
  /** Open centered in the workspace (overrides the default tiling placement) when
   *  the caller didn't pin x/y. Used for the Welcome guide. */
  centered?: boolean;
}

/** Callbacks a Window uses to ask the compositor to act on its behalf. */
export interface WindowDelegate {
  requestFocus(id: number): void;
  requestClose(id: number): void;
  /** Window state/title/geometry changed — the taskbar reflects it. */
  onChanged(id: number): void;
}

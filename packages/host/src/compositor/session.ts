/**
 * SessionManager — desktop session snapshot/restore (FR-35).
 *
 * Records the set of open *app* windows (which app, where, what size) to
 * `/home/.session.json` and re-opens them on the next boot, so a reload brings
 * back your desktop. The VFS already persists file CONTENTS (FR-30); this layer
 * persists the window/process layout on top of it.
 *
 * Identity: the launcher spawns an app through `launch(name)`, which records the
 * returned pid → app name. When a canvas window opens for that pid we tag it with
 * the app, so on save we know what to re-spawn. Saves are debounced (window drags
 * fire many change events); restore is guarded so re-opening doesn't re-save mid-
 * flight. The always-present terminal is a DOM window owned by the shell and is
 * never recorded (it is opened unconditionally at boot).
 */
import type { AsyncKernelControl } from "../boot.js";
import type { Compositor } from "./compositor.js";
import type { Win } from "./window.js";

type Geom = { x: number; y: number; w: number; h: number };
interface SessionEntry {
  app: string;
  geom: Geom;
}

const SESSION_PATH = "/home/.session.json";
const SAVE_DEBOUNCE_MS = 250;

export class SessionManager {
  private apps = new Map<string, () => Promise<number>>();
  private pidToApp = new Map<number, string>();
  private winApp = new Map<number, string>();
  private pendingGeom = new Map<string, Geom>();
  private transient = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private restoring = false;

  constructor(
    private control: AsyncKernelControl,
    private compositor: Compositor,
  ) {
    this.compositor.onWindowOpened = (win) => this.onWindowOpened(win);
    this.compositor.onWindowsChanged = () => this.scheduleSave();
  }

  /** Register a launchable app with the spawn closure that opens it (with its
   * capability set). The taskbar launcher and session restore share this. */
  register(name: string, spawn: () => Promise<number>): void {
    this.apps.set(name, spawn);
  }

  /** Mark an app as transient: its window is never recorded in the session
   *  snapshot and never re-opened by restore(). Its lifecycle is owned elsewhere
   *  — e.g. the Welcome guide, which opens on load until the user dismisses it. */
  setTransient(name: string): void {
    this.transient.add(name);
  }

  /** The registered app name a pid was launched as, if any (used to title its
   *  window by app rather than the generic "App (pid N)"). */
  appForPid(pid: number): string | undefined {
    return this.pidToApp.get(pid);
  }

  /** Launch an app by name, recording its pid so its window can be tagged. */
  async launch(name: string): Promise<number | undefined> {
    const spawn = this.apps.get(name);
    if (!spawn) return undefined;
    const pid = await spawn();
    this.pidToApp.set(pid, name);
    return pid;
  }

  /** Re-open the apps recorded in the last session, restoring their geometry. */
  async restore(): Promise<void> {
    let parsed: { apps?: SessionEntry[] } | undefined;
    try {
      parsed = JSON.parse(new TextDecoder().decode(await this.control.fsRead(SESSION_PATH)));
    } catch {
      return; // no saved session (first boot) or unreadable — nothing to restore
    }
    if (!parsed?.apps?.length) return;
    this.restoring = true;
    for (const entry of parsed.apps) {
      if (!this.apps.has(entry.app) || this.transient.has(entry.app)) continue;
      // Stash the geometry BEFORE launching so onWindowOpened applies it.
      if (entry.geom) this.pendingGeom.set(entry.app, entry.geom);
      await this.launch(entry.app);
    }
    this.restoring = false;
  }

  private onWindowOpened(win: Win): void {
    if (win.surface !== "canvas" || win.ownerPid === undefined) return; // app windows only
    const app = this.pidToApp.get(win.ownerPid);
    if (!app) return;
    if (this.transient.has(app)) return; // transient apps are never recorded/restored
    this.winApp.set(win.id, app);
    const geom = this.pendingGeom.get(app);
    if (geom) {
      win.setGeometry(geom);
      this.pendingGeom.delete(app);
    }
  }

  private scheduleSave(): void {
    if (this.restoring) return; // don't re-save while re-opening
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.save(), SAVE_DEBOUNCE_MS);
  }

  private async save(): Promise<void> {
    const apps: SessionEntry[] = [];
    for (const [winId, app] of this.winApp) {
      const win = this.compositor.get(winId);
      if (!win) {
        this.winApp.delete(winId); // window closed since we tagged it
        continue;
      }
      apps.push({ app, geom: win.geometry() });
    }
    await this.control.fsWrite(SESSION_PATH, new TextEncoder().encode(JSON.stringify({ apps })));
  }
}

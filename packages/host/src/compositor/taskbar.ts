/**
 * Taskbar (L3 / M3) — launcher button, per-window buttons, and a live clock
 * (FR-21). The launcher menu is populated in M3-T9 (app registry); here it is a
 * real, clickable button that the compositor owns. Window buttons focus/restore
 * their window; the clock updates every second.
 */

export interface TaskbarHost {
  focus(id: number): void;
  isActive(id: number): boolean;
}

export interface TaskbarWindow {
  id: number;
  title: string;
  minimized: boolean;
  active: boolean;
}

export class Taskbar {
  private el: HTMLElement;
  private launcher: HTMLButtonElement;
  private winList: HTMLDivElement;
  private clock: HTMLSpanElement;
  /** Click handler for the launcher; wired to the app menu in M3-T9. */
  onLauncher: () => void = () => {};

  constructor(el: HTMLElement, private host: TaskbarHost) {
    this.el = el;
    this.el.classList.add("wasmos-taskbar");

    this.launcher = document.createElement("button");
    this.launcher.className = "wasmos-launcher";
    this.launcher.type = "button";
    this.launcher.textContent = "☰ Apps";
    this.launcher.addEventListener("click", () => this.onLauncher());

    this.winList = document.createElement("div");
    this.winList.className = "wasmos-tasks";

    this.clock = document.createElement("span");
    this.clock.className = "wasmos-clock";
    this.tickClock();
    // The interval is intentionally never cleared: the taskbar lives for the
    // whole session (the tab owns it), so there is nothing to tear down.
    setInterval(() => this.tickClock(), 1000);

    this.el.appendChild(this.launcher);
    this.el.appendChild(this.winList);
    this.el.appendChild(this.clock);
  }

  private tickClock(): void {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, "0");
    this.clock.textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  /** Rebuild the per-window buttons to match the live window set. */
  render(windows: TaskbarWindow[]): void {
    this.winList.replaceChildren();
    for (const w of windows) {
      const b = document.createElement("button");
      b.className = "wasmos-task";
      b.type = "button";
      b.dataset.winId = String(w.id);
      b.textContent = w.title;
      b.classList.toggle("wasmos-task-active", w.active);
      b.classList.toggle("wasmos-task-min", w.minimized);
      b.addEventListener("click", () => this.host.focus(w.id));
      this.winList.appendChild(b);
    }
  }
}

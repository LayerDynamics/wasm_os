/**
 * Theme + wallpaper (L3 / M3, FR-26). A taskbar settings menu picks a desktop
 * wallpaper and a light/dark theme; the choice is persisted to `/home/.desktop.json`
 * via the VFS and reapplied on boot, so it survives a reload (FR-30 persistence).
 */
import type { AsyncKernelControl } from "../boot.js";

interface Wallpaper {
  name: string;
  css: string;
}

const WALLPAPERS: Wallpaper[] = [
  { name: "Midnight", css: "linear-gradient(135deg, #1a1d23, #0d1117)" },
  { name: "Ocean", css: "linear-gradient(135deg, #1e3a5f, #0a1929)" },
  { name: "Forest", css: "linear-gradient(135deg, #1b3a2b, #0d1f15)" },
  { name: "Plum", css: "linear-gradient(135deg, #2d1b3a, #1a0d24)" },
];
const DEFAULT_WP = WALLPAPERS[0]!;
const SETTINGS_PATH = "/home/.desktop.json";

interface Settings {
  wallpaper: string;
  theme: "dark" | "light";
}

export class ThemeManager {
  private settings: Settings = { wallpaper: DEFAULT_WP.name, theme: "dark" };
  private menu: HTMLDivElement;

  constructor(
    private control: AsyncKernelControl,
    private desktop: HTMLElement,
    taskbarEl: HTMLElement,
  ) {
    const btn = document.createElement("button");
    btn.className = "wasmos-settings";
    btn.type = "button";
    btn.textContent = "⚙";

    this.menu = document.createElement("div");
    this.menu.className = "wasmos-settings-menu";
    this.menu.style.display = "none";
    this.buildMenu();

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.menu.style.display = this.menu.style.display === "none" ? "block" : "none";
    });
    document.addEventListener("click", () => {
      this.menu.style.display = "none";
    });

    taskbarEl.appendChild(btn);
    taskbarEl.appendChild(this.menu);
    void this.load();
  }

  private buildMenu(): void {
    this.menu.replaceChildren();
    const label = document.createElement("div");
    label.className = "wasmos-settings-label";
    label.textContent = "Wallpaper";
    this.menu.appendChild(label);

    const row = document.createElement("div");
    row.className = "wasmos-wallpaper-row";
    for (const wp of WALLPAPERS) {
      const sw = document.createElement("button");
      sw.className = "wasmos-wallpaper";
      sw.type = "button";
      sw.title = wp.name;
      sw.dataset.name = wp.name;
      sw.style.background = wp.css;
      sw.addEventListener("click", (e) => {
        e.stopPropagation();
        this.settings.wallpaper = wp.name;
        this.apply();
        void this.save();
      });
      row.appendChild(sw);
    }
    this.menu.appendChild(row);

    const toggle = document.createElement("button");
    toggle.className = "wasmos-theme-toggle";
    toggle.type = "button";
    toggle.textContent = "Toggle light / dark";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      this.settings.theme = this.settings.theme === "dark" ? "light" : "dark";
      this.apply();
      void this.save();
    });
    this.menu.appendChild(toggle);
  }

  private apply(): void {
    const wp = WALLPAPERS.find((w) => w.name === this.settings.wallpaper) ?? DEFAULT_WP;
    this.desktop.style.background = wp.css;
    this.desktop.dataset.wallpaper = wp.name;
    document.body.dataset.theme = this.settings.theme;
  }

  private async load(): Promise<void> {
    try {
      const bytes = await this.control.fsRead(SETTINGS_PATH);
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<Settings>;
      if (parsed.wallpaper) this.settings.wallpaper = parsed.wallpaper;
      if (parsed.theme === "dark" || parsed.theme === "light") this.settings.theme = parsed.theme;
    } catch {
      // No saved settings yet — keep the defaults.
    }
    this.apply();
  }

  private async save(): Promise<void> {
    await this.control.fsWrite(SETTINGS_PATH, new TextEncoder().encode(JSON.stringify(this.settings)));
  }
}

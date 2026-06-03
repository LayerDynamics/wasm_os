import { useEffect, useRef, useState } from "react";
import { startDesktop } from "@wasmos/host";

type Phase = "booting" | "ready" | "error";

/**
 * The WASM_OS web client shell. React owns the page chrome — a boot splash, the
 * status readout, and the desktop/taskbar containers — and on mount hands those
 * containers to the host runtime's `startDesktop`, which boots the kernel and brings
 * up the full OS (compositor windows, terminal, app launcher, the TinyEMU RISC-V emulator).
 * The compositor renders real DOM/canvas windows into the desktop container.
 */
export function App() {
  const desktopRef = useRef<HTMLDivElement>(null);
  const taskbarRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const [phase, setPhase] = useState<Phase>("booting");
  const [status, setStatus] = useState("booting the kernel…");

  useEffect(() => {
    // Guard against React 18 StrictMode's double-invoke (we must boot exactly once).
    if (started.current) return;
    started.current = true;
    const desktop = desktopRef.current;
    const taskbar = taskbarRef.current;
    if (!desktop || !taskbar) return;
    startDesktop({
      desktop,
      taskbar,
      welcomeOnLoad: true, // open the centered Welcome guide on load until dismissed
      onStatus: (text) => {
        setStatus(text);
        setPhase("ready");
      },
    }).catch((e: unknown) => {
      setStatus(`boot failed: ${String(e)}`);
      setPhase("error");
    });
  }, []);

  return (
    <div className="wasmos-root">
      <div id="desktop" ref={desktopRef} className="wasmos-desktop" />
      <div id="taskbar" ref={taskbarRef} className="wasmos-taskbar-host" />
      <div id="status" className={`wasmos-status wasmos-status-${phase}`}>{status}</div>
      {phase === "booting" && (
        <div className="wasmos-bootsplash" role="status" aria-live="polite">
          <div className="wasmos-bootsplash-logo">WASM_OS</div>
          <div className="wasmos-bootsplash-sub">an operating system in a browser tab</div>
          <div className="wasmos-bootsplash-status">{status}</div>
        </div>
      )}
      {phase === "error" && (
        <div className="wasmos-bootsplash wasmos-bootsplash-error" role="alert">
          <div className="wasmos-bootsplash-logo">WASM_OS</div>
          <div className="wasmos-bootsplash-status">{status}</div>
        </div>
      )}
    </div>
  );
}

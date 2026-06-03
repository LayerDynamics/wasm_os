import { useEffect, useRef, useState } from "react";
import { startDesktop, isCrossOriginIsolated } from "@wasmos/host";

type Phase = "booting" | "ready" | "error" | "unsupported";

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
    // Bail BEFORE booting if the context can't provide SharedArrayBuffer — render
    // actionable guidance rather than letting the kernel crash on first use.
    if (!isCrossOriginIsolated()) {
      setPhase("unsupported");
      return;
    }
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
      {phase === "unsupported" && (
        <div className="wasmos-bootsplash wasmos-bootsplash-error" role="alert">
          <div className="wasmos-bootsplash-logo">WASM_OS</div>
          <div className="wasmos-bootsplash-sub">this browser can’t run WASM_OS here</div>
          <div className="wasmos-bootsplash-status">
            WASM_OS runs a real kernel using <code>SharedArrayBuffer</code>, which needs a
            cross-origin-isolated context your browser hasn’t enabled on this page.
          </div>
          <ul className="wasmos-bootsplash-help">
            <li>
              Opened from inside another app (a link in a messenger, X, Instagram…)? Tap the
              ••• or share menu and choose <b>Open in Safari</b> / <b>Open in Chrome</b>.
            </li>
            <li>Or paste the link straight into your browser’s address bar.</li>
            <li>Make sure your browser and OS are up to date (iOS 16+, a recent Chrome).</li>
          </ul>
        </div>
      )}
    </div>
  );
}

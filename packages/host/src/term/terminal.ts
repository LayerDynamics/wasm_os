/**
 * Terminal (L3-lite) — binds an xterm.js terminal to a shell process (FR-15).
 *
 * Kernel → terminal: the kworker streams a terminal-bound process's stdout/
 * stderr (`onOutput`); we write it to xterm and accumulate a plain-text log the
 * E2E can assert on (decoupled from xterm's visual buffer).
 *
 * Terminal → kernel: keystrokes are locally echoed and delivered to the shell's
 * stdin via `control.stdin` (the shell parks on a read until they arrive).
 */
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AsyncKernelControl } from "../boot.js";

export interface TerminalSession {
  term: Terminal;
  /** All text written to the terminal so far (for tests/inspection). */
  log(): string;
}

export function attachTerminal(
  element: HTMLElement,
  control: AsyncKernelControl,
  shellPid: number,
): TerminalSession {
  const term = new Terminal({ convertEol: true, cursorBlink: true, fontSize: 14, cols: 80, rows: 24 });
  term.open(element);
  term.focus();

  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let logText = "";

  // Single sink: everything shown on the terminal is also accumulated in the log.
  const write = (text: string) => {
    term.write(text);
    logText += text;
  };

  // Kernel → terminal.
  control.onOutput((_pid, bytes) => write(dec.decode(bytes)));

  // Terminal → kernel (local echo, then deliver to the shell's stdin).
  //
  // We must NOT blindly echo raw input back into xterm: pressing an arrow/function
  // key makes xterm emit an escape sequence (e.g. ESC[A), and writing that straight
  // back into xterm's own parser produces "Parsing error" spam. The shell is also
  // line-oriented and has no use for cursor-movement keys. So:
  //   • Enter (CR)         → echo CRLF, send "\n" to the shell.
  //   • escape sequences   → dropped (not echoed, not forwarded).
  //   • printable text      → echoed and forwarded verbatim.
  //   • other control bytes → forwarded to the shell (e.g. Ctrl-C) but not echoed.
  const isPrintable = (s: string) =>
    s.length > 0 && [...s].every((ch) => { const c = ch.charCodeAt(0); return c >= 0x20 && c !== 0x7f; });
  term.onData((data) => {
    if (data === "\r") {
      write("\r\n");
      void control.stdin(shellPid, enc.encode("\n"));
      return;
    }
    if (data.charCodeAt(0) === 0x1b) return; // ESC-prefixed: arrows, F-keys, etc.
    if (isPrintable(data)) write(data);
    void control.stdin(shellPid, enc.encode(data));
  });

  return { term, log: () => logText };
}

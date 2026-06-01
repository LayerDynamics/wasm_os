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

  // Terminal → kernel: a minimal line discipline (local echo + Backspace), then
  // deliver to the shell's stdin. Only ordinary line input reaches the shell:
  //   • Enter (CR)       → echo CRLF, send "\n", reset the line.
  //   • Backspace / DEL  → visually erase the last typed char (never into the
  //                        prompt) and send DEL so the shell drops it from its line.
  //   • printable text    → echoed and forwarded verbatim.
  //   • everything else   → dropped. Escape sequences (arrows/F-keys) would corrupt
  //                        xterm's own parser if echoed, and raw control bytes would
  //                        be pushed into the command by the line-oriented shell.
  //
  // `lineLen` tracks how many chars the user has typed on the CURRENT input line so
  // Backspace erases only that, staying in lockstep with the shell's line buffer.
  const isPrintable = (s: string) =>
    s.length > 0 && [...s].every((ch) => { const c = ch.charCodeAt(0); return c >= 0x20 && c !== 0x7f; });
  let lineLen = 0;
  term.onData((data) => {
    if (data === "\r") {
      write("\r\n");
      lineLen = 0;
      void control.stdin(shellPid, enc.encode("\n"));
      return;
    }
    if (data === "\x7f" || data === "\b") {
      if (lineLen > 0) {
        write("\b \b"); // cursor back, overwrite with space, cursor back
        lineLen -= 1;
        void control.stdin(shellPid, enc.encode("\x7f"));
      }
      return;
    }
    if (!isPrintable(data)) return; // ESC sequences + other control bytes
    write(data);
    lineLen += [...data].length;
    void control.stdin(shellPid, enc.encode(data));
  });

  return { term, log: () => logText };
}

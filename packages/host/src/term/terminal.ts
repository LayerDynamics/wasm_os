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
  term.onData((data) => {
    write(data === "\r" ? "\r\n" : data);
    const toSend = data === "\r" ? "\n" : data;
    void control.stdin(shellPid, enc.encode(toSend));
  });

  return { term, log: () => logText };
}

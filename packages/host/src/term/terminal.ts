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
  /** Move keyboard focus to the terminal's xterm textarea. The compositor calls
   *  this when the terminal window is (re)activated so typing reaches the shell. */
  focus(): void;
  /** The shell process the terminal is currently delivering keystrokes to. */
  shellPid(): number;
  /** Rebind the terminal to a freshly-respawned shell (the previous one exited).
   *  Keystrokes now go to `pid`; the input line is reset. */
  setShell(pid: number): void;
  /** Write a host notice (e.g. "shell restarted") into the terminal + log. */
  notice(text: string): void;
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
  // The shell the terminal talks to. Mutable: if the shell exits (e.g. `exit`, a
  // crash, or being killed), the host respawns a fresh one and rebinds via setShell
  // so the terminal keeps working instead of becoming a dead echo-only box.
  let currentShell = shellPid;

  // Single sink: everything shown on the terminal is also accumulated in the log.
  const write = (text: string) => {
    term.write(text);
    logText += text;
  };

  // Kernel → terminal.
  control.onOutput((_pid, bytes) => write(dec.decode(bytes)));

  // Terminal → kernel: a minimal line discipline (local echo + Backspace), then
  // deliver to the shell's stdin. A single `onData` chunk can carry many characters
  // at once — most importantly a PASTE such as "ls\n" or text containing tabs — so
  // we process it character-by-character, batching runs of printable text and
  // handling control characters individually:
  //   • CR / LF          → flush pending text, echo CRLF, send "\n", reset the line.
  //   • Backspace / DEL  → flush pending text, visually erase the last typed char
  //                        (never into the prompt) and send DEL so the shell drops it.
  //   • printable text    → batched, then echoed + forwarded verbatim.
  //   • other control bytes (tab, Ctrl-keys, …) → dropped (a line-oriented shell has
  //                        no use for them and they would corrupt the command).
  // A chunk that begins with ESC is an escape sequence (arrow/F-key); we drop the
  // whole chunk so its "[A"/"[B" tail is never inserted into the command line.
  //
  // `lineLen` tracks how many chars the user has typed on the CURRENT input line so
  // Backspace erases only that, staying in lockstep with the shell's line buffer.
  let lineLen = 0;
  term.onData((data) => {
    if (data.charCodeAt(0) === 0x1b) return; // ESC-prefixed: arrows, F-keys, etc.
    let pending = "";
    const flush = () => {
      if (pending.length === 0) return;
      write(pending);
      lineLen += [...pending].length;
      void control.stdin(currentShell, enc.encode(pending));
      pending = "";
    };
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        flush();
        write("\r\n");
        lineLen = 0;
        void control.stdin(currentShell, enc.encode("\n"));
      } else if (ch === "\x7f" || ch === "\b") {
        flush();
        if (lineLen > 0) {
          write("\b \b"); // cursor back, overwrite with space, cursor back
          lineLen -= 1;
          void control.stdin(currentShell, enc.encode("\x7f"));
        }
      } else {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code !== 0x7f) pending += ch; // printable; drop other control bytes
      }
    }
    flush();
  });

  return {
    term,
    log: () => logText,
    focus: () => term.focus(),
    shellPid: () => currentShell,
    setShell: (pid: number) => {
      currentShell = pid;
      lineLen = 0; // the fresh shell starts at a clean prompt
    },
    notice: (text: string) => write(text),
  };
}

/**
 * Terminal (L3-lite) — binds an xterm.js terminal to a shell process (FR-15).
 *
 * Kernel → terminal: the kworker streams a terminal-bound process's stdout/
 * stderr (`onOutput`); we write it to xterm and accumulate a plain-text log the
 * E2E can assert on (decoupled from xterm's visual buffer).
 *
 * Terminal → kernel: keystrokes are delivered to the terminal's foreground job
 * via `control.terminalInput` (the kworker routes them to the running program,
 * else the shell). In COOKED mode (the default) we apply a minimal line
 * discipline — local echo, Backspace, line buffering — and drop escape/control
 * bytes a line-oriented shell can't use. A foreground program can switch the
 * terminal to RAW mode (`tty_set_raw`, e.g. nano): then we stop echoing and line
 * buffering and forward every byte verbatim — arrows, Ctrl-keys and all — so the
 * program reads keys one at a time and owns the screen.
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

  // Raw vs cooked line discipline. A foreground program (nano) flips this via
  // `tty_set_raw`; the kworker tells us. On any change we reset the cooked input
  // line so the two disciplines never share stale state. The kworker also forces
  // cooked mode back if the program exits while raw (so the terminal can't brick).
  // `lineLen` tracks how many chars the user has typed on the CURRENT input line so
  // Backspace erases only that, staying in lockstep with the shell's line buffer.
  let lineLen = 0;
  let rawMode = false;
  control.onTermMode((raw) => {
    rawMode = raw;
    lineLen = 0;
  });

  // Terminal → kernel: deliver keystrokes to the terminal's foreground job (the
  // kworker routes them to the running program, else the shell).
  //
  // RAW mode (a full-screen program like nano): forward every byte verbatim —
  // printable, control bytes, and ESC sequences (arrow keys arrive as "\x1b[A"
  // etc.) — with NO local echo and NO line buffering. The program reads keys one
  // at a time and repaints the screen itself.
  //
  // COOKED mode (the default shell line discipline): a single `onData` chunk can
  // carry many characters at once — most importantly a PASTE such as "ls\n" — so
  // we process it character-by-character, batching runs of printable text and
  // handling control characters individually:
  //   • CR / LF          → flush pending text, echo CRLF, send "\n", reset the line.
  //   • Backspace / DEL  → flush pending text, visually erase the last typed char
  //                        (never into the prompt) and send DEL so the shell drops it.
  //   • printable text    → batched, then echoed + forwarded verbatim.
  //   • other control bytes (tab, Ctrl-keys, …) → dropped (a line-oriented shell has
  //                        no use for them and they would corrupt the command).
  // Escape sequences (arrow/F-keys) are skipped IN PLACE — only the sequence
  // itself is dropped, so ordinary text typed or pasted in the same chunk still
  // reaches the command line (and a sequence's "[A"/"[B" tail is never inserted).
  term.onData((data) => {
    if (rawMode) {
      // Pass through unchanged; the foreground program owns echo + rendering.
      void control.terminalInput(enc.encode(data));
      return;
    }
    let pending = "";
    const flush = () => {
      if (pending.length === 0) return;
      write(pending);
      lineLen += [...pending].length;
      void control.terminalInput(enc.encode(pending));
      pending = "";
    };
    const chars = [...data];
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i]!; // in-bounds per the loop condition
      if (ch === "\x1b") {
        // Skip a terminal escape sequence in place rather than discarding the rest
        // of the chunk. CSI: ESC [ params… final(0x40–0x7e). SS3: ESC O final.
        i++;
        if (chars[i] === "[") {
          i++;
          while (i < chars.length) {
            const c = chars[i]!.charCodeAt(0); // in-bounds per the loop condition
            i++;
            if (c >= 0x40 && c <= 0x7e) break; // CSI final byte ends the sequence
          }
        } else if (chars[i] === "O") {
          i += 2; // ESC O <final>
        } else {
          i++; // bare ESC or ESC <char>
        }
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        flush();
        write("\r\n");
        lineLen = 0;
        void control.terminalInput(enc.encode("\n"));
      } else if (ch === "\x7f" || ch === "\b") {
        flush();
        if (lineLen > 0) {
          write("\b \b"); // cursor back, overwrite with space, cursor back
          lineLen -= 1;
          void control.terminalInput(enc.encode("\x7f"));
        }
      } else {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code !== 0x7f) pending += ch; // printable; drop other control bytes
      }
      i++;
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

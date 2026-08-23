/**
 * Terminal — binds an xterm.js terminal to a shell process (FR-15).
 *
 * Kernel → terminal: the kworker streams a terminal-bound process's stdout/
 * stderr (`onOutput`); we write it to xterm and accumulate a plain-text log the
 * E2E can assert on (decoupled from xterm's visual buffer).
 *
 * Terminal → kernel: keystrokes are delivered to the terminal's foreground job
 * via `control.terminalInput` (the kworker routes them to the running program,
 * else the shell). In COOKED mode (the default) the host owns line editing:
 * printable text is echoed immediately, cursor movement and history stay local,
 * and the completed UTF-8 line is sent to the foreground job on Enter. A
 * foreground program can switch the terminal to RAW mode (`tty_set_raw`, e.g.
 * nano): then we stop echoing and line buffering and forward every byte
 * verbatim — arrows, Ctrl-keys and all — so the program reads keys one at a
 * time and owns the screen.
 */
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { AsyncKernelControl } from "../boot.js";
import type { InputMetrics } from "../compositor/input.js";

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
  metrics?: InputMetrics,
): TerminalSession {
  const term = new Terminal({
    convertEol: true,
    cursorBlink: true,
    fontSize: 14,
    scrollback: 2_000,
    cols: 80,
    rows: 24,
  });
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
    term.write(text, () => metrics?.markTerminalEcho());
    logText += text;
  };

  // Raw vs cooked line discipline. A foreground program (nano) flips this via
  // `tty_set_raw`; the kworker tells us. On any change we reset the cooked input
  // line so the two disciplines never share stale state. The kworker also forces
  // cooked mode back if the program exits while raw (so the terminal can't brick).
  let rawMode = false;
  let inputLine = "";
  let cursor = 0;
  const history: string[] = [];
  let historyIndex = -1;
  let historyDraft = "";
  let pendingEscape = "";

  const moveCursorLeft = (count: number) => {
    if (count > 0) write(`\x1b[${count}D`);
  };

  const moveCursorRight = (count: number) => {
    if (count > 0) write(`\x1b[${count}C`);
  };

  // The shell has already printed the prompt. Redraw only the part after it by
  // moving back from the current input cursor, erasing the old line, writing the
  // new line, and moving back to the requested logical cursor position.
  const redrawLine = (nextLine: string, nextCursor: number) => {
    moveCursorLeft(cursor);
    write("\x1b[K");
    write(nextLine);
    moveCursorLeft([...nextLine].length - nextCursor);
    inputLine = nextLine;
    cursor = nextCursor;
  };

  const clearLine = () => {
    historyIndex = -1;
    historyDraft = "";
    redrawLine("", 0);
  };

  const insertText = (text: string) => {
    if (historyIndex !== -1) {
      historyIndex = -1;
      historyDraft = "";
    }
    const next = [...inputLine];
    const inserted = [...text];
    next.splice(cursor, 0, ...inserted);
    redrawLine(next.join(""), cursor + inserted.length);
  };

  const deletePrevious = () => {
    if (cursor === 0) return;
    if (historyIndex !== -1) {
      historyIndex = -1;
      historyDraft = "";
    }
    const next = [...inputLine];
    next.splice(cursor - 1, 1);
    redrawLine(next.join(""), cursor - 1);
  };

  const deleteAtCursor = () => {
    const next = [...inputLine];
    if (cursor >= next.length) return;
    if (historyIndex !== -1) {
      historyIndex = -1;
      historyDraft = "";
    }
    next.splice(cursor, 1);
    redrawLine(next.join(""), cursor);
  };

  const historyUp = () => {
    if (history.length === 0) return;
    if (historyIndex === -1) {
      historyDraft = inputLine;
      historyIndex = history.length - 1;
    } else if (historyIndex > 0) {
      historyIndex--;
    }
    const recalled = history[historyIndex];
    if (recalled !== undefined) redrawLine(recalled, [...recalled].length);
  };

  const historyDown = () => {
    if (historyIndex === -1) return;
    if (historyIndex < history.length - 1) {
      historyIndex++;
      const recalled = history[historyIndex]!;
      redrawLine(recalled, [...recalled].length);
    } else {
      historyIndex = -1;
      redrawLine(historyDraft, [...historyDraft].length);
      historyDraft = "";
    }
  };

  const deleteWord = () => {
    if (cursor === 0) return;
    const chars = [...inputLine];
    let start = cursor;
    while (start > 0 && /\s/.test(chars[start - 1]!)) start--;
    while (start > 0 && !/\s/.test(chars[start - 1]!)) start--;
    if (start !== cursor) {
      if (historyIndex !== -1) {
        historyIndex = -1;
        historyDraft = "";
      }
      chars.splice(start, cursor - start);
      redrawLine(chars.join(""), start);
    }
  };

  const submitLine = () => {
    const line = inputLine;
    if (line.length > 0 && history[history.length - 1] !== line) history.push(line);
    historyIndex = -1;
    historyDraft = "";
    inputLine = "";
    cursor = 0;
    write("\r\n");
    void control.terminalInput(enc.encode(`${line}\n`));
  };

  const handleEscapeSequence = (sequence: string) => {
    const final = sequence[sequence.length - 1];
    if (final === undefined) return;
    if (sequence.startsWith("\x1bO")) {
      if (final === "A") historyUp();
      else if (final === "B") historyDown();
      else if (final === "C") {
        if (cursor < [...inputLine].length) {
          cursor++;
          moveCursorRight(1);
        }
      } else if (final === "D") {
        if (cursor > 0) {
          cursor--;
          moveCursorLeft(1);
        }
      } else if (final === "H") redrawLine(inputLine, 0);
      else if (final === "F") redrawLine(inputLine, [...inputLine].length);
      return;
    }

    if (!sequence.startsWith("\x1b[")) return;
    const body = sequence.slice(2, -1);
    if (final === "A") historyUp();
    else if (final === "B") historyDown();
    else if (final === "C") {
      if (cursor < [...inputLine].length) {
        cursor++;
        moveCursorRight(1);
      }
    } else if (final === "D") {
      if (cursor > 0) {
        cursor--;
        moveCursorLeft(1);
      }
    } else if (final === "H" || (final === "~" && (body === "1" || body === "7"))) {
      redrawLine(inputLine, 0);
    } else if (final === "F" || (final === "~" && (body === "4" || body === "8"))) {
      redrawLine(inputLine, [...inputLine].length);
    } else if (final === "~" && body === "3") {
      deleteAtCursor();
    } else if (final === "~" && (body === "5" || body === "6")) {
      if (body === "5") historyUp();
      else historyDown();
    }
  };

  const processCookedInput = (data: string) => {
    const chars = [...pendingEscape, ...data];
    pendingEscape = "";
    let i = 0;
    while (i < chars.length) {
      const ch = chars[i]!;
      if (ch === "\x1b") {
        const next = chars[i + 1];
        if (next === undefined) {
          pendingEscape = ch;
          break;
        }
        if (next === "[" || next === "O") {
          let end = i + 2;
          while (end < chars.length) {
            const code = chars[end]!.charCodeAt(0);
            if (code >= 0x40 && code <= 0x7e) break;
            end++;
          }
          if (end >= chars.length) {
            pendingEscape = chars.slice(i).join("");
            break;
          }
          handleEscapeSequence(chars.slice(i, end + 1).join(""));
          i = end + 1;
          continue;
        }
        i += 2;
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        submitLine();
      } else if (ch === "\x7f" || ch === "\b") {
        deletePrevious();
      } else if (ch === "\x01") {
        redrawLine(inputLine, 0);
      } else if (ch === "\x05") {
        redrawLine(inputLine, [...inputLine].length);
      } else if (ch === "\x15") {
        clearLine();
      } else if (ch === "\x17") {
        deleteWord();
      } else if (ch === "\x03") {
        clearLine();
        write("^C\r\n");
        void control.terminalInput(enc.encode("\n"));
      } else if (ch === "\x04") {
        deleteAtCursor();
      } else if (ch === "\t") {
        insertText("    ");
      } else if (ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f) {
        insertText(ch);
      }
      i++;
    }
  };

  control.onTermMode((raw) => {
    rawMode = raw;
    inputLine = "";
    cursor = 0;
    historyIndex = -1;
    historyDraft = "";
    pendingEscape = "";
  });

  // Kernel → terminal.
  control.onOutput((_pid, bytes) => write(dec.decode(bytes)));

  // Terminal → kernel: deliver keystrokes to the terminal's foreground job (the
  // kworker routes them to the running program, else the shell).
  //
  // RAW mode (a full-screen program like nano): forward every byte verbatim —
  // printable, control bytes, and ESC sequences (arrow keys arrive as "\x1b[A"
  // etc.) — with NO local echo and NO line buffering. The program reads keys one
  // at a time and repaints the screen itself.
  //
  // COOKED mode (the default shell line discipline): xterm can deliver ordinary
  // typing, paste, and escape sequences in separate or combined chunks. Keep the
  // editable line in the host, so the shell receives one complete UTF-8 command
  // only when Enter is pressed. This is what lets arrows, Home/End, Delete,
  // history, Ctrl editing keys, and paste behave like a normal terminal without
  // making the Rust shell implement a second line editor.
  term.onData((data) => {
    const sample = metrics?.beginTerminal(data);
    if (rawMode) {
      // Pass through unchanged; the foreground program owns echo + rendering.
      void control.terminalInput(enc.encode(data)).then((accepted) => {
        if (sample !== undefined) metrics?.deliveredByKernel(sample, accepted);
      }).catch(() => {
        if (sample !== undefined) metrics?.drop(sample);
      });
      return;
    }
    if (sample !== undefined) metrics?.deliveredByKernel(sample, true);
    processCookedInput(data);
  });

  return {
    term,
    log: () => logText,
    focus: () => term.focus(),
    shellPid: () => currentShell,
    setShell: (pid: number) => {
      currentShell = pid;
      inputLine = "";
      cursor = 0;
      historyIndex = -1;
      historyDraft = "";
      pendingEscape = "";
    },
    notice: (text: string) => write(text),
  };
}

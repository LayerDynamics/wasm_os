import { boot, type BootResult } from "./boot.js";
import { attachTerminal, type TerminalSession } from "./term/terminal.js";

/** Executables loaded into the VFS `/bin` at boot (tmpfs, repopulated each boot). */
const BIN = ["sh", "echo", "cat", "grep", "ls", "wc", "cp", "mv", "rm", "mkdir", "pwd", "head", "tail", "env"];
const GUESTS = "/packages/host/guests";

/** Boot result + cold-load timing + the running shell/terminal session. */
export type ReadyState = BootResult & {
  coldLoadMillis: number;
  shellPid: number;
  term: TerminalSession;
};

declare global {
  interface Window {
    __wasmos?: ReadyState;
  }
}

/** Fetch a built guest `.wasm` and install it into the VFS `/bin`. */
async function loadBin(control: BootResult["control"], name: string): Promise<ArrayBuffer> {
  const bytes = await (await fetch(`${GUESTS}/${name}.wasm`)).arrayBuffer();
  await control.fsWrite(`/bin/${name}`, new Uint8Array(bytes));
  return bytes;
}

async function main() {
  const result = await boot();
  // Capture full cold-load (navigation start → kernel ready) BEFORE the userland
  // spins up, so this stays comparable to M0/M1.
  const coldLoadMillis = Math.round(performance.now());
  const { control } = result;

  // Populate /bin, then launch the shell as a terminal-bound process.
  const bins: Record<string, ArrayBuffer> = {};
  for (const name of BIN) bins[name] = await loadBin(control, name);
  const shellPid = await control.spawn(bins.sh!, { name: "sh", grantSpawn: true, grantFsSubtree: "/" });
  await control.bindTerminal(shellPid);

  const el = document.getElementById("terminal") ?? document.body;
  const term = attachTerminal(el, control, shellPid);

  const state: ReadyState = { ...result, coldLoadMillis, shellPid, term };
  window.__wasmos = state;

  const status = document.getElementById("status");
  if (status) {
    status.textContent = `ready in ${coldLoadMillis}ms · tier ${result.features.tier} · shell pid ${shellPid}`;
  }
  window.dispatchEvent(
    new CustomEvent("wasmos:ready", { detail: { bootMillis: result.bootMillis, coldLoadMillis, features: result.features } }),
  );
}

main().catch((e) => {
  const el = document.getElementById("status");
  if (el) el.textContent = `boot failed: ${String(e)}`;
  throw e;
});

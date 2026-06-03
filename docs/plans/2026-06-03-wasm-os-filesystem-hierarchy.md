# WASM_OS — a real Unix filesystem hierarchy (FHS)

Date: 2026-06-03
Status: planned

## Goal

Give WASM_OS a proper, **real** (not simulated) Unix filesystem hierarchy:
`/bin /sbin /lib /usr /etc /var /tmp /opt /srv /mnt /media /proc /dev /root /run`
`/boot /home /Volumes`. Every directory is a real VFS directory on a real backend;
`/proc` and `/dev` are **real kernel-generated virtual filesystems** that reflect live
state (the actual process table, real entropy) exactly as Linux's procfs/devfs do —
never hardcoded contents. Config under `/etc` is **actually consumed** (PATH, hostname,
login banner), not decorative.

## Decisions (from planning)

- **Depth:** real structure end-to-end, including synthetic `/proc` + `/dev` backed by
  live kernel state. Nothing faked.
- **Dir set:** Linux FHS **+ `/Volumes`** (macOS-style mount-point dir).
- **Persistence:** persist almost everything. Ephemeral only where correctness demands
  it: `/tmp`, `/run` (scratch), `/proc`, `/dev` (synthetic), and `/bin`+`/usr/bin`+`/lib`
  (code that must match the *deployed* build — re-materialized each boot from the served
  wasm, never stale-persisted).

## Current architecture (verified)

- `crates/kernel/src/vfs.rs` — hierarchical tree over flat `key→bytes` backends, routed
  by **longest-prefix mount**. Backends today: `Tmpfs` (in-memory), `Opfs` (`/home`,
  persistent), `Idb` (`/mnt`, persistent). Dirs are implicit (any descendant key) or
  explicit (`\x01d:` marker). Full `mkdir`/`mkdir_p`/`rmdir`/`readdir`/`rename` exist.
- Root `/` is mounted on `Tmpfs` (`vfs.rs:79`). `kcore.rs:boot()` mounts `/home`→Opfs,
  `/mnt`→Idb.
- `/bin` is tmpfs, re-populated every boot by `index.ts` `loadBin` (host `fsWrite`).
- **`mkdir` is NOT exposed in the host control API** (`boot.ts`: mount/write/read/list/
  delete only) — must be added. Guests *can* mkdir via WASI `path_create_directory`.
- Shell resolves bare commands via `$PATH` (`sh/main.rs:240`, currently `/bin`); the
  default env sets `PATH=/bin` (`types.rs:254`).
- Entropy (`random_get`) is a host fact at the WASI-shim layer (`syscall.rs:197`), not
  the deterministic kernel — `/dev/random` routes there.

## Design

### Storage tiers (which backend each subtree mounts on)

| Tier | Dirs | Backend |
|------|------|---------|
| Persistent system | `/etc /var /opt /srv /root /usr/local /Volumes` | new `Sys` store (OPFS) |
| Persistent user | `/home` | Opfs (existing) |
| Persistent mounts | `/mnt` | Idb (existing) |
| Ephemeral scratch | `/tmp /run` | Tmpfs |
| Ephemeral code | `/bin /sbin /usr/bin /usr/sbin /lib /usr/lib` | Tmpfs (re-materialized each boot) |
| Synthetic (live) | `/proc /dev` | new `Proc` / `Dev` backends |
| Structural only | `/boot /media /usr` (parents) | Tmpfs markers |

A dedicated **`Sys` OPFS store** (separate from the user `home` store) keeps system
state cleanly separated and lets `/home` stay independently wipeable. (Alternative:
reuse the `home` store via additional `Opfs` mounts — keys are full paths so they can't
collide. The dedicated store is cleaner; this is the one cross-cutting design choice to
confirm at implementation.)

### Synthetic backends (the real engineering)

`vfs.rs` gains two synthetic, **read-mostly** backends whose contents are generated on
read from live kernel state rather than stored:

- **`/proc`** — `readdir` lists every live PID (from `kcore` process table) + the global
  files; `read("/proc/<pid>/status")`, `.../stat`, `.../cmdline`, `.../cwd`; globals
  `/proc/meminfo`, `/proc/uptime`, `/proc/mounts`, `/proc/self`, `/proc/version`,
  `/proc/cpuinfo`. Backed by the **actual** `procs`/`sched` state — same source as
  `listProcs`. Writes rejected (EROFS) except where Linux allows.
- **`/dev`** — device nodes with **real** semantics handled at the fs-op layer:
  `/dev/null` (writes discarded, reads EOF), `/dev/zero` (reads zero bytes), `/dev/full`
  (writes ENOSPC), `/dev/random`+`/dev/urandom` (reads → real host CSPRNG via the
  existing entropy path), `/dev/tty` (the terminal). `readdir(/dev)` lists the nodes.

Mechanism: add `Backend::Proc` / `Backend::Dev` variants; `kv_get`/`kv_keys`/`write`
dispatch to generator functions that borrow live kernel state. Because generators need
the process table, the synthetic read path lives in `kcore`/`syscall` (which own
`procs`), with `vfs` exposing a hook — keeps `vfs` testable and the kernel the single
source of truth.

## Phases

### Phase 0 — Plumbing (enables everything)
- Add `mkdir` / `mkdir-p` to the WIT interface (`wit/`), export in `kernel/src/lib.rs`,
  handle in `kernel-worker.ts` (`case "mkdirp"`), expose `fsMkdirp` in `boot.ts` control.
- Add a third persistent blockstore binding (`sys-store`, OPFS) end-to-end (WIT import,
  `OpfsBlockstore.create("sys")`, `Vfs::new` 3rd arg, `kernel-worker` init).
- Tests: control `fsMkdirp` round-trips; `Vfs` routes a `/etc` write to the sys store.

### Phase 1 — The real directory skeleton
- `kcore.rs:boot()` mounts the new subtrees on their tiers (table above) and `mkdir_p`s
  the full FHS so `ls /` shows the real hierarchy immediately.
- Persistent dirs survive reload (markers/files live in the sys/idb/opfs stores);
  ephemeral ones are recreated each boot.
- e2e: `ls /` lists the FHS; a file written to `/etc/x` and `/opt/x` survives reload;
  `/tmp/x` does not.

### Phase 2 — `/etc` actually consumed
- Materialize real `/etc/os-release`, `/etc/hostname` (`wasmos`), `/etc/motd`,
  `/etc/profile` (`PATH=/usr/bin:/bin:/sbin`), `/etc/passwd` (single `user`/`root`).
- Seed the shell/login `PATH` from `/etc/profile` (replace the hardcoded `PATH=/bin` in
  `types.rs`); print `/etc/motd` as the terminal login banner.
- e2e: `cat /etc/os-release`; a command in `/usr/bin` runs by bare name via the seeded
  PATH; the motd shows on boot.

### Phase 3 — Binaries across `/usr/bin` + `/sbin`
- `loadBin` materializes guests into `/usr/bin` (canonical) with `/bin` as the
  compatibility location; admin tools (`kill`, `renice`, `mount`-style) into `/sbin`.
- Verify `$PATH` resolution spans all three (`sh/main.rs` `resolve_cmd`).
- e2e: `ls /usr/bin` lists the coreutils; bare `ls` resolves from `/usr/bin`.

### Phase 4 — Synthetic `/proc` (live process data)
- Implement the `Proc` backend reading the real process table; wire `readdir`/`read`.
- `cat /proc/<pid>/status` reflects a real running app; `ls /proc` shows live PIDs that
  change as apps open/close; `/proc/mounts` lists the real mount table.
- Rust unit tests (fake process table) + e2e (`ls /proc` includes the shell's pid;
  launch an app → its pid appears).

### Phase 5 — Synthetic `/dev`
- Implement `Dev` device semantics at the fs-op layer (`syscall.rs` read/write routing
  + `vfs` listing).
- e2e: `echo hi > /dev/null` (discarded), `head -c 16 /dev/zero | wc -c` = 16,
  reading `/dev/random` yields differing bytes across reads.

### Phase 6 — Wiring + visibility
- `df`/`mount` coreutils reflect `/proc/mounts`; a boot log lands in `/var/log`.
- The Welcome app gains a "Filesystem" slide; `docs/` notes the layout.

### Phase 7 — Hardening
- Capability checks honor the new tree (e.g. `/etc` writable only with the right grant;
  `/proc`/`/dev` read paths default-allow, writes default-deny).
- Migration: existing `/home` data untouched; first boot stamps the new sys store.
- Full `verify` green (rust + host + e2e), no regressions.

## Risks / notes
- **`/bin` must stay ephemeral** even under "persist everything": persisting code risks
  serving stale guests after a deploy. Re-materialize from the served wasm each boot.
- Synthetic backends are the bulk of the work and touch the kernel's `procs`/`syscall`
  ownership — keep generators in the kernel, not the host, so `/proc` is the real table.
- Cross-backend `rename`/`cp` already returns a clear error; document that moving across
  tiers is copy+unlink at the shell layer.

## Verification bar
Each phase ships with Rust unit tests (`vfs`/`kcore`) and Playwright e2e proving the
**real** behavior (live `/proc`, real `/dev` semantics, persistence across reload),
watched red→green, on a local build. `npm run verify` green before each merge.

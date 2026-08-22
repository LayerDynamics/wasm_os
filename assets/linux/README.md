# Guest Linux images

The privileged "emulator" process boots a real Linux guest (FR-27/FR-28). These are
**guest payloads** the emulator executes — not linked into WASM_OS — so their licenses
do not reach the application (mere aggregation, like shipping a distro image). The
emulator *core* itself is MIT (`third_party/tinyemu/`).

## RISC-V (current) — TinyEMU riscv64

Self-contained boot: ext2 BusyBox rootfs on virtio-block (`/dev/vda`), console on
virtio-console (`hvc0`), no network. Verified booting to a BusyBox shell.

| File | What | License |
|------|------|---------|
| `bbl64.bin` | riscv-pk Berkeley Boot Loader (the BIOS/SBI) | **BSD** (riscv-pk) |
| `kernel-riscv64.bin` | Linux kernel (raw image) | **GPLv2** (guest payload) |
| `root-riscv64.bin` | ext2 root filesystem (BusyBox/Buildroot) | **GPLv2 + various** (guest payload) |
| `wasmos-riscv64.cfg` | TinyEMU VM config (this repo) | — |

**Provenance:** TinyEMU `diskimage-linux-riscv-2018-09-23`
(`https://bellard.org/tinyemu/diskimage-linux-riscv-2018-09-23.tar.gz`). SHA-256:
- `bbl64.bin` `293610cea7af6c75e4a8337e16c0d62834becbf31ffd9cca35e0c211602349db`
- `kernel-riscv64.bin` `293aef345c8e996320de4ca7fc87ff48155a183b3dde00d2f269c8e461b067c5`
- `root-riscv64.bin` `04c4e67351934c3b81602698adf56f39961f53fe630f2920ad15bc9c12da971b`

**GPL source availability + reproducibility:** `riscv64-src/` holds the upstream build
recipe — `patches/riscv-pk.diff`, `patches/riscv-linux.diff`, the kernel `.config`
(`config_linux_riscv64`), and `upstream-readme.txt`. The kernel + bootloader are built
with a `riscv64-unknown-linux-gnu` toolchain and `objcopy -O binary` to raw images; the
rootfs comes from Buildroot (`https://bellard.org/tinyemu/buildroot.html`). This
satisfies the GPL written-offer for the kernel/rootfs binaries above.

## Using / regenerating

Vendored via git-LFS — a clone/deploy just needs `scripts/setup-vendored-assets.sh`
(no toolchain). See `third_party/tinyemu/README.md` for the emulator-core build.

## x86 (removed)

The x86 `buildroot-bzimage.bin` guest and the GPLv2 v86 core (`third_party/v86/`) were
**removed** in the switch to the MIT RISC-V core — see git history for the prior x86 setup.

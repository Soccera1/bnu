# QEMU test matrix

The QEMU matrix runs the GNU coreutils 9.11 command-test inventory in isolated
Gentoo environments. It exists for cases that cannot be validated reliably on
an ordinary development host, including root-only, SELinux, and SMACK tests.

This setup is intended for maintainers. It downloads and provisions several
guest images and requires KVM.

## Environments

| Guest | Purpose |
|---|---|
| Standard Gentoo Linux | Non-root command tests |
| Gentoo Linux with SELinux MLS | Root-only and SELinux tests |
| Gentoo Linux with SMACK | SMACK-specific tests |
| Gentoo GNU/Hurd preview | Verification of the unsupported target-ABI boundary |

The runner starts one VM at a time. It defaults to 1536 MiB RAM and two vCPUs
per guest.

## Host requirements

The host must provide:

- Bash and Bun;
- readable and writable `/dev/kvm`;
- `qemu-img` and `qemu-system-x86_64`;
- OVMF firmware;
- OpenSSH client tools;
- `curl` and GnuPG;
- `mkfs.ext4`;
- either `xorriso` or `genisoimage`;
- `awk`, `sort`, `comm`, `sha512sum`, `tar`, `xz`, and `timeout`.

Package names vary by distribution. Check the actual executables and firmware
paths without downloading or booting anything:

```sh
scripts/qemu/check-host.sh
scripts/setup-qemu-environments.sh --dry-run
scripts/run-gnu-qemu-matrix.sh --dry-run
```

The matrix payload also requires `coreutils-9.11.tar.xz` in the repository
root. Follow the download instructions in [Testing](testing.md#gnu-command-tests).

There is no software-emulation fallback. The scripts require KVM and use
`-cpu host`.

## Storage and downloads

State is stored under `/var/tmp/bnu-qemu` by default. Set `BNU_QEMU_DIR` to
use another writable location:

```sh
BNU_QEMU_DIR=/path/to/bnu-qemu scripts/setup-qemu-environments.sh --dry-run
```

Allow about 30 GiB of free space for a complete first setup. Images are sparse,
but downloads, package data, kernel sources, modules, and guest overlays consume
real space. The setup checks available space before it starts.

Downloaded Gentoo artifacts are authenticated before use. Automated release
artifacts are checked with Gentoo's service keys. The Hurd preview is checked
against its pinned signing-key fingerprint and published SHA-512 digest.

Temporary extraction and seed-building data use `${TMPDIR:-/tmp}`.

## Provisioning

Create or resume every environment:

```sh
scripts/setup-qemu-environments.sh
```

Provision a single environment with `--only`:

```sh
scripts/setup-qemu-environments.sh --only standard
scripts/setup-qemu-environments.sh --only selinux
scripts/setup-qemu-environments.sh --only smack
scripts/setup-qemu-environments.sh --only hurd
```

Provisioning is resumable. Ready markers prevent completed guests from being
rebuilt on later runs.

The SELinux guest uses the MLS policy in enforcing mode. Bun requires executable
anonymous memory for its FFI compiler, so provisioning enables the policy's
standard `allow_execmem` boolean. The SMACK guest uses a separately built
kernel and a distinct overlay.

## Running the matrix

Run the local suite followed by the complete matrix:

```sh
scripts/run-all-tests.sh --setup
```

Run only the GNU matrix:

```sh
scripts/run-gnu-qemu-matrix.sh --setup
```

Omit `--setup` after the guests have been provisioned. Each run rebuilds the
payload from the current checkout and attaches it read-only to the guests.

The matrix reconciles all 733 test names. It fails if any test lacks a passing
record unless that test is one of the six documented Bun runtime or ABI
boundaries. It also reports a boundary that unexpectedly starts passing so the
allowlist can be updated.

Results are written to:

```text
$BNU_QEMU_DIR/results/TIMESTAMP/
```

The directory contains the inventory, per-guest logs, passing and unresolved
sets, the accepted boundary list, and any unexpected unresolved tests.

## Configuration

The main environment variables are:

| Variable | Default | Purpose |
|---|---:|---|
| `BNU_QEMU_DIR` | `/var/tmp/bnu-qemu` | Persistent state and results |
| `BNU_QEMU_MEMORY` | `1536M` | Memory assigned to each VM |
| `BNU_QEMU_CPUS` | `2` | vCPUs assigned to each VM |
| `BNU_QEMU_SSH_PORT` | `22222` | Host port used for guest SSH |
| `BNU_QEMU_TIMEOUT` | `900` | Guest SSH readiness timeout in seconds |
| `BNU_QEMU_MIN_FREE_GIB` | phase-dependent | Override the free-space guard |
| `BNU_OVMF_CODE` | auto-detected | Explicit OVMF code image |
| `BNU_OVMF_VARS` | auto-detected | Explicit OVMF variable template |

Heavy guest builds are configured to use one compiler job. Change VM sizing
only when the host has enough resources for the test limits and guest overhead.

## Smaller root smoke test

A separate initramfs runner checks privileged ownership changes, special-file
creation, and `cp -p` metadata preservation without provisioning the full
matrix:

```sh
BNU_QEMU_KERNEL=/boot/vmlinuz-... \
BNU_QEMU_INITRAMFS=/boot/initramfs-....img \
  scripts/run-qemu-root-smoke.sh
```

It requires a matching host kernel and initramfs, KVM,
`qemu-system-x86_64`, `zstd`, and `cpio`. It uses `lsinitrd` when
available and otherwise attempts direct decompression.

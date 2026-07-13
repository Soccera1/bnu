# bnu

A Bun JavaScript rewrite of GNU coreutils, currently implemented as a multi-call CLI.

```sh
bun ./bin/bnu.js echo hello
bun ./bin/bnu.js sort file.txt
```

The normal local test suite runs each test in a fresh process with a 1 GiB
aggregate process-tree RSS ceiling and a 3 GiB per-process address-space
ceiling.  `factor` also defaults to one worker; controlled audits can opt in to
bounded parallelism with `BNU_FACTOR_WORKERS`.

```sh
bun run test
```

There is also an optional harness for running GNU coreutils' command-level
upstream tests from the bundled tarball against the Bun wrappers. With no test
arguments it runs a small curated subset; pass upstream test paths for targeted
runs, or use `--all` to
select the 733 `.sh`/`.pl` entries in GNU's standard `TESTS` list. The 41
root-test names are members of that same list and are rerun with root privileges
rather than counted as additional tests. GNU's separate `gnulib-tests` validate
its internal C portability library and are outside this JavaScript command
compatibility scope. By default compatibility failures are
reported without making the command fail; add `--strict` to return a non-zero
status when any GNU test fails. Each GNU test has a default 300 second timeout
to account for the Bun-backed wrappers' startup cost in broad all-command
upstream sweeps; override it with
`--timeout`. Pass `--expensive` to set `RUN_EXPENSIVE_TESTS=yes`, or
`--very-expensive` to set both `RUN_EXPENSIVE_TESTS=yes` and
`RUN_VERY_EXPENSIVE_TESTS=yes` for upstream tests that are disabled by default.
Known terminal-dependent upstream tests are automatically run in their own
controlling pseudo-terminal. Pass `--tty` to force that mode for every selected
test. Pass `--keep` to preserve both the extracted source tree and GNU tests'
inner temporary directories for syscall-log and failure-artifact inspection.
The harness enforces a 1536 MiB aggregate RSS ceiling for each test process
tree and a 3 GiB per-process address-space ceiling by default; override these
with `--rss-limit` and `--memory-limit` when a controlled stress audit requires
different bounds.

```sh
bun run test:gnu --list
bun run test:gnu
bun run test:gnu --all --list
bun run test:gnu tests/misc/echo.sh
bun run test:gnu --strict tests/misc/echo.sh
bun run test:gnu --timeout 10s tests/misc/printenv.sh
bun run test:gnu --rss-limit 1GiB --memory-limit 3GiB tests/misc/echo.sh
bun run test:gnu tests/stty/stty-invalid.sh
bun run test:gnu --expensive tests/tail/big-4gb.sh
bun run test:gnu --very-expensive tests/misc/sort.sh
# A representative 96-bit contiguous-range factor stress case.
bun run test:gnu --strict --very-expensive tests/factor/t26.sh
```

## Portable QEMU test matrix

The complete upstream command-test inventory can run without depending on the
host distribution or host root access. The matrix uses official, authenticated
Gentoo amd64 artifacts to create four separate environments beneath
`/var/tmp/bnu-qemu`:

- a standard Gentoo guest for the 692 non-root inventory members;
- a stage4 built from Gentoo's hardened SELinux systemd stage3, with the MLS
  policy active in enforcing mode, for the 41 root tests and SELinux cases;
- a distinct qcow2 SMACK overlay with a custom kernel built using one compiler
  job and a 2 GiB guest swap file;
- the official Gentoo amd64 GNU/Hurd preview and a separate BNU matrix overlay.

The all-tests entry point first runs the local bounded unit suite, then creates
or resumes the guests, builds an ext4 payload from the current checkout, runs
one VM at a time, and reconciles all 733 upstream test names:

```sh
scripts/run-all-tests.sh --setup
# Subsequent runs reuse the guests and refresh only the payload:
scripts/run-all-tests.sh
```

Use `scripts/run-gnu-qemu-matrix.sh` directly when only the upstream matrix is
wanted.

The host can be any Linux distribution. It needs Bash, Bun, KVM access, QEMU
for x86_64, OVMF, OpenSSH clients, curl, GnuPG, e2fsprogs (`mkfs.ext4`), xorriso
or genisoimage, and ordinary POSIX archive/checksum tools. Package names differ
between distributions, so the scripts check executable names rather than
assuming a package manager. `/dev/kvm` must be readable and writable by the
calling user; there is intentionally no TCG fallback. A quick dependency and
action check that downloads or boots nothing is available with:

```sh
scripts/qemu/check-host.sh
scripts/setup-qemu-environments.sh --dry-run
scripts/run-gnu-qemu-matrix.sh --dry-run
```

Persistent downloads, base images, isolated overlays, readiness markers, and
timestamped results stay under `BNU_QEMU_DIR` (default `/var/tmp/bnu-qemu`).
Set that variable to another user-writable directory if necessary. Temporary
seed staging and GNU extraction trees use `${TMPDIR:-/tmp}` and may be wiped
between runs. The setup is phase-resumable; completed image markers prevent a
costly rebuild. Individual environments can be prepared with
`scripts/setup-qemu-environments.sh --only standard|selinux|smack|hurd`.

Every VM is KVM-only, defaults to 1536 MiB RAM and two vCPUs, and heavy work is
strictly sequential. Guest package/kernel builds use `-j1`; each GNU test gets
a 1 GiB aggregate process-tree RSS ceiling and a 3 GiB per-process virtual
memory ceiling. Override VM sizing only when needed with `BNU_QEMU_MEMORY` and
`BNU_QEMU_CPUS`. Official artifacts are cached only after their Gentoo OpenPGP
signature is verified using Gentoo's published service-key bundle; the Hurd
image's developer signature is pinned to its full Gentoo signing-key
fingerprint and also gets its published SHA-512 check.

Allow roughly 30 GiB of free space for a first complete setup: qcow2 images are
sparse, but Portage downloads, the SELinux root, kernel sources, modules, and
the one-job SMACK build still consume real blocks. The setup checks free space
before downloading or booting. `BNU_QEMU_MIN_FREE_GIB` can override that guard
when the state directory is on a specially provisioned thin or compressed
filesystem.

The final reconciliation fails if any inventory member lacks a PASS on its
appropriate platform, except for the six documented Bun startup/ABI boundaries
in [`docs/gnu-test-boundaries.md`](docs/gnu-test-boundaries.md).
Logs are written to `/var/tmp/bnu-qemu/results/TIMESTAMP` by default.

For a smaller Linux root-only smoke check, the repository also retains an
initramfs runner. It assembles the current Bun executable and source tree into
a matching zstd-compressed initramfs, then checks privileged ownership changes,
special-file creation, and `cp -p` metadata preservation as guest root:

```sh
BNU_QEMU_KERNEL=/boot/vmlinuz-... \
BNU_QEMU_INITRAMFS=/boot/initramfs-....img \
  scripts/run-qemu-root-smoke.sh
```

The smoke runner requires `qemu-system-x86_64`, `zstd`, `cpio`, KVM access, and
a kernel/initramfs pair that can boot on the host CPU. It uses `lsinitrd` when
available to unpack concatenated or compressed input images, with direct
decompressor fallbacks. Compression is single-threaded and it uses KVM with
`-cpu host`; `BNU_QEMU_MEMORY` overrides its default 1536 MiB guest allocation.

SELinux guests must select SELinux in the kernel's active LSM list, not merely
compile it in. On kernels whose `CONFIG_LSM` default omits SELinux, boot with
`lsm=selinux` (in addition to `security=selinux selinux=1`); otherwise
libselinux process attributes and thread-local creation contexts can fail with
`EINVAL` even though `sestatus` reports an enabled policy. Bun's FFI compiler
also requires executable anonymous memory in enforcing mode; the dedicated
test guest enables the policy's standard `allow_execmem` boolean rather than
carrying an ad-hoc local allow rule.

To create command-name wrappers such as `cat`, `wc`, and `sort`:

```sh
bun run link-commands -- ./dist/bin
./dist/bin/echo hello
```

## Implemented Commands

`[`, `arch`, `b2sum`, `base32`, `base64`, `basename`, `basenc`, `cat`, `chcon`,
`chgrp`, `chmod`, `chown`, `chroot`, `cksum`, `comm`, `coreutils`, `cp`,
`csplit`, `cut`, `date`, `dd`, `df`, `dir`, `dircolors`, `dirname`, `du`,
`echo`, `env`, `expand`, `expr`, `factor`, `false`, `fmt`, `fold`, `ginstall`,
`groups`, `head`, `hostid`, `hostname`, `id`, `install`, `join`, `kill`, `link`,
`ln`, `logname`, `ls`, `md5sum`, `mkdir`, `mkfifo`, `mknod`, `mktemp`, `mv`,
`nice`, `nl`, `nohup`, `nproc`, `numfmt`, `od`, `paste`, `pathchk`, `pinky`,
`pr`, `printenv`, `printf`, `ptx`, `pwd`, `readlink`, `realpath`, `rm`,
`rmdir`, `runcon`, `seq`, `sha1sum`, `sha224sum`, `sha256sum`, `sha384sum`,
`sha512sum`, `shred`, `shuf`, `sleep`, `sm3sum`, `sort`, `split`, `stat`,
`stdbuf`, `stty`, `sum`, `sync`, `tac`, `tail`, `tee`, `test`, `timeout`,
`touch`, `tr`, `true`, `truncate`, `tsort`, `tty`, `uname`, `unexpand`, `uniq`,
`unlink`, `uptime`, `users`, `vdir`, `wc`, `who`, `whoami`, `yes`.

The GNU coreutils 9.11 command-test inventory is reconciled against the current
source: 727 of its 733 scripts have passing host or QEMU evidence. The remaining
six are confirmed Bun startup or target-ABI boundaries: two tests remove the
procfs facilities Bun needs to start, two start below Bun's required file-
descriptor floor, one traps during Bun startup in a `SCHED_DEADLINE` systemd
scope, and one requires a GNU/Hurd ABI for which no Bun runtime exists. This
includes root-only reruns and activated terminal, SELinux MLS, SMACK, expensive,
and very-expensive paths. The six test names, exact rationale, and evidence are
in [`docs/gnu-test-boundaries.md`](docs/gnu-test-boundaries.md).

This 733-script scope is not every assertion in the package: individual scripts
contain multiple cases, and it excludes GNU's C-internal `gnulib-tests`.
Passing it does not imply that every GNU extension or platform combination is
implemented; BNU remains an independent JavaScript implementation rather than
GNU's native C code.

## Compatibility Notes

BNU targets command-line compatibility with GNU coreutils 9.11 for the
commands listed above. It is an independent JavaScript implementation, so
compatibility applies to observable command behavior rather than GNU internals
or binary interfaces. Passing the upstream command-test inventory does not
guarantee that every option combination, platform, locale, or filesystem
behaves identically.

Some behavior depends on the host:

- ACLs, extended attributes, security contexts, reflinks, sparse files, inotify,
  device nodes, and similar features require corresponding operating-system and
  filesystem support.
- Ownership changes, `chroot`, clock changes, device creation, and security-label
  operations may require elevated privileges.
- Sorting, character handling, user and group lookup, terminal behavior, and
  diagnostics can vary with the active locale and system configuration.
- Six upstream tests cannot start BNU because of Bun runtime or target-ABI
  constraints. They are documented in
  [`docs/gnu-test-boundaries.md`](docs/gnu-test-boundaries.md).

Use `bnu COMMAND --help` for the options exposed by a command. The local and
upstream test suites provide the most precise record of currently verified
behavior.

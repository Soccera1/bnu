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

The test suite now covers recursive `cp`, copying into directory targets,
metadata preservation hooks, symbolic `chmod` mode clauses, signed and legacy
shorthand `head` and `tail` counts, zero-terminated `head` and `tail` records,
real FIFO creation through libc for
`mkfifo`/`mknod p` including octal and symbolic modes, and multi-call wrapper generation. On SELinux systems,
`mkdir`, `mkfifo`, and `mknod` apply validated explicit creation contexts with
`--context=CTX` and restore pathname defaults with `-Z`, including directories
created by `mkdir -p`. `cat` supports
numbering, blank squeezing, line end markers, tab markers, and common
nonprinting character display modes. Hash utilities support standard
checksum-file verification with `-c`/`--check`, `--status`, `--quiet`,
`--warn`, `--strict`, and `--ignore-missing`. `echo`
supports common GNU `-n`/`-e`/`-E`, long-option, POSIXLY_CORRECT, simple, octal, hex, escape, and `\c` forms. `basename`
supports suffix stripping, multiple-name mode, NUL-delimited output, and GNU
root and suffix edge cases;
`dirname` supports multiple names and NUL-delimited output, and both preserve
non-UTF-8 pathname bytes. `pwd` supports
physical output by default, logical `PWD` validation with `-L`, and operand
validation. Common option-parsed commands reject undeclared short and long options with GNU-style usage failures. `sort` covers
common GNU comparison modes including version, month, human numeric,
dictionary order, check variants, NUL-terminated records, and `-o` output. `ls`
covers hidden-file modes,
classification, recursive listing, size/time/extension/reverse sorting,
unsorted mode, basic color output, and POSIX ACL `+` mode indicators when
`getfacl` is available. Text ordering for both `sort` and `ls` follows the
active libc locale's collation rules, including non-UTF-8 command-line names;
C and POSIX locales retain bytewise ordering. `base32` and `base64` support
standalone RFC 4648 encoding/decoding, wrapping, and decode garbage handling.
`cat` streams ordinary file and special-device operands with bounded memory.
`cut` likewise streams bounded byte, character, and field selections from
special files, preserves invalid UTF-8 bytes, honors multibyte character
boundaries for `-b -n`, and follows libc-style multibyte blank classification.
`basenc` supports base16, base32, base32hex, base64, base64url, base2 MSB/LSB,
base58, z85, wrapping, strict decode garbage handling, and bounded-memory
streaming for the group-based encoders.
`cut` supports byte, character, delimiter, complement, output-delimiter,
NUL-terminated, and whitespace-delimited field modes, with interval-based
huge ranges and bounded-memory streaming for byte positions and safe field
selections.
`expand` and `unexpand` support explicit and repeating tab-stop forms and
bounded-memory conversion of stdin, files, and special devices while preserving
multibyte display-width and blank-run state across input chunks.
`fold` streams ordinary stdin, file, and special-device folding, distinguishes byte, character, and
display-column widths, and preserves zero-width characters without forcing
spurious line breaks.
Single-input `paste` preserves records through a bounded-memory stream, and
`od -v` incrementally formats ordinary and special files without accumulating
the complete input.
`comm` incrementally merges sorted non-regular inputs, `uniq` streams its
default and unseparated all-repeated modes, and negative-count `head` keeps
only the bounded byte or record tail needed for special devices.
From-start `tail` streams non-regular byte-record inputs directly, including
NUL-delimited device streams.
`factor` consumes non-regular standard input as a bounded token stream while
retaining batch optimization for regular-file input.
Checksum verification consumes non-regular checklist input line-by-line and
reports each verification result without waiting for end of input.
`join` streams selected unmatched records when the opposite input is known
empty, including NUL-delimited device input against `/dev/null`.
`wc` and `du` consume non-regular `--files0-from` sources one name at a time,
so FIFO and standard-input filename lists remain bounded even when unending.
`dircolors` supports shell output modes, database printing, and simple color
database files.
`cksum` supports the classic CRC form plus common digest algorithms through
`--algorithm`, including tagged, untagged, base64, and NUL-terminated output.
`sum` supports GNU's BSD and System V algorithms. `touch` supports explicit,
reference, access/modify-only, GNU `--time` aliases, and no-dereference
symlink timestamps. `factor` supports stdin and
argument factoring plus GNU exponent output. `expr` supports arithmetic,
comparisons, and common GNU string operations including length, substr, index,
and anchored regex matching. `id` supports current and named-user numeric and named user/group output
for primary and supplementary groups, NUL-delimited selected fields, and GNU-style choice validation; `groups` prints resolved primary and supplementary group names
when available and accepts username operands, and `logname` and `whoami` validate that no operands
are supplied. `users` accepts GNU's optional file operand. `who` supports simple heading, count, boot-time, `am i`, message-status,
short, users, and all-mode option forms.
Recursive `chmod -R` uses the same
numeric and symbolic mode parser as single-path `chmod`, including GNU
long-option abbreviation forms, and reports failed permission-changing syscalls
separately from pathname-access failures. `chown` and `chgrp`
cover common ownership/group changes, reference/from filters, recursive safety,
GNU `-H`/`-L`/`-P` symlink traversal semantics, inaccessible-directory
diagnostics, verbose failure records, and
GNU long-option abbreviation forms. `readlink` and `realpath` cover
common canonicalization, NUL delimiter, no-symlink, and relative-output modes.
`truncate` supports reference sizes, reference-relative size operators,
no-create mode, GNU byte suffixes, and common relative size operators. `tee` supports append, ignore-interrupts, and
output-error mode options. `cp`, `mv`, and `ln`
support GNU target-directory forms with `-t` and `-T`; all three accept GNU
long-option abbreviation forms, and `cp --parents` also
accepts the GNU-style `--parent` abbreviation; `mkdir` supports octal
and symbolic modes, `install` supports octal and symbolic `-m` modes for files
and directories; on SELinux systems it also preserves contexts with
`--preserve-context`, includes contexts in `-C` comparisons, restores default
labels with `-Z` (including `-D`/`-d` parents), and validates explicit
`--context=CTX` creation labels. `install -C` also compares the requested or
effective owner and group before deciding that an existing target can be left
unchanged. `rmdir` and `rm` cover common verbose, parent,
non-empty, interactive-mode, empty-directory removal, and GNU long-option
abbreviation modes. `cp --copy-contents`
copies FIFO contents when a writer supplies data during recursive copies, and
`cp -p` preserves POSIX ACLs when `getfacl` and `setfacl` are available. `cp`
and cross-filesystem `mv` preserve supported extended-attribute namespaces,
including attributes on symlinks; explicit `--preserve=xattr` reports restore
failures while archive and `--preserve=all` use GNU's best-effort behavior;
on an active SELinux system, `cp -a`, `--preserve=context`, `--context=CTX`,
and `-Z` respectively preserve, explicitly set, or restore destination security
contexts, with interposable libselinux `getfilecon` access and validation of
explicit labels. Missing optional source labels are ignored for archives while
an explicitly required context fails before copying. Context-preserving
`--parents` copies update both new and existing parent-directory labels;
explicitly required preservation fails before file data is written on a
fixed-context filesystem; and `-Z` creates with the source label before
restoring a pathname default, retaining that label when no default exists.
Directory creation uses a same-thread syscall while `setfscreatecon(3)` is
active, so Bun worker scheduling cannot silently lose explicit creation labels;
`cp --reflink=always|auto|never` attempts Linux native file cloning when the
filesystem supports it, and `cp --sparse=always|auto|never` controls sparse regular-file copying with
`SEEK_DATA`/`SEEK_HOLE` extent traversal and allocated-zero detection.
Cross-filesystem `mv` preserves sparse extents and recreates FIFO, device, and
socket nodes; failed source removal from sticky directories uses GNU's
operation-level diagnostic. With terminal input, `mv` also protects an
unwritable destination with GNU's default mode-aware prompt unless an effective
`-f` suppresses it. `cp` also retries destination creation when an interposed
`fstatat` reports a stale NFS entry that has disappeared before open. `link` and
`unlink` enforce fixed operand counts and support `--` for dash-prefixed names.
Capability xattrs are applied after final ownership changes, so
`cp --preserve=xattr` and `--preserve=all` retain Linux file capabilities.
Recursive `rm` traverses Linux directory streams incrementally, preserves raw
filename bytes, and distinguishes immediate read failures from partial traversal
failures. Noninteractive flat entries use a one-syscall unlink fast path with
metadata-aware fallback, keeping a 400,000-entry ext4 removal below GNU's
60-second performance gate.
`mktemp` supports files, directories, optional tmpdir/default temp placement,
explicit and implicit suffixes, suffix validation, and dry-run name generation. `dd` supports input/output block sizes, skip, count, seek,
byte-oriented flags, status modes, range-aware `nocache` input/output advice
that evicts through EOF only when EOF was reached, pre-copy seek
truncation with failure diagnostics, real seek-based stdin skipping and stdout
positioning (including block-device boundary validation), notrunc output writes,
and sparse output conversion. `split`
supports line, byte, line-byte, chunk-count, round-robin,
numeric, hex, configurable suffix starts, additional-suffix, and separator
modes, plus GNU-style operand validation. Fixed-number splitting of non-regular
input is disk-spooled through `$TMPDIR`, avoiding unbounded heap growth and
reporting storage exhaustion normally. `env` and `printenv`
support NUL-delimited output, and `env` handles empty environments, directory
changes, variable unsets, custom command argv0, and simple `-S` split strings. `sync` supports file
operands plus data and file-system mode flags. `df --sync` issues `sync(2)`
before its native filesystem query. `tail -f`/`-F` uses native inotify watches
for regular files and FIFOs, watches parent directories for name following,
removes stale watches across rotation, and falls back to blocking device reads
or polling when notification is unavailable or disabled; `--debug` reports the
selected strategy. Byte-count mode seeks relative to the true end of block
devices, including `-c +OFFSET`, without buffering the device. `stat` supports a
broader set of GNU file format escapes, `--printf`, and terse output. `du`
supports byte, block-size, human-readable, SI, apparent-size, total, and
NUL-terminated output modes, including GNU long-option abbreviations. During
concurrent directory moves it collapses stale descendants into one GNU-style
`fts_read failed` diagnostic and continues later operands. `df`
supports GNU block-size suffixes, human-readable/SI output, inode reporting,
local and file-system-type filtering, total row modes, over-mounted block-device
diagnostics, and byte-preserving non-UTF-8 mount names. `od` supports common
address, skip, limit, width, character, unsigned, and hex dump modes. `numfmt`
supports common scaling, table-field, header, delimiter,
padding, suffix, and invalid-value modes. `stdbuf` accepts input, output, and
error buffering mode options, including GNU long-option abbreviations, before running a command. `shuf` supports NUL records, repeat
mode, output files, deterministic random sources, and GNU operand/count validation. `shred` supports force,
verbose, exact, zero, remove, pass-count, and GNU long-option abbreviation modes. `uniq` supports common
counting, repeated, unique, field/character skipping, NUL-delimited,
all-repeated, group-delimiter, output-file, and operand-validation modes. `seq` handles fixed-point decimal
steps, negative operands with options, and common printf-style formatting. `printf` supports common numeric,
string, `%b`, `%q`, `\c` stop, Unicode escapes, and bounded streaming for very
large simple field widths. `sleep` and `timeout` support GNU
duration suffixes and fractional intervals; `timeout` also supports custom signals, preserve-status,
kill-after, disabled zero-duration timeouts, verbose signal diagnostics, default process-group
termination of descendants, `--foreground` PID-only behavior, and Linux parent-death signaling.
`nice` parses common
GNU adjustment forms before running a command. `nohup` preserves piped input,
makes commands immune to SIGHUP, implements terminal-only input/output/error
redirection and 0600 `nohup.out` creation, preserves command exit status, and
returns 127 for missing commands. `kill` supports signal
listing, signal table output, name/number conversion, and signal-zero checks. `date` supports more GNU format
escapes, padding/case flags, reference files, date files, debug diagnostics,
and real `--set` clock changes through `clock_settime(2)` when permitted.
`fmt` supports width shorthand, goal parsing, prefix-filtered formatting,
split-only mode, uniform spacing, and bounded paragraph formatting for
non-regular default input. `fold` supports byte, character, width,
and blank-aware wrapping modes. `tr` covers common POSIX character
classes, escaped characters, complement mode, deletion, translation, and repeat
squeezing. `tac` supports literal custom separators and before-separator mode;
non-seekable input is disk-spooled so an input failure does not prevent later
file operands from being processed.
`arch` and `hostid` expose platform identifiers with GNU-style operand
validation. `hostname` prints or attempts to set the system host name. `stty` supports
all-settings and saved-settings output modes, speed/size queries, real termios
setting forms, GNU fractional baud rounding and legacy speed aliases, C-style
numeric control values, and invalid-setting diagnostics. `tty` supports
silent/quiet status-only mode and GNU-style operand validation. `uname` supports common GNU
selectors including `-a`, `-s`, `-n`, `-r`, `-v`, `-m`, `-p`, `-i`, and `-o`.
`uptime` follows GNU coreutils' current-time, uptime, user-count, and load-average
format, with the standard optional utmp/wtmp file operand.
`nproc` supports `--all`, `--ignore`, OpenMP thread-limit environment
variables, cgroup v2 CPU quotas (including inherited quotas and scheduler
exceptions), and GNU-style operand and option diagnostics.
`nl` supports common body-selection, number-format, width,
separator, increment, starting-number, regex, and blank-grouping modes. `paste`
supports serial and parallel operation with custom escaped, column-cycled delimiters and
NUL-terminated records, including repeated stdin operands. `comm` supports custom output delimiters, totals,
NUL-terminated records, and sorted-order checking modes. `pinky` supports
simple short and long user records, including project/plan files and
left-to-right `-l`/`-s` mode selection.
`csplit` supports prefixes, digit widths, suffix formats, quiet mode,
empty-file elision, suppressed matched separators, regex offsets, and skip
patterns. `pr` supports omitted and custom page headers, line numbering,
custom first line numbers, margin indentation, and bounded-memory streaming
for default single-column pagination from stdin and special-file operands. `ptx` supports GNU-style
ignore-case option parsing, ignore/only word files, custom word and sentence
regexes, break-character files, automatic/manual references, and configurable
truncation markers.
`expr` preserves raw command-line bytes, applying character-aware length,
index, substring, and basic-regex behavior only in multibyte locales.
`ls -Z` and `stat %C` read SELinux contexts where the `security.selinux`
xattr is available, and long `ls` listings use GNU's `.` mode suffix for a
security context when no extended ACL takes precedence. Classification queries
regular-file mode bits without dereferencing symlink targets unnecessarily.
If a directory entry's metadata becomes inaccessible after `readdir`, `ls`
retains its kernel `d_type`, emits GNU's unknown-metadata row, and continues
with minor-error status (including accurate `--dired` offsets).
When `LS_COLORS` enables `ca=`, `ls` colors files carrying a
`security.capability` xattr using their full path; an empty `ca=` disables the
capability probe.
`chcon` supports explicit, reference, component, recursive,
and no-dereference context changes on SELinux-capable filesystems, and reports
failed full-context or partial-context operations on unlabeled files.
`cp`, `install`, and the file-creation commands support GNU context preservation,
explicit contexts, and default-policy restoration; `mv -Z`/`--context` restores
destination-policy labels after both renames and cross-filesystem moves.
`id -Z`/`--context` reports the current SELinux process label, and default `id`
output includes `context=...` outside POSIX mode.  On newer stacked-LSM kernels,
the implementation uses `lsm_get_self_attr(2)` before legacy libselinux access.
`chroot` performs the real root switch, GNU `/` versus `--skip-chdir` handling,
command-status propagation, and user, primary-group, and supplementary-group
changes from named or forced-numeric specifications.
`runcon` prints the active process context, accepts complete contexts or GNU
compute/user/role/type/range forms, validates and computes transitions through
libselinux, and applies the requested exec label through legacy or modern LSM
interfaces before dispatching the command.
`yes` repeats the default `y` line or joined operand strings.
`test` and `[` support common file predicates,
read/write/execute checks, string and numeric comparisons, and file identity
and timestamp comparisons. `pathchk` supports GNU portability checks with
`-p`/`--portability` and leading-hyphen/empty-component checks with `-P`.

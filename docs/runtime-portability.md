# Runtime and platform requirements

BNU targets Bun on Linux, with glibc Linux as the tested baseline. It is
JavaScript, but it is not a runtime-neutral JavaScript package: the command
entries use Bun extensions, Node-compatible APIs, native FFI, and Linux
interfaces. A runtime that can execute ordinary ECMAScript modules is not
sufficient. A non-glibc Linux libc may satisfy many or all of the native calls;
the exact requirements are distinguished below.

This document separates requirements that are checked while a module is loaded
from facilities needed only by particular commands or options. "Optional"
below means that the command can perform some useful operations without the
facility; it does not mean that BNU emulates the missing OS feature.

## Load-time requirements

All command entries require:

- Bun's ES module behavior, including `import.meta.main`, top-level `await`,
  `Bun.argv`, and, for `factor`, `import.meta.path`;
- Bun's Node compatibility layer, including `node:fs`, `node:fs/promises`,
  `node:path`, `node:os`, `node:crypto`, `process`, and `Buffer`;
- normal POSIX file descriptors, signals, environment variables, and filesystem
  semantics.

The repository currently declares Bun 1.3.14. Other Bun releases may work, but
the local and GNU compatibility suites, rather than ECMAScript conformance,
define the supported runtime behavior. The generated files in `dist/commands/`
and `dist/runtime/` are Bun-targeted bundles; building them does not remove the
Bun or native-library requirements. The Node-targeted npm launcher only locates
and starts Bun.

### Bun FFI and `libc.so.6`

Every command except `echo` imports `src/shared/common.js`, directly or through
a shared command-family module. That module eagerly imports `bun:ffi` and calls:

```js
dlopen("libc.so.6", { /* the complete BNU libc symbol table */ })
```

Consequently, all commands other than `echo` have these hard startup
requirements, including when invoked with only `--help` or `--version`:

- Bun's `bun:ffi` module (`dlopen`, `linkSymbols`, pointers, native reads, and
  C strings);
- a loadable `libc.so.6` exporting the complete symbol table declared in
  `src/shared/common.js`, including the non-standard but cross-libc
  `__errno_location` interface and Linux-facing functions such as `statx`,
  `renameat2`, and the inotify calls;
- the Linux constants and native layouts assumed by the FFI callers.

The literal filename is a loader contract, not proof that the loaded library is
glibc. A non-glibc libc exposed through a `libc.so.6` symlink can pass this
stage if it exports every requested symbol. The symlink alone is not enough:
the calling convention, integer widths, constants, structures, loader
interposition, and behavior used by a command must also be compatible. BNU has
not yet recorded the complete test matrix on such a configuration.

The exceptions are narrowly scoped:

| Invocation | Native FFI loaded? | Remaining requirements |
|---|---:|---|
| `bun src/commands/echo.js ...` | No | Bun, Node-compatible `process` and `node:fs`, and the shared CLI modules |
| `bun bin/bnu.js echo ...` | No | Same as above, plus the multi-call launcher's Node-compatible path/filesystem APIs |
| `bun bin/bnu.js --help` or `--version` | No | Bun and the launcher's/shared CLI APIs |
| Any other command, including its help/version path | Yes | Bun FFI, a compatible library resolved as `libc.so.6`, and the requirements below when the corresponding behavior is used |

Moving or lazily loading the native table would change this boundary. Until
then, a command-specific entry that happens not to call a libc function still
cannot start without the table.

### `libc.so.6` versus glibc-specific behavior

The native calls fall into different portability classes:

| Class | Interfaces | Meaning for another Linux libc |
|---|---|---|
| Filename assumption | `dlopen("libc.so.6", ...)` | `libc.so.6` is the name BNU opens. A symlink or equivalent loader mapping can satisfy the name; this does not require the loaded implementation to be glibc. |
| ISO C, POSIX, XSI, or widely implemented Unix interfaces | `memset`, `chdir`, `chmod`, `clock_settime`, `dlsym`, `execve`, `execvp`, `fcntl`, `ioctl`, `lseek`, `kill`, `mkfifo`, `mknod`, `poll`, `signal`, `setuid`, `setgid`, `setgroups`, `opendir`, `readdir`, `closedir`, `getpriority`, `setpriority`, `sched_getscheduler`, `setlocale`, `nl_langinfo`, `strcoll`, `sync`, `truncate`, `utimensat`, and the termios calls | These calls do not intrinsically require glibc. They can work through another libc with compatible exported symbols and types. Some are optional POSIX/XSI interfaces or common extensions rather than ISO C. |
| Linux-specific or non-standard libc wrappers | `chroot`, `renameat2`, `sethostname`, `statfs`, `statx`, inotify, `capget`, and xattr calls | These require the corresponding Linux-compatible interface and a libc that exports the wrapper. They are not necessarily glibc-specific. Older or smaller libcs may omit a wrapper even when the kernel has the syscall. |
| Non-standard compatibility symbol | `__errno_location` | BNU calls this symbol directly. glibc exports it, but compatible Linux libcs can and do export the same interface; its presence is a symbol-level requirement, not sufficient evidence of glibc. |
| Dynamic-loader/interposition behavior | `dlsym(0, ...)` and `linkSymbols` in copy/move, SELinux, `dd`, `rm`, and `stty` paths | The alternative loader must give compatible `RTLD_DEFAULT`-style lookup and `LD_PRELOAD` interposition semantics. Merely exporting the base symbol may not cover these paths. |
| Direct layout interpretation | `struct dirent`, `statx`, `statfs`, termios, and selected `struct stat` buffers | These are primarily Linux and architecture ABI assumptions. They can match across glibc and another Linux libc, but each layout must be verified; the libc name does not decide compatibility. |
| glibc-oriented host data | The hard-coded 384-byte little-endian `/var/run/utmp` parser | `pinky`, `uptime`, `users`, and `who` assume the tested glibc/Linux record layout. This is a genuine libc/data-format compatibility risk even if all FFI symbols load. |

No FFI symbol is requested with a `GLIBC_*` symbol version, and most of the
table consists of standardized or Linux-wide entry points. Thus "loads
`libc.so.6`" and "requires glibc behavior" are not synonyms. glibc remains the
supported/tested baseline; another libc is compatible only to the extent that
it passes the symbol, ABI, semantic, and command tests.

The current FFI declarations also use 64-bit types for several C `size_t`,
`unsigned long`, pointer-sized, and syscall arguments, while multiple decoded
buffers assume little-endian fields. A 64-bit little-endian Linux libc is much
closer to the current contract than a 32-bit or big-endian target, regardless
of whether either uses glibc.

For an alternative libc, check these boundaries separately:

1. Bun itself must be built for and runnable with that libc.
2. `libc.so.6` must resolve to the intended implementation.
3. Every symbol in the eager table must resolve, even if the selected command
   never calls it.
4. The command's C types, constants, structures, dynamic-loader behavior, and
   kernel interfaces must match.
5. The relevant local and GNU command tests must pass. Successful module
   loading proves only the first part of compatibility.

## Bun-specific APIs by behavior

These are in addition to `Bun.argv` and `import.meta.main`, which all single-call
entries use.

| Bun facility | Commands or behavior |
|---|---|
| `Bun.file(...).arrayBuffer()` | Shared bulk file input used by the base encoders, checksums, and many text utilities, including `cat`, `comm`, `csplit`, `cut`, `date`, `du`, `fmt`, `fold`, `head`, `join`, `nl`, `paste`, `pr`, `ptx`, `shuf`, `sort`, `split`, `tac`, `tr`, `tsort`, `uniq`, and `wc` |
| `Bun.stdin.arrayBuffer()` | `dircolors` when reading its database from standard input |
| `Bun.spawn` | Executing children in `chroot`, `env`, `nice`, `nohup`, `runcon`, `stdbuf`, and `timeout`; factor workers; `sort --compress-program`; `split --filter`; `install`/`ginstall --strip` |
| `Bun.spawnSync` | Locale, ACL, extended-attribute, and security-context helper fallbacks used by `date`, `cp`, `mv`, `ls`/`dir`/`vdir`, `chcon`, `id`, `install`/`ginstall`, `mkdir`, `mkfifo`, `mknod`, `runcon`, and `stat` |
| `Bun.sleep` | `sleep` and polling/follow loops in `tail` |
| `import.meta.path` | Multi-process `factor` execution |

Porting to another runtime therefore requires replacements with the same byte,
file-descriptor, stdio inheritance, signal, exit-status, and `argv[0]`
semantics. Merely renaming a similar API is unlikely to preserve coreutils
behavior.

## Native and Linux interfaces by command

The following table lists command-specific native behavior. The shared eager
libc load described above still applies to all non-`echo` commands even when a
listed feature is not exercised.

| Interface or ABI assumption | Commands or options | Portability class | Behavior if unavailable |
|---|---|---|---|
| `execve`, `execvp`, `chdir`, signal state, and Bun child processes | `chroot`, `env`, `nice`, `nohup`, `runcon`, `stdbuf`, `timeout` | Cross-libc Unix interfaces | These commands cannot faithfully run their child command. `nohup` additionally requires `/bin/sh`. |
| UID/GID, group, root-directory, hostname, priority, signal, and clock syscalls | `chroot`, `hostname`, `nice`, `kill`, `timeout`, `date --set` | Cross-libc POSIX/Linux interfaces | The operation fails when the syscall or necessary privilege is absent. |
| Linux `statx` layout for nanosecond timestamps | `cp`, `date --reference`, `du --time`, `install`/`ginstall`, `ls`/`dir`/`vdir` time modes, `stat`, `touch` | Linux/architecture ABI, not inherently glibc | BNU usually falls back to Bun/Node bigint stat data, which can have different precision or fields. |
| Linux `struct dirent` offsets and `opendir`/`readdir` | `ls`, `dir`, `vdir`, and recursive `rm` | Linux/architecture ABI, not inherently glibc | The hard-coded Linux layout is required for byte-exact filenames and directory traversal. |
| Linux termios layout, baud constants, and `TIOC*` ioctl values | `stty` | Linux/architecture ABI, not inherently glibc | `stty` is ABI-specific and is not portable to a different termios layout. |
| `lseek`, `poll`, `fcntl`, and file-descriptor behavior | `cat`, `head`, `tail`, `tac`, `tee`, and shared streaming/text paths | Cross-libc POSIX interfaces | Seek optimizations, nonblocking handling, and follow behavior can fail or differ. |
| Block-device and sparse/reflink ioctls (`BLKGETSIZE64`, `FICLONE`) plus `SEEK_DATA`/`SEEK_HOLE` | `dd`; `cp` and cross-filesystem `mv` | Linux kernel/filesystem ABI | The relevant block-device, reflink, or sparse-file operation is unavailable; options that permit fallback may use an ordinary copy. |
| Native `fstat`, `ftruncate`, `posix_fadvise`, `statfs`, `sync`, `truncate`, `mkfifo`, `mknod`, and `renameat2` | `dd`, `df`, `stat -f`, `sync`, `truncate`, `mkfifo`, `mknod`, `split --filter`, recursive `cp`/`mv`, and `mv --exchange` | Mixed POSIX and Linux wrappers; no glibc symbol versions | The requested operation fails or loses the GNU-specific behavior. `mv --exchange` specifically needs Linux `renameat2`. |
| Linux inotify | `tail --follow` / `tail -F` on regular files | Linux wrapper/kernel feature, not inherently glibc | BNU falls back to polling when inotify cannot be opened or maintained. |
| Linux process, mount, cgroup, CPU, and security pseudo-files | General raw-argument/SIGPIPE handling; especially `df`, `du`, `kill`, `logname`, `nproc`, `numfmt`, `tail`, `uname`, and `uptime` | Linux host interface, independent of libc identity | Some probes have fallbacks; exact raw byte arguments, mount/cgroup limits, CPU fields, or diagnostics can differ. Bun itself may fail to start if `/proc` is masked. |
| Tested glibc/Linux 384-byte little-endian `utmp` record layout and `/var/run/utmp` | `pinky`, `uptime`, `users`, `who` | libc/data-format sensitive | Other `utmp` layouts are decoded incorrectly or produce no records. `uptime` can use `/proc/stat` only for its default-file boot-time fallback. |
| Linux capabilities and `security.*` extended attributes | Color/context/mode output in `ls`/`dir`/`vdir`; context and metadata operations below | Linux kernel/filesystem feature, not inherently glibc | Output or preservation is incomplete when the kernel or filesystem lacks the relevant xattrs. |

Several constants and buffer offsets are encoded directly rather than obtained
from platform headers. In particular, `stty`, native directory reads, `utmp`,
`statx`, `statfs` filesystem IDs, Linux security syscalls, device-number
encoding, and ioctl requests must be audited before claiming support for a new
OS, libc, or CPU ABI.

## Security modules, ACLs, and extended attributes

Security behavior requires both runtime support and a supporting kernel and
filesystem:

| Facility | Commands or options | Additional requirement |
|---|---|---|
| SELinux/SMACK labels | `chcon`; `id -Z`; `runcon`; `stat %C`; `ls`/`dir`/`vdir -Z`; context/preservation options in `cp`, `mv`, `install`/`ginstall`, `mkdir`, `mkfifo`, and `mknod` | Active Linux security module and label-capable filesystem. SELinux operations prefer `libselinux.so.1`; some reads/writes fall back to xattr tools. `runcon` requires SELinux and its libselinux context APIs. |
| POSIX ACL display | Long-format `ls`, `dir`, and `vdir` | `getfacl`; without it the `+` ACL indicator can be omitted. |
| POSIX ACL preservation | `cp --preserve=mode`/`-a` and cross-filesystem `mv` fallback | `getfacl` and `setfacl`; absence can reduce preservation. |
| Arbitrary xattr preservation | `cp --preserve=xattr`/`--preserve=all`/`-a` and cross-filesystem `mv` fallback | `getfattr` and `setfattr`, plus xattr support on both filesystems. Explicitly required preservation can fail the command. |
| Default label restoration | `-Z`/`--context` paths in copy and creation commands | `restorecon` when the libselinux/native path cannot complete the operation. |

Detection may also consult `/sys/fs/selinux`, `/sys/fs/smackfs`,
`/sys/kernel/security/lsm`, `/proc/self/attr/current`, `getenforce`, and `ps`.
Missing fallback tools do not make the eager libc FFI requirement optional.

## External programs and files

The basic supported-host CLI has no JavaScript package installation step, but
some options intentionally invoke programs that are not bundled with BNU:

| Command or option | External dependency |
|---|---|
| `install` / `ginstall --strip` | `strip`, or the program named by `--strip-program` |
| `sort --compress-program=PROGRAM` | The named compressor/decompressor |
| `split --filter=COMMAND` | `$SHELL` or `/bin/sh`; one ranged path also uses `/usr/bin/dd` |
| `nohup COMMAND` | `/bin/sh` and the requested command |
| `stdbuf` | A GNU `libstdbuf.so` at `/usr/libexec/coreutils/libstdbuf.so` or `/usr/lib/coreutils/libstdbuf.so`; without it BNU can set `_STDBUF_*` but cannot enforce buffering for ordinary programs |
| `timeout COMMAND` | The requested command; Linux `setpriv` is used when available to install a parent-death signal and is otherwise skipped |
| Localized `date` formatting | `locale` is queried for `date_fmt`; built-in formatting is used when unavailable |
| ACL/xattr/security fallbacks | `getfacl`, `setfacl`, `getfattr`, `setfattr`, `restorecon`, `getenforce`, and `ps`, as described above |

Account-aware commands also read host databases directly: `/etc/passwd` and
`/etc/group` are used by `chgrp`, `chown`, `chroot`, `groups`, `id`,
`install`/`ginstall`, `ls`/`dir`/`vdir`, `pinky`, `stat`, and `whoami`-related
lookups. BNU does not currently call NSS APIs, so LDAP or other NSS-only users
and groups may not be represented like they are by GNU coreutils.

## Privileges and filesystem support

Even on a supported runtime and ABI, the host can reject an operation:

- `chroot`, changing another process identity, setting the hostname or system
  clock, raising priority, creating device nodes, and most security-label
  changes normally require capabilities or root;
- ownership, setuid/setgid bits, ACLs, xattrs, file capabilities, reflinks,
  sparse extents, and nanosecond timestamps depend on filesystem support and
  mount options;
- inotify, cgroups, `/proc`, `/sys`, terminal devices, account databases,
  locales, and mount namespaces affect observable output.

These are command-level environmental requirements, not facilities supplied by
a JavaScript engine.

## Porting checklist

Before describing a new runtime or platform as supported:

1. Replace or provide every Bun and Node-compatible API listed above.
2. Make the libc loader platform-aware and lazy enough that unrelated commands
   do not inherit unavailable symbols.
3. Replace hard-coded Linux constants, syscall numbers, and structure layouts
   with definitions verified for the target OS, libc, architecture, and
   endianness.
4. Define fallbacks for `/proc`, `/sys`, `utmp`, account lookup, locales,
   security modules, ACLs, and xattrs.
5. Run the local suite, relevant GNU command tests, and an environment matrix
   comparable to the one in [Testing](testing.md).

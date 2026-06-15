# GNU coreutils 9.11 test boundaries

## Scope

BNU tracks the 733 `.sh` and `.pl` command-test scripts in GNU coreutils
9.11's standard `TESTS = $(all_tests) $(factor_tests)` inventory. Individual
scripts can contain multiple assertions. GNU's C-internal `gnulib-tests` suite
is outside this JavaScript command-compatibility scope.

The upstream `all_root_tests` variable contains 41 names that are already part
of the 733; they are routed to a root guest rather than counted twice. The
runner derives both sets from the extracted upstream `Makefile.in`, currently
yielding 692 non-root tests and 41 root tests.

The accepted result is 727 tests with a `PASS` record on at least one suitable
platform and the following six Bun runtime or target-ABI boundaries. A normal
BNU JavaScript command cannot begin in any of these six environments.

## Accepted boundaries

| Upstream test | Boundary before BNU can execute |
|---|---|
| `tests/df/no-mtab-status-masked-proc.sh` | The test replaces or masks `/proc`. Bun aborts during runtime startup because required procfs facilities are unavailable. |
| `tests/id/gnu-zero-uids.sh` | The behavior is specific to GNU/Hurd. The official Gentoo amd64 Hurd guest supplies that ABI, but Bun is a Linux ELF executable requesting Linux's loader and glibc ABI, so it cannot start on Hurd. |
| `tests/nproc/nproc-quota-systemd.sh` | The test starts the command in an exact `SCHED_DEADLINE` systemd scope. Bun traps during startup in that scope; ordinary and other scheduler/cgroup quota cases run. |
| `tests/sort/sort-continue.sh` | The test closes file descriptors below Bun's runtime startup requirement. Bun aborts while initializing its event loop, before the `sort` JavaScript runs. |
| `tests/sort/sort-merge-fdlimit.sh` | The imposed descriptor limit is below Bun's runtime startup floor, so the runtime aborts before dispatching BNU. |
| `tests/stat/stat-mount.sh` | The test hides or replaces `/proc`. Bun aborts during startup before the `stat` JavaScript can execute. |

These entries are not allowances for arbitrary skips. The QEMU matrix embeds
this exact sorted allowlist and fails when any other inventory member lacks a
`PASS` record. If a future Bun version makes one of these tests pass, the
matrix reports that the documented boundary is stale so it can be removed.

## Resolved former skips

The following cases formerly depended on unavailable host state or GNU C
debugger hooks and now have executable coverage:

| Tests | Resolution |
|---|---|
| `tests/df/no-mtab-status.sh`, `tests/df/skip-duplicates.sh`, `tests/df/skip-rootfs.sh` | Deterministic JavaScript mount-table fixtures exercise the same parser cases without obsolete or synthetic host mounts. |
| `tests/du/bigtime.sh` | A JavaScript timestamp fixture supplies the upstream out-of-range timestamp independently of the host filesystem range. |
| `tests/rm/r-root.sh` | The adapted fixture intercepts the same removal boundary and validates abbreviated `--no-preserve-root` rejection without GNU `remove.c` symbols. |
| `tests/tail/inotify-race.sh`, `tests/tail/inotify-race2.sh` | A synchronous JavaScript hook replaces the GNU `tail.c` debugger breakpoint and deterministically reproduces both races. |
| `tests/chcon/chcon.sh`, `tests/ls/selinux.sh`, `tests/id/setgid.sh` | These run in the Gentoo amd64 SELinux guest with the MLS policy active. |
| `tests/id/smack.sh`, `tests/mkdir/smack-root.sh`, `tests/mkdir/smack-no-root.sh` | These run in the Gentoo amd64 SMACK guest; the no-root case runs as `nobody` on the XFS guest root. BNU selects the active LSM and reads or writes `security.SMACK64`. |

Terminal-dependent tests receive a controlling pseudo-terminal. Expensive and
very-expensive paths, including generated factor tests `t00` through `t40`, are
enabled by the matrix. Root, SELinux, SMACK, and Hurd cases are routed to their
dedicated Gentoo guests.

## Reproduction and evidence

Run the bounded unit suite and complete platform matrix with:

```sh
scripts/run-all-tests.sh --setup
```

The process is sequential and KVM-only. It defaults to 1536 MiB per guest,
uses one compiler job for guest kernel/package builds, and applies an aggregate
RSS ceiling to every GNU test process tree. See the QEMU section in the main
[README](../README.md#portable-qemu-test-matrix) for host prerequisites and
image setup.

Each run writes its inventory, per-platform logs, allowed boundaries, passed
set, unresolved set, and unexpected-unresolved set beneath:

```text
/var/tmp/bnu-qemu/results/TIMESTAMP/
```

That directory is generated evidence and is intentionally not stored in Git.
The durable source-controlled contract is this document plus the executable
reconciliation in `scripts/run-gnu-qemu-matrix.sh`.

# GNU test boundaries

## Scope

BNU tracks the 733 `.sh` and `.pl` scripts in GNU coreutils 9.11's standard
command-test inventory. A script can contain multiple assertions. GNU's
C-internal `gnulib-tests` are outside this scope.

The inventory contains 692 non-root tests and 41 tests GNU marks as root-only.
The QEMU matrix routes those groups, plus security-module cases, to suitable
guests.

The last complete accepted matrix result, recorded before the July 2026
single-call source refactor, is 727 passing tests and the six boundaries below.
The refactored layout passes the local bounded suite, but these matrix results
should remain identified as historical until the complete matrix is rerun. In
each boundary case, the environment prevents a normal BNU command from
beginning; it is not a skipped command behavior.

## Boundaries

| Upstream test | Reason BNU cannot execute |
|---|---|
| `tests/df/no-mtab-status-masked-proc.sh` | The test masks or replaces `/proc`. Bun aborts during startup because required procfs facilities are unavailable. |
| `tests/id/gnu-zero-uids.sh` | The behavior requires the GNU/Hurd ABI. Bun supplies no compatible GNU/Hurd runtime. |
| `tests/nproc/nproc-quota-systemd.sh` | The test starts the command in an exact `SCHED_DEADLINE` systemd scope. Bun traps during startup in that scope. |
| `tests/sort/sort-continue.sh` | The test closes file descriptors below Bun's runtime startup requirement. Bun aborts while initializing its event loop. |
| `tests/sort/sort-merge-fdlimit.sh` | The imposed file-descriptor limit is below Bun's runtime startup floor. |
| `tests/stat/stat-mount.sh` | The test masks or replaces `/proc`. Bun aborts before the `stat` implementation can run. |

## Enforcement

The allowlist is exact. The matrix fails if any other inventory member lacks a
passing record. It also reports an allowlisted test that unexpectedly passes so
the stale boundary can be removed.

The standard, SELinux MLS, and SMACK guests supply coverage for Linux
platform-specific cases. The GNU/Hurd guest verifies the target environment for
the ABI boundary; it cannot run BNU because the available Bun executable targets
Linux.

## Reproducing the result

Run the local suite and provision or reuse the complete matrix:

```sh
scripts/run-all-tests.sh --setup
```

See [Testing](testing.md) for the host-side harness and
[QEMU test matrix](qemu-test-matrix.md) for guest setup and result files.

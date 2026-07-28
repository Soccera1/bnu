# Testing BNU

BNU has three test levels:

1. the local Bun suite;
2. selected or complete GNU command tests on the current host;
3. the complete cross-environment GNU test matrix in KVM guests.

Most changes need the local suite and relevant GNU tests. The VM matrix is for
release-level or platform-specific validation.

## Local suite

```sh
bun run test
```

Each test runs in a fresh process. The runner defaults to a 1 GiB aggregate
process-tree RSS limit, a 3 GiB per-process address-space limit, and one
`factor` worker.

The defaults can be changed for a controlled test run:

```sh
BNU_TEST_RSS_LIMIT=2GiB \
BNU_TEST_MEMORY_LIMIT=4GiB \
BNU_TEST_TIMEOUT=600000 \
BNU_FACTOR_WORKERS=2 \
  bun run test
```

## GNU command tests

The [GNU Coreutils 9.11](https://ftp.gnu.org/gnu/coreutils/coreutils-9.11.tar.xz)
source tarball is tracked at the repository root through Git LFS. Ensure the
LFS object is materialized before using the harness:

```sh
git lfs pull --include=coreutils-9.11.tar.xz
```

Use `--tarball PATH` to test against a separately downloaded archive.

The harness extracts the tarball and adapts its command tests to invoke BNU.

With no paths, the harness runs a maintained default selection:

```sh
bun run test:gnu
```

To select tests:

```sh
bun run test:gnu -- --list
bun run test:gnu -- tests/misc/echo.sh
bun run test:gnu -- tests/misc/echo.sh tests/misc/printenv.sh
bun run test:gnu -- --all --list
bun run test:gnu -- --all
```

By default, failed GNU tests are reported but do not make the harness return a
failure status. Use `--strict` in CI or whenever the exit status matters:

```sh
bun run test:gnu -- --strict tests/misc/echo.sh
```

### Harness options

| Option | Effect |
|---|---|
| `--all` | Select all 733 tests in GNU's standard command-test inventory. |
| `--list` | Print the selected test names without running them. |
| `--strict` | Return a non-zero status if any selected test fails. |
| `--root-tests` | Restrict the selection to tests GNU marks as root-only. |
| `--nonroot-tests` | Exclude tests GNU marks as root-only. |
| `--expensive` | Set `RUN_EXPENSIVE_TESTS=yes`. |
| `--very-expensive` | Enable both expensive and very-expensive GNU cases. |
| `--tty` | Give every selected test a controlling pseudo-terminal. |
| `--keep` | Preserve the extracted source and inner temporary directories. |
| `--timeout VALUE` | Set the per-test timeout; the default is 300 seconds. |
| `--max-output SIZE` | Set the retained output limit; the default is 1 MiB. |
| `--rss-limit SIZE` | Set the process-tree RSS limit; the default is 1536 MiB. |
| `--memory-limit SIZE` | Set the per-process address-space limit; the default is 4 GiB. RSS remains capped separately. |
| `--tarball PATH` | Use a different GNU coreutils source tarball. |

Known terminal-dependent tests receive a pseudo-terminal automatically.
Root-only tests still require a suitable privileged environment. The complete
matrix routes them to a dedicated guest.

Examples:

```sh
bun run test:gnu -- --strict --timeout 10s tests/misc/printenv.sh
bun run test:gnu -- --expensive tests/tail/big-4gb.sh
bun run test:gnu -- --strict --very-expensive tests/factor/t26.sh
```

GNU's `gnulib-tests` exercise internal C portability code and are not part of
this harness.

## Complete KVM matrix

The complete entry point runs the local suite, then the GNU inventory in its
required guest environments:

```sh
scripts/run-all-tests.sh --setup
```

Later runs can reuse the provisioned guests:

```sh
scripts/run-all-tests.sh
```

Use `scripts/run-gnu-qemu-matrix.sh` when the local suite is not needed. The
matrix accepts only the boundaries listed in
[GNU test boundaries](gnu-test-boundaries.md).

Provisioning, host requirements, storage, and result locations are documented
in [QEMU test matrix](qemu-test-matrix.md).

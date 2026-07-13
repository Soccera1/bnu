# BNU

BNU is an independent implementation of GNU coreutils for
[Bun](https://bun.sh/). It runs as a multi-call command: the first argument
selects the utility.

```sh
bun ./bin/bnu.js echo hello
bun ./bin/bnu.js sort file.txt
bun ./bin/bnu.js cp source destination
```

Linux is the primary tested platform. BNU is not built from GNU coreutils
source and does not provide its internal C interfaces.

## Requirements

Running BNU from this repository requires Bun. Some commands also rely on
operating-system facilities such as Linux extended attributes, ACLs, inotify,
or security modules.

No dependency installation is needed for the basic CLI:

```sh
bun ./bin/bnu.js --help
bun ./bin/bnu.js COMMAND --help
```

The GNU compatibility harness also needs the coreutils 9.11 source tarball,
which is not stored in Git. See [Testing](docs/testing.md#gnu-command-tests) for
the download command.

## Command wrappers

The CLI can generate command-name wrappers for use in a separate directory:

```sh
bun run link-commands -- ./dist/bin
./dist/bin/echo hello
./dist/bin/wc README.md
```

Add that directory to `PATH` only when you intentionally want BNU commands to
take precedence over the system coreutils.

The top-level `--help` output lists the available commands. Use
`COMMAND --help` for a command's accepted options.

## Compatibility

The compatibility target is the observable command-line behavior of GNU
coreutils 9.11. The upstream package contains 733 command-test scripts; BNU has
passing test results for 727 of them. The other six cannot start the Bun runtime
in the environment constructed by the test.

That result is useful test coverage, not a claim of complete equivalence.
Individual scripts contain many cases, and the inventory does not cover every
option combination, locale, filesystem, kernel, or failure mode. GNU's internal
`gnulib-tests` are also outside BNU's scope.

Host capabilities affect some results:

- ACL, extended-attribute, security-context, reflink, sparse-file, device, and
  notification behavior depends on kernel and filesystem support.
- Ownership changes, `chroot`, clock changes, device creation, and
  security-label operations may require elevated privileges.
- Locale, account databases, terminal configuration, and mount state can
  change output or diagnostics.

See [GNU test boundaries](docs/gnu-test-boundaries.md) for the six runtime/ABI
cases.

## Development

Run the local test suite with:

```sh
bun run test
```

Run the default selection of upstream GNU tests with:

```sh
bun run test:gnu
```

The upstream harness reports failures without failing the command unless
`--strict` is supplied. Full test options, resource limits, and the KVM test
matrix are documented in [Testing](docs/testing.md).

## Repository layout

- `bin/bnu.js` — multi-call entry point
- `src/coreutils.js` — command implementations
- `tests/` — local Bun tests
- `scripts/` — test harnesses, wrapper generation, and VM tooling
- `docs/` — testing and compatibility documentation

## License

See [LICENSE](LICENSE).

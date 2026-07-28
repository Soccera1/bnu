# BNU

BNU is an independent implementation of GNU coreutils for
[Bun](https://bun.sh/). Every utility has its own single-call source entry:

```sh
bun ./src/commands/echo.js hello
bun ./src/commands/sort.js file.txt
bun ./src/commands/cp.js source destination
```

The `bnu` multi-call launcher remains as a compatibility and discovery surface:

```sh
bun ./bin/bnu.js echo hello
bun ./bin/bnu.js --help
```

Command modules contain their command-specific implementation, not just a call
through to a combined implementation file. Helpers used by more than one
command are defined once in the family modules under `src/shared/` and imported by each
consumer. This keeps shared code deduplicated and lets Bun cache/JIT the same
module instance across commands loaded in one process.

Linux is the primary tested platform. BNU is not built from GNU coreutils
source and does not provide its internal C interfaces.

## Requirements

Running BNU from this repository requires Bun. Some commands also rely on
operating-system facilities such as Linux extended attributes, ACLs, inotify,
or security modules.

No dependency installation is needed for the basic CLI:

```sh
bun ./src/commands/echo.js --help
bun ./bin/bnu.js --help
```

The GNU compatibility harness also needs the coreutils 9.11 source tarball,
which is not stored in Git. See [Testing](docs/testing.md#gnu-command-tests) for
the download command.

## Command wrappers

The CLI can generate command-name wrappers for the single-call entries in a
separate directory:

```sh
bun run link-commands -- ./dist/bin
./dist/bin/echo hello
./dist/bin/wc README.md
```

Add that directory to `PATH` only when you intentionally want BNU commands to
take precedence over the system coreutils.

The top-level `--help` output lists the available commands. Use
`COMMAND --help` for a command's accepted options.

## Manuals

BNU includes section-1 manual pages and an Info manual adapted from GNU
Coreutils 9.11, with BNU-specific invocation, diagnostic, and extension notes.
Read them directly from a checkout with:

```sh
man -l man/cat.1
info -f doc/bnu.info
```

The manual sources, licensing, adaptations, and refresh procedure are described
in [BNU manual provenance](doc/README.md).

## Compatibility

BNU keeps the familiar GNU diagnostic as the first line of an error, then adds
an actionable `Hint:`. Command-aware remedies cover option syntax, operands,
formats, ranges, modes, filesystems, processes, and uncommon platform failures;
a general next step remains as a final fallback. Set `GNULY_CORRECT` to
a truthy value such as `1` or `true` to emit GNU-compatible diagnostics exactly.
Boolean names are case-insensitive, so `True` and `TRUE` work too:

```sh
GNULY_CORRECT=1 bnu cat missing-file
```

An empty value, `0`, or any capitalization of `false` disables GNU-compatible
wording and leaves friendly hints enabled.

This switch affects diagnostic wording only; it does not change command
semantics. It is enabled automatically by BNU's GNU compatibility test harness.

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

- `src/commands/` — one independently runnable entry per command
- `src/shared/catalog.js` — command discovery and lazy module loading
- `src/shared/command.js` — shared single-call entry behavior
- `src/shared/runtime.js` — multi-call dispatch shared by all commands
- `src/shared/{diagnostics,help,help-options}.js` — diagnostics and command help data/rendering
- `src/shared/{listing,copy,time,hash,install,ownership,paths,head-tail,tabs,test-expression}.js` — focused, single-copy command-family modules
- `src/shared/{common,filesystem,text,checksum,process,system}.js` — smaller cross-family primitives
- `src/coreutils.js` — compatibility export for API consumers
- `bin/bnu.js` — compatibility multi-call launcher
- `man/` — adapted section-1 manual pages
- `doc/` — adapted Texinfo sources and compiled Info manual
- `tests/` — local Bun tests
- `scripts/` — test harnesses, wrapper generation, and VM tooling
- `docs/` — testing and compatibility documentation

## License

See [LICENSE](LICENSE).

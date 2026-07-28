# BNU manual provenance

The section-1 pages in [`man/`](../man/) and the Texinfo sources in this
directory are adapted from the documentation in the GNU Coreutils 9.11 source
release. The compiled [`bnu.info`](bnu.info) manual is generated from
[`bnu.texi`](bnu.texi).

The imported documentation retains the Free Software Foundation copyright,
original author credits, warranty notice, and license notices. The Texinfo
manual is distributed under the GNU Free Documentation License 1.3 or later,
with no invariant sections or cover texts; its full license is included in
[`fdl.texi`](fdl.texi). The upstream-generated manual pages state their
GPLv3-or-later terms in each page.

The BNU edition is marked as modified. Its substantive adaptations are:

- BNU naming, version headers, bug-reporting URL, and local Info references
- an explicit compatibility caveat for this independent Bun implementation
- BNU's primary single-call entries and compatibility dispatcher forms
- standalone documentation for BNU's `sm3sum` extension
- alias pages for `[` and `ginstall`, plus the local `bnu(1)` page
- replacement of upstream C-implementation claims that do not apply to BNU

The Info manual's title page, copyright notice, and History appendix identify
the modified edition's contributors, publisher, date, and transparent sources
as required by the GNU Free Documentation License.

Most command and option descriptions remain upstream text because matching that
observable interface is BNU's compatibility target. Platform-dependent behavior
can still differ; command `--help` output and actual BNU behavior take precedence.

The GNU Coreutils release archive is tracked at the repository root through Git
LFS. To refresh the imported files, first ensure the LFS object is present, then
install `tar`, Bun, and GNU Texinfo and run:

```sh
git lfs pull --include=coreutils-9.11.tar.xz
bun run docs:import
```

An alternate archive can be passed directly to
`bun scripts/import-gnu-docs.js PATH`.

The importer overwrites upstream-derived section-1 pages and regenerates the
Texinfo and Info files. The locally authored `man/bnu.1` page is preserved.

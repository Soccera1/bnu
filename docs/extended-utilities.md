# Utilities beyond Coreutils

BNU includes text processing, comparison/patching, archives/compression, HTTP
downloads and a binutils command family. These commands use the same direct
entries, `bnu COMMAND` dispatch, generated wrappers and production build as the
Coreutils commands. They are independent implementations with the supported
interfaces described below, not complete replacements for every GNU option.

```sh
bun bin/bnu.js grep -rn 'TODO' src
bun bin/bnu.js sed 's/old/new/g' input.txt
bun bin/bnu.js awk '{ total += $1 } END { print total }' numbers.txt
bun bin/bnu.js diff -u before.txt after.txt
bun bin/bnu.js patch -p1 -i changes.patch
bun bin/bnu.js tar -czf source.tar.gz src
bun bin/bnu.js gzip -k input.txt
bun bin/bnu.js cpio -o -H newc < file-list > files.cpio
bun bin/bnu.js wget -O download.bin https://example.com/download.bin
```

Use `COMMAND --help` for accepted options. The existing adapted Coreutils man
and Info pages describe the original Coreutils commands; the additional command
families are documented here and in their command help.

## Text, diff and patch

| Commands | Implemented behavior |
|---|---|
| `grep` | Basic/extended POSIX regexes, fixed strings and PCRE2; repeated patterns and pattern files; recursion and include/exclude filters; context, line/byte/file prefixes, counts, matched substrings and filename lists; binary and NUL-delimited input. Exit status is 0 for matches, 1 for no matches and 2 for errors. |
| `sed` | Script expressions/files, addresses and ranges, substitution/transliteration, pattern/hold spaces, branching and grouped commands, multiline cycles, inserted text, file reads/writes, in-place edits with optional backups, separate-file and NUL modes. |
| `awk` | A parser and interpreter for pattern/action programs: BEGIN/END, records and fields, assignments, arithmetic/string/regex expressions, conditions and loops, functions and associative arrays, standard math/string functions, printf, getline and file/pipe redirection. |
| `diff`, `cmp`, `sdiff`, `diff3` | Normal, unified, context, ed/rcs and side-by-side differences; recursive directories; whitespace/case/line filtering; byte comparisons with skips/limits; three-way comparison and merging with conflict markers. |
| `patch` | Normal, context and unified patch application; path stripping, directory/input selection, reverse application, offsets/fuzz, dry runs, backups and rejects, file creation/deletion and output selection. Paths derived from patches cannot escape the selected destination through traversal or existing symlink parents. |

Text tools generally buffer their input; `sed -u` reads records incrementally.
AWK output pipes run when the pipe is closed or
the program finishes; interactive pipe streaming and coprocesses are not
implemented. GNU AWK extensions are not a general compatibility promise.
`sdiff` provides display, not interactive merging. Patch does not implement ed
scripts or revision-control retrieval. `diff3` rejects ed output containing an
unsupported literal-dot insertion rather than emitting a broken script.

## Archives and compression

`tar` creates pax/ustar archives and reads those formats plus GNU long-name and
base-256 extensions. It supports create, list, extract, compare, append, update,
concatenate and delete, gzip compression, member selection, exclusions,
files-from lists, positional directories, permissions, times, symlinks and
hardlinks. Sparse archives and device-node members are not implemented. Gzip is
the supported compression format; xz/bzip2/zstd integration is not included.

`gzip`, `gunzip` and `zcat` compress/decompress files and standard streams, support
concatenated gzip members, integrity testing/listing, compression levels,
recursive operation, suffixes, preservation of source files and filename/time
metadata. Decompression validates data before replacing output or removing the
source. The historical Unix `.Z`/LZW format is not supported.

`cpio` reads/writes binary, odc, newc and crc archives, reads tar/ustar input, and
supports copy-in, copy-out and pass-through, patterns, NUL filename lists,
append, links and timestamps. HPUX variants are not implemented.

Archive/compression operations buffer data in memory. Extraction rejects unsafe
absolute/traversal paths and symlinks that escape the output directory, and
does not follow pre-existing symlink parents or overwrite outside hardlink
contents. Ordinary extraction does not require elevated privileges.

## Binutils and cross-platform object targets

The binutils command set is `addr2line`, `ar`, `as`, `c++filt`, `elfedit`, `ld`,
`nm`, `objcopy`, `objdump`, `ranlib`, `readelf`, `size`, `strings` and `strip`.
Target format support means handling those files on the tested Linux host; it
does not establish that the BNU runtime itself runs on Windows or macOS.

| Commands | Targets and behavior |
|---|---|
| `ar`, `ranlib` | Unix archives, GNU and BSD extended member names, deterministic writing and GNU linker symbol indexes. Archive indexes can contain symbols from ELF, COFF and Mach-O objects. Thin archives are not supported. |
| `nm`, `size`, `strings` | ELF32/64, PE/COFF, Mach-O32/64 and universal Mach-O inspection, archives, symbol filtering/sorting and section sizes. Strings also scans arbitrary binary streams and supports single-byte/UTF-16/UTF-32 encodings. |
| `readelf`, `elfedit` | ELF headers, segments, sections, symbols, relocations, notes and dynamic entries; section hex/string dumps; ELF machine/type/OS-ABI field editing. These commands are ELF-specific by design. |
| `objdump` | Headers, sections, symbols, relocations, contents and architecture-aware disassembly for ELF, PE/COFF and Mach-O. |
| `as` | Assembly into ELF, COFF or Mach-O with target triples such as `x86_64-unknown-linux-gnu`, `aarch64-pc-windows-msvc` and `arm64-apple-darwin`. Instruction parsing/encoding uses LLVM's public C API. |
| `ld` | Native static executable linking for ELF64, PE32+ and Mach-O64, on x86-64 and AArch64. Handles input objects/archives, symbols, common/weak definitions, library search, relocations, entry points, image base and link maps. Unsupported relocation types produce errors. |
| `objcopy`, `strip` | Copy/strip ELF, PE/COFF, Mach-O and archives; remove/rename sections and extract raw binary contents. ELF additionally supports added/updated sections, selective symbol removal, separate debug data, and wrapping binary input as a relocatable ELF object. |
| `addr2line` | DWARF 2–5 source lookup in ELF/COFF/Mach-O, including compressed ELF debug sections, inline frames, function names, section-relative queries and C++ demangling. |
| `c++filt` | Itanium ABI C++ symbol demangling using the native C++ ABI library. Microsoft symbol mangling and other demangling dialects are not implemented. |

The linker emits static images: it does not implement `ld -r`, shared libraries,
PIE, dynamic imports, linker scripts or TLS. PE executables have fixed image
bases and no DLL imports. Mach-O executable output uses `LC_UNIXTHREAD`.
Linux executables are run in the tests; PE and Mach-O are validated by independent
LLVM readers and relocation assertions, not executed on their destination OSes.
Conversion between object formats with their relocations is not supported by
`objcopy`; binary input can be wrapped as ELF and object section data can be
exported as raw binary.

Modifying signed PE or Mach-O files can invalidate their signatures. BNU does
not sign or re-sign output files.

```sh
# Assemble for three operating-system object formats.
bun bin/bnu.js as --target=x86_64-unknown-linux-gnu -o linux.o linux.s
bun bin/bnu.js as --target=x86_64-pc-windows-msvc -o windows.obj windows.s
bun bin/bnu.js as --target=arm64-apple-darwin -o mac.o mac.s
bun bin/bnu.js objdump -d windows.obj
bun bin/bnu.js nm mac.o
bun bin/bnu.js ar rcs libexample.a linux.o
bun bin/bnu.js ld -o example -e _start start.o libexample.a
```

## Wget

`wget` supports HTTP/HTTPS, streaming response bodies, redirects, request
headers and basic authentication, POST/custom request bodies, output files or
stdout, directory prefixes, URL input lists, retries/timeouts, server-response
printing, spider requests, timestamping, no-clobber and validated range resumes.
Credentials and cookies are removed from requests redirected to a different
origin. TLS verification is enabled unless `--no-check-certificate` is given.
File names derived from URLs or Content-Disposition are reduced to a basename.

FTP, recursive website mirroring, HTML link conversion, cookie jars and a full
GNU wget configuration language are not implemented. HTTP errors, network
failures and local output failures use distinct nonzero statuses.

## Dependencies and tests

The baseline remains Bun on Linux with the native libc interfaces documented
in [Runtime and platform requirements](runtime-portability.md). Additional
native libraries are loaded only when needed:

- `as` and `objdump -d/-D`: a shared LLVM library exporting the public C API and
  X86, AArch64, ARM and RISCV target components. Tested with LLVM 22. The system
  loader searches `libLLVM.so` and versioned names; `BNU_LLVM_LIBRARY` selects an
  explicit library path.
- `c++filt` and demangling options: `libstdc++.so.6` or `libc++abi.so.1`.
- `grep -P`: `libpcre2-8.so.0`.

Implementations do not invoke the corresponding host utility. User programs
can still explicitly execute other programs through AWK `system()` and pipes.
The tests use GNU tools and Clang/LLVM as independent references; LLVM/Clang,
GCC and the corresponding GNU archive/text/binutils commands must be installed
to run the full interoperability suite.

`bun run test` discovers every `tests/*.test.js` file and runs each named test
in a separate memory-bounded process. The extended suites exercise actual
file/stream operations, failures and GNU/LLVM interoperability. The separate
upstream Coreutils harness continues to wrap only Coreutils commands, so its
reference text/archive tools remain the host implementations.

Format implementation references: [ELF gABI](https://refspecs.linuxfoundation.org/elf/gabi4+/contents.html),
[Microsoft PE/COFF](https://learn.microsoft.com/en-us/windows/win32/debug/pe-format),
[Apple Mach-O headers](https://github.com/apple-oss-distributions/xnu/blob/main/EXTERNAL_HEADERS/mach-o/loader.h),
and the [GNU Binutils manual](https://www.sourceware.org/binutils/docs/binutils.html).

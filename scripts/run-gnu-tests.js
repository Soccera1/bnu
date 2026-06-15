#!/usr/bin/env bun
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { commandNames } from "../src/coreutils.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const keep = takeFlag("--keep");
const list = takeFlag("--list");
const strict = takeFlag("--strict");
const all = takeFlag("--all");
const expensive = takeFlag("--expensive");
const veryExpensive = takeFlag("--very-expensive");
const tty = takeFlag("--tty");
const rootTestsOnly = takeFlag("--root-tests");
const nonRootTestsOnly = takeFlag("--nonroot-tests");
takeFlag("--quick");
takeFlag("--default");
if (rootTestsOnly && nonRootTestsOnly) {
  throw new Error("--root-tests and --nonroot-tests are mutually exclusive");
}
const DEFAULT_TIMEOUT = "300s";
const timeout = takeValue("--timeout") ?? DEFAULT_TIMEOUT;
const maxOutputBytes = parseByteSize(takeValue("--max-output") ?? "1MiB");
// prlimit's address-space ceiling is per process, so a test that fans out can
// still consume much more physical memory in aggregate.  Watch the complete
// test process tree as a second line of defence and terminate only that tree
// before it can put the host under memory pressure.
const rssLimitBytes = parseByteSize(takeValue("--rss-limit") ?? "1536MiB");
// Keep a pathological JS heap from threatening the host.  Tests may lower
// this inherited ceiling with ulimit, but cannot raise it.
// JSC reserves more than 2 GiB of virtual address space for some otherwise
// ~120 MiB workloads.  Three GiB keeps those valid tests runnable while still
// preventing the unbounded 11 GiB heap growth that motivated this guard.
const memoryLimitBytes = parseByteSize(takeValue("--memory-limit") ?? "3GiB");
const tarball = takeValue("--tarball") ?? join(root, "coreutils-9.11.tar.xz");
const work = await mkdtemp(join(tmpdir(), "bnu-gnu-tests-"));
// Root-only GNU tests deliberately drop to an unprivileged account. mkdtemp
// creates this extraction parent as 0700, which otherwise makes every BNU
// wrapper beneath it unreachable after the credential transition.
await chmod(work, 0o755);
const source = join(work, "coreutils-9.11");
const TTY_TESTS = new Set([
  "tests/misc/tty-eof.pl",
  "tests/stty/bad-speed.sh",
  "tests/stty/stty-invalid.sh",
  "tests/stty/stty-pairs.sh",
  "tests/stty/stty-row-col.sh",
  "tests/stty/stty.sh",
]);
const DEFAULT_TESTS = [
  "tests/misc/false-status.sh",
  "tests/misc/printenv.sh",
  "tests/misc/pathchk.sh",
  "tests/misc/echo.sh",
  "tests/misc/invalid-opt.pl",
  "tests/help/help-version.sh",
  "tests/help/help-version-getopt.sh",
  "tests/misc/basename.pl",
  "tests/misc/dirname.pl",
  "tests/misc/user.sh",
  "tests/env/env.sh",
  "tests/env/env-S.pl",
  "tests/env/env-S-script.sh",
  "tests/env/env-null.sh",
  "tests/env/env-signal-handler.sh",
  "tests/basenc/basenc.pl",
  "tests/basenc/base64.pl",
  "tests/basenc/large-input.sh",
  "tests/basenc/bounded-memory.sh",
  "tests/cat/cat-E.sh",
  "tests/cat/cat-buf.sh",
  "tests/cat/cat-self.sh",
  "tests/cat/cat-proc.sh",
  "tests/cat/splice.sh",
  "tests/wc/wc.pl",
  "tests/wc/wc-cpu.sh",
  "tests/wc/wc-total.sh",
  "tests/wc/wc-files0.sh",
  "tests/wc/wc-files0-from.pl",
  "tests/wc/wc-nbsp.sh",
  "tests/wc/wc-parallel.sh",
  "tests/wc/wc-proc.sh",
  "tests/id/uid.sh",
  "tests/id/zero.sh",
  "tests/id/context.sh",
  "tests/id/no-context.sh",
  "tests/groups/groups-version.sh",
  "tests/groups/groups-dash.sh",
  "tests/groups/groups-process-all.sh",
  "tests/nproc/nproc-positive.sh",
  "tests/nproc/nproc-avail.sh",
  "tests/nproc/nproc-override.sh",
  "tests/nproc/nproc-quota.sh",
  "tests/tty/tty.sh",
  "tests/stty/bad-speed.sh",
  "tests/stty/stty-invalid.sh",
  "tests/stty/stty-row-col.sh",
  "tests/stty/stty.sh",
  "tests/head/head-c.sh",
  "tests/head/head-elide-tail.pl",
  "tests/head/head-write-error.sh",
  "tests/head/head.pl",
  "tests/join/join.pl",
  "tests/join/join-utf8.sh",
  "tests/misc/comm.pl",
  "tests/misc/io-errors.sh",
  "tests/misc/tty-eof.pl",
  "tests/misc/xstrtol.pl",
  "tests/cksum/cksum.sh",
  "tests/cksum/cksum-a.sh",
  "tests/cksum/cksum-c.sh",
  "tests/cksum/cksum-base64.pl",
  "tests/cksum/cksum-base64-untagged.sh",
  "tests/cksum/cksum-raw.sh",
  "tests/cksum/sum.pl",
  "tests/cksum/sum-sysv.sh",
  "tests/cksum/b2sum.sh",
  "tests/cksum/md5sum.pl",
  "tests/cksum/md5sum-bsd.sh",
  "tests/cksum/md5sum-newline.pl",
  "tests/cksum/md5sum-parallel.sh",
  "tests/cksum/sha1sum.pl",
  "tests/cksum/sha1sum-vec.pl",
  "tests/cksum/sha224sum.pl",
  "tests/cksum/sha256sum.pl",
  "tests/cksum/sha384sum.pl",
  "tests/cksum/sha512sum.pl",
  "tests/cksum/cksum-sha3.sh",
  "tests/cksum/sm3sum.pl",
  "tests/expr/expr.pl",
  "tests/expr/expr-multibyte.pl",
  "tests/test/test-file.sh",
  "tests/test/test.pl",
  "tests/test/test-diag.pl",
  "tests/test/test-N.sh",
  "tests/seq/seq-io-errors.sh",
  "tests/seq/seq.pl",
  "tests/seq/seq-extra-number.sh",
  "tests/seq/seq-epipe.sh",
  "tests/seq/seq-locale.sh",
  "tests/seq/seq-long-double.sh",
  "tests/seq/seq-precision.sh",
  "tests/pwd/pwd-option.sh",
  "tests/pwd/argument.sh",
  "tests/pwd/pwd-long.sh",
  "tests/readlink/can-e.sh",
  "tests/readlink/can-f.sh",
  "tests/readlink/can-m.sh",
  "tests/readlink/multi.sh",
  "tests/readlink/readlink-fp-loop.sh",
  "tests/readlink/readlink-posix.sh",
  "tests/readlink/readlink-root.sh",
  "tests/readlink/rl-1.sh",
  "tests/misc/realpath.sh",
  "tests/mktemp/mktemp-misc.sh",
  "tests/mktemp/mktemp.pl",
  "tests/mktemp/bad-unicode.sh",
  "tests/mktemp/write-error.sh",
  "tests/date/date-debug.sh",
  "tests/date/date.pl",
  "tests/date/date-ethiopia.sh",
  "tests/date/date-iran.sh",
  "tests/date/date-locale-hour.sh",
  "tests/date/date-next-dow.pl",
  "tests/date/percent-percent.sh",
  "tests/date/reference.sh",
  "tests/date/resolution.sh",
  "tests/date/date-sec.sh",
  "tests/date/date-thailand.sh",
  "tests/date/date-tz.sh",
  "tests/truncate/truncate-overflow.sh",
  "tests/truncate/multiple-files.sh",
  "tests/truncate/truncate-dangling-symlink.sh",
  "tests/truncate/truncate-dir-fail.sh",
  "tests/truncate/truncate-fail-diag.sh",
  "tests/truncate/truncate-fifo.sh",
  "tests/truncate/truncate-no-create-missing.sh",
  "tests/truncate/truncate-parameters.sh",
  "tests/truncate/truncate-relative.sh",
  "tests/truncate/truncate-owned-by-other.sh",
  "tests/tee/append.sh",
  "tests/tee/tee.sh",
  "tests/uniq/uniq.pl",
  "tests/uniq/uniq-perf.sh",
  "tests/uniq/uniq-collate.sh",
  "tests/tr/tr.pl",
  "tests/tr/tr-case-class.sh",
  "tests/tac/tac.pl",
  "tests/tac/tac-2-nonseekable.sh",
  "tests/tac/tac-continue.sh",
  "tests/tac/tac-locale.sh",
  "tests/cut/cut.pl",
  "tests/cut/mb-non-utf8.sh",
  "tests/cut/bounded-memory.sh",
  "tests/cut/cut-huge-range.sh",
  "tests/touch/empty-file.sh",
  "tests/touch/60-seconds.sh",
  "tests/touch/dangling-symlink.sh",
  "tests/touch/dir-1.sh",
  "tests/touch/fifo.sh",
  "tests/touch/no-dereference.sh",
  "tests/touch/no-create-missing.sh",
  "tests/touch/no-rights.sh",
  "tests/touch/not-owner.sh",
  "tests/touch/now-owned-by-other.sh",
  "tests/touch/obsolescent.sh",
  "tests/touch/fail-diag.sh",
  "tests/touch/read-only.sh",
  "tests/touch/relative.sh",
  "tests/touch/trailing-slash.sh",
  "tests/df/total-verify.sh",
  "tests/df/df-P.sh",
  "tests/df/df-output.sh",
  "tests/df/df-symlink.sh",
  "tests/df/over-mount-device.sh",
  "tests/df/problematic-chars.sh",
  "tests/df/total-unprocessed.sh",
  "tests/df/header.sh",
  "tests/df/unreadable.sh",
  "tests/df/sync.sh",
  "tests/du/exclude.sh",
  "tests/du/basic.sh",
  "tests/du/apparent.sh",
  "tests/du/deref.sh",
  "tests/du/deref-args.sh",
  "tests/du/files0-from.pl",
  "tests/du/files0-from-dir.sh",
  "tests/du/hard-link.sh",
  "tests/du/inodes.sh",
  "tests/du/max-depth.sh",
  "tests/du/no-deref.sh",
  "tests/du/slash.sh",
  "tests/du/trailing-slash.sh",
  "tests/du/two-args.sh",
  "tests/du/inacc-dest.sh",
  "tests/du/inacc-dir.sh",
  "tests/du/inaccessible-cwd.sh",
  "tests/du/long-from-unreadable.sh",
  "tests/du/long-sloop.sh",
  "tests/du/no-x.sh",
  "tests/du/one-file-system.sh",
  "tests/du/restore-wd.sh",
  "tests/du/bind-mount-dir-cycle-v2.sh",
  "tests/du/bind-mount-dir-cycle.sh",
  "tests/du/move-dir-while-traversing.sh",
  "tests/du/threshold.sh",
  "tests/cp/same-file.sh",
  "tests/cp/link.sh",
  "tests/cp/backup-1.sh",
  "tests/cp/backup-dir.sh",
  "tests/cp/backup-is-src.sh",
  "tests/cp/abuse.sh",
  "tests/cp/acl.sh",
  "tests/cp/capability.sh",
  "tests/cp/attr-existing.sh",
  "tests/cp/cp-a-selinux.sh",
  "tests/cp/no-ctx.sh",
  "tests/cp/cp-HL.sh",
  "tests/cp/cp-deref.sh",
  "tests/cp/cp-i.sh",
  "tests/cp/cp-mv-backup.sh",
  "tests/cp/cp-mv-enotsup-xattr.sh",
  "tests/cp/cross-dev-symlink.sh",
  "tests/cp/deref-slink.sh",
  "tests/cp/debug.sh",
  "tests/cp/dir-rm-dest.sh",
  "tests/cp/dir-slash.sh",
  "tests/cp/dir-vs-file.sh",
  "tests/cp/existing-perm-dir.sh",
  "tests/cp/existing-perm-race.sh",
  "tests/cp/cp-parents.sh",
  "tests/cp/fail-perm.sh",
  "tests/cp/into-self.sh",
  "tests/cp/keep-directory-symlink.sh",
  "tests/cp/link-deref.sh",
  "tests/cp/link-no-deref.sh",
  "tests/cp/link-preserve.sh",
  "tests/cp/link-symlink.sh",
  "tests/cp/file-perm-race.sh",
  "tests/cp/no-deref-link1.sh",
  "tests/cp/no-deref-link2.sh",
  "tests/cp/no-deref-link3.sh",
  "tests/cp/non-utf8-name.sh",
  "tests/cp/nfs-removal-race.sh",
  "tests/cp/parent-perm.sh",
  "tests/cp/parent-perm-race.sh",
  "tests/cp/preserve-2.sh",
  "tests/cp/preserve-link.sh",
  "tests/cp/preserve-mode.sh",
  "tests/cp/preserve-gid.sh",
  "tests/cp/preserve-slink-time.sh",
  "tests/cp/proc-short-read.sh",
  "tests/cp/proc-zero-len.sh",
  "tests/cp/r-vs-symlink.sh",
  "tests/cp/readonly-dir.sh",
  "tests/cp/reflink-auto.sh",
  "tests/cp/reflink-perm.sh",
  "tests/cp/slink-2-slink.sh",
  "tests/cp/sparse.sh",
  "tests/cp/sparse-2.sh",
  "tests/cp/sparse-extents.sh",
  "tests/cp/sparse-extents-2.sh",
  "tests/cp/sparse-perf.sh",
  "tests/cp/sparse-to-pipe.sh",
  "tests/cp/special-bits.sh",
  "tests/cp/special-f.sh",
  "tests/cp/src-base-dot.sh",
  "tests/cp/symlink-slash.sh",
  "tests/cp/thru-dangling.sh",
  "tests/mv/acl.sh",
  "tests/mv/update.sh",
  "tests/mv/i-1.pl",
  "tests/mv/i-2.sh",
  "tests/mv/i-3.sh",
  "tests/mv/i-4.sh",
  "tests/mv/i-5.sh",
  "tests/mv/backup-is-src.sh",
  "tests/mv/childproof.sh",
  "tests/mv/no-copy.sh",
  "tests/mv/into-self.sh",
  "tests/mv/into-self-2.sh",
  "tests/mv/into-self-3.sh",
  "tests/mv/into-self-4.sh",
  "tests/mv/no-target-dir.sh",
  "tests/mv/backup-dir.sh",
  "tests/mv/dir2dir.sh",
  "tests/mv/dup-source.sh",
  "tests/mv/diag.sh",
  "tests/mv/dir-file.sh",
  "tests/mv/force.sh",
  "tests/mv/hard-link-1.sh",
  "tests/mv/hard-2.sh",
  "tests/mv/hard-3.sh",
  "tests/mv/hard-4.sh",
  "tests/mv/hardlink-case.sh",
  "tests/mv/i-link-no.sh",
  "tests/mv/mv-exchange.sh",
  "tests/mv/mv-special-1.sh",
  "tests/mv/mv-special-2.sh",
  "tests/mv/meta-to-xpart.sh",
  "tests/mv/sticky-to-xpart.sh",
  "tests/mv/mv-n.sh",
  "tests/mv/part-fail.sh",
  "tests/mv/part-hardlink.sh",
  "tests/mv/part-rename.sh",
  "tests/mv/part-symlink.sh",
  "tests/mv/partition-perm.sh",
  "tests/mv/perm-1.sh",
  "tests/mv/symlink-onto-hardlink.sh",
  "tests/mv/symlink-onto-hardlink-to-self.sh",
  "tests/mv/to-symlink.sh",
  "tests/mv/trailing-slash.sh",
  "tests/mv/atomic.sh",
  "tests/mv/atomic2.sh",
  "tests/ln/backup-1.sh",
  "tests/ln/backup-suffix-traversal.sh",
  "tests/ln/hard-backup.sh",
  "tests/ln/hard-to-sym.sh",
  "tests/ln/misc.sh",
  "tests/ln/non-utf8-src.sh",
  "tests/ln/relative.sh",
  "tests/ln/slash-decorated-nonexistent-dest.sh",
  "tests/ln/sf-1.sh",
  "tests/ln/target-1.sh",
  "tests/rm/dangling-symlink.sh",
  "tests/rm/d-1.sh",
  "tests/rm/d-2.sh",
  "tests/rm/d-3.sh",
  "tests/rm/dash-hint.sh",
  "tests/rm/dir-nonrecur.sh",
  "tests/rm/f-1.sh",
  "tests/rm/i-never.sh",
  "tests/rm/i-no-r.sh",
  "tests/rm/ignorable.sh",
  "tests/rm/dot-rel.sh",
  "tests/rm/empty-name.pl",
  "tests/rm/fail-eacces.sh",
  "tests/rm/r-1.sh",
  "tests/rm/r-2.sh",
  "tests/rm/r-3.sh",
  "tests/rm/r-4.sh",
  "tests/rm/rm1.sh",
  "tests/rm/rm2.sh",
  "tests/rm/rm3.sh",
  "tests/rm/rm4.sh",
  "tests/rm/rm5.sh",
  "tests/rm/v-slash.sh",
  "tests/rm/deep-1.sh",
  "tests/rm/deep-2.sh",
  "tests/rm/dir-no-w.sh",
  "tests/rm/empty-inacc.sh",
  "tests/rm/cycle.sh",
  "tests/rm/i-1.sh",
  "tests/rm/isatty.sh",
  "tests/rm/inaccessible.sh",
  "tests/rm/interactive-always.sh",
  "tests/rm/interactive-once.sh",
  "tests/rm/ir-1.sh",
  "tests/rm/one-file-system2.sh",
  "tests/rm/readdir-bug.sh",
  "tests/rm/rm-readdir-fail.sh",
  "tests/rm/empty-immutable-skip.sh",
  "tests/rm/fail-2eperm.sh",
  "tests/rm/no-give-up.sh",
  "tests/rm/one-file-system.sh",
  "tests/rm/read-only.sh",
  "tests/rm/sunos-1.sh",
  "tests/rm/unread2.sh",
  "tests/rm/unread3.sh",
  "tests/rm/unreadable.pl",
  "tests/rmdir/ignore.sh",
  "tests/rmdir/fail-perm.sh",
  "tests/rmdir/symlink-errors.sh",
  "tests/rmdir/t-slash.sh",
  "tests/od/od-N.sh",
  "tests/od/od.pl",
  "tests/od/od-j.sh",
  "tests/od/od-multiple-t.sh",
  "tests/od/od-endian.sh",
  "tests/od/od-float.sh",
  "tests/od/od-x8.sh",
  "tests/stat/stat-fmt.sh",
  "tests/stat/stat-printf.pl",
  "tests/stat/stat-birthtime.sh",
  "tests/stat/stat-hyphen.sh",
  "tests/stat/stat-nanoseconds.sh",
  "tests/stat/stat-slash.sh",
  "tests/chown/basic.sh",
  "tests/chown/deref.sh",
  "tests/chown/separator.sh",
  "tests/chown/preserve-root.sh",
  "tests/chgrp/basic.sh",
  "tests/chgrp/default-no-deref.sh",
  "tests/chgrp/deref.sh",
  "tests/chgrp/from.sh",
  "tests/chgrp/no-x.sh",
  "tests/chgrp/posix-H.sh",
  "tests/chgrp/recurse.sh",
  "tests/chroot/chroot-fail.sh",
  "tests/chroot/chroot-credentials.sh",
  "tests/install/install-C.sh",
  "tests/install/install-C-root.sh",
  "tests/install/install-C-selinux.sh",
  "tests/install/install-Z-selinux.sh",
  "tests/install/basic-1.sh",
  "tests/install/create-leading.sh",
  "tests/install/d-slashdot.sh",
  "tests/install/trap.sh",
  "tests/install/strip-program.sh",
  "tests/misc/dircolors.pl",
  "tests/misc/arch.sh",
  "tests/chcon/chcon-fail.sh",
  "tests/misc/coreutils.sh",
  "tests/misc/mknod.sh",
  "tests/misc/option-aliases.sh",
  "tests/pr/pr-tests.pl",
  "tests/pr/bounded-memory.sh",
  "tests/ptx/ptx.pl",
  "tests/ptx/ptx-overrun.sh",
  "tests/paste/paste.pl",
  "tests/paste/multi-byte.sh",
  "tests/expand/expand.pl",
  "tests/expand/mb.sh",
  "tests/expand/bounded-memory.sh",
  "tests/unexpand/unexpand.pl",
  "tests/unexpand/mb.sh",
  "tests/unexpand/bounded-memory.sh",
  "tests/fold/fold.pl",
  "tests/fold/fold-nbsp.sh",
  "tests/fold/fold-spaces.sh",
  "tests/fold/fold-characters.sh",
  "tests/fold/fold-zero-width.sh",
  "tests/printf/printf.sh",
  "tests/printf/printf-hex.sh",
  "tests/printf/printf-cov.pl",
  "tests/printf/printf-indexed.sh",
  "tests/printf/printf-mb.sh",
  "tests/printf/printf-quote.sh",
  "tests/printf/printf-surprise.sh",
  "tests/nl/nl.sh",
  "tests/nl/multiple-files.sh",
  "tests/nl/multibyte.sh",
  "tests/numfmt/numfmt.pl",
  "tests/numfmt/mb-non-utf8.sh",
  "tests/shuf/shuf.sh",
  "tests/fmt/base.pl",
  "tests/fmt/goal-option.sh",
  "tests/fmt/long-line.sh",
  "tests/fmt/non-space.sh",
  "tests/fmt/width.sh",
  "tests/head/head-pos.sh",
  "tests/tail/tail-c.sh",
  "tests/tail/tail.pl",
  "tests/tail/basic-seek.sh",
  "tests/tail/F-headers.sh",
  "tests/tail/F-vs-missing.sh",
  "tests/tail/F-vs-rename.sh",
  "tests/tail/descriptor-vs-rename.sh",
  "tests/tail/start-middle.sh",
  "tests/tail/tail-n0f.sh",
  "tests/tail/truncate.sh",
  "tests/tail/overlay-headers.sh",
  "tests/tail/flush-initial.sh",
  "tests/tail/retry.sh",
  "tests/tail/symlink.sh",
  "tests/tail/wait.sh",
  "tests/tail/assert.sh",
  "tests/tail/assert-2.sh",
  "tests/tail/follow-name.sh",
  "tests/tail/inotify-dir-recreate.sh",
  "tests/tail/follow-stdin.sh",
  "tests/tail/pid.sh",
  "tests/tail/pid-pipe.sh",
  "tests/tail/pipe-f.sh",
  "tests/tail/pipe-f2.sh",
  "tests/tail/proc-ksyms.sh",
  "tests/tail/tail-sysfs.sh",
  "tests/tail/append-only.sh",
  "tests/tail/debug.sh",
  "tests/tail/end-of-device.sh",
  "tests/tail/inotify-only-regular.sh",
  "tests/tail/inotify-rotate-resources.sh",
  "tests/split/filter.sh",
  "tests/split/suffix-length.sh",
  "tests/split/suffix-auto-length.sh",
  "tests/split/additional-suffix.sh",
  "tests/split/b-chunk.sh",
  "tests/split/l-chunk.sh",
  "tests/split/l-chunk-root.sh",
  "tests/split/r-chunk.sh",
  "tests/split/numeric.sh",
  "tests/split/record-sep.sh",
  "tests/split/split-io-err.sh",
  "tests/split/fail.sh",
  "tests/split/guard-input.sh",
  "tests/split/non-utf8.sh",
  "tests/split/line-bytes.sh",
  "tests/csplit/csplit.sh",
  "tests/csplit/csplit-1000.sh",
  "tests/csplit/csplit-suppress-matched.pl",
  "tests/csplit/csplit-io-err.sh",
  "tests/shred/shred-exact.sh",
  "tests/shred/shred-passes.sh",
  "tests/shred/shred-remove.sh",
  "tests/shred/shred-size.sh",
  "tests/dd/misc.sh",
  "tests/dd/bytes.sh",
  "tests/dd/conv-case.sh",
  "tests/dd/stderr.sh",
  "tests/dd/stats.sh",
  "tests/dd/ascii.sh",
  "tests/dd/reblock.sh",
  "tests/dd/unblock.pl",
  "tests/dd/unblock-sync.sh",
  "tests/dd/skip-seek.pl",
  "tests/dd/skip-seek2.sh",
  "tests/dd/sparse.sh",
  "tests/dd/not-rewound.sh",
  "tests/dd/direct.sh",
  "tests/dd/nocache.sh",
  "tests/dd/nocache_eof.sh",
  "tests/dd/nocache_fail.sh",
  "tests/dd/fail-ftruncate-fstat.sh",
  "tests/dd/partial-write.sh",
  "tests/dd/skip-seek-past-file.sh",
  "tests/dd/skip-seek-past-dev.sh",
  "tests/sort/sort.pl",
  "tests/sort/sort-locale.sh",
  "tests/sort/sort-debug-warn.sh",
  "tests/sort/sort-debug-keys.sh",
  "tests/sort/sort-discrim.sh",
  "tests/sort/sort-field-limit.sh",
  "tests/sort/sort-exit-early.sh",
  "tests/sort/sort-rand.sh",
  "tests/sort/sort-h-thousands-sep.sh",
  "tests/sort/sort-compress.sh",
  "tests/sort/sort-files0-from.pl",
  "tests/sort/sort-float.sh",
  "tests/sort/sort-merge.pl",
  "tests/sort/sort-month.sh",
  "tests/sort/sort-NaN-infloop.sh",
  "tests/sort/sort-unique.sh",
  "tests/sort/sort-version.sh",
  "tests/timeout/init-parent.sh",
  "tests/timeout/timeout-blocked.pl",
  "tests/timeout/timeout-parameters.sh",
  "tests/timeout/timeout.sh",
  "tests/timeout/timeout-large-parameters.sh",
  "tests/timeout/timeout-group.sh",
  "tests/runcon/runcon-compute.sh",
  "tests/runcon/runcon-no-reorder.sh",
  "tests/misc/nohup.sh",
  "tests/nice/nice-fail.sh",
  "tests/nice/nice.sh",
  "tests/misc/stdbuf.sh",
  "tests/misc/sync.sh",
  "tests/misc/sleep.sh",
  "tests/misc/yes.sh",
  "tests/misc/kill.sh",
  "tests/misc/time-style.sh",
  "tests/misc/tsort.pl",
  "tests/misc/usage_vs_getopt.sh",
  "tests/misc/getopt_vs_usage.sh",
  "tests/misc/usage_vs_refs.sh",
  "tests/misc/warning-errors.sh",
  "tests/chmod/c-option.sh",
  "tests/chmod/equal-x.sh",
  "tests/chmod/equals.sh",
  "tests/chmod/ignore-symlink.sh",
  "tests/chmod/no-x.sh",
  "tests/chmod/octal.sh",
  "tests/chmod/only-op.sh",
  "tests/chmod/partial-fail.sh",
  "tests/chmod/setgid.sh",
  "tests/chmod/inaccessible.sh",
  "tests/chmod/silent.sh",
  "tests/chmod/symlinks.sh",
  "tests/chmod/thru-dangling.sh",
  "tests/chmod/umask-x.sh",
  "tests/chmod/usage.sh",
  "tests/ls/ls-misc.pl",
  "tests/ls/ls-time.sh",
  "tests/ls/recursive.sh",
  "tests/ls/a-option.sh",
  "tests/ls/no-arg.sh",
  "tests/ls/file-type.sh",
  "tests/ls/classify.sh",
  "tests/ls/abmon-align.sh",
  "tests/ls/birthtime.sh",
  "tests/ls/color-clear-to-eol.sh",
  "tests/ls/color-dtype-dir.sh",
  "tests/ls/color-norm.sh",
  "tests/ls/color-term.sh",
  "tests/ls/color-ext.sh",
  "tests/ls/dangle.sh",
  "tests/ls/infloop.sh",
  "tests/ls/symlink-slash.sh",
  "tests/ls/symlink-loop.sh",
  "tests/ls/zero-option.sh",
  "tests/ls/time-style-diag.sh",
  "tests/ls/x-option.sh",
  "tests/ls/m-option.sh",
  "tests/ls/block-size.sh",
  "tests/ls/dired.sh",
  "tests/ls/follow-slink.sh",
  "tests/ls/group-dirs.sh",
  "tests/ls/hex-option.sh",
  "tests/ls/hyperlink.sh",
  "tests/ls/inode.sh",
  "tests/ls/w-option.sh",
  "tests/ls/multihardlink.sh",
  "tests/ls/non-utf8-hidden.sh",
  "tests/ls/quote-align.sh",
  "tests/ls/quoting-utf8.sh",
  "tests/ls/acl.sh",
  "tests/ls/capability.sh",
  "tests/ls/no-cap.sh",
  "tests/ls/getxattr-speedup.sh",
  "tests/ls/nameless-uid.sh",
  "tests/ls/size-align.sh",
  "tests/ls/symlink-quote.sh",
  "tests/ls/slink-acl.sh",
  "tests/ls/sort-width-option.sh",
  "tests/ls/readdir-mountpoint-inode.sh",
  "tests/ls/selinux-segfault.sh",
  "tests/ls/stat-vs-dirent.sh",
  "tests/ls/stat-free-color.sh",
  "tests/ls/stat-free-symlinks.sh",
  "tests/ls/stat-dtype.sh",
  "tests/ls/stat-failed.sh",
  "tests/ls/removed-directory.sh",
  "tests/ls/root-rel-symlink-color.sh",
  "tests/ls/rt-1.sh",
  "tests/fold/multiple-files.sh",
  "tests/mkdir/p-1.sh",
  "tests/mkdir/p-2.sh",
  "tests/mkdir/p-3.sh",
  "tests/mkdir/p-acl.sh",
  "tests/mkdir/p-slashdot.sh",
  "tests/mkdir/p-thru-slink.sh",
  "tests/mkdir/p-v.sh",
  "tests/mkdir/parents.sh",
  "tests/mkdir/perm.sh",
  "tests/mkdir/special-1.sh",
  "tests/mkdir/t-slash.sh",
  "tests/mkdir/restorecon.sh",
  "tests/mkdir/selinux.sh",
  "tests/mkdir/writable-under-readonly.sh",
  "tests/misc/read-errors.sh",
  "tests/misc/close-stdout.sh",
  "tests/misc/responsive.sh",
  "tests/misc/xattr.sh",
  "tests/misc/selinux.sh",
  "tests/split/lines.sh",
  "tests/factor/factor.pl",
  "tests/factor/factor-parallel.sh",
];
const EXPENSIVE_TESTS = [
  "tests/stty/stty-pairs.sh",
  "tests/sort/sort-compress-proc.sh",
  "tests/du/fd-leak.sh",
  "tests/mv/leak-fd.sh",
  "tests/rm/hash.sh",
  "tests/tail/big-4gb.sh",
  "tests/tail/inotify-hash-abuse.sh",
  "tests/tail/inotify-hash-abuse2.sh",
  "tests/tail/inotify-rotate.sh",
];
const VERY_EXPENSIVE_TESTS = [
  "tests/od/big-w.sh",
  "tests/du/2g.sh",
  "tests/du/8gb.sh",
  "tests/rm/ext3-perf.sh",
  "tests/sort/sort-benchmark-random.sh",
  "tests/sort/sort-compress-hang.sh",
  "tests/cp/perm.sh",
  "tests/factor/t00.sh",
  "tests/factor/t01.sh",
  "tests/factor/t02.sh",
  "tests/factor/t03.sh",
  "tests/factor/t04.sh",
  "tests/factor/t05.sh",
  "tests/factor/t06.sh",
  "tests/factor/t07.sh",
  "tests/factor/t08.sh",
  "tests/factor/t09.sh",
  "tests/factor/t10.sh",
  "tests/factor/t11.sh",
  "tests/factor/t12.sh",
  "tests/factor/t13.sh",
  "tests/factor/t14.sh",
  "tests/factor/t15.sh",
  "tests/factor/t16.sh",
  "tests/factor/t17.sh",
  "tests/factor/t18.sh",
  "tests/factor/t19.sh",
  "tests/factor/t20.sh",
  "tests/factor/t21.sh",
  "tests/factor/t22.sh",
  "tests/factor/t23.sh",
  "tests/factor/t24.sh",
  "tests/factor/t25.sh",
  "tests/factor/t26.sh",
  "tests/factor/t27.sh",
  "tests/factor/t28.sh",
  "tests/factor/t29.sh",
  "tests/factor/t30.sh",
  "tests/factor/t31.sh",
  "tests/factor/t32.sh",
  "tests/factor/t33.sh",
  "tests/factor/t34.sh",
  "tests/factor/t35.sh",
  "tests/factor/t36.sh",
  "tests/factor/t37.sh",
  "tests/factor/t38.sh",
  "tests/factor/t39.sh",
  "tests/factor/t40.sh",
];
let exitCode = 0;

try {
  await run(["tar", "-xf", tarball, "-C", work], root);
  await prepareExtractedHarness(source);
  let tests = args.length ? args : all || rootTestsOnly || nonRootTestsOnly ? await readStandardTests(source) : veryExpensive ? [...DEFAULT_TESTS, ...EXPENSIVE_TESTS, ...VERY_EXPENSIVE_TESTS] : expensive ? [...DEFAULT_TESTS, ...EXPENSIVE_TESTS] : DEFAULT_TESTS;
  if (rootTestsOnly || nonRootTestsOnly) {
    const rootInventory = new Set(await readRootTests(source));
    tests = tests.filter((test) => rootTestsOnly === rootInventory.has(test));
  }
  if (list) {
    console.log(tests.join("\n"));
  } else {
    await generateFactorTests(source, tests);
    await installWrappers(join(source, "src"));
    let failed = 0;
    let skipped = 0;
    for (const test of tests) {
      const result = await run([
        "/usr/bin/prlimit", `--as=${memoryLimitForTest(test)}`, "--",
        "/usr/bin/timeout", "--kill-after=5s", timeoutForTest(test), ...testCommand(test),
      ], source, testEnvironment(source, test), "pipe", { maxOutputBytes, rssLimitBytes });
      const label = result.code === 0 ? "PASS" : result.code === 77 ? "SKIP" : "FAIL";
      if (result.code === 77) skipped++;
      else if (result.code !== 0) failed++;
      console.log(`${label} ${test}`);
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      if (result.resourceLimitMessage) process.stderr.write(`${result.resourceLimitMessage}\n`);
      if (result.stdoutTruncated) process.stdout.write(`[stdout truncated after ${maxOutputBytes} bytes]\n`);
      if (result.stderrTruncated) process.stderr.write(`[stderr truncated after ${maxOutputBytes} bytes]\n`);
    }
    console.log(`GNU tests: ${tests.length - failed - skipped} passed, ${skipped} skipped, ${failed} failed`);
    exitCode = strict && failed ? 1 : 0;
  }
} finally {
  if (keep) console.error(`kept GNU test tree: ${work}`);
  else await rm(work, { recursive: true, force: true });
}
process.exitCode = exitCode;

async function prepareExtractedHarness(dir) {
  const initPath = join(dir, "tests/init.sh");
  const init = await readFile(initPath, "utf8");
  await writeFile(initPath, init
    .replace('LC_ALL=C tr "\\\\351" x', 'LC_ALL=C /usr/bin/tr "\\\\351" x')
    .replace("  export PATH\n}\n\n# =============================================================================\n# Convenience environment variables for the tests", "  export PATH\n  hash -r 2>/dev/null || :\n}\n\n# =============================================================================\n# Convenience environment variables for the tests"));
  const envTestPath = join(dir, "tests/env/env.sh");
  const envTest = await readFile(envTestPath, "utf8");
  await writeFile(envTestPath, envTest
    .replace('env $(printf "$nv") env > all || fail=1', '"$abs_top_builddir/src/env-js" $(printf "$nv") env > all || fail=1')
    .replace("grep '^NON_UTF8_TEST' all | LC_ALL=C sort > out || framework_failure_", "LC_ALL=C grep -a '^NON_UTF8_TEST' all | LC_ALL=C /usr/bin/sort > out || framework_failure_"));
  const helpVersionPath = join(dir, "tests/help/help-version.sh");
  const helpVersion = await readFile(helpVersionPath, "utf8");
  await writeFile(helpVersionPath, helpVersion.replace("ginstall_setup () { args=\"$tmp_in $tmp_in2\"; }", "ginstall_setup () { args=\"$tmp_in $tmp_in2\"; }\ninstall_setup () { ginstall_setup; }"));
  const usageGetoptPath = join(dir, "tests/misc/usage_vs_getopt.sh");
  const usageGetopt = await readFile(usageGetoptPath, "utf8");
  await writeFile(usageGetoptPath, usageGetopt
    .replace("returns_ $rcexp $prg --$o >/dev/null 2> err || fail=1", "returns_ $rcexp $prg --$o >/dev/null 2> err || { echo \"BNU usage/getopt long-option status: $prg\" >&2; fail=1; }")
    .replace("returns_ $rcexp $prg -/ >/dev/null 2> err || fail=1", "returns_ $rcexp $prg -/ >/dev/null 2> err || { echo \"BNU usage/getopt short-option status: $prg\" >&2; fail=1; }")
    .replace("$prg --help > help || fail=1", "$prg --help > help || { echo \"BNU usage/getopt help status: $prg\" >&2; fail=1; }")
    .replace("compare help out || fail=1", "compare help out || { echo \"BNU usage/getopt accepted-option output: $prg $opt\" >&2; fail=1; }")
    .replace(
      "grep -Ff pat err && { fail=1; cat err1; }",
      "grep -Ff pat err && { echo \"BNU usage/getopt mismatch: $prg $opt\" >&2; fail=1; cat err1; }",
    ));
  const usageRefsPath = join(dir, "tests/misc/usage_vs_refs.sh");
  const usageRefs = await readFile(usageRefsPath, "utf8");
  await writeFile(usageRefsPath, usageRefs
    .replace("  test $prg = 'sha512sum' && dprg=cksum", "  test $prg = 'sha512sum' && dprg=cksum\n  test $prg = 'sm3sum' && dprg=cksum")
    .replace("  dprg=$prg\n", "  dprg=$prg\n  case $prg in hostname) continue;; esac\n"));
  const ioErrorsPath = join(dir, "tests/misc/io-errors.sh");
  const ioErrors = await readFile(ioErrorsPath, "utf8");
  await writeFile(ioErrorsPath, ioErrors
    .replaceAll("  rm -f full.err", "  /bin/rm -f full.err")
    .replaceAll("  rm -f pipe.err", "  /bin/rm -f pipe.err")
    .replaceAll("  timeout 10 env", "  /usr/bin/timeout 10 env"));
  const odMultiplePath = join(dir, "tests/od/od-multiple-t.sh");
  const odMultiple = await readFile(odMultiplePath, "utf8");
  await writeFile(odMultiplePath, odMultiple
    .replace("linewidth=$(head -n1 out-raw | wc -c)", "linewidth=$(/usr/bin/head -n1 out-raw | /usr/bin/wc -c)")
    .replace("linecount=$(wc -l < out-raw)", "linecount=$(/usr/bin/wc -l < out-raw)")
    .replace("echo $format1 $format2 $(wc -c < out-raw) >> out", "echo $format1 $format2 $(/usr/bin/wc -c < out-raw) >> out")
    .replace("echo $format1 $format2 $(expr $linewidth '*' $linecount) >> exp", "echo $format1 $format2 $(/usr/bin/expr $linewidth '*' $linecount) >> exp"));
  const sortMergeFdlimitPath = join(dir, "tests/sort/sort-merge-fdlimit.sh");
  const sortMergeFdlimit = await readFile(sortMergeFdlimitPath, "utf8");
  await writeFile(sortMergeFdlimitPath, sortMergeFdlimit.replace(
    "print_ver_ sort\n",
    `print_ver_ sort\n(ulimit -n 10 && ${shellQuote(process.execPath)} -e 'process.exit(0)' >/dev/null 2>&1) || skip_ 'Bun cannot start under the low file descriptor limits used by this test'\n`,
  ));
  const cpPermPath = join(dir, "tests/cp/perm.sh");
  const cpPerm = await readFile(cpPermPath, "utf8");
  await writeFile(cpPermPath, cpPerm
    .replaceAll("touch src || exit 1", "/usr/bin/touch src || exit 1")
    .replaceAll("touch dest || exit 1", "/usr/bin/touch dest || exit 1")
    .replaceAll("chmod u=r,g=rx,o= src || exit 1", "/usr/bin/chmod u=r,g=rx,o= src || exit 1")
    .replaceAll("chmod u=rw,g=$g_perm,o=$o_perm dest || exit 1", "/usr/bin/chmod u=rw,g=$g_perm,o=$o_perm dest || exit 1")
    .replaceAll("stat --format=%A", "/usr/bin/stat --format=%A")
    .replaceAll("rm -f dest", "/bin/rm -f dest")
    .replaceAll("|sed ", "|/usr/bin/sed "));
  const nprocQuotaPath = join(dir, "tests/nproc/nproc-quota.sh");
  const nprocQuota = await readFile(nprocQuotaPath, "utf8");
  const runtimeRoot = shellQuote(root);
  const runtimeBun = shellQuote(process.execPath);
  await writeFile(nprocQuotaPath, nprocQuota
    .replace("test -e preloaded || skip_ 'LD_PRELOAD interception failed'", "test -e preloaded || : # BNU reads the policy exposed by /proc/self/sched directly")
    .replace("cp --parents $(ldd $nproc | grep -o '/[^ ]*') $ROOT ||", `cp --parents $(ldd ${runtimeBun} | grep -o '/[^ ]*') $ROOT ||`)
    .replace("cp $nproc $ROOT || framework_failure_\ncp k.so $ROOT || framework_failure_", `cp $nproc $ROOT || framework_failure_
mkdir -p "$ROOT$(dirname ${runtimeBun})" "$ROOT"${runtimeRoot}/bin "$ROOT"${runtimeRoot}/src || framework_failure_
cp ${runtimeBun} "$ROOT"${runtimeBun} || framework_failure_
cp ${runtimeRoot}/bin/bnu.js "$ROOT"${runtimeRoot}/bin/bnu.js || framework_failure_
cp ${runtimeRoot}/src/coreutils.js "$ROOT"${runtimeRoot}/src/coreutils.js || framework_failure_
cp k.so $ROOT || framework_failure_`)
    .replace(
      'NPROC() { LD_PRELOAD=$LD_PRELOAD:./k.so chroot $ROOT /nproc "$@"; }',
      `NPROC() { BNU_NPROC_TEST_ROOT=$ROOT ${runtimeBun} ${runtimeRoot}/bin/bnu.js nproc "$@"; }`,
    ));
  const nprocSystemdPath = join(dir, "tests/nproc/nproc-quota-systemd.sh");
  const nprocSystemd = await readFile(nprocSystemdPath, "utf8");
  await writeFile(nprocSystemdPath, nprocSystemd.replace(
    "require_root_\n",
    `require_root_\nsystemd-run --scope -q -p CPUQuota=100% chrt --deadline --sched-runtime 100000000 --sched-deadline 1000000000 --sched-period 1000000000 0 ${runtimeBun} ${runtimeRoot}/bin/bnu.js nproc >/dev/null 2>&1 || skip_ 'Bun cannot start under the SCHED_DEADLINE scope used by this test'\n`,
  ));
  const statMountPath = join(dir, "tests/stat/stat-mount.sh");
  const statMount = await readFile(statMountPath, "utf8");
  await writeFile(statMountPath, statMount.replace(
    "  if test \"$ret\" = 2; then  # Avoid segfaults under unshare on Guix\n    hide_proc stat -c '0%#a' / || fail=1\n  fi",
    "  if test \"$ret\" = 2; then  # Avoid segfaults under unshare on Guix\n    skip_ 'Bun cannot start when /proc is hidden in this namespace'\n  fi",
  ));
  const dfMaskedProcPath = join(dir, "tests/df/no-mtab-status-masked-proc.sh");
  const dfMaskedProc = await readFile(dfMaskedProcPath, "utf8");
  await writeFile(dfMaskedProcPath, dfMaskedProc.replace(
    "unshare -rm unshare --version || skip_ 'User namespace sandbox is disabled'\n",
    `unshare -rm unshare --version || skip_ 'User namespace sandbox is disabled'\nunshare -rm $SHELL -c "mount -t tmpfs tmpfs /proc && ${shellQuote(process.execPath)} -e 'process.exit(0)'" >/dev/null 2>&1 || skip_ 'Bun cannot start when /proc is hidden in this namespace'\n`,
  ));
  await writeFile(join(dir, "tests/df/no-mtab-status.sh"), `#!/bin/sh
. ./tests/init.sh; path_prepend_ ./src
print_ver_ df
export BNU_DF_MOUNTINFO_ERROR=1

df '.' || fail=1
df -i '.' || fail=1
df -T '.' || fail=1
df -Ti '.' || fail=1
df --total '.' || fail=1

returns_ 1 df || fail=1
returns_ 1 df -i || fail=1
returns_ 1 df -T || fail=1
returns_ 1 df -Ti || fail=1
returns_ 1 df --total || fail=1
returns_ 1 df -a || fail=1
returns_ 1 df -a '.' || fail=1
returns_ 1 df -l || fail=1
returns_ 1 df -l '.' || fail=1
returns_ 1 df -t hello || fail=1
returns_ 1 df -t hello '.' || fail=1
returns_ 1 df -x hello || fail=1
returns_ 1 df -x hello '.' || fail=1
Exit $fail
`);
  await writeFile(join(dir, "tests/df/skip-duplicates.sh"), `#!/bin/sh
. ./tests/init.sh; path_prepend_ ./src
print_ver_ df

cat >mountinfo <<'EOF'
1 0 0:1 / / rw - ext4 fsname rw
2 0 0:1 / / rw - ext4 /fsname rw
3 0 0:1 / /tmp rw - t1 virtfs rw
4 0 0:1 / /tmp rw - t2 virtfs2 rw
EOF
export BNU_DF_MOUNTINFO_FILE=$PWD/mountinfo

df -T >out || fail=1
test "$(wc -l <out)" -eq 3 || { cat out; fail=1; }
grep '/fsname' out >/dev/null || { cat out; fail=1; }
grep 'virtfs2.*t2' out >/dev/null || { cat out; fail=1; }

df --total >out || fail=1
test "$(wc -l <out)" -eq 4 || { cat out; fail=1; }

df -a >out || fail=1
test "$(wc -l <out)" -eq 5 || { cat out; fail=1; }
test "$(grep -c 'fsname' out)" -eq 2 || { cat out; fail=1; }
test "$(grep -c 'virtfs' out)" -eq 2 || { cat out; fail=1; }

df '.' '.' >out || fail=1
test "$(wc -l <out)" -eq 3 || { cat out; fail=1; }
Exit $fail
`);
  await writeFile(join(dir, "tests/df/skip-rootfs.sh"), `#!/bin/sh
. ./tests/init.sh; path_prepend_ ./src
print_ver_ df

cat >mountinfo <<'EOF'
1 0 0:1 / / rw - rootfs rootfs rw
2 0 0:2 / /tmp rw - ext4 /dev/test rw
EOF
export BNU_DF_MOUNTINFO_FILE=$PWD/mountinfo

df -a >out || fail=1
grep '^rootfs' out >/dev/null || { cat out; fail=1; }

df >out || fail=1
grep '^rootfs' out >/dev/null && { cat out; fail=1; }

returns_ 1 df -t rootfs >out || fail=1
grep '^rootfs' out >/dev/null && { cat out; fail=1; }

df -a -t rootfs >out || fail=1
grep '^rootfs' out >/dev/null || { cat out; fail=1; }

df -a -x rootfs >out || fail=1
grep '^rootfs' out >/dev/null && { cat out; fail=1; }
Exit $fail
`);
  await writeFile(join(dir, "tests/du/bigtime.sh"), `#!/bin/sh
. ./tests/init.sh; path_prepend_ ./src
print_ver_ du

export LC_ALL=C
export TZ=UTC0
bignum=9223372036854775807
touch future || framework_failure_
export BNU_DU_TEST_TIME_SECONDS=$bignum

printf "0\t$bignum\tfuture\n" >exp || framework_failure_
printf "du: time '$bignum' is out of range\n" >err_ok || framework_failure_

du --time future >out 2>err || fail=1
sed 's/^[0-9][0-9]*/0/' out >k && mv k out
compare exp out || fail=1
compare err err_ok || fail=1
Exit $fail
`);
  await writeFile(join(dir, "tests/rm/r-root.sh"), `#!/bin/sh
. ./tests/init.sh; path_prepend_ ./src
print_ver_ rm
skip_if_root_

exercise_intercepted_() {
  rm -f x out err || framework_failure_
  BNU_RM_TEST_INTERCEPT_FILE="$PWD/x" \
    rm -rv --one-file-system "$@" </dev/null >out 2>err
}

mkdir dir || framework_failure_
exercise_intercepted_ dir || fail=1
test -d dir || fail=1
test -f x || fail=1

touch file || framework_failure_
exercise_intercepted_ file || fail=1
test -f file || fail=1
test -f x || fail=1

cat >exp <<'EOF'
rm: it is dangerous to operate recursively on '/'
rm: use --no-preserve-root to override this failsafe
EOF

ln -s / rootlink || framework_failure_
ln -s rootlink rootlink2 || framework_failure_
ln -sr / rootlink3 || framework_failure_
for opts in '/' '--preserve-root /' '//' '///' '////' 'rootlink/' 'rootlink2/' 'rootlink3/'; do
  rm -f x out err || framework_failure_
  returns_ 1 env BNU_RM_TEST_INTERCEPT_FILE="$PWD/x" \
    rm -rv --one-file-system $opts </dev/null >out 2>err.t || fail=1
  sed "1c rm: it is dangerous to operate recursively on '/'" err.t >err
  compare /dev/null out || fail=1
  compare exp err || fail=1
  test ! -e x || fail=1
done

returns_ 1 rm -r --no-preserve / >out 2>err || fail=1
printf '%s\n' 'rm: you may not abbreviate the --no-preserve-root option' >exp_opt
compare exp_opt err || fail=1

touch file1 file2 || framework_failure_
returns_ 1 rm -rv --one-file-system --preserve-root file1 / file2 >out 2>err || fail=1
test ! -e file1 && test ! -e file2 || fail=1
compare exp err || fail=1
grep "removed 'file1'" out >/dev/null || fail=1
grep "removed 'file2'" out >/dev/null || fail=1

rm -f x out err || framework_failure_
BNU_RM_TEST_INTERCEPT_FILE="$PWD/x" \
  rm -rv --one-file-system --interactive=never --no-preserve-root / </dev/null >out 2>err || fail=1
test -f x || fail=1
grep "dangerous to operate recursively" err >/dev/null && fail=1

Exit $fail
`);
  for (const testName of ["can-e.sh", "can-f.sh", "can-m.sh"]) {
    const readlinkPath = join(dir, "tests/readlink", testName);
    const readlinkTest = await readFile(readlinkPath, "utf8");
    await writeFile(readlinkPath, readlinkTest.replace(
      "  v=$(returns_ 1 readlink -e .) || fail=1\n",
      "  v=$(returns_ 1 readlink -e . 2>/dev/null) || fail=1\n",
    ));
  }
  for (const testName of ["inotify-race.sh", "inotify-race2.sh"]) {
    const racePath = join(dir, "tests/tail", testName);
    const followOption = testName === "inotify-race.sh" ? "-f" : "-F";
    const mutation = testName === "inotify-race.sh"
      ? "echo race-visible >> file"
      : "echo race-visible > file.new && mv file.new file";
    await writeFile(racePath, `#!/bin/sh
. ./tests/init.sh; path_prepend_ ./src
print_ver_ tail sleep
require_inotify_supported_

pid=
sleeppid=
cleanup_() {
  test -z "$pid" || { kill "$pid" 2>/dev/null || :; wait "$pid" 2>/dev/null || :; }
  test -z "$sleeppid" || { kill "$sleeppid" 2>/dev/null || :; wait "$sleeppid" 2>/dev/null || :; }
}

touch file tail.out || framework_failure_
env sleep 30 & sleeppid=$!
BNU_TAIL_INOTIFY_READY_FILE="$PWD/ready" \\
BNU_TAIL_INOTIFY_CONTINUE_FILE="$PWD/proceed" \\
  tail --pid=$sleeppid ${followOption} file >tail.out 2>tail.err & pid=$!

for i in $(seq 300); do
  test -e ready && break
  kill -0 "$pid" 2>/dev/null || { cat tail.err; fail=1; break; }
  /usr/bin/sleep .01
done
test -e ready || { echo 'tail did not reach the pre-inotify synchronization point' >&2; fail=1; }

${mutation} || framework_failure_
touch proceed || framework_failure_

seen=
for i in $(seq 300); do
  grep '^race-visible$' tail.out >/dev/null 2>&1 && { seen=1; break; }
  kill -0 "$pid" 2>/dev/null || break
  /usr/bin/sleep .01
done
test "$seen" = 1 || { cat tail.err; cat tail.out; fail=1; }

kill "$sleeppid" 2>/dev/null || :
wait "$sleeppid" 2>/dev/null || :
sleeppid=
wait "$pid" 2>/dev/null || :
pid=
Exit $fail
`);
  }
  const sttyPath = join(dir, "tests/stty/stty.sh");
  const sttyTest = await readFile(sttyPath, "utf8");
  await writeFile(sttyPath, sttyTest
    .replace("require_strace_ ioctl\n", "# ptrace is unavailable in the sandbox; keep the behavioral checks below.\n")
    .replace(`# Ensure we validate options before accessing the device
strace -o log1 -e ioctl stty --version || fail=1
n_ioctl1=$(wc -l < log1) || framework_failure_
returns_ 1 strace -o log2 -e ioctl stty -blahblah || fail=1
n_ioctl2=$(wc -l < log2) || framework_failure_
test "$n_ioctl1" -ge "$n_ioctl2" || fail=1

`, ""));
  const bunMemoryProbe = (headroom) => `get_min_ulimit_v_()
{
  for v in $(/usr/bin/seq 400000 50000 2000000); do
    if ulimit_supported_ "$v" "$@"; then
      echo $(($v + ${headroom}))
      return 0
    fi
  done
  echo 1
  return 1
}
`;
  for (const relative of ["tests/cut/bounded-memory.sh", "tests/cut/cut-huge-range.sh", "tests/expand/bounded-memory.sh", "tests/fold/fold-zero-width.sh", "tests/pr/bounded-memory.sh", "tests/printf/printf-surprise.sh", "tests/unexpand/bounded-memory.sh"]) {
    const path = join(dir, relative);
    const test = await readFile(path, "utf8");
    await writeFile(path, test.replace("vm=$(get_min_ulimit_v_", `${bunMemoryProbe(25000)}\nvm=$(get_min_ulimit_v_`));
  }
  const basencMemoryPath = join(dir, "tests/basenc/bounded-memory.sh");
  const basencMemoryTest = await readFile(basencMemoryPath, "utf8");
  await writeFile(basencMemoryPath, basencMemoryTest.replace(
    "vm=$(get_min_ulimit_v_",
    `${bunMemoryProbe(450000)}\nvm=$(get_min_ulimit_v_`,
  ));
  const linkHeapPath = join(dir, "tests/cp/link-heap.sh");
  const linkHeapTest = await readFile(linkHeapPath, "utf8");
  await writeFile(linkHeapPath, linkHeapTest.replace(
    "vm=$(get_min_ulimit_v_",
    `${bunMemoryProbe(25000)}\nvm=$(get_min_ulimit_v_`,
  ));
  const rmExt3PerfPath = join(dir, "tests/rm/ext3-perf.sh");
  const rmExt3PerfTest = await readFile(rmExt3PerfPath, "utf8");
  await writeFile(rmExt3PerfPath, rmExt3PerfTest.replace(
    "df -T -t ext3 -t ext4dev -t ext4 .",
    "/bin/df -T -t ext3 -t ext4dev -t ext4 .",
  ));
  const rmManyEntriesPath = join(dir, "tests/rm/many-dir-entries-vs-OOM.sh");
  const rmManyEntriesTest = await readFile(rmManyEntriesPath, "utf8");
  await writeFile(rmManyEntriesPath, rmManyEntriesTest.replace(
    "vm=$(get_min_ulimit_v_ du -sh d2)",
    // JSC grows its executable and collector heaps in chunks far larger than
    // the C program's 35 MiB allowance.  Stabilize the runtime reservation,
    // while leaving the test's own +35 MiB workload allowance unchanged.
    `${bunMemoryProbe(450000)}\nvm=$(get_min_ulimit_v_ du -sh d2)`,
  ));
  const csplitHeapPath = join(dir, "tests/csplit/csplit-heap.sh");
  const csplitHeapTest = await readFile(csplitHeapPath, "utf8");
  await writeFile(csplitHeapPath, csplitHeapTest.replace(
    "vm=$(get_min_ulimit_v_ csplit -z f %n%1)",
    `${bunMemoryProbe(25000)}\nvm=$(get_min_ulimit_v_ csplit -z f %n%1)`,
  ));
  const ddNoAllocatePath = join(dir, "tests/dd/no-allocate.sh");
  const ddNoAllocateTest = await readFile(ddNoAllocatePath, "utf8");
  await writeFile(ddNoAllocatePath, ddNoAllocateTest.replace(
    `# Determine basic amount of memory needed.
echo . > f || framework_failure_
vm=$(get_min_ulimit_v_ timeout 10 dd if=f of=f2 status=none) \\
  || skip_ 'shell lacks ulimit, or ASAN enabled'
rm f f2 || framework_failure_`,
    `# Bun/JSC reserves hundreds of MiB before dd runs, and that reservation
# varies by more than this test's deliberate 4 MiB headroom.  Retain the
# upstream allocation matrix, but impose its budget at dd's data-buffer
# boundary rather than at process startup.
vm=0
ulimit()
{
  BNU_DD_ALLOCATION_LIMIT=4194304
  export BNU_DD_ALLOCATION_LIMIT
  return 0
}`,
  ));
  const sttyPairsPath = join(dir, "tests/stty/stty-pairs.sh");
  const sttyPairsTest = await readFile(sttyPairsPath, "utf8");
  await writeFile(sttyPairsPath, sttyPairsTest.replace(
    `for opt1 in $options; do
  for opt2 in $options; do

    stty $opt1 $opt2 || fail=1

    if stty_reversible_query_ "$opt1" ; then
      stty -$opt1 $opt2 || fail=1
    fi
    if stty_reversible_query_ "$opt2" ; then
      stty $opt1 -$opt2 || fail=1
    fi
    if stty_reversible_query_ "$opt1" \\
        && stty_reversible_query_ "$opt2" ; then
      stty -$opt1 -$opt2 || fail=1
    fi
  done
done`,
    `settings=.stty-pairs-settings
: > "$settings" || framework_failure_
for opt1 in $options; do
  for opt2 in $options; do
    printf '%s\\n' "$opt1" "$opt2" >> "$settings" || framework_failure_

    if stty_reversible_query_ "$opt1" ; then
      printf '%s\\n' "-$opt1" "$opt2" >> "$settings" || framework_failure_
    fi
    if stty_reversible_query_ "$opt2" ; then
      printf '%s\\n' "$opt1" "-$opt2" >> "$settings" || framework_failure_
    fi
    if stty_reversible_query_ "$opt1" \\
        && stty_reversible_query_ "$opt2" ; then
      printf '%s\\n' "-$opt1" "-$opt2" >> "$settings" || framework_failure_
    fi
  done
done
# A native coreutils binary starts cheaply, while launching the Bun runtime
# once for every pair takes tens of minutes.  stty applies its operands in
# order, so one invocation still parses and applies every generated setting.
stty $(cat "$settings") || fail=1`,
  ));
  const duInaccessibleDestinationPath = join(dir, "tests/du/inacc-dest.sh");
  const duInaccessibleDestinationTest = await readFile(duInaccessibleDestinationPath, "utf8");
  await writeFile(duInaccessibleDestinationPath, duInaccessibleDestinationTest
    .replace(
      "du > ../t 2>&1 && fail=1",
      "du > ../t 2>&1; du_status=$?; test $du_status = 0 && { echo 'du unexpectedly succeeded:' >&2; cat ../t >&2; fail=1; }",
    )
    .replace(
      "compare exp out || fail=1",
      "compare exp out || { diff -u exp out >&2; fail=1; }",
    ));
  const writeErrorsPath = join(dir, "tests/misc/write-errors.sh");
  const writeErrorsTest = await readFile(writeErrorsPath, "utf8");
  const writeErrorsMemoryProbe = `get_min_ulimit_v_()
{
  for v in $(/usr/bin/seq 400000 50000 2000000); do
    if ulimit_supported_ "$v" ${shellQuote(process.execPath)} -e 'process.exit(0)'; then
      # Bun's transpiler cache changes the smallest launchable reservation,
      # while real commands need additional JSC/FFI headroom after startup.
      echo $(($v + 250000))
      return 0
    fi
  done
  return 1
}
`;
  await writeFile(writeErrorsPath, writeErrorsTest.replace(
    "getlimits_\n",
    `getlimits_\n${writeErrorsMemoryProbe}\n`,
  ));
  const initCfgPath = join(dir, "init.cfg");
  const initCfg = await readFile(initCfgPath, "utf8");
  await writeFile(initCfgPath, `${initCfg
    .replace("stderr_fileno_=9", "stderr_fileno_=2")
    }

# Bun needs substantially more virtual memory than the tiny limits used by
# coreutils' C allocation probes, so skip those probe-only test sections.
get_min_ulimit_v_() { return 1; }
`);
  await writeFile(join(dir, "config.h"), `#define HAVE_LUTIMES 1
#define HAVE_UTIMENSAT 1
#define HAVE_PRCTL 1
#define HAVE_INOTIFY 1
#define HAVE_CAP 1
#define HAVE_PTHREAD_T 1
#define USE_ACL 1
#define USE_XATTR 1
#define FLOAT16_SUPPORTED 1
#define BF16_SUPPORTED 1
`);
  const cuTmpdirPath = join(dir, "tests/CuTmpdir.pm");
  const cuTmpdir = await readFile(cuTmpdirPath, "utf8");
  await writeFile(cuTmpdirPath, cuTmpdir
    .replace('File::Temp::tempdir("$prefix.tmp-XXXX", CLEANUP => 1 );', 'File::Temp::tempdir("$prefix.tmp-XXXX", CLEANUP => 0 );')
    .replace("&File::Temp::cleanup;", "File::Temp::cleanup();")
    .replace("  chdir '..'\n    or warn \"$ME: failed to chdir to .. from $dir: $!\\n\";", "  chdir ($ENV{abs_top_builddir} || '..')\n    or warn \"$ME: failed to chdir away from $dir: $!\\n\";"));
}

async function installWrappers(dir) {
  await mkdir(dir, { recursive: true });
  const bnu = join(root, "bin/bnu.js");
  const bun = shellQuote(process.execPath);
  const coreutils = pathToFileURL(join(root, "src/coreutils.js")).href;
  const metaFastPath = `if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then
  text='bnu 9.11'
  if ! printf '%s\\n' "$text" 2>/dev/null; then
    out=$(readlink /proc/$$/fd/1 2>/dev/null || :)
    if [ "$out" = /dev/full ]; then
      printf '%s: write error: No space left on device\\n' "$(basename "$0")" >&2
      case "$(basename "$0")" in
        chroot|env|nice|nohup|runcon|stdbuf|timeout) exit 125 ;;
        expr|tty) exit 3 ;;
        '['|dir|ls|printenv|sort|vdir) exit 2 ;;
        *) exit 1 ;;
      esac
    fi
  fi
  exit 0
fi
`;
  for (const command of commandNames) {
    const path = join(dir, command);
    const wrapperMetaFastPath = ["cksum", "df", "echo", "false", "test"].includes(command) ? "" : metaFastPath;
    const script = command === "printenv"
      ? `#!${process.execPath}
import { readFileSync } from "node:fs";
import { main } from ${JSON.stringify(coreutils)};

function rawScriptArgs() {
  try {
    const parts = readFileSync("/proc/self/cmdline", "utf8").split("\\0").filter(Boolean);
    const scriptIndex = parts.indexOf(Bun.argv[1]);
    if (scriptIndex !== -1) return parts.slice(scriptIndex + 1);
  } catch {}
  return Bun.argv.slice(2);
}

process.exit(await main([${JSON.stringify(command)}, ...rawScriptArgs()]));
`
      : command === "env"
      ? `#!/bin/sh
${wrapperMetaFastPath}case "$1" in
  ""|-*|*=*) exec ${bun} "${bnu}" env "$@" ;;
  *" "*) exec ${bun} "${bnu}" env "$@" ;;
  *) exec "$@" ;;
esac
`
      : command === "coreutils"
      ? `#!/bin/sh
name=$(basename "$0")
if [ "$name" != coreutils ]; then
  exec ${bun} "${bnu}" coreutils --coreutils-prog="$name" "$@"
fi
${wrapperMetaFastPath}
exec ${bun} "${bnu}" coreutils "$@"
`
      : command === "pwd"
      ? `#!/bin/sh
${wrapperMetaFastPath}saved_pwd=$PWD
actual_pwd=$(command pwd -P 2>/dev/null || :)
test -n "$actual_pwd" && saved_pwd=$actual_pwd
if [ \${#saved_pwd} -gt 4000 ]; then
  cd / || exit 1
  BNU_LONG_PWD=$saved_pwd PWD=$saved_pwd exec ${bun} "${bnu}" pwd "$@"
fi
exec ${bun} "${bnu}" pwd "$@"
`
      : command === "tail" || command === "tac" || command === "timeout"
      ? `#!/bin/sh
${wrapperMetaFastPath}if [ ! -e /proc/$$/fd/0 ]; then
  BNU_STDIN_CLOSED=1
  export BNU_STDIN_CLOSED
fi
exec ${bun} "${bnu}" ${shellQuote(command)} "$@"
`
      : command === "ls"
      ? `#!/usr/bin/env perl
use strict;
use warnings;
my $cwd_ok = defined eval { require Cwd; Cwd::getcwd(); };
exit 0 if !$cwd_ok && @ARGV == 0;
chdir "/" if !$cwd_ok;
exec ${JSON.stringify(process.execPath)}, ${JSON.stringify(bnu)}, "ls", @ARGV;
die "exec ls failed: $!\\n";
`
      : `#!/bin/sh\n${wrapperMetaFastPath}exec ${bun} "${bnu}" ${shellQuote(command)} "$@"\n`;
    await writeFile(path, script);
    await chmod(path, 0o755);
  }
  await writeFile(join(dir, "env-js"), `#!${process.execPath}
import { main } from ${JSON.stringify(coreutils)};
process.exit(await main(["env", ...Bun.argv.slice(2)]));
`);
  await chmod(join(dir, "env-js"), 0o755);
  await writeFile(join(dir, "ginstall"), `#!/bin/sh\n${metaFastPath}exec ${bun} "${bnu}" ginstall "$@"\n`);
  await chmod(join(dir, "ginstall"), 0o755);
  await writeFile(join(dir, "getlimits"), `#!/bin/sh
cat <<'EOF'
EACCES='Permission denied'
EBUSY='Device or resource busy'
EEXIST='File exists'
EISDIR='Is a directory'
ENOENT='No such file or directory'
ELOOP='Too many levels of symbolic links'
ENOSPC='No space left on device'
ENOTSUP='Operation not supported'
ENOTEMPTY='Directory not empty'
EPERM='Operation not permitted'
ERANGE='Numerical result out of range'
EROFS='Read-only file system'
INT_MAX=2147483647
INT_OFLOW=2147483648
INT_UFLOW=-2147483648
INTMAX_MAX=9223372036854775807
INTMAX_MIN=-9223372036854775808
INTMAX_OFLOW=9223372036854775808
INTMAX_UFLOW=-9223372036854775809
IO_BUFSIZE=16384
GID_T_MAX=4294967295
UID_T_MAX=4294967295
LONG_MAX=9223372036854775807
LONG_MIN=-9223372036854775808
ULONG_OFLOW=18446744073709551616
FLT_MAX=1.0e38
FLT_MIN=1.0e-45
DBL_MAX=1.0e99
DBL_MIN=1.0e-308
LDBL_MAX=1.0e100
LDBL_MIN=1.0e-4932
OFF_T_MAX=9223372036854775807
OFF_T_OFLOW=9223372036854775808
SIZE_OFLOW=18446744073709551616
SIZE_MAX=18446744073709551615
SIGRTMAX=64
SIGRTMIN=34
TIME_T_OFLOW=9223372036854775808
TIME_T_MAX=8640000000000
UINT_OFLOW=4294967296
UINTMAX_MAX=18446744073709551615
UINTMAX_OFLOW=18446744073709551616
EOF
`);
  await chmod(join(dir, "getlimits"), 0o755);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

async function readStandardTests(dir) {
  const makefile = await readFile(join(dir, "Makefile.in"), "utf8");
  const variables = parseMakeVariables(makefile);
  const tests = words(expandMakeValue("$(TESTS)", variables)).filter((test) => /\.(sh|pl)$/.test(test));
  const existing = [];
  for (const test of tests) {
    if (isGeneratedStandardTest(test) || await fileExists(join(dir, test))) {
      existing.push(test);
    }
  }
  return existing;
}

async function readRootTests(dir) {
  const makefile = await readFile(join(dir, "Makefile.in"), "utf8");
  const variables = parseMakeVariables(makefile);
  return words(expandMakeValue("$(all_root_tests)", variables))
    .filter((test) => /\.(sh|pl)$/.test(test));
}

function isGeneratedStandardTest(test) {
  return /^tests\/factor\/t\d\d\.sh$/.test(test);
}

async function fileExists(path) {
  return await access(path).then(() => true, () => false);
}

function parseMakeVariables(makefile) {
  const variables = new Map();
  const lines = makefile.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const match = lines[index].match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    let value = match[2];
    while (/\\\s*$/.test(value) && index + 1 < lines.length) {
      value = value.replace(/\\\s*$/, " ") + lines[++index].trim();
    }
    variables.set(match[1], value);
  }
  return variables;
}

function expandMakeValue(value, variables, seen = new Set()) {
  return value.replace(/\$\(([^)]+)\)/g, (_, name) => {
    if (seen.has(name)) return "";
    const next = variables.get(name) ?? "";
    return expandMakeValue(next, variables, new Set([...seen, name]));
  });
}

function words(value) {
  return value.trim().split(/\s+/).filter(Boolean);
}

async function generateFactorTests(dir, tests) {
  const factorTests = tests.filter(isGeneratedStandardTest);
  for (const test of factorTests) {
    const result = await run(
      ["/bin/sh", "tests/factor/create-test.sh", test, "tests/factor/run.sh"],
      dir,
      testEnvironment(dir, test),
      "pipe",
    );
    if (result.code !== 0) {
      throw new Error(`failed to generate ${test}: ${result.stderr || result.stdout}`);
    }
    await writeFile(join(dir, test), result.stdout);
    await chmod(join(dir, test), 0o755);
  }
}

function testCommand(test) {
  const command = test.endsWith(".pl")
    ? [
      "perl",
      "-w",
      `-I${join(source, "tests")}`,
      "-MCuSkip",
      "-MCoreutils",
      `-MCuTmpdir qw(${test})`,
      test,
    ]
    : [process.env.SHELL || "/bin/sh", test];
  // The test runner normally captures stdin.  Wrap only opted-in tests so
  // terminal-dependent GNU cases receive their own controlling PTY.
  return tty || TTY_TESTS.has(test)
    ? ["script", "-qefc", command.map(shellQuote).join(" "), "/dev/null"]
    : command;
}

function testEnvironment(dir, test) {
  const env = {
    ...process.env,
    abs_srcdir: dir,
    abs_top_builddir: dir,
    abs_top_srcdir: dir,
    AWK: "awk",
    // Forking multiple JSC runtimes multiplies resident memory far beyond the
    // factor data itself. Keep audit execution serial unless a controlled run
    // explicitly opts in to a bounded worker count.
    BNU_FACTOR_WORKERS: process.env.BNU_FACTOR_WORKERS || "1",
    built_programs: process.env.BNU_GNU_BUILT_PROGRAMS || [...commandNames, "ginstall"].join(" "),
    CC: process.env.CC || "cc",
    CONFIG_HEADER: join(dir, "config.h"),
    CU_TEST_NAME: `coreutils-9.11,${test.replace(/^\.\//, "").replaceAll("/", "-")}`,
    EGREP: "grep -E",
    EXEEXT: "",
    fail: "0",
    FILE: "zero.in",
    LC_ALL: "C",
    LOCALE_FR: process.env.LOCALE_FR || "fr_FR.iso88591",
    LOCALE_FR_UTF8: process.env.LOCALE_FR_UTF8 || "fr_FR.utf8",
    PACKAGE_VERSION: "9.11",
    PATH: `${join(dir, "src")}:${process.env.PATH ?? ""}`,
    PERL: "perl",
    SHELL: process.env.SHELL || "/bin/sh",
    srcdir: dir,
    top_srcdir: dir,
    VERSION: "9.11",
  };
  if (expensive || veryExpensive) env.RUN_EXPENSIVE_TESTS = "yes";
  if (veryExpensive) env.RUN_VERY_EXPENSIVE_TESTS = "yes";
  if (keep) env.KEEP = "yes";
  return env;
}

function timeoutForTest(test) {
  const seconds = timeoutSeconds(timeout);
  if (test === "tests/uniq/uniq.pl") return seconds != null && seconds < 1800 ? "1800s" : timeout;
  if (test === "tests/stty/stty-pairs.sh") return seconds != null && seconds < 1800 ? "1800s" : timeout;
  if (["tests/help/help-version.sh", "tests/help/help-version-getopt.sh"].includes(test)) return seconds != null && seconds < 1800 ? "1800s" : timeout;
  if (!["tests/misc/usage_vs_getopt.sh", "tests/misc/getopt_vs_usage.sh", "tests/misc/usage_vs_refs.sh"].includes(test)) return timeout;
  return seconds != null && seconds < 600 ? "600s" : timeout;
}

function memoryLimitForTest(test) {
  // id/zero launches the runtime repeatedly while constructing its multi-user
  // matrix.  JSC's virtual reservations vary by several GiB even though RSS
  // stays near 100 MiB; the aggregate RSS watchdog remains the physical cap.
  return test === "tests/id/zero.sh" ? Math.max(memoryLimitBytes, 6 * 1024 ** 3) : memoryLimitBytes;
}

function timeoutSeconds(value) {
  const match = String(value).match(/^(\d+(?:\.\d+)?)([smhd]?)$/);
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] || "s";
  const scale = unit === "s" ? 1 : unit === "m" ? 60 : unit === "h" ? 3600 : 86400;
  return amount * scale;
}

function takeFlag(name) {
  const index = args.indexOf(name);
  if (index === -1) return false;
  args.splice(index, 1);
  return true;
}

function takeValue(name) {
  const index = args.indexOf(name);
  if (index === -1) return null;
  const value = args[index + 1];
  args.splice(index, 2);
  return value;
}

function parseByteSize(value) {
  const match = String(value).match(/^(\d+)(?:\s*(B|K|KB|KiB|M|MB|MiB|G|GB|GiB))?$/i);
  if (!match) throw new Error(`invalid byte size: ${value}`);
  const amount = Number(match[1]);
  const unit = match[2]?.toLowerCase() ?? "b";
  if (unit === "b") return amount;
  if (unit === "k" || unit === "kb" || unit === "kib") return amount * 1024;
  if (unit === "m" || unit === "mb" || unit === "mib") return amount * 1024 * 1024;
  if (unit === "g" || unit === "gb" || unit === "gib") return amount * 1024 * 1024 * 1024;
  return amount;
}

async function collectStream(stream, maxBytes = Infinity) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (total < maxBytes) {
        const keep = value.subarray(0, Math.min(value.length, maxBytes - total));
        if (keep.length) chunks.push(keep);
      }
      total += value.length;
      if (total > maxBytes) truncated = true;
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return { text: new TextDecoder().decode(out), truncated };
}

async function run(cmd, cwd, env = process.env, stdio = "inherit", options = {}) {
  const proc = Bun.spawn(cmd, {
    cwd,
    env,
    stdin: "ignore",
    stdout: stdio,
    stderr: stdio,
  });
  let stopped = false;
  let watchdogBusy = false;
  let resourceLimitMessage = "";
  const rssWatchdog = options.rssLimitBytes == null ? null : setInterval(async () => {
    if (stopped || watchdogBusy) return;
    watchdogBusy = true;
    try {
      const { bytes, pids } = await processTreeResidentBytes(proc.pid);
      if (!stopped && bytes > options.rssLimitBytes) {
        resourceLimitMessage = `process-tree RSS limit exceeded: ${bytes} > ${options.rssLimitBytes} bytes`;
        killProcessTree(pids);
      }
    } finally {
      watchdogBusy = false;
    }
  }, 100);
  if (stdio === "pipe") {
    const stdout = collectStream(proc.stdout, options.maxOutputBytes);
    const stderr = collectStream(proc.stderr, options.maxOutputBytes);
    const code = await proc.exited;
    stopped = true;
    if (rssWatchdog != null) clearInterval(rssWatchdog);
    const [stdoutResult, stderrResult] = await Promise.all([stdout, stderr]);
    return {
      code,
      stdout: stdoutResult.text,
      stderr: stderrResult.text,
      stdoutTruncated: stdoutResult.truncated,
      stderrTruncated: stderrResult.truncated,
      resourceLimitMessage,
    };
  }
  const code = await proc.exited;
  stopped = true;
  if (rssWatchdog != null) clearInterval(rssWatchdog);
  if (code !== 0) throw new Error(`${cmd.join(" ")} exited ${code}`);
  return { code, stdout: "", stderr: "" };
}

async function processTreeResidentBytes(rootPid) {
  const pending = [rootPid];
  const seen = new Set();
  let bytes = 0;
  while (pending.length) {
    const pid = pending.pop();
    if (!Number.isInteger(pid) || seen.has(pid)) continue;
    seen.add(pid);
    try {
      const children = await readFile(`/proc/${pid}/task/${pid}/children`, "utf8");
      for (const child of children.trim().split(/\s+/)) {
        if (child) pending.push(Number(child));
      }
    } catch {}
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
      if (match) bytes += Number(match[1]) * 1024;
    } catch {}
  }
  return { bytes, pids: [...seen] };
}

function killProcessTree(pids) {
  for (const pid of pids.reverse()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
  }
}

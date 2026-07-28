#!/usr/bin/env bun

import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { commandNames } from "../src/shared/catalog.js";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const archive = resolve(process.argv[2] ?? join(projectRoot, "coreutils-9.11.tar.xz"));
const manDir = join(projectRoot, "man");
const docDir = join(projectRoot, "doc");
const temporaryDir = await mkdtemp(join(tmpdir(), "bnu-doc-import-"));

try {
  const listing = run("tar", ["-tf", archive]).trim().split("\n");
  const archiveRoot = listing[0]?.split("/", 1)[0];
  if (!archiveRoot || !listing.includes(`${archiveRoot}/man/`) || !listing.includes(`${archiveRoot}/doc/`)) {
    throw new Error(`${basename(archive)} does not look like a GNU Coreutils source archive`);
  }

  run("tar", [
    "-xf",
    archive,
    "-C",
    temporaryDir,
    `${archiveRoot}/man`,
    `${archiveRoot}/doc`,
  ]);

  await mkdir(manDir, { recursive: true });
  await mkdir(docDir, { recursive: true });

  const upstreamManDir = join(temporaryDir, archiveRoot, "man");
  const manPages = (await readdir(upstreamManDir)).filter((name) => name.endsWith(".1")).sort();
  for (const name of manPages) {
    const source = await readFile(join(upstreamManDir, name), "utf8");
    await writeFile(join(manDir, name), adaptManPage(source, name));
  }

  const sha256sum = await readFile(join(upstreamManDir, "sha256sum.1"), "utf8");
  await writeFile(join(manDir, "sm3sum.1"), adaptSm3ManPage(sha256sum));
  await writeFile(join(manDir, "[.1"), bracketAliasManPage());
  await writeFile(join(manDir, "ginstall.1"), ginstallAliasManPage());
  const documentedCommands = new Set([
    ...manPages.map((name) => name.slice(0, -2)),
    "[",
    "ginstall",
    "sm3sum",
  ]);
  const undocumentedCommands = commandNames.filter((name) => !documentedCommands.has(name));
  if (undocumentedCommands.length) {
    throw new Error(`Missing manual pages for: ${undocumentedCommands.join(", ")}`);
  }

  const texinfoSources = [
    "constants.texi",
    "fdl.texi",
    "parse-datetime.texi",
    "perm.texi",
    "sort-version.texi",
  ];
  for (const name of texinfoSources) {
    await copyFile(join(temporaryDir, archiveRoot, "doc", name), join(docDir, name));
  }

  const upstreamTexinfo = await readFile(join(temporaryDir, archiveRoot, "doc", "coreutils.texi"), "utf8");
  await writeFile(join(docDir, "bnu.texi"), adaptTexinfo(upstreamTexinfo));
  await writeFile(
    join(docDir, "version.texi"),
    "@set UPDATED 28 July 2026\n@set UPDATED-MONTH July 2026\n@set EDITION 9.11\n@set VERSION 9.11\n",
  );

  run("makeinfo", [
    "--no-split",
    "-c",
    "CHECK_NORMAL_MENU_STRUCTURE=1",
    "-I",
    docDir,
    "-o",
    join(docDir, "bnu.info"),
    join(docDir, "bnu.texi"),
  ]);

  console.log(`Imported ${manPages.length} GNU manual pages; covered all ${commandNames.length} BNU commands.`);
  console.log(`Wrote ${join(docDir, "bnu.info")} from the adapted Texinfo source.`);
} finally {
  await rm(temporaryDir, { recursive: true, force: true });
}

function run(command, args) {
  const result = Bun.spawnSync([command, ...args], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (!result.success) {
    const detail = result.stderr.toString().trim();
    throw new Error(`${command} failed${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.toString();
}

function replaceRequired(text, search, replacement, description) {
  const next = text.replace(search, replacement);
  if (next === text) throw new Error(`Could not adapt ${description}; the upstream documentation changed`);
  return next;
}

function adaptManPage(source, name) {
  source = source.replaceAll("documents the GNU version of", "describes the BNU implementation of");
  if (name === "coreutils.1") {
    source = replaceRequired(
      source,
      "coreutils \\- single binary for coreutils programs",
      "coreutils \\- dispatch to a BNU command module",
      "coreutils command summary",
    );
    source = replaceRequired(
      source,
      "Execute the PROGRAM_NAME built\\-in program with the given PARAMETERS.",
      "Load and execute the PROGRAM_NAME single\\-call module with the given PARAMETERS.",
      "coreutils command description",
    );
  }
  let text = replaceRequired(
    source,
    /^\.\\" DO NOT MODIFY THIS FILE!.*$/m,
    '.\\" Adapted for BNU from the GNU Coreutils 9.11 manual page; see doc/README.md.',
    `${name} generation notice`,
  );
  text = replaceRequired(
    text,
    /^(\.TH [^\n]+ "1") "[^"]+" "GNU coreutils 9\.11" "User Commands"$/m,
    '$1 "2026-07-28" "BNU 9.11" "BNU Commands"',
    `${name} title`,
  );
  text = replaceRequired(
    text,
    /\.SH DESCRIPTION\n(?:\.\\" Add any additional description here\n)?/,
    '.SH DESCRIPTION\n.\\" This page is derived from GNU Coreutils documentation.\nThis page documents BNU, an independent Bun implementation compatible with\nGNU Coreutils 9.11.\n',
    `${name} description`,
  );
  text = replaceRequired(
    text,
    /\.SH AUTHOR\n([\s\S]*?)\n\.SH "REPORTING BUGS"/,
    '.SH AUTHORS\nUpstream GNU Coreutils documentation authors:\n$1\n.br\nAdapted for BNU; the BNU implementation is independent.\n.SH "REPORTING BUGS"',
    `${name} authors`,
  );
  text = replaceRequired(
    text,
    /Report bugs to: bug\\-coreutils@gnu\.org\n\.br\nGNU coreutils home page: <https:\/\/www\.gnu\.org\/software\/coreutils\/>\n\.br\nGeneral help using GNU software: <https:\/\/www\.gnu\.org\/gethelp\/>\n\.br\nReport any translation bugs to <https:\/\/translationproject\.org\/team\/>/,
    'Report BNU bugs at <https://github.com/Soccera1/bnu/issues>.\n.br\nFor upstream GNU Coreutils, see <https://www.gnu.org/software/coreutils/>.',
    `${name} bug reporting`,
  );
  text = replaceRequired(
    text,
    "Copyright \\(co 2026 Free Software Foundation, Inc.",
    "Copyright \\(co 2026 Free Software Foundation, Inc.\n.br\nThis manual page was adapted for BNU in 2026.",
    `${name} modification notice`,
  );
  text = replaceRequired(
    text,
    /Full documentation (<https:\/\/www\.gnu\.org\/software\/coreutils\/[^>]+>)\n\.br\nor available locally via: info \\\(aq\(coreutils\) ([^\n]+)/,
    'Upstream documentation $1\n.br\nBNU documentation is available locally via: info \\(aq(bnu) $2',
    `${name} Info reference`,
  );
  return text;
}

function adaptSm3ManPage(source) {
  let text = source
    .replaceAll("SHA256SUM", "SM3SUM")
    .replaceAll("sha256sum", "sm3sum")
    .replaceAll("SHA256", "SM3");
  text = replaceRequired(
    text,
    "The sums are computed as described in FIPS\\-180\\-2.",
    "The sums are computed with the 256\\-bit SM3 cryptographic hash algorithm.",
    "sm3sum algorithm description",
  );
  text = text.replace("info \\(aq(coreutils) sha2 utilities\\(aq", "info \\(aq(coreutils) sm3sum invocation\\(aq");
  return adaptManPage(text, "sm3sum.1");
}

function bracketAliasManPage() {
  return String.raw`.TH "[" "1" "2026-07-28" "BNU 9.11" "BNU Commands"
.SH NAME
[ \- evaluate a conditional expression
.SH SYNOPSIS
.B [
\fI\,EXPRESSION \/\fR]
.br
.B [ ]
.br
.B [
\fI\,OPTION\/\fR
.SH DESCRIPTION
.B [
is BNU's alternate form of
.BR test (1).
The closing bracket must be a separate final operand.  To request help or
version information, omit the closing bracket and use
.B [ --help
or
.BR "[ --version" .
.SH "REPORTING BUGS"
Report BNU bugs at <https://github.com/Soccera1/bnu/issues>.
.SH "SEE ALSO"
.BR test (1)
.PP
BNU documentation is available locally via: info \(aq(bnu) test invocation\(aq
`;
}

function ginstallAliasManPage() {
  return String.raw`.TH GINSTALL "1" "2026-07-28" "BNU 9.11" "BNU Commands"
.SH NAME
ginstall \- copy files and set attributes
.SH SYNOPSIS
.B ginstall
[\fI\,OPTION\/\fR]... [\fI\,OPERAND\/\fR]...
.SH DESCRIPTION
.B ginstall
is a BNU alias for
.BR install (1).
It accepts the same invocation forms and options.  The alias is provided for
environments where the unprefixed name is occupied by another program.
.SH "REPORTING BUGS"
Report BNU bugs at <https://github.com/Soccera1/bnu/issues>.
.SH "SEE ALSO"
.BR install (1)
.PP
BNU documentation is available locally via: info \(aq(bnu) install invocation\(aq
`;
}

function adaptTexinfo(source) {
  let text = replaceRequired(source, "@setfilename coreutils.info", "@setfilename bnu.info", "Info file name");
  text = replaceRequired(text, "@settitle GNU Coreutils @value{VERSION}", "@settitle BNU Core Utilities @value{VERSION}", "Info title");
  text = text.replaceAll("(coreutils)", "(bnu)");
  text = replaceRequired(
    text,
    "* Coreutils: (bnu).       Core GNU (file, text, shell) utilities.",
    "* BNU: (bnu).             Core file, text, and shell utilities for Bun.\n* BNU invocation: (bnu)Multi-call invocation.  Invoke single-call commands and compatibility dispatchers.",
    "Info directory entry",
  );
  text = replaceRequired(
    text,
    "* install: (bnu)install invocation.       Copy files and set attributes.",
    "* install: (bnu)install invocation.       Copy files and set attributes.\n* ginstall: (bnu)install invocation.          Alias for install.",
    "ginstall directory entry",
  );
  text = replaceRequired(
    text,
    "* sha2: (bnu)sha2 utilities.              Print or check SHA-2 digests.",
    "* sha2: (bnu)sha2 utilities.              Print or check SHA-2 digests.\n* sm3sum: (bnu)sm3sum invocation.           Print or check SM3 digests.",
    "sm3sum directory entry",
  );
  text = replaceRequired(
    text,
    "This manual documents version @value{VERSION} of the GNU core\nutilities, including the standard programs for text and file manipulation.",
    "This manual documents BNU @value{VERSION}, an independent Bun implementation\nof the GNU Coreutils command-line interface.  It is adapted from the GNU\nCoreutils @value{VERSION} manual for the corresponding commands.",
    "copying summary",
  );
  text = replaceRequired(
    text,
    "Copyright @copyright{} 1994--2026 Free Software Foundation, Inc.",
    "Copyright @copyright{} 1994--2026 Free Software Foundation, Inc.\nCopyright @copyright{} 2026 BNU contributors (adaptations).\n\nThis modified version was adapted for BNU on 28 July 2026.  The original\nauthorship and copyright are retained below.",
    "Texinfo modification notice",
  );
  text = replaceRequired(text, "@title GNU @code{Coreutils}", "@title BNU Core Utilities", "title page");
  text = replaceRequired(text, "@subtitle Core GNU utilities", "@subtitle Core utilities for Bun", "title subtitle");
  text = replaceRequired(
    text,
    "@author David MacKenzie et al.",
    "@author GNU manual: David MacKenzie, Jim Meyering, François Pinard,\n@author Karl Berry, Brian Youmans, and Richard Stallman\n@author BNU modifications: BNU contributors\n@subtitle Published by the BNU project",
    "title authors",
  );
  text = replaceRequired(text, "@top GNU Coreutils", "@top BNU Core Utilities", "top node");

  const introductionStart = text.indexOf("This manual is a work in progress:");
  const introductionEnd = text.indexOf("@cindex Berry, K.", introductionStart);
  if (introductionStart < 0 || introductionEnd < 0) throw new Error("Could not adapt the Texinfo introduction");
  text = `${text.slice(0, introductionStart)}This is the BNU edition of the GNU Coreutils manual.  BNU is an independent\nimplementation for the Bun runtime; it is not built from GNU Coreutils source\nand does not provide GNU Coreutils' internal C interfaces.  The command-line\nbehavior described here is BNU's compatibility target.  Platform-dependent\nbehavior can vary with the operating system, file system, locale, and available\nsecurity facilities.\n\nWhere this manual and BNU disagree, the installed BNU command's\n@option{--help} output and actual behavior take precedence.\n\n@cindex POSIX\nBNU's utilities aim to be compatible with GNU Coreutils 9.11 and the applicable\nPOSIX interfaces.\n@cindex bugs, reporting\n\nPlease report BNU bugs at\n@uref{https://github.com/Soccera1/bnu/issues}.  Include the version number,\nmachine architecture, input files, and the information needed to reproduce the\nproblem: your input, what you expected, what you got, and why it is wrong.\n\nIf you have a problem with @command{sort} or @command{date}, try using the\n@option{--debug} option when available, as its output can help diagnose the\nproblem.\n\nThis edition was adapted from the GNU Coreutils 9.11 manual.  The upstream\nmanual's authorship follows.\n\n${text.slice(introductionEnd)}`;
  text = replaceRequired(
    text,
    "What you are reading now is the authoritative documentation\nfor these utilities; the man pages are no longer being maintained.",
    "The upstream manual is the authoritative GNU Coreutils documentation.\nThis BNU edition retains and adapts it for BNU's compatible command surface.",
    "manual authority statement",
  );

  const multiCallStart = text.indexOf("@c This node is named \"Multi-call invocation\"");
  const multiCallEnd = text.indexOf("@node Output of entire files", multiCallStart);
  if (multiCallStart < 0 || multiCallEnd < 0) throw new Error("Could not adapt the multi-call section");
  const multiCall = `@c This node keeps the upstream name so command nodes remain easy to find.\n@node Multi-call invocation\n@section Invoking BNU commands\n\n@pindex bnu\n@pindex coreutils\n@cindex single-call command\n@cindex calling combined multi-call program\n\nEach BNU utility has an independently runnable single-call module.  From a\nsource checkout, invoke one with Bun:\n\n@example\nbun ./src/commands/@var{command}.js [@var{argument}]@dots{}\n@end example\n\nThe repository command @samp{bun run link-commands -- @var{directory}} creates\ncommand-name wrappers that invoke those modules directly.  After deliberately\nadding that directory to @env{PATH}, the usual form is:\n\n@example\n@var{command} [@var{argument}]@dots{}\n@end example\n\nThe @command{bnu} multi-call launcher remains available for compatibility and\ncommand discovery:\n\n@example\nbnu @var{command} [@var{argument}]@dots{}\nbnu @option{--help}\n@end example\n\nFor compatibility with the GNU Coreutils multi-call interface, BNU also\nprovides:\n\n@example\ncoreutils @option{--coreutils-prog=@var{program}} [@var{argument}]@dots{}\n@end example\n\nThe source entries, generated wrappers, and compatibility launchers require the\nBun runtime.\n\n`;
  text = `${text.slice(0, multiCallStart)}${multiCall}${text.slice(multiCallEnd)}`;
  text = text.replaceAll(
    "* Multi-call invocation::        Multi-call program invocation",
    "* Multi-call invocation::        Single-call commands and compatibility dispatch",
  );

  text = replaceRequired(
    text,
    "* sha2 utilities::               Print or check SHA-2 digests\n",
    "* sha2 utilities::               Print or check SHA-2 digests\n* sm3sum invocation::              Print or check SM3 digests\n",
    "sm3sum detail menu entry",
  );
  text = replaceRequired(
    text,
    "* sha2 utilities::              Print or check SHA-2 digests.\n@end menu",
    "* sha2 utilities::              Print or check SHA-2 digests.\n* sm3sum invocation::             Print or check SM3 digests.\n@end menu",
    "sm3sum chapter menu entry",
  );
  text = replaceRequired(
    text,
    "@samp{sm3}       only available through @command{cksum}",
    "@samp{sm3}       equivalent to @command{sm3sum} in BNU",
    "sm3sum algorithm entry",
  );
  text = replaceRequired(
    text,
    "@checksumUsage{sha???sum}\n\n\n@node Operating on sorted files",
    "@checksumUsage{sha???sum}\n\n\n@node sm3sum invocation\n@section @command{sm3sum}: Print or check SM3 digests\n\n@pindex sm3sum\n@cindex SM3\n@cindex 256-bit checksum\n@command{sm3sum} computes a 256-bit SM3 checksum for each specified\n@var{file}.  It is a BNU extension provided as a standalone interface to the\nSM3 algorithm accepted by @command{cksum}.\n\n@legacyDigest\n\n@checksumUsage{sm3sum}\n\n\n@node Operating on sorted files",
    "sm3sum section",
  );
  text = replaceRequired(
    text,
    "This version of @command{false} is implemented as a C program, and is thus\nmore secure and faster than a shell script implementation, and may safely\nbe used as a dummy shell for the purpose of disabling accounts.",
    "BNU implements @command{false} as a Bun single-call command module.  Do not\nuse the source-checkout entry as a login shell.",
    "false implementation note",
  );
  text = replaceRequired(
    text,
    "This version of @command{true} is implemented as a C program, and is thus\nmore secure and faster than a shell script implementation, and may safely\nbe used as a dummy shell for the purpose of disabling accounts.",
    "BNU implements @command{true} as a Bun single-call command module.  Do not\nuse the source-checkout entry as a login shell.",
    "true implementation note",
  );
  text = replaceRequired(
    text,
    "* GNU Free Documentation License:: Copying and sharing this manual\n* Concept index::",
    "* History::                      History of this modified manual\n* GNU Free Documentation License:: Copying and sharing this manual\n* Concept index::",
    "History top-level menu entry",
  );
  text = replaceRequired(
    text,
    "Copying This Manual\n\n* GNU Free Documentation License::     Copying and sharing this manual",
    "Manual History\n\n* History::                             Original and modified editions\n\nCopying This Manual\n\n* GNU Free Documentation License::     Copying and sharing this manual",
    "History detail menu entry",
  );
  text = replaceRequired(
    text,
    "@node GNU Free Documentation License\n@appendix GNU Free Documentation License",
    "@node History\n@appendix History\n\n@table @asis\n@item GNU @code{Coreutils} 9.11 (2026)\nThe original manual was authored by David MacKenzie et al. and published by\nthe Free Software Foundation.  Its transparent Texinfo source is distributed\nin the GNU Coreutils 9.11 source release at\n@uref{https://ftp.gnu.org/gnu/coreutils/coreutils-9.11.tar.xz}.\n\n@item BNU Core Utilities 9.11 (2026)\nThis modified edition was adapted by BNU contributors and published by the BNU\nproject.  It documents BNU's independent Bun implementation, adds BNU-specific\ninvocation and extension material, and identifies the original GNU material.\nIts transparent source is available at\n@uref{https://github.com/Soccera1/bnu}.\n@end table\n\n@node GNU Free Documentation License\n@appendix GNU Free Documentation License",
    "History appendix",
  );
  return text;
}

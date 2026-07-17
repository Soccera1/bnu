import { stdout } from "./diagnostics.js";
import { COMMAND_HELP_OPTIONS } from "./help-options.js";

export const SPECIAL_HELP = {
  arch: {
    usage: "Usage: arch [OPTION]...",
    description: "Print machine architecture.",
  },
  basename: {
    usage: "Usage: basename NAME [SUFFIX]\n  or:  basename OPTION... NAME...",
    description: "Print NAME with any leading directory components removed.\nIf specified, also remove a trailing SUFFIX.",
    options: ["-a, --multiple", "-s, --suffix=SUFFIX", "-z, --zero"],
  },
  base32: {
    usage: "Usage: base32 [OPTION]... [FILE]",
    description: "Base32 encode or decode FILE, or standard input, to standard output.",
    options: COMMAND_HELP_OPTIONS.base32,
  },
  base64: {
    usage: "Usage: base64 [OPTION]... [FILE]",
    description: "Base64 encode or decode FILE, or standard input, to standard output.",
    options: COMMAND_HELP_OPTIONS.base64,
  },
  b2sum: {
    usage: "Usage: b2sum [OPTION]... [FILE]...",
    description: "Print or check BLAKE2b (512-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.b2sum,
  },
  basenc: {
    usage: "Usage: basenc [OPTION]... [FILE]",
    description: "basenc encode or decode FILE, or standard input, to standard output.",
    options: COMMAND_HELP_OPTIONS.basenc,
  },
  cat: {
    usage: "Usage: cat [OPTION]... [FILE]...",
    description: "Concatenate FILE(s) to standard output.",
    options: COMMAND_HELP_OPTIONS.cat,
  },
  comm: {
    usage: "Usage: comm [OPTION]... FILE1 FILE2",
    description: "Compare sorted files FILE1 and FILE2 line by line.",
    options: COMMAND_HELP_OPTIONS.comm,
  },
  chgrp: {
    usage: "Usage: chgrp [OPTION]... GROUP FILE...\n  or:  chgrp [OPTION]... --reference=RFILE FILE...",
    description: "Change the group of each FILE to GROUP.",
    options: COMMAND_HELP_OPTIONS.chgrp,
  },
  chmod: {
    usage: "Usage: chmod [OPTION]... MODE[,MODE]... FILE...\n  or:  chmod [OPTION]... OCTAL-MODE FILE...\n  or:  chmod [OPTION]... --reference=RFILE FILE...",
    description: "Change the mode of each FILE to MODE.",
    options: COMMAND_HELP_OPTIONS.chmod,
  },
  chown: {
    usage: "Usage: chown [OPTION]... [OWNER][:[GROUP]] FILE...\n  or:  chown [OPTION]... --reference=RFILE FILE...",
    description: "Change the owner and/or group of each FILE to OWNER and/or GROUP.",
    options: COMMAND_HELP_OPTIONS.chown,
  },
  chcon: {
    usage: "Usage: chcon [OPTION]... CONTEXT FILE...\n  or:  chcon [OPTION]... [-u USER] [-r ROLE] [-l RANGE] [-t TYPE] FILE...\n  or:  chcon [OPTION]... --reference=RFILE FILE...",
    description: "Change the SELinux security context of each FILE to CONTEXT.",
    options: COMMAND_HELP_OPTIONS.chcon,
  },
  chroot: {
    usage: "Usage: chroot [OPTION]... NEWROOT [COMMAND [ARG]...]",
    description: "Run COMMAND with root directory set to NEWROOT.",
    options: COMMAND_HELP_OPTIONS.chroot,
  },
  cp: {
    usage: "Usage: cp [OPTION]... [-T] SOURCE DEST\n  or:  cp [OPTION]... SOURCE... DIRECTORY\n  or:  cp [OPTION]... -t DIRECTORY SOURCE...",
    description: "Copy SOURCE to DEST, or multiple SOURCE(s) to DIRECTORY.",
    options: COMMAND_HELP_OPTIONS.cp,
  },
  csplit: {
    usage: "Usage: csplit [OPTION]... FILE PATTERN...",
    description: "Output pieces of FILE separated by PATTERN(s) to files 'xx00', 'xx01', ...,\nand output byte counts of each piece to standard output.",
    options: COMMAND_HELP_OPTIONS.csplit,
  },
  cut: {
    usage: "Usage: cut OPTION... [FILE]...",
    description: "Print selected parts of lines from each FILE to standard output.",
    options: COMMAND_HELP_OPTIONS.cut,
  },
  date: {
    usage: "Usage: date [OPTION]... [+FORMAT]\n  or:  date [OPTION]... MMDDhhmm[[CC]YY][.ss]",
    description: "Display date and time in the given FORMAT.\nWith -s, or with MMDDhhmm[[CC]YY][.ss], set the date and time first.",
    options: COMMAND_HELP_OPTIONS.date,
  },
  dd: {
    usage: "Usage: dd [OPERAND]...\n  or:  dd OPTION",
    description: "Copy a file, converting and formatting according to the operands.",
  },
  df: {
    usage: "Usage: df [OPTION]... [FILE]...",
    description: "Show information about the file system on which each FILE resides,\nor all file systems by default.",
    options: COMMAND_HELP_OPTIONS.df,
  },
  dir: {
    usage: "Usage: dir [OPTION]... [FILE]...",
    description: "List information about the FILEs (the current directory by default).\nSort entries alphabetically if none of -cftuvSUX nor --sort is specified.",
    options: COMMAND_HELP_OPTIONS.dir,
  },
  dircolors: {
    usage: "Usage: dircolors [OPTION]... [FILE]",
    description: "Output commands to set the LS_COLORS environment variable.",
    options: COMMAND_HELP_OPTIONS.dircolors,
  },
  dirname: {
    usage: "Usage: dirname [OPTION] NAME...",
    description: "Output each NAME with its last non-slash component and trailing slashes\nremoved; if NAME contains no /'s, output '.' (meaning the current directory).",
    options: ["-z, --zero"],
  },
  du: {
    usage: "Usage: du [OPTION]... [FILE]...\n  or:  du [OPTION]... --files0-from=F",
    description: "Summarize device usage of the set of FILEs, recursively for directories.",
    options: COMMAND_HELP_OPTIONS.du,
  },
  env: {
    usage: "Usage: env [OPTION]... [-] [NAME=VALUE]... [COMMAND [ARG]...]",
    description: "Set each NAME to VALUE in the environment and run COMMAND.",
    options: COMMAND_HELP_OPTIONS.env,
  },
  expr: {
    usage: "Usage: expr EXPRESSION\n  or:  expr OPTION",
    description: "",
    options: [],
  },
  expand: {
    usage: "Usage: expand [OPTION]... [FILE]...",
    description: "Convert tabs in each FILE to spaces, writing to standard output.",
    options: COMMAND_HELP_OPTIONS.expand,
  },
  fold: {
    usage: "Usage: fold [OPTION]... [FILE]...",
    description: "Wrap input lines in each FILE, writing to standard output.",
    options: COMMAND_HELP_OPTIONS.fold,
  },
  groups: {
    usage: "Usage: groups [OPTION]... [USERNAME]...",
    description: "Print group memberships for each USERNAME or, if no USERNAME is specified, for\nthe current process (which may differ if the groups database has changed).",
  },
  ginstall: {
    usage: "Usage: install [OPTION]... [-T] SOURCE DEST\n  or:  install [OPTION]... SOURCE... DIRECTORY\n  or:  install [OPTION]... -t DIRECTORY SOURCE...\n  or:  install [OPTION]... -d DIRECTORY...",
    description: "Copy files and set attributes.",
    options: COMMAND_HELP_OPTIONS.install,
  },
  hostid: {
    usage: "Usage: hostid [OPTION]",
    description: "Print the numeric identifier (in hexadecimal) for the current host.",
  },
  head: {
    usage: "Usage: head [OPTION]... [FILE]...",
    description: "Print the first 10 lines of each FILE to standard output.\nWith more than one FILE, precede each with a header giving the file name.",
    options: COMMAND_HELP_OPTIONS.head,
  },
  id: {
    usage: "Usage: id [OPTION]... [USER]...",
    description: "Print user and group information for each specified USER,\nor (when USER omitted) for the current process.",
    options: COMMAND_HELP_OPTIONS.id,
  },
  install: {
    usage: "Usage: install [OPTION]... [-T] SOURCE DEST\n  or:  install [OPTION]... SOURCE... DIRECTORY\n  or:  install [OPTION]... -t DIRECTORY SOURCE...\n  or:  install [OPTION]... -d DIRECTORY...",
    description: "Copy files and set attributes.",
    options: COMMAND_HELP_OPTIONS.install,
  },
  join: {
    usage: "Usage: join [OPTION]... FILE1 FILE2",
    description: "For each pair of input lines with identical join fields, write a line to\nstandard output.",
    options: COMMAND_HELP_OPTIONS.join,
  },
  kill: {
    usage: "Usage: kill [-s SIGNAL | --signal SIGNAL | -SIGNAL] PID...\n  or:  kill [-l | --list | -t | --table] [SIGNAL]...",
    description: "Send a signal to processes, or list information about signals.",
    options: [
      "-s, --signal=SIGNAL  specify the name or number of the signal to be sent",
      "-l, --list[=SIGNAL]  list signal names, or convert signal names and numbers",
      "-t, --table          print a table of signal numbers, names, and descriptions",
    ],
  },
  ls: {
    usage: "Usage: ls [OPTION]... [FILE]...",
    description: "List information about the FILEs (the current directory by default).\nSort entries alphabetically if none of -cftuvSUX nor --sort is specified.",
    options: COMMAND_HELP_OPTIONS.ls,
  },
  logname: {
    usage: "Usage: logname [OPTION]",
    description: "Print the user's login name.",
  },
  md5sum: {
    usage: "Usage: md5sum [OPTION]... [FILE]...",
    description: "Print or check MD5 (128-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.md5sum,
  },
  factor: {
    usage: "Usage: factor [OPTION] [NUMBER]...",
    description: "Print the prime factors of each specified integer NUMBER.  If none\nare specified on the command line, read them from standard input.",
    options: ["-h, --exponents"],
  },
  fmt: {
    usage: "Usage: fmt [-WIDTH] [OPTION]... [FILE]...",
    description: "Reformat each paragraph in the FILE(s), writing to standard output.\nThe option -WIDTH is an abbreviated form of --width=DIGITS.",
    options: COMMAND_HELP_OPTIONS.fmt,
  },
  mkdir: {
    usage: "Usage: mkdir [OPTION]... DIRECTORY...",
    description: "Create the DIRECTORY(ies), if they do not already exist.\n\nMandatory arguments to long options are mandatory for short options too.",
    options: [
      "-m, --mode=MODE   set file mode (as in chmod), not a=rwx - umask",
      "-p, --parents     no error if existing, make parent directories as needed,\n                   with their file modes unaffected by any -m option",
      "-v, --verbose     print a message for each created directory",
      "-Z                set SELinux security context of each created directory\n                   to the default type",
      "--context[=CTX]   like -Z, or if CTX is specified then set the\n                   SELinux or SMACK security context to CTX",
    ],
  },
  mkfifo: {
    usage: "Usage: mkfifo [OPTION]... NAME...",
    description: "Create named pipes (FIFOs) with the given NAMEs.\n\nMandatory arguments to long options are mandatory for short options too.",
    options: [
      "-m, --mode=MODE   set file permission bits to MODE, not a=rw - umask",
      "-Z                set the SELinux security context to default type",
      "--context[=CTX]   like -Z, or if CTX is specified then set the\n                   SELinux or SMACK security context to CTX",
    ],
  },
  mktemp: {
    usage: "Usage: mktemp [OPTION]... [TEMPLATE]",
    description: "Create a temporary file or directory, safely, and print its name.\nTEMPLATE must contain at least 3 consecutive 'X's in last component.\nIf TEMPLATE is not specified, use tmp.XXXXXXXXXX, and --tmpdir is implied.\nFiles are created u+rw, and directories u+rwx, minus umask restrictions.",
    options: [
      "-d, --directory   create a directory, not a file",
      "-u, --dry-run     do not create anything; merely print a name (unsafe)",
      "-q, --quiet       suppress diagnostics about file/dir-creation failure",
      "--suffix=SUFF     append SUFF to TEMPLATE; SUFF must not contain a slash.\n                   This option is implied if TEMPLATE does not end in X",
      "-p DIR, --tmpdir[=DIR]\n                   interpret TEMPLATE relative to DIR;\n                   if DIR is not specified, use $TMPDIR if set, else /tmp.\n                   With this option, TEMPLATE must not be an absolute name;\n                   unlike with -t, TEMPLATE may contain slashes,\n                   but mktemp creates only the final component",
      "-t                interpret TEMPLATE as a single file name component,\n                   relative to a directory: $TMPDIR, if set;\n                   else the directory specified via -p; else /tmp [deprecated]",
    ],
  },
  mv: {
    usage: "Usage: mv [OPTION]... [-T] SOURCE DEST\n  or:  mv [OPTION]... SOURCE... DIRECTORY\n  or:  mv [OPTION]... -t DIRECTORY SOURCE...",
    description: "Rename SOURCE to DEST, or move SOURCE(s) to DIRECTORY.",
    options: COMMAND_HELP_OPTIONS.mv,
  },
  nice: {
    usage: "Usage: nice [OPTION] [COMMAND [ARG]...]",
    description: "Run COMMAND with an adjusted niceness, which affects process scheduling.\nWith no COMMAND, print the current niceness.",
    options: COMMAND_HELP_OPTIONS.nice,
  },
  nohup: {
    usage: "Usage: nohup COMMAND [ARG]...\n  or:  nohup OPTION",
    description: "Run COMMAND, ignoring hangup signals.",
  },
  ln: {
    usage: "Usage: ln [OPTION]... [-T] TARGET LINK_NAME\n  or:  ln [OPTION]... TARGET\n  or:  ln [OPTION]... TARGET... DIRECTORY\n  or:  ln [OPTION]... -t DIRECTORY TARGET...",
    description: "Create links between files.",
    options: COMMAND_HELP_OPTIONS.ln,
  },
  mknod: {
    usage: "Usage: mknod [OPTION]... NAME TYPE [MAJOR MINOR]",
    description: "Create the special file NAME of the given TYPE.\n\nMandatory arguments to long options are mandatory for short options too.",
    options: [
      "-m, --mode=MODE   set file permission bits to MODE, not a=rw - umask",
      "-Z                set the SELinux security context to default type",
      "--context[=CTX]   like -Z, or if CTX is specified then set the\n                   SELinux or SMACK security context to CTX",
    ],
    after: "Both MAJOR and MINOR must be specified when TYPE is b, c, or u, and they\nmust be omitted when TYPE is p.  If MAJOR or MINOR begins with 0x or 0X,\nit is interpreted as hexadecimal; otherwise, if it begins with 0, as octal;\notherwise, as decimal.  TYPE may be:\n\n  b      create a block (buffered) special file\n  c, u   create a character (unbuffered) special file\n  p      create a FIFO\n\nYour shell may have its own version of mknod, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.",
  },
  nproc: {
    usage: "Usage: nproc [OPTION]...",
    description: "Print the number of processing units available to the current process,\nwhich may be less than the number of online processors.\nIf the 'OMP_NUM_THREADS' or 'OMP_THREAD_LIMIT' environment variables are set,\nthen they will determine the minimum and maximum returned value respectively.",
    options: [
      "--all\n         print the number of installed processors,\n         disregarding any OpenMP environment variables, or CPU quotas.",
      "--ignore=N\n         if possible, exclude N processing units.\n         The result is guaranteed to be at least 1.",
    ],
  },
  nl: {
    usage: "Usage: nl [OPTION]... [FILE]...",
    description: "Write each FILE to standard output, with line numbers added.",
    options: COMMAND_HELP_OPTIONS.nl,
  },
  numfmt: {
    usage: "Usage: numfmt [OPTION]... [NUMBER]...",
    description: "Reformat NUMBER(s), or the numbers from standard input if none are specified.",
    options: COMMAND_HELP_OPTIONS.numfmt,
  },
  od: {
    usage: "Usage: od [OPTION]... [FILE]...\n  or:  od [-abcdfilosx]... [FILE] [[+]OFFSET[.][b]]\n  or:  od --traditional [OPTION]... [FILE] [[+]OFFSET[.][b] [+][LABEL][.][b]]",
    description: "Write an unambiguous representation, octal bytes by default,\nof FILE to standard output.",
    options: COMMAND_HELP_OPTIONS.od,
  },
  pathchk: {
    usage: "Usage: pathchk [OPTION]... NAME...",
    description: "Diagnose invalid or non-portable file names.",
    options: [
      "-p     check for most POSIX systems",
      "-P     check for empty names and leading \"-\"",
      "--portability\n         check for all POSIX systems (equivalent to -p -P)",
    ],
  },
  paste: {
    usage: "Usage: paste [OPTION]... [FILE]...",
    description: "Write lines consisting of the sequentially corresponding lines from\neach FILE, separated by TABs, to standard output.",
    options: COMMAND_HELP_OPTIONS.paste,
  },
  pinky: {
    usage: "Usage: pinky [OPTION]... [USER]...",
    description: "",
    options: COMMAND_HELP_OPTIONS.pinky,
  },
  printenv: {
    usage: "Usage: printenv [OPTION] [VARIABLE]...",
    description: "Print the values of the specified environment VARIABLE(s).\nIf no VARIABLE is specified, print name and value pairs for them all.",
    options: ["-0, --null     end each output line with NUL, not newline"],
    after: "Your shell may have its own version of printenv, which usually supersedes\nthe version described here.  Please refer to your shell's documentation\nfor details about the options it supports.",
  },
  printf: {
    usage: "Usage: printf FORMAT [ARGUMENT]...\n  or:  printf OPTION",
    description: "Print ARGUMENT(s) according to FORMAT, or execute according to OPTION:",
    options: [],
  },
  ptx: {
    usage: "Usage: ptx [OPTION]... [INPUT]...   (without -G)\n  or:  ptx -G [OPTION]... [INPUT [OUTPUT]]",
    description: "Output a permuted index, including context, of the words in the input files.",
    options: COMMAND_HELP_OPTIONS.ptx,
  },
  pr: {
    usage: "Usage: pr [OPTION]... [FILE]...",
    description: "Paginate or columnate FILE(s) for printing.",
    options: COMMAND_HELP_OPTIONS.pr,
  },
  pwd: {
    usage: "Usage: pwd [OPTION]...",
    description: "Print the full filename of the current working directory.",
    options: ["-L, --logical", "-P, --physical"],
  },
  readlink: {
    usage: "Usage: readlink [OPTION]... FILE...",
    description: "Print value of a symbolic link or canonical file name",
    options: [
      "-f, --canonicalize\n         canonicalize by following every symlink\n         in every component of the given name recursively;\n         all but the last component must exist",
      "-e, --canonicalize-existing\n         canonicalize by following every symlink\n         in every component of the given name recursively;\n         all components must exist",
      "-m, --canonicalize-missing\n         canonicalize by following every symlink\n         in every component of the given name recursively,\n         without requirements on components existence",
      "-n, --no-newline\n         do not output the trailing delimiter",
      "-q, --quiet\n         suppress most error messages\n         (on by default if POSIXLY_CORRECT is not set)",
      "-s, --silent\n         suppress most error messages\n         (on by default if POSIXLY_CORRECT is not set)",
      "-v, --verbose\n         report error messages\n         (on by default if POSIXLY_CORRECT is set)",
      "-z, --zero\n         end each output line with NUL, not newline",
    ],
  },
  realpath: {
    usage: "Usage: realpath [OPTION]... FILE...",
    description: "Print the resolved absolute file name.",
    options: [
      "-E, --canonicalize           all but the last component must exist (default)",
      "-e, --canonicalize-existing  all components of the path must exist",
      "-m, --canonicalize-missing   no path components need exist or be a directory",
      "-L, --logical                resolve '..' components before symlinks",
      "-P, --physical               resolve symlinks as encountered (default)",
      "-q, --quiet                  suppress most error messages",
      "--relative-to=DIR        print the resolved path relative to DIR",
      "--relative-base=DIR      print absolute paths unless paths below DIR",
      "-s, --strip, --no-symlinks   don't expand symlinks",
      "-z, --zero                   end each output line with NUL, not newline",
    ],
  },
  rmdir: {
    usage: "Usage: rmdir [OPTION]... DIRECTORY...",
    description: "Remove the DIRECTORY(ies), if they are empty.",
    options: ["--ignore-fail-on-non-empty", "-p, --parents", "-v, --verbose"],
  },
  runcon: {
    usage: "Usage: runcon CONTEXT COMMAND [args]\n  or:  runcon [ -c ] [-u USER] [-r ROLE] [-t TYPE] [-l RANGE] COMMAND [args]",
    description: "Run COMMAND with specified SELinux security context.",
    options: COMMAND_HELP_OPTIONS.runcon,
  },
  rm: {
    usage: "Usage: rm [OPTION]... [FILE]...",
    description: "Remove (unlink) the FILE(s).",
    options: COMMAND_HELP_OPTIONS.rm,
  },
  sum: {
    usage: "Usage: sum [OPTION]... [FILE]...",
    description: "Print or check BSD (16-bit) checksums.\nLegacy interface to the cksum utility.\n\nWith no FILE, or when FILE is -, read standard input.",
    options: [
      "-r\n         use BSD sum algorithm (the default), use 1K blocks",
      "-s, --sysv\n         use System V sum algorithm, use 512 bytes blocks",
    ],
  },
  tac: {
    usage: "Usage: tac [OPTION]... [FILE]...",
    description: "Write each FILE to standard output, last line first.",
    options: COMMAND_HELP_OPTIONS.tac,
  },
  sync: {
    usage: "Usage: sync [OPTION] [FILE]...",
    description: "Synchronize cached writes to persistent storage\n\nIf one or more files are specified, sync only them,\nor their containing file systems.",
    options: [
      "-d, --data             sync only file data, no unneeded metadata",
      "-f, --file-system      sync the file systems that contain the files",
    ],
  },
  shuf: {
    usage: "Usage: shuf [OPTION]... [FILE]\n  or:  shuf -e [OPTION]... [ARG]...\n  or:  shuf -i LO-HI [OPTION]...",
    description: "Write a random permutation of the input lines to standard output.",
    options: COMMAND_HELP_OPTIONS.shuf,
  },
  shred: {
    usage: "Usage: shred [OPTION]... FILE...",
    description: "Overwrite the specified FILE(s) repeatedly, in order to make it harder\nfor even very expensive hardware probing to recover the data.",
    options: COMMAND_HELP_OPTIONS.shred,
  },
  sort: {
    usage: "Usage: sort [OPTION]... [FILE]...\n  or:  sort [OPTION]... --files0-from=F",
    description: "Write sorted concatenation of all FILE(s) to standard output.",
    options: COMMAND_HELP_OPTIONS.sort,
  },
  seq: {
    usage: "Usage: seq [OPTION]... LAST\n  or:  seq [OPTION]... FIRST LAST\n  or:  seq [OPTION]... FIRST INCREMENT LAST",
    description: "Print numbers from FIRST to LAST, in steps of INCREMENT.",
    options: COMMAND_HELP_OPTIONS.seq,
  },
  sha1sum: {
    usage: "Usage: sha1sum [OPTION]... [FILE]...",
    description: "Print or check SHA1 (160-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.sha1sum,
  },
  sha224sum: {
    usage: "Usage: sha224sum [OPTION]... [FILE]...",
    description: "Print or check SHA224 (224-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.sha224sum,
  },
  sha256sum: {
    usage: "Usage: sha256sum [OPTION]... [FILE]...",
    description: "Print or check SHA256 (256-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.sha256sum,
  },
  sha384sum: {
    usage: "Usage: sha384sum [OPTION]... [FILE]...",
    description: "Print or check SHA384 (384-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.sha384sum,
  },
  sha512sum: {
    usage: "Usage: sha512sum [OPTION]... [FILE]...",
    description: "Print or check SHA512 (512-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.sha512sum,
  },
  sm3sum: {
    usage: "Usage: sm3sum [OPTION]... [FILE]...",
    description: "Print or check SM3 (256-bit) checksums.\nLegacy interface to the cksum utility.",
    options: COMMAND_HELP_OPTIONS.sm3sum,
  },
  split: {
    usage: "Usage: split [OPTION]... [FILE [PREFIX]]",
    description: "Output pieces of FILE to PREFIXaa, PREFIXab, ...;\ndefault size is 1000 lines, and default PREFIX is 'x'.",
    options: COMMAND_HELP_OPTIONS.split,
  },
  stat: {
    usage: "Usage: stat [OPTION]... FILE...",
    description: "Display file or file system status.",
    options: COMMAND_HELP_OPTIONS.stat,
  },
  tail: {
    usage: "Usage: tail [OPTION]... [FILE]...",
    description: "Print the last 10 lines of each FILE to standard output.\nWith more than one FILE, precede each with a header giving the file name.",
    options: COMMAND_HELP_OPTIONS.tail,
  },
  tee: {
    usage: "Usage: tee [OPTION]... [FILE]...",
    description: "Copy standard input to each FILE, and also to standard output.",
    options: COMMAND_HELP_OPTIONS.tee,
  },
  stty: {
    usage: "Usage: stty [-F DEVICE | --file=DEVICE] [SETTING]...\n  or:  stty [-F DEVICE | --file=DEVICE] [-a|--all]\n  or:  stty [-F DEVICE | --file=DEVICE] [-g|--save]",
    description: "Print or change terminal characteristics.",
    options: COMMAND_HELP_OPTIONS.stty,
  },
  stdbuf: {
    usage: "Usage: stdbuf OPTION... COMMAND",
    description: "Run COMMAND, with modified buffering operations for its standard streams.\n\nMandatory arguments to long options are mandatory for short options too.",
    options: [
      "-i, --input=MODE   adjust standard input stream buffering",
      "-o, --output=MODE  adjust standard output stream buffering",
      "-e, --error=MODE   adjust standard error stream buffering",
    ],
    after: "If MODE is 'L' the corresponding stream will be line buffered.\nThis option is invalid with standard input.\n\nIf MODE is '0' the corresponding stream will be unbuffered.\n\nOtherwise MODE is a number which may be followed by one of the following:\nKB 1000, K 1024, MB 1000*1000, M 1024*1024, and so on for G,T,P,E,Z,Y,R,Q.\nBinary prefixes can be used, too: KiB=K, MiB=M, and so on.\nIn this case the corresponding stream will be fully buffered with the buffer\nsize set to MODE bytes.\n\nNOTE: If COMMAND adjusts the buffering of its standard streams ('tee' does\nfor example) then that will override corresponding changes by 'stdbuf'.\nAlso some filters (like 'dd' and 'cat' etc.) don't use streams for I/O,\nand are thus unaffected by 'stdbuf' settings.\n\nExit status:\n  125  if the stdbuf command itself fails\n  126  if COMMAND is found but cannot be invoked\n  127  if COMMAND cannot be found\n  -    the exit status of COMMAND otherwise",
  },
  touch: {
    usage: "Usage: touch [OPTION]... FILE...",
    description: "Update the access and modification times of each FILE to the current time.",
    options: COMMAND_HELP_OPTIONS.touch,
  },
  timeout: {
    usage: "Usage: timeout [OPTION]... DURATION COMMAND [ARG]...",
    description: "Start COMMAND, and kill it if still running after DURATION.",
    options: COMMAND_HELP_OPTIONS.timeout,
  },
  tr: {
    usage: "Usage: tr [OPTION]... STRING1 [STRING2]",
    description: "Translate, squeeze, and/or delete characters from standard input,\nwriting to standard output.",
    options: COMMAND_HELP_OPTIONS.tr,
  },
  truncate: {
    usage: "Usage: truncate OPTION... FILE...",
    description: "Shrink or extend the size of each FILE to the specified size",
    options: ["-c, --no-create", "-o, --io-blocks", "-r, --reference=RFILE", "-s, --size=SIZE"],
  },
  tsort: {
    usage: "Usage: tsort [OPTION] [FILE]",
    description: "Write totally ordered list consistent with the partial ordering in FILE.\n\nWith no FILE, or when FILE is -, read standard input.",
  },
  tty: {
    usage: "Usage: tty [OPTION]...",
    description: "Print the file name of the terminal connected to standard input.",
    options: ["-s, --silent, --quiet\n         print nothing, only return an exit status"],
  },
  uname: {
    usage: "Usage: uname [OPTION]...",
    description: "Print certain system information.  With no OPTION, same as -s.",
    options: COMMAND_HELP_OPTIONS.uname,
  },
  unexpand: {
    usage: "Usage: unexpand [OPTION]... [FILE]...",
    description: "Convert blanks in each FILE to tabs, writing to standard output.",
    options: COMMAND_HELP_OPTIONS.unexpand,
  },
  uniq: {
    usage: "Usage: uniq [OPTION]... [INPUT [OUTPUT]]",
    description: "Filter adjacent matching lines from INPUT (or standard input),\nwriting to OUTPUT (or standard output).",
    options: COMMAND_HELP_OPTIONS.uniq,
  },
  uptime: {
    usage: "Usage: uptime [OPTION]... [FILE]",
    description: "Print the current time, the length of time the system has been up,\nthe number of users on the system, and the average number of jobs\nin the run queue over the last 1, 5 and 15 minutes.\nIf FILE is not specified, use /var/run/utmp.  /var/log/wtmp as FILE is common.",
  },
  users: {
    usage: "Usage: users [OPTION]... [FILE]",
    description: "Output who is currently logged in according to FILE.\nIf FILE is not specified, use /var/run/utmp.  /var/log/wtmp as FILE is common.",
  },
  vdir: {
    usage: "Usage: vdir [OPTION]... [FILE]...",
    description: "List information about the FILEs (the current directory by default).\nSort entries alphabetically if none of -cftuvSUX nor --sort is specified.",
    options: COMMAND_HELP_OPTIONS.vdir,
  },
  whoami: {
    usage: "Usage: whoami [OPTION]...",
    description: "Print the user name associated with the current effective user ID.\nSame as id -un.",
  },
  wc: {
    usage: "Usage: wc [OPTION]... [FILE]...\n  or:  wc [OPTION]... --files0-from=F",
    description: "Print newline, word, and byte counts for each FILE, and a total line if\nmore than one FILE is specified.",
    options: COMMAND_HELP_OPTIONS.wc,
  },
  who: {
    usage: "Usage: who [OPTION]... [ FILE | ARG1 ARG2 ]",
    description: "Print information about users who are currently logged in.",
    options: COMMAND_HELP_OPTIONS.who,
  },
};

export function showGenericHelp(program) {
  const helpProgram = program === "ginstall" ? "install" : program;
  if (program === "[") {
    showBracketHelp();
    return;
  }
  if (program === "link") {
    showLinkHelp();
    return;
  }
  if (program === "unlink") {
    showUnlinkHelp();
    return;
  }
  if (SPECIAL_HELP[program]) {
    showSpecialHelp(program);
    return;
  }
  if (program === "cksum") {
    stdout("Usage: cksum [OPTION]... [FILE]...\n");
    stdout("Print or verify checksums.\nBy default use the 32 bit CRC algorithm.\n\n");
    stdout("Available algorithms:\n  sysv\n  bsd\n  crc\n  crc32b\n  md5\n  sha1\n  sha2\n  sha3\n  blake2b\n  sm3\n");
    stdout("\nOptions:\n");
    for (const option of COMMAND_HELP_OPTIONS.cksum) stdout(`  ${option}\n`);
    stdout("  --help\n");
    stdout("  --version\n");
    return;
  }
  stdout(`Usage: ${program} [OPTION]... [FILE]...\n`);
  stdout(`Bun implementation of GNU ${program}.\n\n`);
  stdout("Options:\n");
  for (const option of COMMAND_HELP_OPTIONS[helpProgram] ?? []) stdout(`  ${option}\n`);
  stdout("  --help\n");
  stdout("  --version\n");
}

export function showSpecialHelp(program) {
  const help = SPECIAL_HELP[program];
  stdout(`${help.usage}\n`);
  stdout(`${help.description}\n\n`);
  for (const option of help.options ?? []) stdout(`  ${option}\n`);
  if (help.options?.length) stdout("\n");
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n");
  if (help.after) stdout(`\n${help.after}\n`);
}

export function showBracketHelp() {
  stdout("Usage: test EXPRESSION\n");
  stdout("  or:  test\n");
  stdout("  or:  [ EXPRESSION ]\n");
  stdout("  or:  [ ]\n");
  stdout("  or:  [ OPTION\n");
  stdout("Exit with the status determined by EXPRESSION.\n\n");
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n\n");
  stdout("An omitted EXPRESSION defaults to false.  Otherwise,\n");
  stdout("EXPRESSION is true or false and sets exit status.\n");
}

export function showLinkHelp() {
  stdout("Usage: link FILE1 FILE2\n");
  stdout("  or:  link OPTION\n");
  stdout("Call the link function to create a link named FILE2 to an existing FILE1.\n\n");
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n");
}

export function showUnlinkHelp() {
  stdout("Usage: unlink FILE\n");
  stdout("  or:  unlink OPTION\n");
  stdout("Call the unlink function to remove the specified FILE.\n\n");
  stdout("      --help     display this help and exit\n");
  stdout("      --version  output version information and exit\n");
}
